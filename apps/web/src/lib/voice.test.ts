import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  onTrackStarted: undefined as ((track: MediaStreamTrack, participant?: { local: boolean }) => void) | undefined,
  ready: undefined as (() => void) | undefined,
  trackStop: vi.fn(),
  disconnect: vi.fn(async () => {}),
  tracks: vi.fn(),
  microphone: vi.fn(),
  probeStop: vi.fn(),
}));
vi.mock("@pipecat-ai/small-webrtc-transport", () => ({ SmallWebRTCTransport: class {} }));
vi.mock("@pipecat-ai/client-js", () => ({
  PipecatClient: class {
    constructor(options: { callbacks: { onTrackStarted: typeof sdk.onTrackStarted } }) {
      sdk.onTrackStarted = options.callbacks.onTrackStarted;
    }
    tracks() { return sdk.tracks(); }
    disconnect() { return sdk.disconnect(); }
    on(_event: string, callback: () => void) { sdk.ready = callback; }
    off() { sdk.ready = undefined; }
    async connect() { sdk.ready?.(); }
  },
}));
import { VoiceCall } from "./voice";

function setup() {
  const audio = { pause: vi.fn(), srcObject: null } as unknown as HTMLAudioElement;
  const callbacks = { onReady: vi.fn(), onEnded: vi.fn(), onPlaybackBlocked: vi.fn() };
  return { call: new VoiceCall(audio, callbacks), callbacks };
}
beforeEach(() => {
  vi.clearAllMocks();
  const track = { readyState: "live", stop: sdk.probeStop };
  sdk.microphone.mockReset().mockResolvedValue({ getAudioTracks: () => [track], getTracks: () => [track] });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: sdk.microphone } });
  sdk.tracks.mockImplementation(() => ({ local: { audio: { stop: sdk.trackStop } } }));
});
afterEach(() => vi.unstubAllGlobals());

it("shows authorization failure even if tracks are unavailable before connect", async () => {
  sdk.tracks.mockImplementation(() => { throw new Error("not initialized"); });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ detail: "Wrong demo code" }, { status: 401 })));
  const { call, callbacks } = setup();
  await call.start("wrong");
  expect(callbacks.onEnded.mock.calls[0][0]).toContain("Demo access code does not match");
  expect(sdk.disconnect).not.toHaveBeenCalled();
  expect(callbacks.onReady).not.toHaveBeenCalled();
});

it("releases microphone and ends the session once on repeated stop", async () => {
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) =>
    Response.json(options.method === "POST" && _url.endsWith("/sessions")
      ? { id: "call-1", controlToken: "control" }
      : { status: "ended" }));
  vi.stubGlobal("fetch", fetchMock);
  const { call, callbacks } = setup();
  await call.start("demo");
  expect(callbacks.onReady).toHaveBeenCalledOnce();
  await call.stop();
  await call.stop();
  expect(sdk.trackStop).toHaveBeenCalledOnce();
  expect(sdk.disconnect).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/end"))).toHaveLength(1);
});

it("can retry a failed start with the same controller", async () => {
  let attempt = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/sessions")) {
      attempt++;
      if (attempt === 1) return Response.json({ detail: "Wrong code" }, { status: 401 });
      return Response.json({ id: "retry", controlToken: "control" });
    }
    return Response.json({ status: "ended" });
  }));
  const { call, callbacks } = setup();
  await call.start("wrong");
  await call.start("right");
  expect(callbacks.onReady).toHaveBeenCalledOnce();
  await call.stop();
});

it("reports failed server cleanup instead of claiming it was confirmed", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/end")) throw new Error("offline");
    return Response.json({ id: "call", controlToken: "control" });
  }));
  const { call, callbacks } = setup();
  await call.start("demo");
  await call.stop();
  expect(callbacks.onEnded.mock.calls[0][0]).toContain("cleanup could not be confirmed");
});



