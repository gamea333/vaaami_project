import asyncio
import json
from pathlib import Path
import pytest
import httpx
from api_client import CallUploader, SaveError
from persistence import CallPayload, freeze_call, latency_metrics
from session import Session, SessionManager, BusyError
from server import Offer
from test_sessions import configured, FakePeer

FIXTURE = json.loads((Path(__file__).parents[2] / "packages/contracts/call.example.json").read_text())
async def no_wait(seconds):
    pass

def detail(payload):
    return {"call": {k: v for k, v in payload.items() if k not in ("transcripts", "metrics")},
            "transcripts": payload["transcripts"], "metrics": payload["metrics"]}

def test_shared_contract_and_metric_units():
    assert CallPayload.model_validate(FIXTURE).model_dump() == FIXTURE
    metrics = latency_metrics([
        {"type": "TTFBMetricsData", "processor": "BoundedGroq#0", "value": 0.125},
        {"type": "LLMUsageMetricsData", "processor": "BoundedGroq#0", "value": {"total_tokens": 100}},
        {"type": "TTFAMetricsData", "processor": "BoundedCartesia#0", "ttfa": 0.2},
        {"type": "ProcessingMetricsData", "processor": "Unknown#0", "value": 3},
        {"type": "TTFBMetricsData", "processor": "BoundedGroq#0", "value": float("nan")},
    ])
    assert [m["valueMs"] for m in metrics] == [125, 200]
    assert all(m["turnSequence"] is None for m in metrics)

@pytest.mark.asyncio
async def test_lost_response_retries_identical_payload_then_verifies_readback():
    posts = []
    def handler(request):
        if request.method == "POST":
            posts.append(request.content)
            assert request.headers["Authorization"] == "Bearer test-ingest"
            if len(posts) == 1:
                raise httpx.ReadTimeout("response lost after commit")
            return httpx.Response(200, json={"id": FIXTURE["id"], "duplicate": True})
        return httpx.Response(200, json=detail(FIXTURE))
    uploader = CallUploader(configured(), transport=httpx.MockTransport(handler), sleep=no_wait)
    await uploader.save(json.dumps(FIXTURE))
    assert len(posts) == 2 and posts[0] == posts[1]

@pytest.mark.asyncio
@pytest.mark.parametrize("status,attempts", [(401, 1), (400, 1), (409, 1), (503, 3)])
async def test_permanent_errors_not_retried_and_transient_retries_bounded(status, attempts):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(status, text="private internal failure")
    uploader = CallUploader(configured(), transport=httpx.MockTransport(handler), sleep=no_wait)
    with pytest.raises(SaveError) as error:
        await uploader.save(json.dumps(FIXTURE))
    assert len(requests) == attempts
    assert "private" not in str(error.value)

@pytest.mark.asyncio
async def test_acknowledgement_alone_does_not_report_saved():
    def handler(request):
        if request.method == "POST":
            return httpx.Response(201, json={"id": FIXTURE["id"], "duplicate": False})
        altered = detail(FIXTURE)
        altered["transcripts"] = []
        return httpx.Response(200, json=altered)
    uploader = CallUploader(configured(), transport=httpx.MockTransport(handler), sleep=no_wait)
    with pytest.raises(SaveError, match="does not match"):
        await uploader.save(json.dumps(FIXTURE))

class CaptureUploader:
    def __init__(self):
        self.payloads = []
        self.fail = False
    async def save(self, frozen):
        self.payloads.append(frozen)
        if self.fail:
            raise SaveError("Worker offline")

async def connected(manager):
    ready = asyncio.Event()
    async def bot(settings, peer, session):
        session.mark_started()
        session.transcript.append({"role": "user", "text": "Hello", "timestamp": session.started_at, "interrupted": False})
        ready.set()
        await session.stop.wait()
        # A final aggregator callback during cleanup must land before the frozen snapshot.
        session.transcript.append({"role": "assistant", "text": "Hi", "timestamp": session.started_at, "interrupted": True})
    manager.run_bot = bot
    await manager.start()
    await manager.offer(manager.current, Offer(sdp="offer", type="offer"))
    await ready.wait()
    return manager.current

@pytest.mark.asyncio
async def test_concurrent_hangups_finalize_once_after_cleanup():
    uploader = CaptureUploader()
    peer = FakePeer()
    manager = SessionManager(configured(), None, lambda: peer, uploader)
    session = await connected(manager)
    await asyncio.gather(manager.end(session), manager.end(session))
    await session.save_task
    assert session.save_status == "saved"
    assert peer.closed == 1 and len(uploader.payloads) == 1
    payload = json.loads(session.frozen_payload)
    assert len(payload["transcripts"]) == 2
    assert payload["transcripts"][1]["interrupted"]
    session.transcript[0]["text"] = "later mutation"
    assert json.loads(session.frozen_payload)["transcripts"][0]["text"] == "Hello"

