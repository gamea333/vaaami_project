"""Freeze a validated Phase 3 payload after media cleanup; never regenerate on retry."""
import json
import math
import re
from datetime import datetime, timezone
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

def utc(value):
    if not isinstance(value, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)", value):
        raise ValueError("Expected an ISO UTC timestamp")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat(timespec="milliseconds").replace("+00:00", "Z")

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

class Transcript(StrictModel):
    sequence: int = Field(ge=0, le=49)
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=2000)
    timestamp: str
    interrupted: bool
    _timestamp = field_validator("timestamp")(utc)

class Metric(StrictModel):
    sequence: int = Field(ge=0, le=199)
    turnSequence: int | None
    stage: Literal["stt", "llm", "tts"]
    metricName: Literal["ttfb", "processing", "time_to_first_audio", "time_to_first_answer_token", "stt_finalization", "response_latency"]
    valueMs: float = Field(ge=0, le=300000, allow_inf_nan=False)
    provider: str = Field(min_length=1, max_length=64)
    measurementSource: str = Field(min_length=1, max_length=120)

class CallPayload(StrictModel):
    id: str = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    startedAt: str
    endedAt: str
    durationMs: int = Field(ge=0, le=300000)
    status: Literal["completed", "disconnected", "failed"]
    endReason: str = Field(min_length=1, max_length=200)
    transcripts: list[Transcript] = Field(max_length=50)
    metrics: list[Metric] = Field(max_length=200)
    _timestamps = field_validator("startedAt", "endedAt")(utc)

    @model_validator(mode="after")
    def coherent(self):
        wall_ms = (datetime.fromisoformat(self.endedAt.replace("Z", "+00:00")) -
                   datetime.fromisoformat(self.startedAt.replace("Z", "+00:00"))).total_seconds() * 1000
        if not 0 <= wall_ms <= 300000 or abs(wall_ms - self.durationMs) > 2000:
            raise ValueError("Incoherent call timing")
        if not self.endReason.strip():
            raise ValueError("Empty end reason")
        for index, turn in enumerate(self.transcripts):
            if turn.sequence != index or not turn.text.strip() or not self.startedAt <= turn.timestamp <= self.endedAt:
                raise ValueError("Invalid transcript order, text or timing")
        for index, metric in enumerate(self.metrics):
            if (metric.sequence != index or not metric.provider.strip() or not metric.measurementSource.strip()
                    or (metric.turnSequence is not None and not 0 <= metric.turnSequence < len(self.transcripts))):
                raise ValueError("Invalid metric reference or sequence")
        return self

def latency_metrics(raw):
    """Only observed latency data; token/audio usage is not a latency measurement."""
    fields = {
        "TTFBMetricsData": ("ttfb", "value"),
        "ProcessingMetricsData": ("processing", "value"),
        "TTFAMetricsData": ("time_to_first_audio", "ttfa"),
        "TTFATMetricsData": ("time_to_first_answer_token", "ttfat"),
    }
    providers = {"DeepgramSTTService": ("stt", "deepgram"),
                 "BoundedGroq": ("llm", "groq"), "BoundedCartesia": ("tts", "cartesia")}
    result = []
    for item in raw:
        source = item.get("type")
        processor = item.get("processor", "").split("#")[0]
        if source not in fields or processor not in providers:
            continue
        name, key = fields[source]
        value = item.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 300:
            continue
        stage, provider = providers[processor]
        result.append({"sequence": len(result), "turnSequence": None, "stage": stage,
            "metricName": name, "valueMs": round(value * 1000, 3),
            "provider": provider, "measurementSource": "pipecat." + source})
    return result[:200]

def freeze_call(session):
    payload = CallPayload.model_validate({
        "id": session.id, "startedAt": session.started_at, "endedAt": session.ended_at,
        "durationMs": session.duration_ms,
        "status": "failed" if session.error else "disconnected" if session.reason == "Browser disconnected." else "completed",
        "endReason": session.reason or "Call ended.",
        "transcripts": [{"sequence": index, **turn} for index, turn in enumerate(session.transcript)],
        "metrics": latency_metrics(session.metrics),
    })
    frozen = payload.model_dump_json()
    if len(frozen.encode("utf-8")) > 128 * 1024:
        raise ValueError("Final call exceeds the upload byte limit")
    return frozen
