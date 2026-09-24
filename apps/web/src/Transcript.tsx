import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { branchScope, type Branch, type E2eRunSummary, type LlmCall, type Snapshot, type ToolCallContent } from "@sessionboxer/protocol";
import { UploadedAttachments } from "./Attachments";
import { formatCost, formatTokens, type Compaction, type TurnStats } from "./context-model";
import { CopyableMessage } from "./CopyMessage";
import { formatDuration } from "./E2e";
import { formatRelative, formatRfc5322, useClock } from "./time";
import { FileLink } from "./FileLink";
import { knownFileRef, splitFileRefs, type FileRef } from "./file-links";
import { formatMb, formatTime } from "./format";
import { Icon } from "./Icons";
import { callFacts } from "./LlmCallDialog";
import { Markdown } from "./Markdown";
import type { DividerRef } from "./BranchTree";
import type { TranscriptItem } from "./transcript-model";

export interface SnapshotActions {
  onFork: (snapshot: Snapshot) => void;
  onDelete: (snapshot: Snapshot) => void;
}

export interface BranchActions {
  onRevert: (seq: number) => void;
  onSwitch: (branchId: string) => void;
}

/** Conversation branches as seen from the active one, for the turn dividers. */
interface BranchView {
  branches: Branch[];
  activeBranchId: string;
  /** Branches that fork off at (branchId, seq) of the visible transcript. */
  forksAt: (branchId: string, seq: number) => Branch[];
  /** The ancestor whose own continuation resumes past (branchId, seq), if this is where the active lineage left it. */
  leftAt: (branchId: string, seq: number) => Branch | null;
  /** Idle, live Session: branching allowed right now. */
  canBranch: boolean;
  busy: boolean;
}

function useBranchView(branches: Branch[], activeBranchId: string, canBranch: boolean, busy: boolean): BranchView {
  return useMemo(() => {
    const scope = branchScope(branches, activeBranchId);
    return {
      branches,
      activeBranchId,
      forksAt: (branchId, seq) => branches.filter((b) => b.parentId === branchId && b.forkedAtSeq === seq && b.id !== activeBranchId),
      leftAt: (branchId, seq) => {
        if (branchId === activeBranchId) return null;
        const entry = scope.find((s) => s.branchId === branchId);
        if (!entry || entry.uptoSeq !== seq) return null;
        return branches.find((b) => b.id === branchId) ?? null;
      },
      canBranch,
      busy,
    };
  }, [branches, activeBranchId, canBranch, busy]);
}

function TurnDivider({
  item,
  view,
  actions,
}: {
  item: Extract<TranscriptItem, { kind: "turn_ended" }>;
  view: BranchView;
  actions: BranchActions;
}) {
  const forks = view.forksAt(item.branchId, item.seq);
  const left = view.leftAt(item.branchId, item.seq);
  const disabled = !view.canBranch || view.busy;
  const why = view.busy ? "Switching branch…" : view.canBranch ? undefined : "Wait for the Agent to finish (needs a running, idle Session)";
  return (
    <div className={`turn-divider${item.tail ? " turn-divider-tail" : ""}`} data-branch={item.branchId} data-seq={item.seq}>
      <span className="turn-divider-line" />
      <span className="turn-divider-label" title={formatRfc5322(item.ts)}>
        {item.stopReason === "end_turn" ? "turn ended" : `turn ended (${item.stopReason})`} {formatTime(item.ts)}
      </span>
      <TurnStatsLabel stats={item.stats} />
      {!item.tail && (
        <button
          type="button"
          className="small"
          disabled={disabled}
          title={why ?? "Continue the conversation from here; what follows is kept as a branch you can switch back to"}
          onClick={() => actions.onRevert(item.seq)}
        >
          {"\u21B6"} Revert to here
        </button>
      )}
      {left && (
        <button
          type="button"
          className="small"
          disabled={disabled}
          title={why ?? `Back to how the conversation went on in "${left.name}"`}
          onClick={() => actions.onSwitch(left.id)}
        >
          {"\u21AA"} Continue on {left.name}
        </button>
      )}
      {forks.map((b) => (
        <button
          key={b.id}
          type="button"
          className="small"
          disabled={disabled}
          title={why ?? `Switch to "${b.name}" (${b.method === "fork" ? "forked" : "replayed"} from this point ${formatTime(b.createdAt)})`}
          onClick={() => actions.onSwitch(b.id)}
        >
          {"\u2387"} {b.name}
        </button>
      ))}
      <span className="turn-divider-line" />
    </div>
  );
}

