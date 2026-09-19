import { useEffect, useMemo, useState } from "react";
import type { LlmCall, LlmCallBody, Session } from "@sessionboxer/protocol";
import { api } from "./api";
import { formatTokens } from "./context-model";
import { formatTime } from "./format";
import { LLM_KIND_LABELS, diffRequests, formatBytes, parseJson, previousCall, requestTree, responseTree, type DiffSection, type TreeNode } from "./llm-model";

type Load = { state: "loading" } | { state: "loaded"; body: LlmCallBody } | { state: "failed"; error: string };
type Tab = "request" | "response" | "tree" | "diff";

/** Above this many characters the body is shown cut until asked for, so the dialog stays responsive. */
const SHOW_CAP = 400_000;

function useBody(sessionId: string, callId: string | null, live: boolean): Load {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    if (callId === null) return;
    if (!live) {
      setLoad({ state: "failed", error: "The bodies live in the Sandbox's memory: the Session is not running, so only this summary is left." });
      return;
    }
    let cancelled = false;
    setLoad({ state: "loading" });
    api
      .llmCallBody(sessionId, callId)
      .then((body) => {
        if (!cancelled) setLoad({ state: "loaded", body });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ state: "failed", error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, callId, live]);
  return load;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Body({ text, bytes, truncated, name }: { text: string | null; bytes: number; truncated: boolean; name: string }) {
  const [pretty, setPretty] = useState(false);
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => (pretty && text !== null ? parseJson(text) : undefined), [pretty, text]);
  if (text === null) {
    return <p className="llm-status">This body is no longer in the Sandbox: only the last 40 calls keep theirs, and a Stop → Resume clears them all.</p>;
  }
  const shown = json !== undefined ? JSON.stringify(json, null, 2) : text;
  const cut = !all && shown.length > SHOW_CAP;
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <div className="llm-body-wrap">
      <div className="llm-body-bar">
        <span>
          {bytes.toLocaleString()} bytes decoded{truncated ? <span className="warn"> (cut at the capture limit)</span> : ""} · {text.length.toLocaleString()} chars
        </span>
        {parseJson(text) !== undefined && (
          <label className="check small-text">
            <input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> pretty
          </label>
        )}
        <span className="spacer" />
        <button type="button" className="small" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="small" onClick={() => download(name, text)}>
          Download
        </button>
      </div>
      <pre className="llm-body">{cut ? shown.slice(0, SHOW_CAP) : shown}</pre>
      {cut && (
        <button type="button" className="small" onClick={() => setAll(true)}>
          Show all {shown.length.toLocaleString()} chars
        </button>
      )}
    </div>
  );
}

