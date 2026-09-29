"""Deterministic limits: reserve usage BEFORE handing work to a paid service."""
from pipecat.frames.frames import LLMContextFrame, MetricsFrame
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.services.groq.llm import GroqLLMService
from pipecat.services.cartesia.tts import CartesiaTTSService

class Budget:
    def __init__(self, settings, session):
        self.settings, self.session = settings, session
        self.replies = 0
        self.tts_chars = 0
        self.reply_chars = 0

    def stop(self, reason):
        self.session.request_stop(reason)

    def reserve_reply(self):
        if self.session.stop.is_set():
            return False
        if self.replies >= self.settings.max_replies:
            self.stop("Reply limit reached.")
            return False
        self.replies += 1
        self.reply_chars = 0
        return True

    def reserve_speech(self, text):
        if self.session.stop.is_set():
            return False
        count = len(text)
        if self.tts_chars + count > self.settings.max_tts_chars:
            self.stop("Speech character limit reached.")
            return False
        if self.reply_chars + count > self.settings.max_reply_chars:
            self.stop("Reply length limit reached.")
            return False
        self.tts_chars += count
        self.reply_chars += count
        return True

def bounded_messages(messages):
    """Keep the system instruction and most recent text turns, at most 6000 chars."""
    system = dict(messages[0])
    system["content"] = str(system.get("content", ""))[:1000]
    remaining = 6000 - len(system["content"])
    recent = []
    for message in reversed(messages[1:]):
        if message.get("role") not in ("user", "assistant"):
            continue
        content = str(message.get("content", ""))[:1000]
        if len(content) > remaining or len(recent) == 10:
            break
        recent.append({"role": message["role"], "content": content})
        remaining -= len(content)
    return [system, *reversed(recent)]

class RequestGuard(FrameProcessor):
    def __init__(self, budget):
        super().__init__()
        self.budget = budget

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, LLMContextFrame):
            if not self.budget.reserve_reply():
                return
            frame.context.set_messages(bounded_messages(frame.context.get_messages()))
        await self.push_frame(frame, direction)

class BoundedGroq(GroqLLMService):
    def create_client(self, **kwargs):
        client = super().create_client(**kwargs)
        # Pipecat's factory ignores extra SDK kwargs; explicitly set the returned client.
        client.max_retries = 0
        client.timeout = 15.0
        return client

class BoundedCartesia(CartesiaTTSService):
    def __init__(self, *, budget, **kwargs):
        super().__init__(**kwargs)
        self.budget = budget

    async def run_tts(self, text, context_id):
        if not self.budget.reserve_speech(text):
            return
        async for frame in super().run_tts(text, context_id):
            yield frame

class MetricsCollector(FrameProcessor):
    def __init__(self, session):
        super().__init__()
        self.session = session

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, MetricsFrame):
            for item in frame.data:
                if len(self.session.metrics) < 200:
                    self.session.metrics.append({
                        "type": type(item).__name__, **item.model_dump(mode="json")})
        await self.push_frame(frame, direction)
