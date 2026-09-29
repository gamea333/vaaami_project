import asyncio
import pytest
from fastapi.testclient import TestClient
from config import Settings
from server import create_app, Offer
from session import BusyError, SessionManager

class FakePeer:
    pc_id = "peer-1"
    def __init__(self):
        self.closed = 0
    async def initialize(self, sdp, type):
        pass
    async def renegotiate(self, sdp, type, restart_pc=False):
        pass
    def get_answer(self):
        return {"sdp": "fake-answer", "type": "answer", "pc_id": self.pc_id}
    async def disconnect(self):
        self.closed += 1

async def fake_bot(settings, peer, session):
    session.status = "active"
    await session.stop.wait()

def configured():
    return Settings(cartesia_key="fake", deepgram_key="fake", groq_key="fake", voice_id="fake", access_code="demo", ingest_token="test-ingest")

@pytest.mark.asyncio
async def test_busy_auth_and_concurrent_hangups():
    peer = FakePeer()
    manager = SessionManager(configured(), fake_bot, lambda: peer)
    data = await manager.start()
    with pytest.raises(BusyError):
        await manager.start()
    assert manager.find(data["id"], "wrong") is None
    session = manager.find(data["id"], data["controlToken"])
    await manager.offer(session, Offer(sdp="offer", type="offer"))
    await asyncio.gather(manager.end(session), manager.end(session))
    assert peer.closed == 1
    assert session.status == "ended"
    await manager.start()
    await manager.close()

@pytest.mark.asyncio
async def test_error_closes_peer_and_redacts_error():
    async def fail(*args):
        raise RuntimeError("secret")
    peer = FakePeer()
    manager = SessionManager(configured(), fail, lambda: peer)
    await manager.start()
    await manager.offer(manager.current, Offer(sdp="offer", type="offer"))
    await manager.current.task
    assert manager.current.status == "failed"
    assert "secret" not in manager.current.error
    assert peer.closed == 1

@pytest.mark.asyncio
async def test_unoffered_session_expires_without_provider_call():
    settings = configured()
    settings.max_seconds = 0.01
    called = False
    async def run(*args):
        nonlocal called
        called = True
    manager = SessionManager(settings, run)
    await manager.start()
    await manager.current.task
    assert manager.current.status == "ended"
    assert not called

def test_api_auth_and_signaling():
    peer = FakePeer()
    with TestClient(create_app(configured(), fake_bot, lambda: peer)) as client:
        assert client.get("/health").json()["transport"] == "small-webrtc"
        assert client.post("/sessions").status_code == 401
        data = client.post("/sessions", headers={"Authorization": "Bearer demo"}).json()
        assert set(data) == {"id", "controlToken"}
        path = "/sessions/" + data["id"]
        headers = {"Authorization": "Bearer " + data["controlToken"]}
        assert client.post(path + "/offer", json={"sdp": "x", "type": "offer"}).status_code == 404
        answer = client.post(path + "/offer", headers=headers, json={"sdp": "x", "type": "offer"})
        assert answer.status_code == 200
        assert answer.json()["type"] == "answer"
        assert client.post(path + "/offer", headers=headers,
                           json={"sdp": "x", "type": "offer", "pc_id": "other"}).status_code == 400
        assert client.patch(path + "/offer", headers=headers,
                            json={"pc_id": "other", "candidates": []}).status_code == 400
        assert client.post(path + "/end", headers=headers).status_code == 200
    assert peer.closed == 1

@pytest.mark.asyncio
async def test_bad_offer_cleans_up():
    class BadPeer(FakePeer):
        async def initialize(self, sdp, type):
            raise RuntimeError("invalid SDP")
    peer = BadPeer()
    manager = SessionManager(configured(), fake_bot, lambda: peer)
    await manager.start()
    with pytest.raises(RuntimeError):
        await manager.offer(manager.current, Offer(sdp="bad", type="offer"))
    await manager.current.task
    assert peer.closed == 1

@pytest.mark.asyncio
async def test_real_local_webrtc_handshake_without_speech_provider():
    from aiortc import RTCPeerConnection, RTCConfiguration, RTCSessionDescription
    client = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    client.addTransceiver("audio", direction="sendrecv")
    channel = client.createDataChannel("rtvi")
    opened = asyncio.Event()
    @channel.on("open")
    def on_open():
        opened.set()
    manager = SessionManager(configured(), fake_bot)
    try:
        await manager.start()
        offer = await client.createOffer()
        await client.setLocalDescription(offer)
        answer = await manager.offer(manager.current, Offer(sdp=client.localDescription.sdp, type="offer"))
        await client.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
        await asyncio.wait_for(opened.wait(), timeout=15)
        assert client.connectionState == "connected"
    finally:
        await manager.close()
        await client.close()
