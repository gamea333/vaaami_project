import { ApiError, type CallPayload } from "./validation";

const summaryColumns = `id, started_at AS startedAt, ended_at AS endedAt,
  duration_ms AS durationMs, status, end_reason AS endReason, created_at AS createdAt`;

export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function existing(db: D1Database, id: string, hash: string) {
  const row = await db.prepare("SELECT payload_hash FROM calls WHERE id = ?").bind(id).first<{ payload_hash: string }>();
  if (!row) return false;
  if (row.payload_hash !== hash) throw new ApiError(409, "CALL_CONFLICT", "This call ID already has different content.");
  return true;
}
function childInserts(db: D1Database, table: string, columns: string[], rows: (string | number | null)[][]) {
  const statements: D1PreparedStatement[] = [];
  // Table and column identifiers are internal constants, never request data.
  // Ten rows => at most 80 bound values, below D1's 100-parameter limit.
  for (let start = 0; start < rows.length; start += 10) {
    const chunk = rows.slice(start, start + 10);
    const placeholders = chunk.map(() => "(" + columns.map(() => "?").join(",") + ")").join(",");
    statements.push(db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}`).bind(...chunk.flat()));
  }
  return statements;
}
export async function saveCall(db: D1Database, call: CallPayload) {
  const hash = await hashText(JSON.stringify(call));
  if (await existing(db, call.id, hash)) return { id: call.id, duplicate: true };
  const statements = [
    db.prepare(`INSERT INTO calls (id, started_at, ended_at, duration_ms, status, end_reason, payload_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(call.id, call.startedAt, call.endedAt,
      call.durationMs, call.status, call.endReason, hash, new Date().toISOString()),
    ...childInserts(db, "transcripts", ["call_id", "sequence", "role", "text", "timestamp", "interrupted"],
      call.transcripts.map(turn => [call.id, turn.sequence, turn.role, turn.text, turn.timestamp, Number(turn.interrupted)])),
    ...childInserts(db, "call_metrics", ["call_id", "sequence", "turn_sequence", "stage", "metric_name", "value_ms", "provider", "measurement_source"],
      call.metrics.map(metric => [call.id, metric.sequence, metric.turnSequence, metric.stage, metric.metricName, metric.valueMs, metric.provider, metric.measurementSource])),
  ];
  try {
    // D1 batch is transactional: a failed child insert rolls back the parent too.
    await db.batch(statements);
  } catch (error) {
    // A competing request may have committed between our read and insert.
    // Re-read the winner; never overwrite it and never treat arbitrary failures as success.
    if (await existing(db, call.id, hash)) return { id: call.id, duplicate: true };
    throw error;
  }
  return { id: call.id, duplicate: false };
}
export async function listCalls(db: D1Database, limit: number, offset: number) {
  const rows = await db.prepare(`SELECT ${summaryColumns} FROM calls
    ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`).bind(limit + 1, offset).all();
  return { items: rows.results.slice(0, limit), hasMore: rows.results.length > limit };
}
export async function getCall(db: D1Database, id: string) {
  const [calls, transcripts, metrics] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT ${summaryColumns} FROM calls WHERE id = ?`).bind(id),
    db.prepare(`SELECT sequence, role, text, timestamp, interrupted FROM transcripts
      WHERE call_id = ? ORDER BY sequence ASC`).bind(id),
    db.prepare(`SELECT sequence, turn_sequence AS turnSequence, stage, metric_name AS metricName,
      value_ms AS valueMs, provider, measurement_source AS measurementSource FROM call_metrics
      WHERE call_id = ? ORDER BY sequence ASC`).bind(id),
  ]);
  if (!calls.results.length) throw new ApiError(404, "CALL_NOT_FOUND", "Call not found.");
  return { call: calls.results[0],
    transcripts: transcripts.results.map(turn => ({ ...turn, interrupted: Boolean(turn.interrupted) })),
    metrics: metrics.results };
}