/** What the turn cost, on its divider: context movement, model calls, tokens in/out, money. */
function TurnStatsLabel({ stats }: { stats: TurnStats }) {
  const parts: Array<{ text: string; title: string }> = [];
  if (stats.contextUsed !== null) {
    const delta = stats.contextDelta;
    parts.push({
      text: delta === null ? `context ${formatTokens(stats.contextUsed)}` : `${delta >= 0 ? "+" : "\u2212"}${formatTokens(Math.abs(delta))} context`,
      title: `Context window after this turn: ${stats.contextUsed.toLocaleString()} tokens${delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${delta.toLocaleString()} over the turn)`}`,
    });
  }
  if (stats.calls > 0) parts.push({ text: `${stats.calls} model ${stats.calls === 1 ? "call" : "calls"}`, title: "Replies from the model in this turn (one per tool-call round)" });
  const u = stats.usage;
  if (u) {
    const cached = (u.cachedReadTokens ?? 0) > 0 ? ` / cached ${formatTokens(u.cachedReadTokens ?? 0)}` : "";
    const written = (u.cachedWriteTokens ?? 0) > 0 ? ` / written ${formatTokens(u.cachedWriteTokens ?? 0)}` : "";
    parts.push({
      text: `in ${formatTokens(u.inputTokens)}${cached}${written} / out ${formatTokens(u.outputTokens)}`,
      title:
        `Tokens this turn — input ${u.inputTokens.toLocaleString()}` +
        (u.cachedReadTokens ? `, read from cache ${u.cachedReadTokens.toLocaleString()}` : "") +
        (u.cachedWriteTokens ? `, written to cache ${u.cachedWriteTokens.toLocaleString()}` : "") +
        `, output ${u.outputTokens.toLocaleString()}` +
        (u.thoughtTokens ? ` (thinking ${u.thoughtTokens.toLocaleString()})` : ""),
    });
  }
  if (stats.costDelta !== null && stats.costDelta > 0) parts.push({ text: formatCost(stats.costDelta), title: "What this turn cost, as the Agent reports it" });
  if (parts.length === 0) return null;
  return (
    <span className="turn-stats">
      {parts.map((p, i) => (
        <span key={i} title={p.title}>
          {i > 0 && <span className="turn-stats-sep">{"\u00b7"}</span>}
          {p.text}
        </span>
      ))}
    </span>
  );
}

function CompactionMarker({ compaction: c, index, onInspect }: { compaction: Compaction; index: number; onInspect: (index: number, compaction: Compaction) => void }) {
  const what = c.status === "completed" ? "Context compacted" : c.status === "failed" ? "Context compaction failed" : "Compacting context\u2026";
  const sizes = c.preTokens !== null && c.postTokens !== null ? ` ${formatTokens(c.preTokens)} \u2192 ${formatTokens(c.postTokens)}` : c.preTokens !== null ? ` from ${formatTokens(c.preTokens)}` : c.postTokens !== null ? ` \u2192 ${formatTokens(c.postTokens)}` : "";
  const how = c.trigger === "automatic" ? " (automatic)" : c.trigger === "manual" ? " (manual)" : "";
  const duration = c.durationMs !== null ? `${(c.durationMs / 1000).toFixed(1)} s` : null;
  if (c.status !== "completed") {
    return (
      <div className={`marker marker-compaction${c.status === "failed" ? " marker-error" : ""}`} title={duration ?? undefined}>
        {"\u267B"} {what}
        {sizes}
        {how}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="marker marker-compaction marker-compaction-button"
      title={`${duration ? `${duration} \u00b7 ` : ""}Click to see what was compacted away and the summary that replaced it`}
      onClick={() => onInspect(index, c)}
    >
      {"\u267B"} {what}
      {sizes}
      {how}: the Agent replaced the older conversation with a summary. <span className="marker-compaction-link">What did it drop?</span>
    </button>
  );
}

function ToolContent({ content }: { content: ToolCallContent }) {
  switch (content.type) {
    case "content":
      if (content.content.type === "image") {
        return (
          <img
            className="screenshot"
            alt="screenshot"
            src={`data:${content.content.mimeType};base64,${content.content.data}`}
          />
        );
      }
      if (content.content.type === "text") return <pre>{content.content.text}</pre>;
      return <pre>{JSON.stringify(content.content, null, 2)}</pre>;
    case "diff": {
      const ref = knownFileRef(content.path);
      return (
        <pre>
          <b>{ref ? <FileLink fileRef={ref}>{content.path}</FileLink> : content.path}</b>
          {"\n"}
          {content.newText}
        </pre>
      );
    }
    case "terminal":
      return <pre>[terminal {content.terminalId}]</pre>;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The file named in a tool's raw input (`file_path`, with Claude's `offset` as the line for reads). */
function inputFileRef(rawInput: unknown): FileRef | null {
  if (!isRecord(rawInput)) return null;
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = rawInput[key];
    if (typeof value !== "string" || value === "") continue;
    const offset = rawInput.offset;
    return knownFileRef(value, typeof offset === "number" ? offset : null);
  }
  return null;
}

/** The file a tool call worked on, for the header link: ACP `locations`, the raw input, a diff's path. */
function toolFileRef(item: Extract<TranscriptItem, { kind: "tool" }>): FileRef | null {
  const location = item.locations[0];
  if (location) {
    const ref = knownFileRef(location.path, location.line);
    if (ref) return ref;
  }
  const fromInput = inputFileRef(item.rawInput);
  if (fromInput) return fromInput;
  for (const c of item.content) {
    if (c.type !== "diff") continue;
    const ref = knownFileRef(c.path);
    if (ref) return ref;
  }
  return null;
}

/** Tool title with the paths it names clickable; the tool's file appended when the title has none. */
function ToolTitle({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const parts = splitFileRefs(item.title);
  const linked = parts.some((p) => typeof p !== "string");
  const ref = linked ? null : toolFileRef(item);
  return (
    <span className="tool-title">
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <FileLink key={i} fileRef={p.ref}>
            {p.text}
          </FileLink>
        ),
      )}
      {ref && (
        <>
          {" "}
          <FileLink fileRef={ref} className="tool-file">
            {ref.path}
            {ref.line !== undefined ? `:${ref.line}` : ""}
          </FileLink>
        </>
      )}
    </span>
  );
}

function ToolCall({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const images = item.content.filter((c) => c.type === "content" && c.content.type === "image");
  const rest = item.content.filter((c) => !(c.type === "content" && c.content.type === "image"));
  return (
    <div className={`tool tool-${item.status}`}>
      <button className="tool-header" onClick={() => setOpen(!open)}>
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
        {images.length > 0 && (
          <span className="tool-image" title={images.length === 1 ? "1 screenshot inside" : `${images.length} screenshots inside`}>
            <Icon name="image" />
          </span>
        )}
        <span className="tool-kind">{item.toolKind}</span>
        <ToolTitle item={item} />
        <span className="tool-status">{item.status}</span>
      </button>
      {open && (
        <div className="tool-body">
          {images.map((c, i) => (
            <ToolContent key={i} content={c} />
          ))}
          {item.rawInput !== undefined && (
            <details open>
              <summary>input</summary>
              <pre>{JSON.stringify(item.rawInput, null, 2)}</pre>
            </details>
          )}
          {rest.map((c, i) => (
            <ToolContent key={i} content={c} />
          ))}
          {rest.length === 0 && item.rawOutput !== undefined && (
            <details>
              <summary>output</summary>
              <pre>{typeof item.rawOutput === "string" ? item.rawOutput : JSON.stringify(item.rawOutput, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function SnapshotMarker({ snapshot, actions }: { snapshot: Snapshot; actions: SnapshotActions }) {
  return (
    <div className="marker marker-snapshot" title={`${snapshot.imageTag}\n${new Date(snapshot.createdAt).toLocaleString()}`}>
      <span>
        {"\u{1F4F7} "}Snapshot #{snapshot.ordinal}
        {snapshot.reason === "manual" ? " (manual)" : ""}
        {" \u00b7 "}
        {formatMb(snapshot.sizeBytes)}
        {" \u00b7 "}
        {formatTime(snapshot.createdAt)}
      </span>
      <button type="button" className="small" title="Start a new Session and Sandbox from this point" onClick={() => actions.onFork(snapshot)}>
        Fork from here
      </button>
      <button type="button" className="small" title="Delete this snapshot image" onClick={() => actions.onDelete(snapshot)}>
        {"\u2715"}
      </button>
    </div>
  );
}

/**
 * The tab over the top-left edge of the first bubble that came out of a model API call
 * (Claude with inspection on): opens the call's exact request and response.
 */
function LlmTab({ call, onInspect }: { call: LlmCall; onInspect: (call: LlmCall) => void }) {
  return (
    <button
      type="button"
      className={`llm-tab${call.error ? " llm-tab-error" : ""}`}
      title={`Model API call #${call.ordinal}: ${callFacts(call).join(" \u00b7 ")}\nClick to see exactly what was sent and what came back`}
      aria-label={`Show model API call ${call.ordinal}`}
      onClick={() => onInspect(call)}
    >
      LLM #{call.ordinal}
    </button>
  );
}

/** When a message was sent, as people say it; the exact RFC 5322 date on hover. */
function Timestamp({ ts }: { ts: string }) {
  const now = useClock();
  return (
    <time className="msg-time" dateTime={ts} title={formatRfc5322(ts)}>
      {formatRelative(ts, now)}
    </time>
  );
}

/** Ticks every second while `live`; the time since `from`. */
function useElapsed(from: number, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return Math.max(0, now - from);
}

function Item({
  item,
  actions,
  branchActions,
  branchView,
  onInspectCompaction,
  onInspectLlmCall,
  onOpenE2e,
  llmTab,
}: {
  item: TranscriptItem;
  actions: SnapshotActions;
  branchActions: BranchActions;
  branchView: BranchView;
  onInspectCompaction: (index: number, compaction: Compaction) => void;
  onInspectLlmCall: (call: LlmCall) => void;
  onOpenE2e: (runId: string | null) => void;
  /** This item is the first of its model call's output: show the call's tab over it. */
  llmTab: boolean;
}) {
  if (llmTab && (item.kind === "agent" || item.kind === "thought" || item.kind === "tool") && item.llmCall) {
    return (
      <div className="llm-labelled">
        <LlmTab call={item.llmCall} onInspect={onInspectLlmCall} />
        <Item
          item={item}
          actions={actions}
          branchActions={branchActions}
          branchView={branchView}
          onInspectCompaction={onInspectCompaction}
          onInspectLlmCall={onInspectLlmCall}
          onOpenE2e={onOpenE2e}
          llmTab={false}
        />
      </div>
    );
  }
  switch (item.kind) {
    case "user":
      return (
        <CopyableMessage className="msg-user" text={item.text} footer={<Timestamp ts={item.ts} />}>
          {item.text.trim() !== "" && <Markdown text={item.text} />}
          {item.attachments && <UploadedAttachments attachments={item.attachments} />}
        </CopyableMessage>
      );
    case "agent":
      return (
        <CopyableMessage className="msg-agent" text={item.text} footer={<Timestamp ts={item.ts} />}>
          <Markdown text={item.text} attachments />
        </CopyableMessage>
      );
    case "thought":
      return (
        <details className="thought">
          <summary>thinking</summary>
          <Markdown text={item.text} />
        </details>
      );
    case "tool":
      return <ToolCall item={item} />;
    case "plan":
      return (
        <ul className="plan">
          {item.entries.map((e, i) => (
            <li key={i} className={`plan-${e.status}`}>
              {e.content}
            </li>
          ))}
        </ul>
      );
    case "turn_ended":
      return <TurnDivider item={item} view={branchView} actions={branchActions} />;
    case "compaction":
      return <CompactionMarker compaction={item.compaction} index={item.index} onInspect={onInspectCompaction} />;
    case "context_report":
      return (
        <div className="marker">
          Context inspected
          {item.totalTokens !== null && item.maxTokens !== null
            ? `: ${formatTokens(item.totalTokens)} / ${formatTokens(item.maxTokens)}${item.percent !== null ? ` (${item.percent}%)` : ""}`
            : ""}
        </div>
      );
    case "error":
      return <div className="marker marker-error">{item.message}</div>;
    case "status":
      return (
        <div className={`marker${item.error ? " marker-error" : ""}`}>
          {item.status}
          {item.error ? `: ${item.error}` : ""}
        </div>
      );
    case "snapshot":
      return <SnapshotMarker snapshot={item.snapshot} actions={actions} />;
    case "forked":
      return (
        <div className="marker marker-forked">
          Forked from <a href={`#/sessions/${item.fromSessionId}`}>{item.fromTitle}</a> at snapshot #{item.snapshotOrdinal}:{" "}
          {item.newConversation
            ? "same files and tools, new conversation; changes below stay in this Session."
            : "same files, tools and conversation up to here; changes below stay in this Session."}
        </div>
      );
    case "mcp_changed":
      return (
        <div className="marker">
          MCP servers now: {item.servers.length === 0 ? "desktop only" : `desktop, ${item.servers.join(", ")}`}
        </div>
      );
    case "model_changed":
      return (
        <div className="marker" title={item.model}>
          Model now: {item.name}
        </div>
      );
    case "option_changed":
      return (
        <div className="marker" title={`${item.option} = ${item.value}`}>
          {item.option} now: {item.valueName}
        </div>
      );
    case "repo_changed":
      return (
        <div className="marker" title={item.origin}>
          Repository {item.action}: <code>/workspace/{item.name}</code> ({item.origin})
        </div>
      );
    case "e2e_prompt":
      return (
        <button type="button" className="marker marker-e2e marker-button" title="The Control Plane asked the Agent to verify the turn above end to end. Click to open the Verification pane." onClick={() => onOpenE2e(null)}>
          Verifying the turn end to end…
        </button>
      );
    case "e2e_run":
      return <E2eMarker run={item.run} onOpen={() => onOpenE2e(item.run.runId)} />;
  }
}

/** `Verified: 4/4 passed · 2:13 · video`; opens the Verification pane on that run. */
function E2eMarker({ run, onOpen }: { run: E2eRunSummary; onOpen: () => void }) {
  let text: string;
  switch (run.status) {
    case "skipped":
      text = `Verification skipped: ${run.skipReason ?? "nothing testable changed"}`;
      break;
    case "aborted":
      text = `Verification aborted: ${run.skipReason ?? "the verification turn did not finish"}`;
      break;
    default:
      text = `Verified: ${run.passed}/${run.total} passed · ${formatDuration(run.durationMs)}${run.cycles > 1 ? ` · ${run.cycles} cycles` : ""}${run.videoPath ? " · video" : ""}`;
  }
  return (
    <button type="button" className={`marker marker-e2e marker-button marker-e2e-${run.status}`} title="Open the Verification pane on this run" onClick={onOpen}>
      {text}
    </button>
  );
}

/** What the Agent produces within a turn; consecutive runs of these fold into one group. */
function isAgentSide(item: TranscriptItem): item is Extract<TranscriptItem, { kind: "agent" | "thought" | "tool" | "plan" }> {
  return item.kind === "agent" || item.kind === "thought" || item.kind === "tool" || item.kind === "plan";
}

type Row = { kind: "item"; index: number } | { kind: "group"; key: string; indices: number[]; live: boolean; startedAt: string; endedAt: string | null };

function itemTs(item: TranscriptItem | undefined): string | null {
  return item && "ts" in item ? item.ts : null;
}

/**
 * Consecutive Agent-side items become one group: always while the Agent is still working on
 * the tail of the transcript (so the whole turn sits behind one spinner), otherwise once there
 * are at least two of them (a lone message is its own summary).
 */
function groupRows(items: TranscriptItem[], running: boolean): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < items.length; ) {
    const item = items[i];
    if (!item || !isAgentSide(item)) {
      rows.push({ kind: "item", index: i });
      i++;
      continue;
    }
    const indices: number[] = [];
    for (let j = i; j < items.length; j++) {
      const next = items[j];
      if (!next || !isAgentSide(next)) break;
      indices.push(j);
    }
    const last = indices[indices.length - 1] ?? i;
    const live = running && last === items.length - 1;
    // The turn's end (or whatever stopped it) follows the group; the time it took runs to there.
    const endedAt = live ? null : itemTs(items[last + 1]);
    if (live || indices.length > 1) rows.push({ kind: "group", key: `g${item.key}`, indices, live, startedAt: item.ts, endedAt });
    else rows.push({ kind: "item", index: i });
    i += indices.length;
  }
  return rows;
}

