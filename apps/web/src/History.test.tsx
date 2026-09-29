// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallHistory, CallDetails } from "./History";
import { parseRoute, duration } from "./lib/api";

const id = "4bfa6c22-5c9d-41e1-a1b3-76a8ebc9a613";
const call = { id, startedAt: "2026-09-29T10:00:00.000Z", endedAt: "2026-09-29T10:00:23.000Z", durationMs: 23000, status: "completed", endReason: "user_ended", createdAt: "2026-09-29T10:00:24.000Z" };
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe("saved conversation screens", () => {
  it("shows loading, then a detail link and pagination", async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise(r => { resolve = r; }));
    await act(async () => root.render(<CallHistory page={0} />));
    expect(container.textContent).toContain("Loading calls");
    await act(async () => resolve(reply({ items: [call], hasMore: true })));
    expect(container.querySelector(`a[href='#/calls/${id}']`)).not.toBeNull();
    expect(container.textContent).toContain("0:23");
    expect(container.querySelector("a[href='#/calls?page=1']")).not.toBeNull();
  });
  it("shows empty state without inventing records", async () => {
    fetchMock.mockResolvedValue(reply({ items: [], hasMore: false }));
    await act(async () => root.render(<CallHistory page={0} />));
    expect(container.textContent).toContain("No saved calls yet");
    expect(container.querySelector(".call-link")).toBeNull();
  });
  it("retries an offline request", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(reply({ items: [call], hasMore: false }));
    await act(async () => root.render(<CallHistory page={0} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Cannot reach");
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(container.textContent).toContain(id);
  });
  it("handles a missing call", async () => {
    fetchMock.mockResolvedValue(reply({}, 404));
    await act(async () => root.render(<CallDetails id={id} />));
    expect(container.textContent).toContain("Call not found");
  });
  it("orders transcripts, labels interruptions and shows missing metrics honestly", async () => {
    fetchMock.mockResolvedValue(reply({ call, transcripts: [
      { sequence: 2, role: "assistant", text: "Second response", timestamp: call.startedAt, interrupted: true },
      { sequence: 1, role: "user", text: "First question", timestamp: call.startedAt, interrupted: false }
    ], metrics: [{ sequence: 0, turnSequence: null, stage: "tts", metricName: "ttfb", valueMs: 145.5, provider: "Cartesia", measurementSource: "test" }] }));
    await act(async () => root.render(<CallDetails id={id} />));
    expect(container.querySelector(".turn")?.textContent).toContain("First question");
    expect(container.textContent).toContain("Interrupted");
    expect(container.textContent).toContain("145.5 ms");
    expect(container.textContent?.match(/Not captured/g)).toHaveLength(2);
  });
  it("ignores an old page response after navigation", async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValue(reply({ items: [], hasMore: false }));
    await act(async () => root.render(<CallHistory page={0} />));
    await act(async () => root.render(<CallHistory page={1} />));
    await act(async () => resolve(reply({ items: [call], hasMore: true })));
    expect(container.textContent).toContain("No calls on this page");
    expect(container.textContent).not.toContain(id);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
it("parses refreshable routes and rejects invalid page values", () => {
  expect(parseRoute(`#/calls/${id}`)).toEqual({ kind: "detail", id });
  expect(parseRoute("#/calls?page=2")).toEqual({ kind: "list", page: 2 });
  expect(parseRoute("#/calls?page=-1")).toEqual({ kind: "missing" });
  expect(parseRoute("#/calls/invalid")).toEqual({ kind: "missing" });
  expect(duration(125999)).toBe("2:05");
});
