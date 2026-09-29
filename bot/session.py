"""One authenticated local WebRTC session with bounded cleanup."""
import asyncio
import logging
import secrets
from dataclasses import dataclass, field
from uuid import uuid4
from datetime import datetime, timezone, timedelta
import time
from api_client import CallUploader, SaveError
from persistence import freeze_call

logger = logging.getLogger("vaami.sessions")

@dataclass
class Session:
    id: str
    token: str = field(repr=False)
    status: str = "connecting"
    error: str | None = None
    reason: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    started_clock: float | None = field(default=None, repr=False)
    duration_ms: int = 0
    save_status: str = "pending"
    save_error: str | None = None
    frozen_payload: str | None = field(default=None, repr=False)
    save_task: asyncio.Task | None = field(default=None, repr=False)
    manual_retries: int = 0
    transcript: list = field(default_factory=list)
    metrics: list = field(default_factory=list)
    budget: object | None = field(default=None, repr=False)
    peer: object | None = field(default=None, repr=False)
    stop: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    offered: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    signaling_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    task: asyncio.Task | None = field(default=None, repr=False)

    def mark_started(self):
        if self.started_clock is None and not self.stop.is_set():
            self.started_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            self.started_clock = time.monotonic()
            self.status = "active"

    def mark_ended(self):
        if self.ended_at is None:
            if self.started_clock is not None:
                self.duration_ms = max(0, round((time.monotonic() - self.started_clock) * 1000))
                # Anchor UTC end to monotonic elapsed time: wall-clock adjustments cannot corrupt duration.
                start = datetime.fromisoformat(self.started_at.replace("Z", "+00:00"))
                self.ended_at = (start + timedelta(milliseconds=self.duration_ms)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            else:
                self.ended_at = datetime.now(timezone.utc).isoformat()

    def request_stop(self, reason=None):
        self.reason = self.reason or reason
        self.mark_ended()
        self.stop.set()

class BusyError(Exception):
    pass

class RunBudgetError(Exception):
    pass

class SessionManager:
    def __init__(self, settings, run_bot, peer_factory=None, uploader=None):
        self.settings, self.run_bot = settings, run_bot
        self.peer_factory = peer_factory or self._new_peer
        self.current = None
        self.sessions = {}
        self.uploader = uploader or CallUploader(settings)
        self.lock = asyncio.Lock()
        self.calls_started = 0
        self.reserved_seconds = 0

    def _new_peer(self):
        from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
        # Optional STUN discovers public candidates; it does not relay media.
        return SmallWebRTCConnection(ice_servers=[self.settings.stun_url] if self.settings.stun_url else [])

    async def start(self):
        async with self.lock:
            if self.current and self.current.task and not self.current.task.done():
                raise BusyError()
            if self.current and self.current.save_status in ("saving", "save_failed"):
                raise BusyError()
            if (self.calls_started >= self.settings.max_calls or
                    self.reserved_seconds + self.settings.max_seconds > self.settings.total_seconds):
                raise RunBudgetError()
            # Reserve the entire maximum, including abandoned/failed calls. No refunds.
            self.calls_started += 1
            self.reserved_seconds += self.settings.max_seconds
            session = Session(str(uuid4()), secrets.token_urlsafe(32))
            self.current = session
            self.sessions[session.id] = session
            session.task = asyncio.create_task(self._run(session))
            return {"id": session.id, "controlToken": session.token}

    async def offer(self, session, data):
        async with session.signaling_lock:
            if session.stop.is_set():
                raise ValueError("Session has ended.")
            if session.peer:
                if data.pc_id != session.peer.pc_id:
                    raise ValueError("Peer ID does not match this session.")
                await asyncio.wait_for(session.peer.renegotiate(data.sdp, data.type, restart_pc=data.restart_pc), timeout=20)
            else:
                if data.pc_id:
                    raise ValueError("Unknown peer ID.")
                session.peer = self.peer_factory()
                try:
                    await asyncio.wait_for(session.peer.initialize(data.sdp, data.type), timeout=20)
                except BaseException:
                    session.stop.set()
                    session.offered.set()
                    raise
                session.offered.set()
            return session.peer.get_answer()

    async def patch(self, session, data):
        from aiortc.sdp import candidate_from_sdp
        async with session.signaling_lock:
            if session.stop.is_set() or not session.peer or data.pc_id != session.peer.pc_id:
                raise ValueError("Peer ID does not match an active session.")
            for item in data.candidates:
                if not item.candidate:
                    continue
                candidate = candidate_from_sdp(item.candidate.removeprefix("candidate:"))
                candidate.sdpMid = item.sdp_mid
                candidate.sdpMLineIndex = item.sdp_mline_index
                await session.peer.add_ice_candidate(candidate)

    async def _run(self, session):
        # Record the reason even if a provider runner absorbs CancelledError during cleanup.
        def expired():
            session.request_stop("Call time limit reached.")
        deadline = asyncio.get_running_loop().call_later(self.settings.max_seconds, expired)
        try:
            async with asyncio.timeout(self.settings.max_seconds):
                await asyncio.wait_for(session.offered.wait(), timeout=40)
                if not session.stop.is_set():
                    await self.run_bot(self.settings, session.peer, session)
            session.status = "ended"
        except TimeoutError:
            session.reason = session.reason or "Call time limit reached."
            session.status = "ended"
        except asyncio.CancelledError:
            session.status = "ended"
        except Exception as error:
            session.status = "failed"
            session.error = session.error or "The voice bot failed. Check provider configuration or remaining quota."
            logger.error("bot_failed call_id=%s error_type=%s", session.id, type(error).__name__)
        finally:
            deadline.cancel()
            session.request_stop(session.reason or "Call ended.")
            try:
                async with session.signaling_lock:
                    if session.peer:
                        try:
                            await asyncio.wait_for(session.peer.disconnect(), timeout=5)
                        except Exception:
                            logger.warning("peer_cleanup_failed call_id=%s", session.id)
            finally:
                # Even a cancellation during peer cleanup must retain the completed call.
                self._finalize(session)

    def find(self, call_id, token):
        session = self.sessions.get(call_id)
        if not session or session.id != call_id or not secrets.compare_digest(session.token, token):
            return None
        return session

    async def end(self, session):
        session.request_stop("Call ended.")
        session.offered.set()
        if session.task:
            try:
                await asyncio.wait_for(asyncio.shield(session.task), timeout=10)
            except TimeoutError:
                session.task.cancel()
                await asyncio.gather(session.task, return_exceptions=True)

    def _finalize(self, session):
        if session.save_status != "pending":
            return
        if session.started_clock is None:
            session.save_status = "not_required"
            return
        try:
            session.frozen_payload = freeze_call(session)
        except Exception:
            session.save_status = "save_failed"
            session.save_error = "Final call validation failed. Transcript remains in this bot process."
            logger.error("finalization_failed call_id=%s", session.id)
            return
        self._start_save(session)

    def _start_save(self, session):
        session.save_status = "saving"
        session.save_error = None
        session.save_task = asyncio.create_task(self._save(session))

    async def _save(self, session):
        try:
            await self.uploader.save(session.frozen_payload)
            session.save_status = "saved"
        except asyncio.CancelledError:
            session.save_status = "save_failed"
            session.save_error = "Save interrupted. Retry while this bot process is running."
            raise
        except Exception as error:
            session.save_status = "save_failed"
            session.save_error = str(error) if isinstance(error, SaveError) else "Save failed. The frozen call is retained for retry."
            logger.warning("save_failed call_id=%s error_type=%s", session.id, type(error).__name__)

    def retry_save(self, session):
        if session.save_status in ("saving", "saved"):
            return
        if not session.frozen_payload or session.manual_retries >= 3:
            raise ValueError("No retryable frozen payload, or the three manual retries were used.")
        session.manual_retries += 1
        self._start_save(session)

    async def close(self):
        if self.current:
            await self.end(self.current)


        saves = [session.save_task for session in self.sessions.values()
                 if session.save_task and not session.save_task.done()]
        if saves:
            await asyncio.gather(*saves, return_exceptions=True)