/** GitHub-style squiggly rule with the fold's button in the middle. */
function FoldDivider({ live, label, expanded, onToggle }: { live: boolean; label: string; expanded: boolean; onToggle: () => void }) {
  return (
    <div className={`fold-divider${live ? " fold-live" : ""}`}>
      <span className="fold-line" />
      <button type="button" className="fold-toggle" onClick={onToggle} title={expanded ? "Fold these messages back into one" : "Show every message the Agent sent"}>
        {live && <span className="fold-spinner" aria-label="working" />}
        {label}
        <span className="fold-chevron">{expanded ? "▴" : "▾"}</span>
      </button>
      <span className="fold-line" />
    </div>
  );
}

/**
 * The Agent's messages of one turn behind a single rule: while it works, a spinner and the count;
 * once the turn ended, only the last message (its summary) shows; open to see them all.
 */
function AgentGroup({
  items,
  indices,
  live,
  startedAt,
  endedAt,
  expanded,
  onToggle,
  render,
}: {
  items: TranscriptItem[];
  indices: number[];
  live: boolean;
  startedAt: string;
  endedAt: string | null;
  expanded: boolean;
  onToggle: () => void;
  render: (index: number) => ReactNode;
}) {
  const n = indices.length;
  const plural = n === 1 ? "message" : "messages";
  const elapsed = useElapsed(new Date(startedAt).getTime(), live);
  const took = live ? elapsed : endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : null;
  const time = took !== null && Number.isFinite(took) ? ` · ${formatDuration(took)}` : "";
  const label = live ? `Working… ${n} ${plural} so far${time}` : expanded ? `Fold ${n} ${plural}${time}` : `Show all ${n} ${plural}${time}`;
  const summary = live ? -1 : ([...indices].reverse().find((i) => items[i]?.kind === "agent") ?? indices[n - 1] ?? -1);
  return (
    <div className="fold">
      <FoldDivider live={live} label={label} expanded={expanded} onToggle={onToggle} />
      {expanded ? indices.map(render) : summary >= 0 && render(summary)}
      {expanded && n > 3 && <FoldDivider live={live} label={label} expanded={expanded} onToggle={onToggle} />}
    </div>
  );
}