function Tree({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ul className="llm-tree">
      {nodes.map((n, i) => (
        <li key={i}>
          {n.children || n.text !== undefined ? (
            <details open={n.open}>
              <summary>
                <span className="llm-tree-label">{n.label}</span>
                {n.meta && <span className="muted"> {n.meta}</span>}
              </summary>
              {n.children && <Tree nodes={n.children} />}
              {n.text !== undefined && <pre className="llm-tree-text">{n.text}</pre>}
            </details>
          ) : (
            <span>
              <span className="llm-tree-label">{n.label}</span>
              {n.meta && <span className="muted"> {n.meta}</span>}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Diff({ sections }: { sections: DiffSection[] }) {
  return (
    <div className="llm-diff">
      {sections.map((s) => (
        <section key={s.title}>
          <h4>{s.title}</h4>
          {s.lines.length === 0 ? (
            <p className="muted small-text">nothing</p>
          ) : (
            <ul>
              {s.lines.map((l, i) => (
                <li key={i} className={`llm-diff-${l.kind}`}>
                  {l.detail ? (
                    <details>
                      <summary>
                        <span className="llm-diff-sign">{l.kind === "added" ? "+" : l.kind === "removed" ? "\u2212" : l.kind === "changed" ? "~" : "="}</span> {l.text}
                      </summary>
                      <pre className="llm-tree-text">{l.detail}</pre>
                    </details>
                  ) : (
                    <span>
                      <span className="llm-diff-sign">{l.kind === "added" ? "+" : l.kind === "removed" ? "\u2212" : l.kind === "changed" ? "~" : "="}</span> {l.text}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

export function callFacts(call: LlmCall): string[] {
  const usage = call.usage;
  return [
    LLM_KIND_LABELS[call.kind],
    `${call.method} ${call.path}`,
    call.model,
    call.status !== null ? `HTTP ${call.status}` : call.error ? `failed: ${call.error}` : null,
    call.durationMs !== null ? `${(call.durationMs / 1000).toFixed(1)} s` : null,
    call.streamed ? "streamed" : null,
    usage
      ? `in ${usage.inputTokens !== null ? formatTokens(usage.inputTokens) : "?"}${usage.cacheReadTokens ? ` / cached ${formatTokens(usage.cacheReadTokens)}` : ""}${usage.cacheWriteTokens ? ` / written ${formatTokens(usage.cacheWriteTokens)}` : ""} / out ${usage.outputTokens !== null ? formatTokens(usage.outputTokens) : "?"}`
      : null,
    call.stopReason ? `stop: ${call.stopReason}` : null,
  ].filter((f): f is string => f !== null && f !== "");
}

/**
 * One model API call, byte for byte: the request Claude Code sent and the response it got at
 * the Sandbox's inspector hop (ADR-0032), a parsed view of both, and what changed since the
 * previous call of the same kind.
 */
export function LlmCallDialog({
  session,
  call,
  calls,
  onClose,
}: {
  session: Session;
  call: LlmCall;
  /** Every call recorded for the Session, for the diff's "previous one". */
  calls: LlmCall[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("request");
  const live = session.status === "idle" || session.status === "running";
  const load = useBody(session.id, call.id, live);
  const [withBodies, setWithBodies] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!live) {
      setWithBodies(new Set());
      return;
    }
    let cancelled = false;
    api.llmCalls(session.id).then(
      (r) => {
        if (!cancelled) setWithBodies(new Set(r.withBodies));
      },
      () => {
        if (!cancelled) setWithBodies(new Set());
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session.id, live, call.id]);
  const prev = useMemo(() => (withBodies ? previousCall(calls, call, withBodies) : null), [calls, call, withBodies]);
  const prevLoad = useBody(session.id, tab === "diff" && prev ? prev.id : null, live);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const body = load.state === "loaded" ? load.body : null;
  const requestJson = useMemo(() => (body ? parseJson(body.request) : undefined), [body]);
  const tree = useMemo(() => (body ? { request: requestTree(requestJson), response: responseTree(body.response) } : null), [body, requestJson]);
  const diff = useMemo(() => {
    if (!body || prevLoad.state !== "loaded" || body.request === null || prevLoad.body.request === null) return null;
    return diffRequests(parseJson(prevLoad.body.request), requestJson);
  }, [body, prevLoad, requestJson]);
  const base = `llm-call-${call.ordinal}`;
  const responseName = body?.response !== null && body?.response !== undefined && /^event:/m.test(body.response) ? `${base}-response.sse.txt` : `${base}-response.json`;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel llm-dialog" role="dialog" aria-modal="true" aria-labelledby="llm-title">
        <h2 id="llm-title">
          LLM call #{call.ordinal} <span className="muted">{formatTime(call.startedAt)}</span>
        </h2>
        <p className="muted small-text">{callFacts(call).join(" \u00b7 ")}</p>
        <div className="segmented llm-tabs" role="tablist">
          {(["request", "response", "tree", "diff"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "request" ? `Request (${formatBytes(call.requestBytes)})` : t === "response" ? `Response (${formatBytes(call.responseBytes)})` : t === "tree" ? "Tree" : "Diff"}
            </button>
          ))}
        </div>
        <div className="llm-content">
          {load.state === "loading" && <p className="llm-status">Reading the bodies from the Sandbox\u2026</p>}
          {load.state === "failed" && <p className="llm-status llm-status-error">{load.error}</p>}
          {body && tab === "request" && <Body text={body.request} bytes={call.requestBytes} truncated={call.requestTruncated} name={`${base}-request.json`} />}
          {body && tab === "response" && <Body text={body.response} bytes={call.responseBytes} truncated={call.responseTruncated} name={responseName} />}
          {body && tree && tab === "tree" && (
            <div className="llm-columns">
              <section>
                <h3>Request</h3>
                {body.request === null ? <p className="llm-status">Body evicted.</p> : <Tree nodes={tree.request} />}
              </section>
              <section>
                <h3>Response</h3>
                {body.response === null ? <p className="llm-status">Body evicted.</p> : <Tree nodes={tree.response} />}
              </section>
            </div>
          )}
          {body && tab === "diff" && (
            <>
              {withBodies === null ? (
                <p className="llm-status">Looking up earlier calls…</p>
              ) : prev === null ? (
                <p className="llm-status">No earlier {LLM_KIND_LABELS[call.kind]} with its body still in the Sandbox to compare with.</p>
              ) : (
                <>
                  <p className="muted small-text">
                    Request of call #{prev.ordinal} ({formatBytes(prev.requestBytes)}) \u2192 this one ({formatBytes(call.requestBytes)}
                    {call.requestBytes !== prev.requestBytes ? `, ${call.requestBytes > prev.requestBytes ? "+" : "\u2212"}${formatBytes(Math.abs(call.requestBytes - prev.requestBytes))}` : ""}).
                  </p>
                  {prevLoad.state === "loading" && <p className="llm-status">Reading call #{prev.ordinal}\u2026</p>}
                  {prevLoad.state === "failed" && <p className="llm-status llm-status-error">{prevLoad.error}</p>}
                  {diff && <Diff sections={diff} />}
                  {prevLoad.state === "loaded" && !diff && <p className="llm-status">One of the two request bodies was evicted.</p>}
                </>
              )}
            </>
          )}
        </div>
        <p className="muted small-text llm-note">
          Captured where Claude Code hands the request to the Sandbox&apos;s loopback inspector, before it reaches{" "}
          <code>{session.provider === "claude-code" ? "the configured ANTHROPIC_BASE_URL" : "the provider"}</code>. Headers (and so credentials) are never
          recorded; a company proxy that rewrites bodies does so after this point.
        </p>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
