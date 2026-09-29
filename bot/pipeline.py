"""Phase 2: streaming speech -> text -> answer -> speech, with bounded usage."""
import asyncio
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair, LLMUserAggregatorParams)
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.workers.runner import WorkerRunner
from guards import Budget, BoundedCartesia, BoundedGroq, RequestGuard, MetricsCollector

SYSTEM = (
    "You are Vaami, a friendly voice assistant for a short internship demo. "
    "Answer in English using one or two short sentences, at most 35 words. "
    "Use plain spoken text, no markdown. Ask at most one question. "
    "Do not claim to book, save, or execute actions: you have no tools. "
    "Keep answers concise even if asked for long output."
)
GREETING = "Hello! I'm Vaami. What would you like to talk about?"

def build_conversation(settings, connection, session):
    """Construct services without making provider calls; connections start with the worker."""
    budget = Budget(settings, session)
    session.budget = budget
    transport = SmallWebRTCTransport(connection, params=TransportParams(
        audio_in_enabled=True, audio_out_enabled=True,
        video_in_enabled=False, video_out_enabled=False))
    stt = DeepgramSTTService(api_key=settings.deepgram_key,
        settings=DeepgramSTTService.Settings(model=settings.deepgram_model,
            interim_results=True, punctuate=True, smart_format=True))
    llm = BoundedGroq(api_key=settings.groq_key, retry_on_timeout=False,
        settings=BoundedGroq.Settings(model=settings.groq_model,
            max_completion_tokens=settings.max_completion_tokens,
            reasoning_effort="low", temperature=0.4))
    tts = BoundedCartesia(api_key=settings.cartesia_key, budget=budget,
        settings=BoundedCartesia.Settings(voice=settings.voice_id, model=settings.model))
    context = LLMContext([{"role": "system", "content": SYSTEM}])
    pair = LLMContextAggregatorPair(context, user_params=LLMUserAggregatorParams(
        vad_analyzer=SileroVADAnalyzer(),
        user_turn_strategies=UserTurnStrategies(stop=[SpeechTimeoutUserTurnStopStrategy()]),
        user_idle_timeout=settings.idle_seconds, empty_user_turn=None))
    worker = PipelineWorker(Pipeline([
        transport.input(), stt, pair.user(), RequestGuard(budget), llm,
        tts, MetricsCollector(session), transport.output(), pair.assistant(),
    ]), params=PipelineParams(enable_metrics=True, enable_usage_metrics=True), enable_rtvi=True)
    ready = asyncio.Event()

    def record(role, message):
        if message.content.strip() and len(session.transcript) < 50:
            session.transcript.append({
                "role": role, "text": message.content[:2000],
                "timestamp": message.timestamp,
                "interrupted": getattr(message, "interrupted", False)})

    @pair.user().event_handler("on_user_turn_message_added")
    async def on_user_message(aggregator, message):
        record("user", message)

    @pair.assistant().event_handler("on_assistant_turn_stopped")
    async def on_assistant_message(aggregator, message):
        record("assistant", message)

    @pair.user().event_handler("on_user_turn_idle")
    async def on_idle(aggregator):
        budget.stop("Call ended after inactivity.")

    @worker.rtvi.event_handler("on_client_ready")
    async def on_ready(rtvi):
        if ready.is_set() or session.stop.is_set():
            return
        ready.set()
        session.mark_started()
        await worker.queue_frames([TTSSpeakFrame(GREETING)])

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(transport, participant):
        budget.stop("Browser disconnected.")

    @worker.event_handler("on_pipeline_error")
    async def on_error(worker, frame):
        session.error = "A voice service failed. Check provider configuration or remaining quota."
        budget.stop("Voice service error.")

    return worker, ready, llm

async def run_conversation(settings, connection, session):
    worker, ready, llm = build_conversation(settings, connection, session)

    async def watch_stop():
        await session.stop.wait()
        await worker.cancel()

    async def watch_join():
        try:
            await asyncio.wait_for(ready.wait(), timeout=35)
        except TimeoutError:
            session.budget.stop("Browser readiness timed out.")

    stop_task = asyncio.create_task(watch_stop())
    join_task = asyncio.create_task(watch_join())
    runner = WorkerRunner(handle_sigint=False)
    try:
        await runner.add_workers(worker)
        await runner.run()
    finally:
        stop_task.cancel()
        join_task.cancel()
        await asyncio.gather(stop_task, join_task, return_exceptions=True)
        await worker.cancel()
        await llm._client.close()
    if session.error:
        raise RuntimeError("Voice pipeline failed")