/** How far from the bottom (px) still counts as "at the bottom", so a trackpad flick does not unpin the view. */
const FOLLOW_SLACK_PX = 32;

export function Transcript({
  items,
  actions,
  branchActions,
  branches,
  activeBranchId,
  canBranch,
  branchBusy,
  running,
  focus,
  onFocused,
  onInspectCompaction,
  onInspectLlmCall,
  onOpenE2e,
}: {
  items: TranscriptItem[];
  actions: SnapshotActions;
  branchActions: BranchActions;
  branches: Branch[];
  activeBranchId: string;
  canBranch: boolean;
  branchBusy: boolean;
  /** The Agent is on a turn: its messages at the tail fold behind a spinner. */
  running: boolean;
  /** Turn divider to scroll to and highlight once it is rendered. */
  focus: DividerRef | null;
  onFocused: () => void;
  /** A completed compaction marker was clicked: `index` counts completed compactions before it. */
  onInspectCompaction: (index: number, compaction: Compaction) => void;
  /** An `LLM #n` tab was clicked. */
  onInspectLlmCall: (call: LlmCall) => void;
  /** A verification marker was clicked: open the Verification pane on that run (`null` = the latest). */
  onOpenE2e: (runId: string | null) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const branchView = useBranchView(branches, activeBranchId, canBranch, branchBusy);
  const rows = useMemo(() => groupRows(items, running), [items, running]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // The view follows new content only while the reader is at the bottom; scrolling up pins it
  // where it is until they scroll back down or press the button. `following` is a ref for the
  // resize/scroll handlers, mirrored in state for the button.
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  const [pinned, setPinned] = useState(false);
  const scrollToBottom = useCallback(() => {
    const el = root.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const follow = useCallback(() => {
    following.current = true;
    setPinned(false);
    scrollToBottom();
  }, [scrollToBottom]);
  // Content growing under a following view leaves scrollTop where it was (the observer below
  // catches up a frame later), so only a scroll that moved *up* is the reader taking over.
  const setFollowing = (next: boolean) => {
    if (next === following.current) return;
    following.current = next;
    setPinned(!next);
  };
  const atBottom = (el: HTMLDivElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  const onScroll = () => {
    const el = root.current;
    if (!el) return;
    const movedUp = el.scrollTop < lastScrollTop.current;
    lastScrollTop.current = el.scrollTop;
    setFollowing(atBottom(el) ? true : movedUp ? false : following.current);
  };
  // Content grows without `items` changing too (streaming text, images and diagrams loading),
  // so keep the bottom in view on any size change of the list while following.
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToBottom();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollToBottom]);
  useEffect(() => {
    if (following.current) scrollToBottom();
  }, [items, scrollToBottom]);
  useEffect(() => {
    if (!focus) return;
    const el = root.current?.querySelector<HTMLElement>(`.turn-divider[data-branch="${focus.branchId}"][data-seq="${focus.seq}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    if (root.current) setFollowing(atBottom(root.current));
    el.classList.add("turn-divider-flash");
    setTimeout(() => el.classList.remove("turn-divider-flash"), 2000);
    onFocused();
  }, [items, focus, onFocused]);
  const renderItem = (i: number) => {
    const item = items[i];
    if (!item) return null;
    const call = item.kind === "agent" || item.kind === "thought" || item.kind === "tool" ? item.llmCall : undefined;
    const prev = items[i - 1];
    const prevCall = prev && (prev.kind === "agent" || prev.kind === "thought" || prev.kind === "tool") ? prev.llmCall : undefined;
    return (
      <Item
        key={item.key}
        item={item}
        actions={actions}
        branchActions={branchActions}
        branchView={branchView}
        onInspectCompaction={onInspectCompaction}
        onInspectLlmCall={onInspectLlmCall}
        onOpenE2e={onOpenE2e}
        llmTab={call !== undefined && call.id !== prevCall?.id}
      />
    );
  };
  return (
    <div className="transcript" ref={root} onScroll={onScroll}>
      <div className="transcript-items" ref={list}>
        {items.length === 0 && <div className="empty">No messages yet. Send a prompt below.</div>}
        {rows.map((row) =>
          row.kind === "item" ? (
            renderItem(row.index)
          ) : (
            <AgentGroup
              key={row.key}
              items={items}
              indices={row.indices}
              live={row.live}
              startedAt={row.startedAt}
              endedAt={row.endedAt}
              expanded={expanded.has(row.key)}
              onToggle={() => toggleGroup(row.key)}
              render={renderItem}
            />
          ),
        )}
      </div>
      {pinned && (
        <div className="transcript-jump">
          <button className="small" onClick={follow} title="Scroll to the latest message and follow new content">
            ↓ Latest
          </button>
        </div>
      )}
    </div>
  );
}
