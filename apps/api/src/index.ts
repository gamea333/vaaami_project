import { ApiError, callId, pagination, readJson, validateCall } from "./validation";
import { getCall, hashText, listCalls, saveCall } from "./db";

interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS: string;
  CALLS_INGEST_TOKEN?: string;
}
async function authorize(request: Request, secret: string | undefined) {
  if (!secret) throw new ApiError(503, "INGEST_NOT_CONFIGURED", "Call ingestion is not configured.");
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Compare fixed-length hashes without short-circuiting on individual characters.
  const [actual, expected] = await Promise.all([hashText(token), hashText(secret)]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  if (!token || difference !== 0) throw new ApiError(401, "UNAUTHORIZED", "A valid bot ingestion token is required.");
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = Date.now(), requestId = crypto.randomUUID();
    const url = new URL(request.url), origin = request.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim());
    const headers = new Headers({ "Vary": "Origin", "Cache-Control": "no-store", "X-Request-ID": requestId });
    if (origin && allowed.includes(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      headers.set("Access-Control-Expose-Headers", "X-Request-ID");
    }
    let status = 500;
    let code: string | undefined;
    let loggedCallId: string | undefined;
    const json = (body: unknown, responseStatus = 200) => {
      status = responseStatus;
      return Response.json(body, { status, headers });
    };
    try {
      if (request.method === "OPTIONS") {
        if (origin && !allowed.includes(origin)) throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Origin is not allowed.");
        status = 204;
        return new Response(null, { status, headers });
      }
      if (url.pathname === "/health" && request.method === "GET")
        return json({ status: "ok", service: "vaami-api" });
      if (url.pathname === "/calls") {
        if (request.method === "POST") {
          await authorize(request, env.CALLS_INGEST_TOKEN);
          const payload = validateCall(await readJson(request));
          loggedCallId = payload.id;
          const result = await saveCall(env.DB, payload);
          return json(result, result.duplicate ? 200 : 201);
        }
        if (request.method === "GET") {
          const { limit, offset } = pagination(url);
          return json(await listCalls(env.DB, limit, offset));
        }
        headers.set("Allow", "GET, POST, OPTIONS");
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      }
      const detail = /^\/calls\/([^/]+)$/.exec(url.pathname);
      if (detail) {
        if (request.method !== "GET") {
          headers.set("Allow", "GET, OPTIONS");
          throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
        }
        loggedCallId = callId(detail[1]);
        return json(await getCall(env.DB, loggedCallId));
      }
      throw new ApiError(404, "NOT_FOUND", "Route not found.");
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(500, "STORAGE_ERROR", "The call service could not complete this request.");
      code = failure.code;
      return json({ error: { code, message: failure.message }, requestId }, failure.status);
    } finally {
      // Never log credentials, request bodies, transcripts, or raw SQL exceptions.
      console.log(JSON.stringify({ requestId, method: request.method,
        route: url.pathname.startsWith("/calls/") ? "/calls/:id" : url.pathname === "/calls" ? "/calls" : "/other",
        status, code, callId: loggedCallId, elapsedMs: Date.now() - started }));
    }
  },
};
