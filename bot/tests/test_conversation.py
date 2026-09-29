"""Offline regression tests: no provider credentials or billable requests."""
import asyncio
from unittest.mock import AsyncMock
import pytest
from fastapi.testclient import TestClient
from config import Settings
from guards import Budget, BoundedCartesia, RequestGuard, bounded_messages
from pipecat.frames.frames import LLMContextFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.cartesia.tts import CartesiaTTSService
from server import create_app, Offer
from session import Session, SessionManager, RunBudgetError
from test_sessions import configured, FakePeer, fake_bot

def test_speech_budget_reserves_before_work_and_never_refunds():
    settings = configured()
    settings.max_tts_chars, settings.max_reply_chars = 10, 10
    session = Session("test", "secret")
    budget = Budget(settings, session)
    assert budget.reserve_speech("hello")
    assert budget.reserve_reply()
    assert budget.reserve_speech("world")
    assert not budget.reserve_speech("!")
    assert budget.tts_chars == 10
    assert session.stop.is_set()

@pytest.mark.asyncio
async def test_tts_guard_blocks_actual_provider_method(monkeypatch):
    sent = []
    async def fake_tts(self, text, context_id):
        sent.append(text)
        yield None
    monkeypatch.setattr(CartesiaTTSService, "run_tts", fake_tts)
    settings = configured()
    settings.max_reply_chars = 5
    budget = Budget(settings, Session("test", "secret"))
    tts = BoundedCartesia(api_key="fake", budget=budget,
        settings=BoundedCartesia.Settings(voice="fake", model="sonic-3.6"))
    assert [x async for x in tts.run_tts("hello", "1")] == [None]
    assert [x async for x in tts.run_tts("more", "1")] == []
    assert sent == ["hello"]

@pytest.mark.asyncio
async def test_request_guard_stops_ninth_generation_and_bounds_context():
    session = Session("test", "secret")
    budget = Budget(configured(), session)
    guard = RequestGuard(budget)
    guard.push_frame = AsyncMock()
    context = LLMContext([{"role": "system", "content": "instruction"},
        {"role": "user", "content": "a" * 20000}])
    for _ in range(9):
        await guard.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
    assert guard.push_frame.await_count == 8
    assert len(context.get_messages()[-1]["content"]) == 1000
    assert session.stop.is_set()
    assert budget.replies == 8

def test_context_retains_instruction_and_recent_followup():
    messages = [{"role": "system", "content": "Be brief."}] + [
        {"role": "user" if n % 2 else "assistant", "content": str(n) * 1000}
        for n in range(20)]
    result = bounded_messages(messages)
    assert result[0] == messages[0]
    assert result[-1]["content"] == messages[-1]["content"][:1000]
    assert sum(len(x["content"]) for x in result) <= 6000

@pytest.mark.asyncio
async def test_repeated_calls_exhaust_budget_even_when_abandoned():
    settings = configured()
    settings.total_seconds = 240
    manager = SessionManager(settings, fake_bot, FakePeer)
    for _ in range(2):
        await manager.start()
        await manager.end(manager.current)
    with pytest.raises(RunBudgetError):
        await manager.start()
    assert manager.reserved_seconds == 240

@pytest.mark.asyncio
async def test_call_duration_cancels_active_provider_task():
    closed = asyncio.Event()
    async def provider(settings, peer, session):
        try:
            await asyncio.Event().wait()
        finally:
            closed.set()
    settings = configured()
    settings.max_seconds = 0.05
    peer = FakePeer()
    manager = SessionManager(settings, provider, lambda: peer)
    await manager.start()
    await manager.offer(manager.current, Offer(sdp="offer", type="offer"))
    await asyncio.wait_for(manager.current.task, 2)
    assert closed.is_set()
    assert peer.closed == 1
    assert manager.current.reason == "Call time limit reached."

def test_api_rejects_missing_providers_and_exhausted_budget():
    settings = configured()
    settings.groq_key = ""
    with TestClient(create_app(settings, fake_bot, FakePeer)) as client:
        response = client.post("/sessions", headers={"Authorization": "Bearer demo"})
        assert response.status_code == 503
        assert "GROQ_API_KEY" in response.json()["detail"]
    settings = configured()
    settings.max_calls = 1
    with TestClient(create_app(settings, fake_bot, FakePeer)) as client:
        data = client.post("/sessions", headers={"Authorization": "Bearer demo"}).json()
        client.post("/sessions/" + data["id"] + "/end",
            headers={"Authorization": "Bearer " + data["controlToken"]})
        assert client.post("/sessions", headers={"Authorization": "Bearer demo"}).status_code == 429

@pytest.mark.asyncio
async def test_real_pipeline_construction_without_provider_connections():
    from pipeline import build_conversation
    from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
    peer = SmallWebRTCConnection(ice_servers=[])
    session = Session("test", "secret")
    worker, ready, llm = build_conversation(configured(), peer, session)
    assert not ready.is_set()
    assert llm._client.max_retries == 0
    assert llm._client.timeout == 15.0
    assert llm._settings.max_completion_tokens == 512
    assert session.budget.replies == 0
    await llm._client.close()
    await peer.disconnect()

def test_invalid_safety_setting_fails_closed(monkeypatch):
    monkeypatch.setenv("MAX_CALL_SECONDS", "0")
    with pytest.raises(ValueError, match="MAX_CALL_SECONDS"):
        Settings.load()


@pytest.mark.asyncio
async def test_idle_and_transcript_handlers_on_real_aggregators():
    from pipeline import build_conversation
    from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMUserAggregator, LLMAssistantAggregator,
        UserTurnMessageAddedMessage, AssistantTurnStoppedMessage)
    peer = SmallWebRTCConnection(ice_servers=[])
    session = Session("test", "secret")
    worker, _, llm = build_conversation(configured(), peer, session)
    def descendants(processor):
        yield processor
        for child in processor.processors:
            yield from descendants(child)
    processors = list(descendants(worker.pipeline))
    user = next(p for p in processors if isinstance(p, LLMUserAggregator))
    assistant = next(p for p in processors if isinstance(p, LLMAssistantAggregator))
    await user._call_event_handler("on_user_turn_message_added",
        UserTurnMessageAddedMessage(content="My name is Aditya.", timestamp="now"))
    await assistant._call_event_handler("on_assistant_turn_stopped",
        AssistantTurnStoppedMessage(content="Hello Aditya.", interrupted=True, timestamp="later"))
    await user._call_event_handler("on_user_turn_idle")
    await asyncio.wait_for(session.stop.wait(), 1)
    await asyncio.sleep(0)
    assert session.reason == "Call ended after inactivity."
    assert [x["role"] for x in session.transcript] == ["user", "assistant"]
    assert session.transcript[-1]["interrupted"] is True
    assert session.budget.replies == 0
    await llm._client.close()
    await peer.disconnect()
