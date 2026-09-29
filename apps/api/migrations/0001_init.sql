-- One finalized call and its ordered transcript/latency observations.
CREATE TABLE calls (
  id TEXT PRIMARY KEY NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL CHECK (ended_at >= started_at),
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 300000),
  status TEXT NOT NULL CHECK (status IN ('completed', 'disconnected', 'failed')),
  end_reason TEXT NOT NULL CHECK (length(end_reason) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at TEXT NOT NULL
);
CREATE INDEX calls_started_id ON calls(started_at DESC, id DESC);
CREATE TABLE transcripts (
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 0 AND 49),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  timestamp TEXT NOT NULL,
  interrupted INTEGER NOT NULL CHECK (interrupted IN (0, 1)),
  PRIMARY KEY (call_id, sequence)
);
CREATE TABLE call_metrics (
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 0 AND 199),
  turn_sequence INTEGER,
  stage TEXT NOT NULL CHECK (stage IN ('stt', 'llm', 'tts')),
  metric_name TEXT NOT NULL CHECK (metric_name IN ('ttfb', 'processing', 'time_to_first_audio', 'time_to_first_answer_token', 'stt_finalization', 'response_latency')),
  value_ms REAL NOT NULL CHECK (value_ms BETWEEN 0 AND 300000),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  measurement_source TEXT NOT NULL CHECK (length(measurement_source) BETWEEN 1 AND 120),
  PRIMARY KEY (call_id, sequence),
  FOREIGN KEY (call_id, turn_sequence) REFERENCES transcripts(call_id, sequence)
);
