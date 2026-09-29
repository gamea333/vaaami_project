export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export interface Transcript {
  sequence: number; role: "user" | "assistant"; text: string; timestamp: string; interrupted: boolean;
}
export interface Metric {
  sequence: number; turnSequence: number | null; stage: "stt" | "llm" | "tts";
  metricName: string; valueMs: number; provider: string; measurementSource: string;
}
export interface CallPayload {
  id: string; startedAt: string; endedAt: string; durationMs: number;
  status: "completed" | "disconnected" | "failed"; endReason: string;
  transcripts: Transcript[]; metrics: Metric[];
}
function invalid(message: string): never { throw new ApiError(400, "INVALID_CALL", message); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected a JSON object.");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !keys.includes(key))) invalid("Unexpected field in call payload.");
  if (keys.some(key => !(key in item))) invalid("Required field is missing.");
  return item;
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid(name + " is invalid.");
  return value;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    invalid(name + " is out of range.");
  return value;
}
function choice<T extends string>(value: unknown, name: string, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) invalid(name + " is invalid.");
  return value as T;
}
export function callId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new ApiError(400, "INVALID_ID", "Call ID must be a UUID.");
  return value.toLowerCase();
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value))
    invalid("Timestamps must be ISO 8601 UTC.");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) invalid("Invalid timestamp.");
  const canonical = date.toISOString();
  if (canonical.slice(0, 19) !== value.slice(0, 19)) invalid("Invalid calendar timestamp.");
  return canonical;
}
export function validateCall(value: unknown): CallPayload {
  const item = object(value, ["id", "startedAt", "endedAt", "durationMs", "status", "endReason", "transcripts", "metrics"]);
  const startedAt = timestamp(item.startedAt), endedAt = timestamp(item.endedAt);
  const wallDuration = Date.parse(endedAt) - Date.parse(startedAt);
  const durationMs = integer(item.durationMs, "durationMs", 0, 300000);
  if (wallDuration < 0 || wallDuration > 300000 || Math.abs(wallDuration - durationMs) > 2000)
    invalid("Duration and timestamps must describe the same call, within two seconds.");
  if (!Array.isArray(item.transcripts) || item.transcripts.length > 50) invalid("At most 50 transcript turns are allowed.");
  if (!Array.isArray(item.metrics) || item.metrics.length > 200) invalid("At most 200 metrics are allowed.");
  const transcripts: Transcript[] = item.transcripts.map((value, index) => {
    const turn = object(value, ["sequence", "role", "text", "timestamp", "interrupted"]);
    const at = timestamp(turn.timestamp);
    if (at < startedAt || at > endedAt) invalid("Transcript timestamp is outside the call.");
    if (typeof turn.interrupted !== "boolean") invalid("interrupted must be a boolean.");
    return {
      sequence: integer(turn.sequence, "Transcript sequence", index, index),
      role: choice(turn.role, "role", ["user", "assistant"] as const),
      text: text(turn.text, "Transcript text", 2000), timestamp: at, interrupted: turn.interrupted,
    };
  });
  const metrics: Metric[] = item.metrics.map((value, index) => {
    const metric = object(value, ["sequence", "turnSequence", "stage", "metricName", "valueMs", "provider", "measurementSource"]);
    if (typeof metric.valueMs !== "number" || !Number.isFinite(metric.valueMs) || metric.valueMs < 0 || metric.valueMs > 300000)
      invalid("Metric valueMs must be finite and between 0 and 300000.");
    return {
      sequence: integer(metric.sequence, "Metric sequence", index, index),
      turnSequence: metric.turnSequence === null ? null : integer(metric.turnSequence, "turnSequence", 0, transcripts.length - 1),
      stage: choice(metric.stage, "stage", ["stt", "llm", "tts"] as const),
      metricName: choice(metric.metricName, "metricName", ["ttfb", "processing", "time_to_first_audio", "time_to_first_answer_token", "stt_finalization", "response_latency"]),
      valueMs: metric.valueMs, provider: text(metric.provider, "provider", 64),
      measurementSource: text(metric.measurementSource, "measurementSource", 120),
    };
  });
  // Construct properties in a fixed order: equivalent accepted JSON hashes identically.
  return { id: callId(item.id), startedAt, endedAt, durationMs,
    status: choice(item.status, "status", ["completed", "disconnected", "failed"] as const),
    endReason: text(item.endReason, "endReason", 200), transcripts, metrics };
}
export function pagination(url: URL) {
  const parse = (name: string, fallback: number, min: number, max: number) => {
    const values = url.searchParams.getAll(name);
    if (values.length === 0) return fallback;
    if (values.length !== 1 || !/^\d+$/.test(values[0])) throw new ApiError(400, "INVALID_PAGINATION", "Invalid " + name);
    const result = Number(values[0]);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new ApiError(400, "INVALID_PAGINATION", "Invalid " + name);
    return result;
  };
  return { limit: parse("limit", 20, 1, 100), offset: parse("offset", 0, 0, 1000000) };
}
export async function readJson(request: Request): Promise<unknown> {
  const maxBytes = 128 * 1024;
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Use Content-Type: application/json.");
  if (Number(request.headers.get("Content-Length")) > maxBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Maximum body size is 128 KiB.");
  if (!request.body) invalid("JSON body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Maximum body size is 128 KiB.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { invalid("Body must contain valid UTF-8 JSON."); }
}
