// Read-only checks. Never starts a voice call or writes sample data in CI.
import assert from "node:assert/strict";
const api = process.env.VITE_API_BASE_URL?.replace(/\/$/, "");
const pages = process.env.PAGES_URL;
if (!api || !pages) throw new Error("Set VITE_API_BASE_URL and PAGES_URL.");
async function check() {
  const health = await fetch(`${api}/health`, { signal: AbortSignal.timeout(15000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, "vaami-api");
  const list = await fetch(`${api}/calls?limit=1`, { headers: { Origin: new URL(pages).origin }, signal: AbortSignal.timeout(15000) });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("access-control-allow-origin"), new URL(pages).origin);
  const body = await list.json();
  assert.ok(Array.isArray(body.items));
  assert.equal(typeof body.hasMore, "boolean");
  const web = await fetch(pages, { signal: AbortSignal.timeout(15000) });
  assert.equal(web.status, 200);
  assert.match(await web.text(), /<div id="root"><\/div>/);
}
for (let attempt = 1; attempt <= 5; attempt++) {
  try { await check(); console.log("Production API, D1 list, CORS and Pages respond correctly."); break; }
  catch (error) { if (attempt === 5) throw error; await new Promise(resolve => setTimeout(resolve, 5000)); }
}
