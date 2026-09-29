"""Local session control and authenticated SmallWebRTC signaling."""
import secrets
from contextlib import asynccontextmanager
from typing import Literal
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from config import Settings
from session import BusyError, RunBudgetError, SessionManager

class Offer(BaseModel):
    sdp: str = Field(min_length=1, max_length=100_000)
    type: Literal["offer"]
    pc_id: str | None = None
    restart_pc: bool = False

class Candidate(BaseModel):
    candidate: str = Field(max_length=4096)
    sdp_mid: str | None = None
    sdp_mline_index: int | None = None

class CandidatePatch(BaseModel):
    pc_id: str
    candidates: list[Candidate] = Field(max_length=100)

async def run_voice_bot(*args):
    from pipeline import run_conversation
    await run_conversation(*args)

def create_app(settings=None, runner=None, peer_factory=None, uploader=None):
    settings = settings or Settings.load()
    manager = SessionManager(settings, runner or run_voice_bot, peer_factory, uploader)

    @asynccontextmanager
    async def lifespan(app):
        if runner is None:
            # Warm heavy voice imports before accepting calls. No provider connection is made.
            from pipeline import run_conversation
        yield
        await manager.close()

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.origins),
                       allow_methods=["GET", "POST", "PATCH"],
                       allow_headers=["Authorization", "Content-Type"])
    app.state.sessions = manager

    def bearer(value):
        return value.removeprefix("Bearer ") if value.startswith("Bearer ") else ""

    @app.get("/health")
    async def health():
        return {"service": "vaami-bot", "transport": "small-webrtc",
                "ready": not settings.missing(), "missing": settings.missing()}

    @app.post("/sessions", status_code=201)
    async def start(authorization: str = Header(default="")):
        if not settings.access_code or not secrets.compare_digest(
                bearer(authorization), settings.access_code):
            raise HTTPException(401, "Enter the demo access code from bot/.env.")
        if settings.missing():
            raise HTTPException(503, "Configure: " + ", ".join(settings.missing()))
        try:
            return await manager.start()
        except RunBudgetError:
            raise HTTPException(429, "Demo usage budget reached. Check provider usage before deliberately restarting the bot.")
        except BusyError:
            raise HTTPException(409, "A call is running or has an unfinished save. End it or retry its save before starting another.")

    def session_for(call_id, authorization):
        session = manager.find(call_id, bearer(authorization))
        if session is None:
            raise HTTPException(404, "Session not found.")
        return session

    @app.post("/sessions/{call_id}/offer")
    async def offer(call_id: str, data: Offer, authorization: str = Header(default="")):
        session = session_for(call_id, authorization)
        try:
            return await manager.offer(session, data)
        except ValueError as error:
            raise HTTPException(400, str(error))
        except Exception:
            raise HTTPException(502, "WebRTC negotiation failed. Check the local bot connection.")

    @app.patch("/sessions/{call_id}/offer")
    async def candidates(call_id: str, data: CandidatePatch, authorization: str = Header(default="")):
        session = session_for(call_id, authorization)
        try:
            await manager.patch(session, data)
        except ValueError as error:
            raise HTTPException(400, str(error))
        return {"ok": True}

    @app.get("/sessions/{call_id}")
    async def status(call_id: str, authorization: str = Header(default="")):
        session = session_for(call_id, authorization)
        return {"id": session.id, "status": session.status, "error": session.error,
                "saveStatus": session.save_status, "saveError": session.save_error,
                "canRetrySave": bool(session.frozen_payload) and session.manual_retries < 3,
                "durationMs": session.duration_ms,
                "reason": session.reason, "startedAt": session.started_at, "endedAt": session.ended_at,
                "transcript": session.transcript, "metrics": session.metrics,
                "usage": {"replies": session.budget.replies if session.budget else 0,
                          "ttsCharactersReserved": session.budget.tts_chars if session.budget else 0}}

    @app.post("/sessions/{call_id}/retry-save", status_code=202)
    async def retry_save(call_id: str, authorization: str = Header(default="")):
        session = session_for(call_id, authorization)
        if session.task and not session.task.done():
            raise HTTPException(409, "End the call before retrying its save.")
        try:
            manager.retry_save(session)
        except ValueError as error:
            raise HTTPException(409, str(error))
        return await status(call_id, authorization)

    @app.get("/pending-saves")
    async def pending_saves(authorization: str = Header(default="")):
        if not settings.access_code or not secrets.compare_digest(bearer(authorization), settings.access_code):
            raise HTTPException(401, "Enter the demo access code from bot/.env.")
        return {"items": [{"id": s.id, "controlToken": s.token}
                          for s in manager.sessions.values() if s.save_status in ("saving", "save_failed")]}

    @app.post("/sessions/{call_id}/end")
    async def end(call_id: str, authorization: str = Header(default="")):
        session = session_for(call_id, authorization)
        await manager.end(session)
        return await status(call_id, authorization)

    return app

app = create_app()
