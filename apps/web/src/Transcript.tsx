import { useEffect, useRef, useState } from "react";
import type { Snapshot, ToolCallContent } from "@sessionboxer/protocol";
import { formatMb, formatTime } from "./format";
import type { TranscriptItem } from "./transcript-model";

export interface SnapshotActions {
  onFork: (snapshot: Snapshot) => void;
  onDelete: (snapshot: Snapshot) => void;
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
    case "diff":
      return (
        <pre>
          <b>{content.path}</b>
          {"\n"}
          {content.newText}
        </pre>
      );
    case "terminal":
      return <pre>[terminal {content.terminalId}]</pre>;
  }
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
        <span className="tool-title">{item.title}</span>
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

function Item({ item, actions }: { item: TranscriptItem; actions: SnapshotActions }) {
  switch (item.kind) {
    case "user":
      return <div className="msg msg-user">{item.text}</div>;
    case "agent":
      return <div className="msg msg-agent">{item.text}</div>;
    case "thought":
      return (
        <details className="thought">
          <summary>thinking</summary>
          <div>{item.text}</div>
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
      return <div className="marker">turn ended ({item.stopReason})</div>;
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
  }
}

export function Transcript({ items, actions }: { items: TranscriptItem[]; actions: SnapshotActions }) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items]);
  return (
    <div className="transcript">
      {items.length === 0 && <div className="empty">No messages yet. Send a prompt below.</div>}
      {items.map((item) => (
        <Item key={item.key} item={item} actions={actions} />
      ))}
      <div ref={bottom} />
    </div>
  );
}
