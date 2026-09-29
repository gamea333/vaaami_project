import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";

let mf, db;
const token = "test-only-ingestion-secret";
const sample = JSON.parse(await readFile(new URL("../../../packages/contracts/call.example.json", import.meta.url), "utf8"));
const fixture = () => structuredClone(sample);
const origin = "http://localhost:5173";
const send = (payload, headers = {}) => mf.dispatchFetch("http://worker/calls", {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, ...headers },
  body: JSON.stringify(payload),
});
const get = path => mf.dispatchFetch("http://worker" + path);
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
    compatibilityDate: "2026-09-28",
    d1Databases: { DB: "test-calls" },
    bindings: { CALLS_INGEST_TOKEN: token, ALLOWED_ORIGINS: origin },
    log: new Log(LogLevel.ERROR),
  }));
  db = await mf.getD1Database("DB");
  const migration = await readFile(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
  for (const sql of migration.split(";").map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => { await db.prepare("DELETE FROM calls").run(); });

test("saves and retrieves ordered transcript and millisecond metrics", async () => {
  const payload = fixture();
  const response = await send(payload);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: payload.id, duplicate: false });
  const result = await (await get("/calls/" + payload.id)).json();
  assert.deepEqual(result.transcripts, payload.transcripts);
  assert.deepEqual(result.metrics, payload.metrics);
  assert.equal(result.call.durationMs, 20000);
  assert.equal(result.call.status, "completed");
  assert.ok(result.call.createdAt);
  assert.equal(result.call.payload_hash, undefined);
});

test("normalized retries are idempotent and conflicting content never overwrites", async () => {
  const payload = fixture();
  assert.equal((await send(payload)).status, 201);
  const normalized = Object.fromEntries(Object.entries(payload).reverse());
  normalized.startedAt = "2026-09-28T12:00:00+00:00";
  normalized.id = normalized.id.toUpperCase();
  const retry = await send(normalized);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  payload.transcripts[0].text = "different";
  assert.equal((await send(payload)).status, 409);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM calls").first()).count, 1);
  assert.equal((await (await get("/calls/" + payload.id)).json()).transcripts[0].text, "Hello");
});

test("simultaneous duplicate saves produce one call and one set of children", async () => {
  const responses = await Promise.all(Array.from({ length: 6 }, () => send(fixture())));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 200).length, 5);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM transcripts").first()).count, 2);
});

test("simultaneous conflicting saves have exactly one winner", async () => {
  const one = fixture(), two = fixture();
  two.transcripts[0].text = "changed";
  const responses = await Promise.all([send(one), send(two)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
});

test("a child insert failure rolls back the whole D1 batch", async () => {
  await db.prepare("CREATE TRIGGER fail_metric BEFORE INSERT ON call_metrics BEGIN SELECT RAISE(ABORT, 'test failure'); END").run();
  try {
    const response = await send(fixture());
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, "STORAGE_ERROR");
    assert.ok(body.requestId);
    assert.ok(!JSON.stringify(body).includes("test failure"));
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM calls").first()).count, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM transcripts").first()).count, 0);
  } finally { await db.prepare("DROP TRIGGER fail_metric").run(); }
  assert.equal((await send(fixture())).status, 201);
});

