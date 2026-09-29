// Seed one invented call locally, then verify an idempotent retry and read-back.
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import assert from "node:assert/strict";

const env = parseEnv(await readFile(new URL("../.dev.vars", import.meta.url), "utf8"));
if (!env.CALLS_INGEST_TOKEN) throw new Error("Set CALLS_INGEST_TOKEN in apps/api/.dev.vars.");
const payload = JSON.parse(await readFile(new URL("../../../packages/contracts/call.example.json", import.meta.url), "utf8"));
const base = env.LOCAL_API_BASE_URL || "http://127.0.0.1:8787";
async function save() {
  return fetch(base + "/calls", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.CALLS_INGEST_TOKEN },
    body: JSON.stringify(payload) });
}
const first = await save();
assert.ok([200, 201].includes(first.status), "Sample save failed: HTTP " + first.status);
const retry = await save();
assert.equal(retry.status, 200);
assert.equal((await retry.json()).duplicate, true);
const response = await fetch(base + "/calls/" + payload.id);
assert.equal(response.status, 200);
const detail = await response.json();
assert.deepEqual(detail.transcripts, payload.transcripts);
assert.deepEqual(detail.metrics, payload.metrics);
console.log("Sample save, duplicate retry, and read-back passed.");
console.log("View the sample: " + base + "/calls/" + payload.id);
