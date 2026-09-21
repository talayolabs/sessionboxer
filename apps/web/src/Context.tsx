import { useState } from "react";
import type { ContextBreakdown, ContextContributor, LlmCall, Session } from "@sessionboxer/protocol";
import { api } from "./api";
import { ROTTING_FRACTION, completedCompactions, fillFraction, formatCost, formatTokens, gaugeHue, type ContextState } from "./context-model";
import { formatTime } from "./format";
import { LLM_KIND_LABELS, formatBytes } from "./llm-model";

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

const PROVIDER_NAMES = { "claude-code": "Claude Code", devin: "Devin" } as const;

/**
 * The context gauge in the composer footer: how full the window is (green when light,
 * red from half on — "rotting", the Agent starts to forget), plus how many times the
 * conversation has been compacted. Click opens the Context pane.
 */
export function ContextGauge({ context, active, onOpen }: { context: ContextState; active: boolean; onOpen: () => void }) {
  const { used, size } = context;
  const compactions = completedCompactions(context.compactions);
  const compacting = context.compactions.some((c) => c.status === "in_progress");
  const fraction = used !== null && size !== null ? fillFraction(used, size) : null;
  const rotting = fraction !== null && fraction > ROTTING_FRACTION;
  const percent = fraction !== null ? Math.round(fraction * 100) : null;
  const title =
    used !== null && size !== null
      ? `Context: ${used.toLocaleString()} of ${size.toLocaleString()} tokens in the window (${(fraction! * 100).toFixed(1)}%)` +
        (rotting ? " \u2014 past half: the Agent works worse from here, consider a fresh Session or /compact" : "") +
        (context.cost ? `\nSession cost so far: ${formatCost(context.cost.amount, context.cost.currency)}` : "") +
        (compactions > 0 ? `\nCompacted ${compactions} time${compactions === 1 ? "" : "s"}: older conversation was replaced by a summary` : "") +
        "\nClick for the breakdown"
      : "Context usage: nothing reported yet";
  return (
    <button
      type="button"
      className={`ctx-gauge${rotting ? " ctx-rotting" : ""}${active ? " active" : ""}`}
      title={title}
      aria-pressed={active}
      onClick={onOpen}
      style={fraction !== null ? { ["--ctx-hue" as string]: String(gaugeHue(fraction)) } : undefined}
    >
      <span className="ctx-bar" aria-hidden="true">
        <span className="ctx-fill" style={{ width: `${Math.max(fraction !== null && fraction > 0 ? 2 : 0, (fraction ?? 0) * 100)}%` }} />
        <span className="ctx-half" />
      </span>
      <span className="ctx-text">
        {used !== null && size !== null ? (
          <>
            <span className="ctx-tokens">{formatTokens(used)} / {formatTokens(size)} </span>
            {percent !== null && <span className="ctx-pct">{percent}%</span>}
          </>
        ) : (
          "context"
        )}
      </span>
      {rotting && <span className="ctx-rot-label">rotting</span>}
      {(compactions > 0 || compacting) && (
        <span className="ctx-compactions" title={`${compactions} compaction${compactions === 1 ? "" : "s"} in this Session${compacting ? " (compacting now)" : ""}`}>
          {compactions > 0 && <span className="ctx-warn">{"\u26A0"}</span>}
          {"\u267B"} {compacting ? "\u2026" : compactions}
        </span>
      )}
    </button>
  );
}

