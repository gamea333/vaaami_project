export type CallRecord = { id: string; startedAt: string; endedAt: string; durationMs: number; status: string; endReason: string; createdAt: string };
export type CallList = { items: CallRecord[]; hasMore: boolean };
export type CallDetail = {
  call: CallRecord;
  transcripts: { sequence: number; role: "user" | "assistant"; text: string; timestamp: string; interrupted: boolean }[];
  metrics: { sequence: number; turnSequence: number | null; stage: string; metricName: string; valueMs: number; provider: string; measurementSource: string }[];
};
const base = (import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function readApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), cache: "no-store" });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError("Cannot reach call history. Check that the Worker is running and VITE_API_BASE_URL is correct, then retry.", 0);
  }
  if (!response.ok) throw new ApiError(response.status === 404 ? "Call not found. It may not have been saved in this database." : `Call history returned HTTP ${response.status}. Please retry.`, response.status);
  return response.json();
}
export const listCalls = (page: number, signal?: AbortSignal) => readApi<CallList>(`/calls?limit=20&offset=${page * 20}`, signal);
export const getCallDetail = (id: string, signal?: AbortSignal) => readApi<CallDetail>(`/calls/${encodeURIComponent(id)}`, signal);
export async function checkApiHealth(): Promise<void> { await readApi("/health"); }
export function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export const dateTime = (value: string) => new Date(value).toLocaleString();
export type Route = { kind: "call" } | { kind: "list"; page: number } | { kind: "detail"; id: string } | { kind: "missing" };
export function parseRoute(hash: string): Route {
  if (!hash || hash === "#/" || hash === "#/call") return { kind: "call" };
  const [path, query] = hash.slice(1).split("?");
  if (path === "/calls") {
    const page = Number(new URLSearchParams(query).get("page") ?? 0);
    return Number.isInteger(page) && page >= 0 && page <= 50000 ? { kind: "list", page } : { kind: "missing" };
  }
  const match = /^\/calls\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
  return match ? { kind: "detail", id: match[1] } : { kind: "missing" };
}
