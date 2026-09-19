import { useEffect, useState } from "react";
import { PROVIDER_LABELS, type CompactionDetails, type CompactionMessage, type Session } from "@sessionboxer/protocol";
import { api } from "./api";
import { formatTokens, type Compaction } from "./context-model";
import { Markdown } from "./Markdown";

type Load = { state: "loading" } | { state: "loaded"; details: CompactionDetails } | { state: "failed"; error: string };

const ROLE_LABELS: Record<CompactionMessage["role"], string> = { user: "You", assistant: "Agent", system: "System", tool: "Tool result" };

function Message({ m }: { m: CompactionMessage }) {
  const [open, setOpen] = useState(m.role === "user" || m.role === "assistant");
  const long = m.text.length > 600 || m.text.split("\n").length > 12;
  const shown = open || !long ? m.text : `${m.text.slice(0, 400).trimEnd()}\u2026`;
  return (
    <li className={`cd-msg cd-msg-${m.role}${m.kept ? " cd-msg-kept" : ""}`}>
      <div className="cd-msg-head">
        <span className="cd-msg-role">{ROLE_LABELS[m.role]}</span>
        {m.kept && (
          <span className="cd-msg-flag" title="The Agent kept this message word for word after the summary">
            kept verbatim
          </span>
        )}
        {m.truncated && <span className="cd-msg-flag muted">cut</span>}
        {long && (
          <button type="button" className="small" onClick={() => setOpen((v) => !v)}>
            {open ? "Less" : "More"}
          </button>
        )}
      </div>
      {m.role === "assistant" || m.role === "user" ? <Markdown text={shown} /> : <pre className="cd-msg-text">{shown}</pre>}
    </li>
  );
}

/**
 * What one compaction did: the conversation it replaced and the summary the Agent wrote for it,
 * read from the Provider's own records in the Sandbox (ADR-0031).
 */
export function CompactionDialog({ session, compaction, index, onClose }: { session: Session; compaction: Compaction; index: number; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const live = session.status === "idle" || session.status === "running";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!live) {
      setLoad({ state: "failed", error: `The Sandbox is ${session.status}: the ${PROVIDER_LABELS[session.provider]} records it holds can only be read while it runs. Resume the Session to see what this compaction did.` });
      return;
    }
    let cancelled = false;
    setLoad({ state: "loading" });
    api
      .compactionDetails(session.id, { index, preTokens: compaction.preTokens, postTokens: compaction.postTokens, trigger: compaction.trigger })
      .then((details) => {
        if (!cancelled) setLoad({ state: "loaded", details });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ state: "failed", error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, session.provider, session.status, live, index, compaction.preTokens, compaction.postTokens, compaction.trigger]);

  const sizes =
    compaction.preTokens !== null && compaction.postTokens !== null
      ? `${formatTokens(compaction.preTokens)} \u2192 ${formatTokens(compaction.postTokens)} tokens`
      : compaction.preTokens !== null
        ? `${formatTokens(compaction.preTokens)} tokens before`
        : compaction.postTokens !== null
          ? `\u2192 ${formatTokens(compaction.postTokens)} tokens`
          : null;
  const facts = [
    compaction.trigger === "automatic" ? "automatic" : compaction.trigger === "manual" ? "manual (/compact)" : null,
    sizes,
    compaction.durationMs !== null ? `${(compaction.durationMs / 1000).toFixed(1)} s` : null,
  ].filter((f): f is string => f !== null);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel compaction-dialog" role="dialog" aria-modal="true" aria-labelledby="compaction-title">
        <h2 id="compaction-title">
          {"\u267B"} Compaction #{index + 1}
          {load.state === "loaded" && load.details.total > 1 ? <span className="muted"> of {load.details.total}</span> : null}
        </h2>
        <p className="muted">
          {facts.length > 0 ? `${facts.join(" \u00b7 ")}. ` : ""}
          The Agent replaced the conversation below with the summary; from then on the summary is all it remembers of it
          {load.state === "loaded" && load.details.before.some((m) => m.kept) ? ", apart from the messages flagged as kept" : ""}.
        </p>
        {load.state === "loading" && <p className="cd-status">Reading the {PROVIDER_LABELS[session.provider]} records in the Sandbox\u2026</p>}
        {load.state === "failed" && <p className="cd-status cd-status-error">{load.error}</p>}
        {load.state === "loaded" && (
          <div className="cd-columns">
            <section className="cd-col">
              <h3>
                Compacted away <span className="muted">{load.details.before.length} messages</span>
              </h3>
              {load.details.before.length === 0 ? (
                <p className="empty">Nothing recorded before this compaction.</p>
              ) : (
                <ol className="cd-messages">
                  {load.details.before.map((m, i) => (
                    <Message key={i} m={m} />
                  ))}
                </ol>
              )}
            </section>
            <section className="cd-col">
              <h3>
                Summary it became{" "}
                {load.details.summary !== null && <span className="muted">{load.details.summary.length.toLocaleString()} chars</span>}
              </h3>
              {load.details.summary === null ? (
                <p className="empty">{PROVIDER_LABELS[session.provider]} recorded no summary for this compaction.</p>
              ) : (
                <div className="cd-summary">
                  <Markdown text={load.details.summary} />
                </div>
              )}
            </section>
          </div>
        )}
        {load.state === "loaded" && (
          <p className="muted cd-source">
            From {load.details.source}.{load.details.note ? ` ${load.details.note}` : ""}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
