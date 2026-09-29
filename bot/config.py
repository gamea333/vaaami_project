"""Local settings. Safety limits are validated before any provider connects."""
import os
from dataclasses import dataclass, field
from pathlib import Path
from dotenv import load_dotenv

@dataclass
class Settings:
    cartesia_key: str = field(repr=False, default="")
    deepgram_key: str = field(repr=False, default="")
    groq_key: str = field(repr=False, default="")
    voice_id: str = ""
    model: str = "sonic-3.6"
    groq_model: str = "openai/gpt-oss-20b"
    deepgram_model: str = "nova-3"
    calls_api_url: str = "http://127.0.0.1:8787"
    ingest_token: str = field(repr=False, default="")
    access_code: str = field(repr=False, default="")
    origins: tuple[str, ...] = ("http://127.0.0.1:5173", "http://localhost:5173")
    stun_url: str = ""
    max_seconds: int = 120
    idle_seconds: int = 30
    max_calls: int = 10
    total_seconds: int = 600
    max_replies: int = 8
    max_completion_tokens: int = 512
    max_tts_chars: int = 1200
    max_reply_chars: int = 300

    @classmethod
    def load(cls):
        load_dotenv(Path(__file__).with_name(".env"), encoding="utf-8-sig")
        def value(name, default=""):
            return os.getenv(name, "").strip() or default
        def limit(name, default, minimum, maximum):
            try:
                result = int(value(name, str(default)))
            except ValueError:
                raise ValueError(f"{name} must be an integer.") from None
            if not minimum <= result <= maximum:
                raise ValueError(f"{name} must be between {minimum} and {maximum}.")
            return result
        return cls(
            cartesia_key=value("CARTESIA_API_KEY"), deepgram_key=value("DEEPGRAM_API_KEY"),
            groq_key=value("GROQ_API_KEY"), voice_id=value("CARTESIA_VOICE_ID"),
            model=value("CARTESIA_MODEL", "sonic-3.6"),
            groq_model=value("GROQ_MODEL", "openai/gpt-oss-20b"),
            deepgram_model=value("DEEPGRAM_MODEL", "nova-3"),
            calls_api_url=value("CALLS_API_BASE_URL", "http://127.0.0.1:8787"),
            ingest_token=value("CALLS_INGEST_TOKEN"),
            access_code=value("DEMO_ACCESS_CODE"),
            origins=tuple(x.strip() for x in value("ALLOWED_ORIGINS",
                "http://127.0.0.1:5173,http://localhost:5173").split(",") if x.strip()),
            stun_url=value("STUN_SERVER_URL"),
            max_seconds=limit("MAX_CALL_SECONDS", 120, 15, 180),
            idle_seconds=limit("IDLE_TIMEOUT_SECONDS", 30, 10, 60),
            max_calls=limit("MAX_CALLS_PER_RUN", 10, 1, 20),
            total_seconds=limit("MAX_RESERVED_SECONDS_PER_RUN", 600, 15, 1200),
            max_replies=limit("MAX_REPLIES_PER_CALL", 8, 1, 12),
            max_completion_tokens=limit("MAX_COMPLETION_TOKENS", 512, 64, 1024),
            max_tts_chars=limit("MAX_TTS_CHARS_PER_CALL", 1200, 100, 2000),
            max_reply_chars=limit("MAX_REPLY_CHARS", 300, 50, 400),
        )

    def missing(self):
        values = {"CARTESIA_API_KEY": self.cartesia_key, "CARTESIA_VOICE_ID": self.voice_id,
                  "DEEPGRAM_API_KEY": self.deepgram_key, "GROQ_API_KEY": self.groq_key,
                  "DEMO_ACCESS_CODE": self.access_code, "CALLS_INGEST_TOKEN": self.ingest_token}
        return [name for name, value in values.items() if not value]