function ContributorTable({ title, rows, sourceHeader, max }: { title: string; rows: ContextContributor[]; sourceHeader: string; max: number | null }) {
  if (rows.length === 0) return null;
  const total = rows.reduce((n, r) => n + r.tokens, 0);
  return (
    <section className="ctx-section">
      <h3>
        {title} <span className="muted">{rows.length} {"\u00b7"} {formatTokens(total)} tokens</span>
      </h3>
      <table className="prs-table ctx-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>{sourceHeader}</th>
            <th className="num">Tokens</th>
            {max !== null && <th className="num">Window</th>}
          </tr>
        </thead>
        <tbody>
          {[...rows]
            .sort((a, b) => b.tokens - a.tokens)
            .map((r, i) => (
              <tr key={i}>
                <td className="ctx-name" title={r.name}>
                  {r.name}
                </td>
                <td className="muted">{r.source}</td>
                <td className="num">{formatTokens(r.tokens)}</td>
                {max !== null && <td className="num muted">{((r.tokens / max) * 100).toFixed(2)}%</td>}
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}

function Categories({ breakdown }: { breakdown: ContextBreakdown }) {
  const max = breakdown.maxTokens ?? breakdown.categories.reduce((n, c) => n + c.tokens, 0);
  if (breakdown.categories.length === 0) return null;
  return (
    <section className="ctx-section">
      <h3>By category</h3>
      <div className="ctx-stack" aria-hidden="true">
        {breakdown.categories
          .filter((c) => c.kind !== "free")
          .map((c, i) => (
            <span key={i} className={`ctx-stack-${c.kind}`} style={{ width: `${max > 0 ? (c.tokens / max) * 100 : 0}%` }} title={`${c.name}: ${formatTokens(c.tokens)}`} />
          ))}
      </div>
      <table className="prs-table ctx-table">
        <tbody>
          {breakdown.categories.map((c, i) => (
            <tr key={i} className={`ctx-cat-${c.kind}`}>
              <td className="ctx-name">{c.name}</td>
              <td className="ctx-catbar">
                {c.kind !== "free" && <span className={`ctx-catfill ctx-stack-${c.kind}`} style={{ width: `${max > 0 ? Math.min(100, (c.tokens / max) * 100) : 0}%` }} />}
              </td>
              <td className="num">{formatTokens(c.tokens)}</td>
              <td className="num muted">{c.percent !== null ? `${c.percent}%` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small-text">
        {breakdown.categories.some((c) => c.kind === "deferred") && "Deferred tools are loaded on demand and not in the window until used. "}
        {breakdown.categories.some((c) => c.kind === "buffer") && "The autocompact buffer is space the Agent keeps free to summarise before the window fills. "}
      </p>
    </section>
  );
}

/** Occupancy over the Session: one bar per model reply, compactions as the drops. */
function History({ context }: { context: ContextState }) {
  const points = context.history;
  if (points.length < 2) return null;
  const size = Math.max(...points.map((p) => p.size));
  const w = 600;
  const h = 80;
  const step = w / points.length;
  return (
    <section className="ctx-section">
      <h3>
        Over the Session <span className="muted">{points.length} model replies {"\u00b7"} {context.turns} turns</span>
      </h3>
      <svg className="ctx-history" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Context occupancy after each model reply">
        <line x1={0} x2={w} y1={h / 2} y2={h / 2} className="ctx-history-half" />
        {points.map((p, i) => {
          const frac = fillFraction(p.used, size);
          return (
            <rect key={p.seq} x={i * step} width={Math.max(1, step - 1)} y={h - frac * h} height={frac * h} style={{ fill: `hsl(${gaugeHue(frac)} 70% 45%)` }}>
              <title>
                {formatTokens(p.used)} / {formatTokens(p.size)} ({(frac * 100).toFixed(1)}%) at {formatTime(p.ts)}
              </title>
            </rect>
          );
        })}
      </svg>
      <p className="muted small-text">The line is half the window: past it the Agent works worse. A drop is a compaction.</p>
    </section>
  );
}

/**
 * Every model API call the Sandbox's inspector recorded, including the side calls that have no
 * bubble in the conversation (session naming, compaction summaries, token counts).
 */
function Requests({ session, calls, onInspect }: { session: Session; calls: LlmCall[]; onInspect: (call: LlmCall) => void }) {
  if (session.provider !== "claude-code") return null;
  const side = calls.filter((c) => c.kind !== "turn").length;
  return (
    <section className="ctx-section">
      <h3>
        Model API calls{" "}
        <span className="muted">
          {calls.length}
          {side > 0 ? ` · ${side} without a bubble` : ""}
        </span>
      </h3>
      {calls.length === 0 ? (
        <p className="muted small-text">
          {session.settings.inspectLlm
            ? "None recorded yet: the next prompt's calls will show up here and as LLM #n tabs on the bubbles."
            : "Turn on Inspect LLM in the Session settings (header) to record the exact request and response of every call to the model."}
        </p>
      ) : (
        <table className="prs-table ctx-table llm-table">
          <thead>
            <tr>
              <th>#</th>
              <th>When</th>
              <th>Kind</th>
              <th>Model</th>
              <th>Result</th>
              <th className="num">In</th>
              <th className="num">Cached</th>
              <th className="num">Out</th>
              <th className="num">Request</th>
              <th className="num">Response</th>
              <th className="num">Time</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} className={c.error ? "llm-row-error" : ""}>
                <td>
                  <button type="button" className="link-btn" onClick={() => onInspect(c)} title="Show the exact request and response">
                    LLM #{c.ordinal}
                  </button>
                </td>
                <td>{formatTime(c.startedAt)}</td>
                <td>{LLM_KIND_LABELS[c.kind]}</td>
                <td>{c.model ?? "—"}</td>
                <td>{c.error ? `failed: ${c.error}` : c.status !== null ? `HTTP ${c.status}${c.stopReason ? ` · ${c.stopReason}` : ""}` : "…"}</td>
                <td className="num">{c.usage?.inputTokens !== null && c.usage?.inputTokens !== undefined ? formatTokens(c.usage.inputTokens) : "—"}</td>
                <td className="num">{c.usage?.cacheReadTokens ? formatTokens(c.usage.cacheReadTokens) : "—"}</td>
                <td className="num">{c.usage?.outputTokens !== null && c.usage?.outputTokens !== undefined ? formatTokens(c.usage.outputTokens) : "—"}</td>
                <td className="num">{formatBytes(c.requestBytes)}</td>
                <td className="num">{formatBytes(c.responseBytes)}</td>
                <td className="num">{c.durationMs !== null ? `${(c.durationMs / 1000).toFixed(1)} s` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ContextPane({
  session,
  context,
  llmCalls,
  onInspectLlmCall,
  run,
}: {
  session: Session;
  context: ContextState;
  llmCalls: LlmCall[];
  onInspectLlmCall: (call: LlmCall) => void;
  run: Runner;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const { used, size, breakdown } = context;
  const fraction = used !== null && size !== null ? fillFraction(used, size) : null;
  const compactions = completedCompactions(context.compactions);
  const canRefresh = session.status === "idle" && !refreshing;
  const refresh = () => {
    if (!canRefresh) return;
    setRefreshing(true);
    void run(() => api.contextReport(session.id)).finally(() => setRefreshing(false));
  };
  const provider = PROVIDER_NAMES[session.provider];
  return (
    <div className="pane prs-pane ctx-pane">
      <div className="prs-toolbar">
        <strong>Context</strong>
        <span className="muted small-text">
          {breakdown ? `breakdown by ${provider} ${context.breakdownTs ? formatTime(context.breakdownTs) : ""}` : `live usage from ${provider}; no breakdown taken yet`}
        </span>
        <span className="spacer" />
        <button
          className="small"
          onClick={refresh}
          disabled={!canRefresh}
          title={
            session.status === "running"
              ? "Wait for the turn to end"
              : session.status !== "idle"
                ? `Session is ${session.status}`
                : "Ask the Agent for its /context report (local, no model call; not part of the conversation)"
          }
        >
          {refreshing ? "Asking\u2026" : breakdown ? "Refresh breakdown" : "Take breakdown"}
        </button>
      </div>
      <div className="ctx-body">
        <section className="ctx-section ctx-now">
          {used !== null && size !== null && fraction !== null ? (
            <>
              <div className="ctx-now-head">
                <span className="ctx-now-big" style={{ color: `hsl(${gaugeHue(fraction)} 70% 55%)` }}>
                  {(fraction * 100).toFixed(1)}%
                </span>
                <span>
                  {used.toLocaleString()} of {size.toLocaleString()} tokens
                  {fraction > ROTTING_FRACTION && <span className="ctx-rot-label"> rotting</span>}
                </span>
                <span className="spacer" />
                {context.cost && (
                  <span title="Cumulative Session cost as the Agent reports it">
                    {formatCost(context.cost.amount, context.cost.currency)}
                  </span>
                )}
                <span title="Compactions in this Session">
                  {compactions > 0 && <span className="ctx-warn">{"\u26A0"} </span>}
                  {"\u267B"} {compactions}
                </span>
              </div>
              <div className="ctx-bar ctx-bar-wide" aria-hidden="true" style={{ ["--ctx-hue" as string]: String(gaugeHue(fraction)) }}>
                <span className="ctx-fill" style={{ width: `${fraction * 100}%` }} />
                <span className="ctx-half" />
              </div>
              <p className="muted small-text">
                After the last model reply{breakdown?.model ? ` \u00b7 model ${breakdown.model}` : session.settings.model ? ` \u00b7 model ${session.settings.model}` : ""}.
                {" "}The mark is half the window.
              </p>
            </>
          ) : (
            <p className="muted">No usage reported yet: send a prompt first.</p>
          )}
        </section>
        {context.compactions.length > 0 && (
          <section className="ctx-section">
            <h3>Compactions</h3>
            <ul className="ctx-list">
              {context.compactions.map((c) => (
                <li key={c.id}>
                  {c.status === "completed" ? "Compacted" : c.status === "failed" ? "Failed" : "Compacting\u2026"}
                  {c.preTokens !== null && c.postTokens !== null ? ` ${formatTokens(c.preTokens)} \u2192 ${formatTokens(c.postTokens)}` : c.postTokens !== null ? ` \u2192 ${formatTokens(c.postTokens)}` : ""}
                  {c.trigger ? ` (${c.trigger})` : ""}
                  {c.durationMs !== null ? ` in ${(c.durationMs / 1000).toFixed(1)} s` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}
        {breakdown ? (
          <>
            <Categories breakdown={breakdown} />
            <ContributorTable title="MCP tools" rows={breakdown.mcpTools} sourceHeader="Server" max={breakdown.maxTokens} />
            <ContributorTable title="Memory files" rows={breakdown.memoryFiles} sourceHeader="Type" max={breakdown.maxTokens} />
            <ContributorTable title="Skills" rows={breakdown.skills} sourceHeader="Source" max={breakdown.maxTokens} />
            {breakdown.note && <p className="muted small-text">{breakdown.note}</p>}
            <details className="ctx-raw">
              <summary className="muted small-text">Raw report</summary>
              <pre>{breakdown.text}</pre>
            </details>
          </>
        ) : (
          <section className="ctx-section">
            <p className="muted">
              The breakdown (system prompt, tools, memory files, skills, messages) is the Agent's own <code>/context</code> report. Take one when the
              Session is idle; it is not part of the conversation and does not cost a model call.
            </p>
          </section>
        )}
        <History context={context} />
        <Requests session={session} calls={llmCalls} onInspect={onInspectLlmCall} />
      </div>
    </div>
  );
}