it("shows usage cutoff reason and the final temporary transcript", async () => {
  vi.useFakeTimers();
  const snapshot = {
    status: "ended", reason: "Speech character limit reached.",
    transcript: [{ role: "user", text: "Hello", timestamp: "now", interrupted: false }],
    usage: { replies: 1, ttsCharactersReserved: 42 },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
    url.endsWith("/sessions") ? { id: "call", controlToken: "control" } : snapshot)));
  const onSnapshot = vi.fn();
  const onEnded = vi.fn();
  const audio = { pause: vi.fn(), srcObject: null } as unknown as HTMLAudioElement;
  const call = new VoiceCall(audio, {
    onReady: vi.fn(), onEnded, onSnapshot, onPlaybackBlocked: vi.fn(),
  });
  try {
    await call.start("demo");
    await vi.advanceTimersByTimeAsync(2000);
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(onEnded).toHaveBeenCalledWith("Speech character limit reached.");
    expect(sdk.trackStop).toHaveBeenCalledOnce();
  } finally {
    await call.stop();
    vi.useRealTimers();
  }
});


function playbackSetup() {
  vi.stubGlobal("MediaStream", class {
    constructor(public tracks: MediaStreamTrack[]) {}
  });
  const audio = { pause: vi.fn(), play: vi.fn(async () => {}), srcObject: null };
  const callbacks = { onReady: vi.fn(), onEnded: vi.fn(), onPlaybackBlocked: vi.fn() };
  const call = new VoiceCall(audio as unknown as HTMLAudioElement, callbacks);
  return { audio, callbacks, call };
}

it.each([undefined, { local: false }])("plays remote audio with participant %j", async (participant) => {
  const { audio, call } = playbackSetup();
  const track = { kind: "audio" } as MediaStreamTrack;
  sdk.onTrackStarted?.(track, participant);
  expect(audio.srcObject).toEqual({ tracks: [track] });
  expect(audio.play).toHaveBeenCalledOnce();
  await call.stop();
  sdk.onTrackStarted?.(track, participant);
  expect(audio.srcObject).toBeNull();
  expect(audio.play).toHaveBeenCalledOnce();
});

it("does not play the local microphone or a video track", () => {
  const { audio } = playbackSetup();
  sdk.onTrackStarted?.({ kind: "audio" } as MediaStreamTrack, { local: true });
  sdk.onTrackStarted?.({ kind: "video" } as MediaStreamTrack);
  expect(audio.srcObject).toBeNull();
  expect(audio.play).not.toHaveBeenCalled();
});

it("shows the sound-enable fallback when remote audio autoplay is blocked", async () => {
  const { audio, callbacks } = playbackSetup();
  audio.play.mockRejectedValueOnce(new Error("autoplay blocked"));
  sdk.onTrackStarted?.({ kind: "audio" } as MediaStreamTrack);
  await Promise.resolve();
  expect(callbacks.onPlaybackBlocked).toHaveBeenCalledOnce();
});

it("releases audio while save polling continues and only reports verified saved state", async () => {
  vi.useFakeTimers();
  const snapshot = { id: "call", transcript: [], usage: { replies: 1, ttsCharactersReserved: 20 } };
  const onSnapshot = vi.fn();
  const onEnded = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
    url.endsWith("/sessions") ? { id: "call", controlToken: "control" } :
    { ...snapshot, saveStatus: url.endsWith("/end") ? "saving" : "saved", status: "ended" })));
  const audio = { pause: vi.fn(), srcObject: null } as unknown as HTMLAudioElement;
  const call = new VoiceCall(audio, { onReady: vi.fn(), onEnded, onSnapshot, onPlaybackBlocked: vi.fn() });
  try {
    await call.start("demo");
    await call.stop();
    expect(sdk.trackStop).toHaveBeenCalledOnce();
    expect(onEnded).toHaveBeenCalledOnce();
    expect(onSnapshot.mock.lastCall?.[0].saveStatus).toBe("saving");
    await vi.advanceTimersByTimeAsync(1000);
    expect(onSnapshot.mock.lastCall?.[0].saveStatus).toBe("saved");
  } finally { call.dispose(); vi.useRealTimers(); }
});