test("rejects unauthorized writes before touching D1", async () => {
  for (const authorization of ["", "Bearer wrong"]) {
    assert.equal((await send(fixture(), { Authorization: authorization })).status, 401);
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM calls").first()).count, 0);
});

test("validation rejects malformed fields, sequences, dates, and dangling metric references", async () => {
  const mutate = [
    p => { p.status = "active"; },
    p => { p.durationMs = -1; },
    p => { p.durationMs = 0; },
    p => { p.startedAt = "2026-02-30T12:00:00.000Z"; },
    p => { p.endedAt = "invalid"; },
    p => { p.transcripts[0].sequence = 1; },
    p => { p.transcripts[1].sequence = 0; },
    p => { p.transcripts[0].role = "system"; },
    p => { p.transcripts[0].text = " "; },
    p => { p.transcripts[0].timestamp = "2026-09-28T13:00:00.000Z"; },
    p => { p.transcripts[0].interrupted = "false"; },
    p => { p.metrics[0].turnSequence = 99; },
    p => { p.metrics[0].valueMs = -1; },
    p => { p.metrics[0].valueMs = "NaN"; },
    p => { p.metrics[0].metricName = "tokens"; },
    p => { p.unexpected = true; },
  ];
  for (const change of mutate) {
    const p = fixture(); change(p);
    assert.equal((await send(p)).status, 400);
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM calls").first()).count, 0);
});

test("SQL-like transcript text is stored literally", async () => {
  const payload = fixture();
  payload.transcripts[0].text = "'); DROP TABLE calls; --";
  assert.equal((await send(payload)).status, 201);
  assert.equal((await (await get("/calls/" + payload.id)).json()).transcripts[0].text, payload.transcripts[0].text);
});

test("maximum collection sizes work within D1 query and parameter limits", async () => {
  const p = fixture();
  p.transcripts = Array.from({ length: 50 }, (_, sequence) => ({ ...sample.transcripts[0], sequence }));
  p.metrics = Array.from({ length: 200 }, (_, sequence) => ({ ...sample.metrics[0], sequence, turnSequence: sequence % 50 }));
  assert.equal((await send(p)).status, 201);
  const detail = await (await get("/calls/" + p.id)).json();
  assert.equal(detail.transcripts.length, 50);
  assert.equal(detail.metrics.length, 200);
});

test("empty transcript and metrics are valid, not invented zero-latency samples", async () => {
  const p = fixture(); p.transcripts = []; p.metrics = [];
  assert.equal((await send(p)).status, 201);
  const detail = await (await get("/calls/" + p.id)).json();
  assert.deepEqual(detail.metrics, []);
  assert.deepEqual(detail.transcripts, []);
});

test("pagination is deterministic for tied timestamps and rejects invalid numbers", async () => {
  for (const suffix of ["1", "2", "3"]) {
    const p = fixture(); p.id = "00000000-0000-4000-8000-00000000000" + suffix;
    assert.equal((await send(p)).status, 201);
  }
  const page = await (await get("/calls?limit=2")).json();
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.items.map(p => p.id.at(-1)), ["3", "2"]);
  const next = await (await get("/calls?limit=2&offset=2")).json();
  assert.equal(next.hasMore, false);
  assert.equal(next.items[0].id.at(-1), "1");
  for (const query of ["limit=0", "limit=101", "offset=-1", "limit=x", "offset=1.5", "limit=2&limit=3"])
    assert.equal((await get("/calls?" + query)).status, 400);
});

test("missing calls, invalid IDs, methods and CORS have consistent responses", async () => {
  assert.equal((await get("/calls/" + sample.id)).status, 404);
  assert.equal((await get("/calls/not-a-uuid")).status, 400);
  const badMethod = await mf.dispatchFetch("http://worker/calls", { method: "DELETE" });
  assert.equal(badMethod.status, 405);
  assert.equal(badMethod.headers.get("Allow"), "GET, POST, OPTIONS");
  const response = await mf.dispatchFetch("http://worker/calls", { headers: { Origin: origin } });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.ok(response.headers.get("X-Request-ID"));
  const denied = await mf.dispatchFetch("http://worker/calls", { method: "OPTIONS", headers: { Origin: "https://other.example" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  const allowed = await mf.dispatchFetch("http://worker/calls", { method: "OPTIONS", headers: { Origin: origin } });
  assert.equal(allowed.status, 204);
  assert.match(allowed.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("malformed JSON, unsupported content types and oversized bodies are rejected", async () => {
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  assert.equal((await mf.dispatchFetch("http://worker/calls", { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await send(fixture(), { "Content-Type": "text/plain" })).status, 415);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(128 * 1024 + 1)));
      controller.close();
    },
  });
  const response = await mf.dispatchFetch("http://worker/calls", { method: "POST", headers, body: stream, duplex: "half" });
  assert.equal(response.status, 413);
});
