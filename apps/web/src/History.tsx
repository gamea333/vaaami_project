import { useEffect, useState } from "react";
import { dateTime, duration, getCallDetail, listCalls, type CallDetail, type CallList } from "./lib/api";

// Abort obsolete requests and ignore late responses after navigation.
function useRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>({ key });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult({ key });
    load(controller.signal).then(data => {
      if (!controller.signal.aborted) setResult({ key, data });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "Could not load calls." });
    });
    return () => controller.abort();
  }, [key, attempt]);
  return { ...(result.key === key ? result : { key }), retry: () => setAttempt(value => value + 1) };
}
function Problem({ message, retry }: { message: string; retry: () => void }) {
  return <div className="data-panel"><p role="alert">{message}</p><button className="secondary-button" onClick={retry}>Retry</button></div>;
}
export function CallHistory({ page }: { page: number }) {
  const { data, error, retry } = useRead<CallList>(`list-${page}`, signal => listCalls(page, signal));
  return <section aria-labelledby="history-title">
    <p className="eyebrow">A conversation, remembered.</p>
    <div className="page-heading"><h1 id="history-title" tabIndex={-1}>Call history</h1><button className="secondary-button" onClick={retry}>Refresh</button></div>
    <p className="intro">Revisit saved conversations, transcripts, and measured response times.</p>
    {error ? <Problem message={error} retry={retry} /> : !data ? <p role="status">Loading calls...</p> : <>
      {data.items.length === 0 ? <div className="data-panel"><h2>{page ? "No calls on this page" : "No saved calls yet"}</h2><p>End a connected call and wait for “Saved and verified”, then refresh this list.</p><a href="#/call">Start a conversation</a></div> :
      <ol className="call-list">{data.items.map(call => <li key={call.id}>
        <a className="call-link" href={`#/calls/${call.id}`}><span><strong>{dateTime(call.startedAt)}</strong><small className="call-id">{call.id}</small></span>
          <span className="call-summary"><span>{duration(call.durationMs)}</span><span className={`status-badge status-${call.status}`}>{call.status}</span><span aria-hidden="true">→</span></span></a>
      </li>)}</ol>}
      <nav className="pagination" aria-label="Call history pages">{page > 0 && <a href={`#/calls?page=${page - 1}`}>← Previous</a>}<span>Page {page + 1}</span>{data.hasMore && <a href={`#/calls?page=${page + 1}`}>Next →</a>}</nav>
    </>}
    {error && page > 0 && <a href="#/calls">Back to first page</a>}
  </section>;
}
export function CallDetails({ id }: { id: string }) {
  const { data, error, retry } = useRead<CallDetail>(id, signal => getCallDetail(id, signal));
  return <section aria-labelledby="detail-title">
    <a href="#/calls">← Call history</a><h1 id="detail-title" tabIndex={-1}>Conversation details</h1>
    {error ? <Problem message={error} retry={retry} /> : !data ? <p role="status">Loading conversation...</p> : <>
      <dl className="metadata data-panel">
        <div><dt>Started (your local time)</dt><dd>{dateTime(data.call.startedAt)}</dd></div>
        <div><dt>Duration</dt><dd>{duration(data.call.durationMs)}</dd></div>
        <div><dt>Status</dt><dd>{data.call.status}</dd></div>
        <div><dt>End reason</dt><dd>{data.call.endReason}</dd></div>
        <div><dt>Ended</dt><dd>{dateTime(data.call.endedAt)}</dd></div>
        <div><dt>Saved</dt><dd>{dateTime(data.call.createdAt)}</dd></div>
        <div className="full-width"><dt>Call ID</dt><dd><code>{data.call.id}</code></dd></div>
      </dl>
      <section className="history"><h2>Transcript</h2><p>Text captured during the call. Interrupted replies may include words that were not played aloud.</p>
        {!data.transcripts.length ? <p>Transcript not captured.</p> : <ol className="saved-transcript">{[...data.transcripts].sort((a,b) => a.sequence - b.sequence).map(turn =>
          <li key={turn.sequence} className={`turn turn-${turn.role}`}><div className="turn-heading"><strong>{turn.role === "user" ? "You" : "Vaami"}</strong><time dateTime={turn.timestamp}>{dateTime(turn.timestamp)}</time>{turn.interrupted && <span className="status-badge">Interrupted</span>}</div><p>{turn.text}</p></li>)}</ol>}
      </section>
      <section className="history"><h2>Latency measurements</h2><p>Individual captured samples in milliseconds (ms). These measurements can overlap and are not added together.</p>
        {["stt", "llm", "tts"].map(stage => <div className="metric-group" key={stage}><h3>{({ stt: "Speech recognition", llm: "Language model", tts: "Speech synthesis" })[stage]}</h3>
          {!data.metrics.some(metric => metric.stage === stage) ? <p>Not captured</p> : <ul className="metric-list">{data.metrics.filter(metric => metric.stage === stage).map(metric => <li key={metric.sequence}>
            <strong>{metric.metricName.replaceAll("_", " ")} · {metric.valueMs.toLocaleString(undefined, { maximumFractionDigits: 2 })} ms</strong>
            <small>{metric.provider} · {metric.measurementSource} · {metric.turnSequence === null ? "Turn not associated" : `Turn ${metric.turnSequence}`}</small>
          </li>)}</ul>}
        </div>)}
      </section>
    </>}
  </section>;
}
