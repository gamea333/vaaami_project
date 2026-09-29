import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

const botUrl = (import.meta.env.VITE_BOT_BASE_URL ?? "http://127.0.0.1:7860").replace(/\/$/, "");

type Session = { id: string; controlToken: string };
export type TranscriptTurn = { role: "user" | "assistant"; text: string; timestamp: string; interrupted: boolean };
export type CallSnapshot = { id?: string; saveStatus?: "pending" | "saving" | "saved" | "save_failed" | "not_required" | "unknown";
  saveError?: string | null; canRetrySave?: boolean; durationMs?: number; transcript: TranscriptTurn[]; usage: { replies: number; ttsCharactersReserved: number } };
type Callbacks = { onReady: () => void; onEnded: (message: string) => void; onPlaybackBlocked: () => void; onSnapshot?: (snapshot: CallSnapshot) => void };

async function request(path: string, token: string, method = "GET", signal?: AbortSignal, timeoutMs = 25000) {
  const response = await fetch(botUrl + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  });
  const data = await response.json();
  if (response.status === 401 && path === "/sessions") {
    throw new Error("Demo access code does not match. Enter only the value after DEMO_ACCESS_CODE= in bot/.env, without quotes. Restart the bot if you changed that value.");
  }
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Session request failed.");
  return data;
}

export class VoiceCall {
  private client: PipecatClient;
  private session?: Session;
  private ended = false;
  private connectionStarted = false;
  private saveAbort?: AbortController;
  private disposed = false;
  private lastSnapshot?: CallSnapshot;
  private abort = new AbortController();
  private poll?: ReturnType<typeof setInterval>;
  private rejectReady?: (reason: Error) => void;

  constructor(private audio: HTMLAudioElement, private callbacks: Callbacks) {
    this.client = new PipecatClient({
      transport: new SmallWebRTCTransport({ waitForICEGathering: true, iceServers: import.meta.env.VITE_STUN_URL ? [{ urls: import.meta.env.VITE_STUN_URL }] : [] }),
      enableMic: true,
      enableCam: false,
      callbacks: {
        onTrackStarted: (track, participant) => {
          // SmallWebRTC emits remote tracks without participant metadata.
          // Local microphone events include local: true and must never be played back.
          if (!this.ended && track.kind === "audio" && !participant?.local) {
            this.audio.srcObject = new MediaStream([track]);
            void this.audio.play().catch(() => this.callbacks.onPlaybackBlocked());
          }
        },
        onDisconnected: () => {
          if (!this.ended) void this.stop("Call disconnected.");
        },
        onBotDisconnected: () => {
          if (!this.ended) void this.stop("The bot disconnected.");
        },
      },
    });
  }

