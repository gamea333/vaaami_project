import { useEffect, useRef, useState } from "react";
import { VoiceCall, type CallSnapshot } from "./lib/voice";

import { CallHistory, CallDetails } from "./History";
import { parseRoute, duration } from "./lib/api";

import { readDemoCode, rememberDemoCode } from "./lib/demo-access";

type CallState = "idle" | "connecting" | "active" | "ending";

export default function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const [elapsed, setElapsed] = useState(0);
  const connectedAt = useRef(0);
  useEffect(() => {
    const navigate = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  useEffect(() => {
    document.querySelector<HTMLElement>("main > section h1, main > div:not([hidden]) h1")?.focus();
  }, [route]);
  const [state, setState] = useState<CallState>("idle");
  const [accessCode, setAccessCode] = useState(readDemoCode);
  const [rememberCode, setRememberCode] = useState(() => Boolean(readDemoCode()));
  const [storageError, setStorageError] = useState("");
  function updateAccess(code: string, remember: boolean) {
    setAccessCode(code);
    setRememberCode(remember);
    const stored = rememberDemoCode(remember ? code : "");
    setStorageError(stored ? "" : "Browser storage is unavailable. Your choice could not be saved; clear this site's browser data to remove any previously saved code.");
  }
  const [message, setMessage] = useState("Start a short conversation with Vaami.");
  const [snapshot, setSnapshot] = useState<CallSnapshot | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const call = useRef<VoiceCall | null>(null);

  useEffect(() => () => { call.current?.dispose(); }, []);

  useEffect(() => {
    if (state !== "active") return;
    const timer = window.setInterval(() => setElapsed(performance.now() - connectedAt.current), 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  function getCall() {
    if (!audio.current) throw new Error("Audio is not initialized.");
    return call.current ??= new VoiceCall(audio.current, {
      onReady: () => { connectedAt.current = performance.now(); setElapsed(0); setState("active"); setMessage("Connected. Speak naturally; you can interrupt the assistant."); },
      onEnded: (text) => { setState("idle"); setPlaybackBlocked(false); setMessage(text); },
      onSnapshot: setSnapshot,
      onPlaybackBlocked: () => setPlaybackBlocked(true),
    });
  }

  async function recoverSave() {
    setSaveBusy(true);
    try { setMessage(await getCall().recoverSave(accessCode) ? "Recovered unfinished save." : "No unfinished saves in this bot process."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not recover save."); }
    finally { setSaveBusy(false); }
  }

  async function retrySave() {
    setSaveBusy(true);
    try { await getCall().retrySave(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not retry save."); }
    finally { setSaveBusy(false); }
  }

  const unfinishedSave = ["saving", "save_failed", "unknown"].includes(snapshot?.saveStatus ?? "");

  async function startCall() {
    if (!audio.current || state !== "idle") return;
    setSnapshot(null);
    setElapsed(0);
    setState("connecting");
    setPlaybackBlocked(false);
    setMessage("Connecting your microphone and the local voice bot...");
    try {
    await getCall().start(accessCode);
    } catch (error) {
      setState("idle");
      setMessage(error instanceof Error ? error.message : "Could not initialize audio.");
    }
  }

  async function endCall() {
    setState("ending");
    setMessage("Ending call...");
    await call.current?.stop();
  }

  async function enableAudio() {
    try {
      await audio.current?.play();
      setPlaybackBlocked(false);
    } catch {
      setMessage("Audio playback is blocked. Check your browser's sound permissions.");
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#/call" aria-label="Vaami home">vaami<span> / </span>call log</a>
        <nav className="site-nav" aria-label="Main navigation">
          <a href="#/call" aria-current={route.kind === "call" ? "page" : undefined}>{state === "idle" ? "New call" : "Return to call"}</a>
          <a href="#/calls" aria-current={route.kind === "list" || route.kind === "detail" ? "page" : undefined}>History</a>
        </nav>
      </header>
      <main>
        <div hidden={route.kind !== "call"}>
        <p className="eyebrow">A conversation, remembered.</p>
        <h1 tabIndex={-1}>Your voice.<br />A little more possibility.</h1>
        <p className="intro">Talk naturally with an AI assistant, then revisit the conversation in your call history.</p>
        <section className="call-card" aria-labelledby="call-heading">
          <div className="voice-symbol" aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <div>
            <h2 id="call-heading">Let's get connected</h2>
            <p>Try a short conversation. Use headphones for the clearest sound.</p>
          </div>
          <label className="access-field">
            Demo access code
            <input type="password" value={accessCode} onChange={(event) => updateAccess(event.target.value, rememberCode)}
              autoComplete="off" disabled={state !== "idle"} placeholder="Enter your demo code" />
          </label>
          <div className="access-options">
            <label><input type="checkbox" checked={rememberCode} disabled={state !== "idle" || saveBusy}
              onChange={event => updateAccess(accessCode, event.target.checked)} /> Remember on this device</label>
            <p>Stores the demo code in this browser. Use only on your own device.</p>
            {rememberCode && <button className="secondary-button" disabled={state !== "idle" || saveBusy}
              onClick={() => updateAccess("", false)}>Forget saved code</button>}
            {storageError && <p role="alert">{storageError}</p>}
          </div>
          {state === "idle" ? (
            <button onClick={startCall} disabled={!accessCode.trim() || unfinishedSave || saveBusy}>Start Call</button>
          ) : (
            <button onClick={endCall} disabled={state === "ending"}>
              {state === "ending" ? "Ending..." : "End Call"}
            </button>
          )}
          {state === "idle" && <button className="secondary-button" disabled={!accessCode.trim() || saveBusy}
            onClick={recoverSave}>Recover unfinished save</button>}
          {playbackBlocked && <button className="secondary-button" onClick={enableAudio}>Enable sound</button>}
          <p className={`connection-message ${state === "active" ? "connected" : ""}`} role="status">{message}</p>
          <p className="call-timer">Elapsed: {duration(state === "idle" ? snapshot?.durationMs ?? elapsed : elapsed)}</p>
          <p className="call-limits">Calls end automatically after the time, inactivity, or usage limit is reached.</p>
          <audio ref={audio} autoPlay />
        </section>
        {snapshot && <section className="history" aria-labelledby="transcript-heading">
          <h2 id="transcript-heading">Current conversation</h2>
          <p>{snapshot.usage.replies} AI replies requested · {snapshot.usage.ttsCharactersReserved} speech characters reserved</p>
          <p role="status">{snapshot.saveStatus === "saved" ? "Saved and verified in the call database." :
            snapshot.saveStatus === "saving" ? "Saving your call..." :
            snapshot.saveStatus === "save_failed" || snapshot.saveStatus === "unknown" ? snapshot.saveError :
            snapshot.saveStatus === "not_required" ? "No connected call to save." : "This conversation will be saved when the call ends."}</p>
          {(snapshot.saveStatus === "save_failed" || snapshot.saveStatus === "unknown") && snapshot.canRetrySave &&
            <button className="secondary-button" onClick={retrySave} disabled={saveBusy}>
              {saveBusy ? "Checking save..." : "Retry save"}</button>}
          {snapshot.saveStatus === "saved" && <p><a href={`#/calls/${snapshot.id}`}>View saved conversation</a> · Call ID: <code>{snapshot.id}</code></p>}
          {snapshot.transcript.length === 0 ? <p>Waiting for speech...</p> :
            <ol className="transcript-list">{snapshot.transcript.map((turn, index) =>
              <li key={index}><strong>{turn.role === "user" ? "You" : "Vaami"}:</strong> {turn.text}
                {turn.interrupted && <em> (interrupted)</em>}</li>)}</ol>}
        </section>}
        </div>
        {route.kind === "list" && <CallHistory page={route.page} />}
        {route.kind === "detail" && <CallDetails id={route.id} />}
        {route.kind === "missing" && <section><h1 tabIndex={-1}>Page not found</h1><a href="#/calls">Go to call history</a></section>}
            </main>
      <footer>Vaami · Mini Call Log Service</footer>
    </div>
  );
}
