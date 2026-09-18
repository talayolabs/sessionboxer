import { useEffect, useMemo, useRef, useState } from "react";
import { branchScope, type Branch, type Snapshot, type ToolCallContent } from "@sessionboxer/protocol";
import { CopyableMessage } from "./CopyMessage";
import { FileLink } from "./FileLink";
import { knownFileRef, splitFileRefs, type FileRef } from "./file-links";
import { formatMb, formatTime } from "./format";
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
      <span className="turn-divider-label" title={new Date(item.ts).toLocaleString()}>
        {item.stopReason === "end_turn" ? "turn ended" : `turn ended (${item.stopReason})`} {formatTime(item.ts)}
      </span>
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
        <span className="tool-kind">{item.toolKind}</span>
        <ToolTitle item={item} />
        <span className="tool-status">{item.status}</span>
      </button>
      {images.map((c, i) => (
        <ToolContent key={i} content={c} />
      ))}
      {open && (
        <div className="tool-body">
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

function Item({
  item,
  actions,
  branchActions,
  branchView,
}: {
  item: TranscriptItem;
  actions: SnapshotActions;
  branchActions: BranchActions;
  branchView: BranchView;
}) {
  switch (item.kind) {
    case "user":
      return (
        <CopyableMessage className="msg-user" text={item.text}>
          <Markdown text={item.text} />
        </CopyableMessage>
      );
    case "agent":
      return (
        <CopyableMessage className="msg-agent" text={item.text}>
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
          Forked from <a href={`#/sessions/${item.fromSessionId}`}>{item.fromTitle}</a> at snapshot #{item.snapshotOrdinal}: same
          files, tools and conversation up to here; changes below stay in this Session.
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
  }
}

export function Transcript({
  items,
  actions,
  branchActions,
  branches,
  activeBranchId,
  canBranch,
  branchBusy,
  focus,
  onFocused,
}: {
  items: TranscriptItem[];
  actions: SnapshotActions;
  branchActions: BranchActions;
  branches: Branch[];
  activeBranchId: string;
  canBranch: boolean;
  branchBusy: boolean;
  /** Turn divider to scroll to and highlight once it is rendered. */
  focus: DividerRef | null;
  onFocused: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const branchView = useBranchView(branches, activeBranchId, canBranch, branchBusy);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items]);
  useEffect(() => {
    if (!focus) return;
    const el = root.current?.querySelector<HTMLElement>(`.turn-divider[data-branch="${focus.branchId}"][data-seq="${focus.seq}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("turn-divider-flash");
    setTimeout(() => el.classList.remove("turn-divider-flash"), 2000);
    onFocused();
  }, [items, focus, onFocused]);
  return (
    <div className="transcript" ref={root}>
      {items.length === 0 && <div className="empty">No messages yet. Send a prompt below.</div>}
      {items.map((item) => (
        <Item key={item.key} item={item} actions={actions} branchActions={branchActions} branchView={branchView} />
      ))}
      <div ref={bottom} />
    </div>
  );
}