@pytest.mark.asyncio
async def test_failed_save_retained_and_manual_retry_uses_same_bytes():
    uploader = CaptureUploader()
    uploader.fail = True
    manager = SessionManager(configured(), None, FakePeer, uploader)
    session = await connected(manager)
    await manager.end(session)
    await session.save_task
    assert session.save_status == "save_failed"
    with pytest.raises(BusyError):
        await manager.start()
    uploader.fail = False
    manager.retry_save(session)
    manager.retry_save(session)
    await session.save_task
    assert session.save_status == "saved"
    assert len(uploader.payloads) == 2 and uploader.payloads[0] == uploader.payloads[1]
    await manager.start()
    assert manager.find(session.id, session.token) is session
    await manager.close()

@pytest.mark.asyncio
async def test_slow_upload_does_not_keep_audio_or_hangup_open():
    uploading, release = asyncio.Event(), asyncio.Event()
    class Slow:
        async def save(self, frozen):
            uploading.set()
            await release.wait()
    peer = FakePeer()
    manager = SessionManager(configured(), None, lambda: peer, Slow())
    session = await connected(manager)
    await asyncio.wait_for(manager.end(session), 1)
    await uploading.wait()
    assert peer.closed == 1 and session.save_status == "saving"
    release.set()
    await session.save_task

@pytest.mark.asyncio
@pytest.mark.parametrize("reason,failed,status", [
    ("Browser disconnected.", False, "disconnected"),
    ("Voice service error.", True, "failed"),
    ("Call time limit reached.", False, "completed"),
])
async def test_non_button_endings_save_without_browser_request(reason, failed, status):
    uploader = CaptureUploader()
    manager = SessionManager(configured(), None, FakePeer, uploader)
    session = await connected(manager)
    if failed:
        session.error = "Voice service failed"
    session.request_stop(reason)
    await session.task
    await session.save_task
    assert json.loads(session.frozen_payload)["status"] == status
    assert session.save_status == "saved"

@pytest.mark.asyncio
async def test_manual_retry_cap_and_validation_failure():
    uploader = CaptureUploader()
    uploader.fail = True
    manager = SessionManager(configured(), None, FakePeer, uploader)
    session = await connected(manager)
    await manager.end(session)
    await session.save_task
    for _ in range(3):
        manager.retry_save(session)
        await session.save_task
    with pytest.raises(ValueError):
        manager.retry_save(session)
    assert len(uploader.payloads) == 4
    other = Session("not-a-uuid", "token")
    other.mark_started()
    other.mark_ended()
    manager._finalize(other)
    assert other.save_status == "save_failed"
    assert other.frozen_payload is None


@pytest.mark.asyncio
async def test_cancel_during_peer_cleanup_still_finalizes():
    cleaning = asyncio.Event()
    class SlowPeer(FakePeer):
        async def disconnect(self):
            cleaning.set()
            await asyncio.Event().wait()
    uploader = CaptureUploader()
    manager = SessionManager(configured(), None, SlowPeer, uploader)
    session = await connected(manager)
    session.request_stop("Browser disconnected.")
    await cleaning.wait()
    session.task.cancel()
    await asyncio.gather(session.task, return_exceptions=True)
    await session.save_task
    assert session.save_status == "saved"
    assert len(uploader.payloads) == 1

def test_retry_and_recovery_endpoints_require_credentials():
    from fastapi.testclient import TestClient
    from server import create_app
    uploader = CaptureUploader()
    app = create_app(configured(), lambda *args: None, FakePeer, uploader)
    session = Session(FIXTURE["id"], "control-test", save_status="save_failed", frozen_payload=json.dumps(FIXTURE))
    app.state.sessions.sessions[session.id] = session
    with TestClient(app) as client:
        path = "/sessions/" + session.id + "/retry-save"
        assert client.get("/pending-saves").status_code == 401
        recovered = client.get("/pending-saves", headers={"Authorization": "Bearer demo"}).json()
        assert recovered["items"] == [{"id": session.id, "controlToken": "control-test"}]
        assert client.post(path).status_code == 404
        assert client.post(path, headers={"Authorization": "Bearer control-test"}).status_code == 202
    assert session.save_status == "saved"
    assert len(uploader.payloads) == 1
