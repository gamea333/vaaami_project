"""Synthetic connected-call lifecycle -> real local Worker/D1. No voice providers."""
import asyncio
from types import SimpleNamespace
import httpx
from api_client import CallUploader
from config import Settings
from session import SessionManager

class Peer:
    pc_id = "synthetic-peer"
    async def initialize(self, sdp, type):
        pass
    def get_answer(self):
        return {"type": "answer", "sdp": "synthetic", "pc_id": self.pc_id}
    async def disconnect(self):
        pass

class LostResponse(httpx.AsyncBaseTransport):
    """Drop one acknowledgement AFTER the real Worker commits the upload."""
    def __init__(self):
        self.inner = httpx.AsyncHTTPTransport()
        self.dropped = False
    async def handle_async_request(self, request):
        response = await self.inner.handle_async_request(request)
        if request.method == "POST" and response.status_code == 201 and not self.dropped:
            await response.aread()
            await response.aclose()
            self.dropped = True
            raise httpx.ReadTimeout("Synthetic response loss after successful commit")
        return response
    async def aclose(self):
        await self.inner.aclose()

async def main():
    settings = Settings.load()
    ready = asyncio.Event()
    async def synthetic_bot(settings, peer, session):
        session.mark_started()
        session.transcript.extend([
            {"role": "user", "text": "[Synthetic persistence test] Hello.", "timestamp": session.started_at, "interrupted": False},
            {"role": "assistant", "text": "Synthetic test reply; no voice provider was called.", "timestamp": session.started_at, "interrupted": True},
        ])
        session.metrics.append({"type": "TTFBMetricsData", "processor": "BoundedGroq#test", "value": 0.125})
        ready.set()
        await session.stop.wait()
    transport = LostResponse()
    manager = SessionManager(settings, synthetic_bot, Peer, CallUploader(settings, transport=transport))
    try:
        await manager.start()
        session = manager.current
        await manager.offer(session, SimpleNamespace(sdp="synthetic", type="offer", pc_id=None, restart_pc=False))
        await ready.wait()
        await asyncio.gather(manager.end(session), manager.end(session))
        await session.save_task
        if session.save_status != "saved":
            raise RuntimeError(session.save_error)
        assert transport.dropped, "The synthetic lost-response branch did not execute."
        print("PASS: finalization, lost-response retry, and D1 read-back.")
        print("Synthetic call ID:", session.id)
        print("View:", settings.calls_api_url + "/calls/" + session.id)
    finally:
        await manager.close()

if __name__ == "__main__":
    asyncio.run(main())