  async start(accessCode: string) {
    this.saveAbort?.abort();
    this.lastSnapshot = undefined;
    this.ended = false;
    this.connectionStarted = false;
    this.abort = new AbortController();
    this.session = undefined;
    let onReady: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const data = await request("/sessions", accessCode.trim(), "POST", this.abort.signal);
      if (!data.id || !data.controlToken) {
        throw new Error("The bot returned invalid session details.");
      }
      this.session = data;
      if (this.ended) {
        await request(`/sessions/${data.id}/end`, data.controlToken, "POST");
        return;
      }
      const ready = new Promise<void>((resolve, reject) => {
        this.rejectReady = reject;
        onReady = resolve; this.client.on("botReady", onReady);
        timer = setTimeout(() => reject(new Error("The bot did not become ready. Check the local bot and provider settings.")), 35000);
      });
      // Polling surfaces provider failures even when WebRTC has not fully connected.
      this.poll = setInterval(() => { void this.checkStatus(); }, 2000);
      this.connectionStarted = true;
      await Promise.all([this.client.connect({
        webrtcRequestParams: {
          endpoint: botUrl + "/sessions/" + data.id + "/offer",
          headers: new Headers({ Authorization: "Bearer " + data.controlToken }),
        },
      }), ready]);
      if (!this.ended) this.callbacks.onReady();
    } catch (error) {
      await this.stop(error instanceof Error ? error.message : "Could not start the call.");
    } finally {
      clearTimeout(timer);
      if (onReady) this.client.off("botReady", onReady);
      this.rejectReady = undefined;
    }
  }

  private async checkStatus() {
    if (!this.session || this.ended) return;
    try {
      const data = await request(`/sessions/${this.session.id}`, this.session.controlToken, "GET", this.abort.signal);
      if (data.transcript) this.publish(data);
      if (data.status === "failed" || data.status === "ended") {
        await this.stop(data.error ?? data.reason ?? "Call ended.");
      }
    } catch {
      if (!this.ended) await this.stop("The local bot is unreachable. The call has been stopped.");
    }
  }

  async stop(message = "Call ended.") {
    if (this.ended) return;
    this.ended = true;
    this.abort.abort();
    this.rejectReady?.(new Error(message));
    clearInterval(this.poll);
    // Explicitly release microphone tracks even if transport cleanup fails.
    try {
      this.client.tracks().local.audio?.stop();
    } catch {
      // The transport may not have initialized when session creation fails.
    }
    this.audio.pause();
    this.audio.srcObject = null;
    // An authentication failure happens before connect(). Some transports cannot
    // finish disconnect() before initialization, which would hide the actual error.
    const disconnect = this.connectionStarted;
    this.connectionStarted = false;
    let cleanupFailed = false;
    try {
      // Let the server record intentional hangup before closing WebRTC. Otherwise
      // its disconnect callback can win the race and persist the wrong reason.
      if (this.session) {
        const data = await request(`/sessions/${this.session.id}/end`, this.session.controlToken, "POST");
        if (data.transcript) this.publish(data);
        void this.followSave(data);
      }
    } catch {
      cleanupFailed = true;
    } finally {
      // The request has a timeout; always close transport even when it fails.
      if (disconnect) {
        try { await this.client.disconnect(); }
        catch { cleanupFailed = true; }
      }
    }
    if (cleanupFailed) {
      message += " Server cleanup could not be confirmed; the session will expire automatically.";
      if (this.session) this.publish({ ...(this.lastSnapshot ?? { transcript: [], usage: { replies: 0, ttsCharactersReserved: 0 } }),
        saveStatus: "unknown", saveError: "Save status is unknown. Recover or retry the save when the bot is reachable.", canRetrySave: true });
    }
    this.callbacks.onEnded(message);
  }
  private publish(data: CallSnapshot) {
    this.lastSnapshot = data;
    if (!this.disposed) this.callbacks.onSnapshot?.(data);
  }

  private async followSave(initial: CallSnapshot) {
    if (!this.session || !initial.saveStatus || this.disposed) return;
    this.saveAbort?.abort();
    const abort = new AbortController();
    this.saveAbort = abort;
    const session = this.session;
    let data = initial;
    const deadline = Date.now() + 35000;
    try {
      while (data.saveStatus === "saving" || data.saveStatus === "pending") {
        if (Date.now() >= deadline) throw new Error("Save confirmation timed out.");
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (abort.signal.aborted) return;
        data = await request(`/sessions/${session.id}`, session.controlToken, "GET", abort.signal, 4000);
        if (abort.signal.aborted) return;
        this.publish(data);
      }
    } catch {
      if (!abort.signal.aborted) this.publish({ ...data, saveStatus: "unknown",
        saveError: "Save could not be confirmed. Check the bot and retry the save status.", canRetrySave: true });
    }
  }

  async retrySave() {
    if (!this.session) throw new Error("Recover the unfinished save first.");
    const data = await request(`/sessions/${this.session.id}/retry-save`, this.session.controlToken, "POST");
    this.publish(data);
    await this.followSave(data);
  }

  async recoverSave(accessCode: string) {
    const result = await request("/pending-saves", accessCode.trim());
    if (!result.items?.length) return false;
    this.session = result.items[0];
    this.ended = true;
    const data = await request(`/sessions/${this.session!.id}`, this.session!.controlToken);
    this.publish(data);
    void this.followSave(data);
    return true;
  }

  dispose() {
    this.disposed = true;
    this.saveAbort?.abort();
    void this.stop();
  }

}