it("recovers a failed save after refresh and retries without opening microphone", async () => {
  const onSnapshot = vi.fn();
  const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/pending-saves")) return Response.json({ items: [{ id: "old", controlToken: "old-control" }] });
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer old-control");
    return Response.json({ id: "old", transcript: [], usage: { replies: 0, ttsCharactersReserved: 0 },
      saveStatus: url.endsWith("/retry-save") ? "saved" : "save_failed", canRetrySave: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  const audio = { pause: vi.fn(), srcObject: null } as unknown as HTMLAudioElement;
  const call = new VoiceCall(audio, { onReady: vi.fn(), onEnded: vi.fn(), onSnapshot, onPlaybackBlocked: vi.fn() });
  expect(await call.recoverSave("demo")).toBe(true);
  expect(onSnapshot.mock.lastCall?.[0].saveStatus).toBe("save_failed");
  await call.retrySave();
  expect(onSnapshot.mock.lastCall?.[0].saveStatus).toBe("saved");
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/offer") || url.endsWith("/sessions"))).toBe(false);
  call.dispose();
});

it("stops the microphone immediately but waits for intentional hangup acknowledgement before disconnecting", async () => {
  let acknowledge!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { acknowledge = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/end") ? pending :
    Response.json({ id: "call", controlToken: "control" })));
  const { call } = setup();
  await call.start("demo");
  const stopping = call.stop();
  // Let queued transport cleanup run if it was incorrectly started concurrently.
  await Promise.resolve();
  expect(sdk.trackStop).toHaveBeenCalledOnce();
  expect(sdk.disconnect).not.toHaveBeenCalled();
  acknowledge(Response.json({ status: "ended" }));
  await stopping;
  expect(sdk.disconnect).toHaveBeenCalledOnce();
});

it("disconnects even when the end request times out", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/end")) throw new DOMException("Request timed out", "TimeoutError");
    return Response.json({ id: "call", controlToken: "control" });
  }));
  const { call, callbacks } = setup();
  await call.start("demo");
  await call.stop();
  expect(sdk.trackStop).toHaveBeenCalledOnce();
  expect(sdk.disconnect).toHaveBeenCalledOnce();
  expect(callbacks.onEnded.mock.calls[0][0]).toContain("cleanup could not be confirmed");
});


it("does not create a session when microphone permission is denied and allows retry", async () => {
  sdk.microphone.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  const fetchMock = vi.fn(async (url: string) => Response.json(url.endsWith("/sessions")
    ? { id: "call", controlToken: "control" } : { status: "ended" }));
  vi.stubGlobal("fetch", fetchMock);
  const { call, callbacks } = setup();
  await call.start("demo");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(callbacks.onReady).not.toHaveBeenCalled();
  expect(callbacks.onEnded.mock.lastCall?.[0]).toContain("Microphone permission is blocked");
  await call.start("demo");
  expect(callbacks.onReady).toHaveBeenCalledOnce();
  expect(sdk.probeStop).toHaveBeenCalledOnce();
  await call.stop();
});

it("does not start a call after canceling a pending microphone prompt", async () => {
  let grant!: (stream: unknown) => void;
  sdk.microphone.mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { call } = setup();
  const starting = call.start("demo");
  await call.stop();
  const track = { readyState: "live", stop: sdk.probeStop };
  grant({ getAudioTracks: () => [track], getTracks: () => [track] });
  await starting;
  expect(fetchMock).not.toHaveBeenCalled();
  expect(sdk.probeStop).toHaveBeenCalledOnce();
});

it("does not create a session when no microphone exists", async () => {
  sdk.microphone.mockRejectedValueOnce(new DOMException("Missing", "NotFoundError"));
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { call, callbacks } = setup();
  await call.start("demo");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(callbacks.onEnded.mock.lastCall?.[0]).toContain("No microphone was found");
});
