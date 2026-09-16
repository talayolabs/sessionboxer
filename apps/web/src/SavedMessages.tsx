import { useState } from "react";
import type { SavedMessage } from "@sessionboxer/protocol";

const PREVIEW_CHARS = 140;

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS)}\u2026` : oneLine;
}

/**
 * The Session's "saved for later" prompts, in queue order. Collapsible so it takes one
 * line when not in use; the header holds the Play/Pause control for the queue.
 */
export function SavedMessages({
  messages,
  queueRunning,
  canSend,
  onLoad,
  onSend,
  onDelete,
  onMove,
  onQueueToggle,
}: {
  messages: SavedMessage[];
  queueRunning: boolean;
  /** The Session can take a prompt right now (idle) or soon (running). */
  canSend: boolean;
  onLoad: (m: SavedMessage) => void;
  onSend: (m: SavedMessage) => void;
  onDelete: (m: SavedMessage) => void;
  onMove: (m: SavedMessage, position: number) => void;
  onQueueToggle: (running: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (messages.length === 0 && !queueRunning) return null;

  return (
    <section className={`saved${queueRunning ? " playing" : ""}`} aria-label="Saved messages">
      <header className="saved-header">
        <button type="button" className="tb saved-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="chev">{open ? "\u25be" : "\u25b8"}</span>
          Saved for later ({messages.length})
        </button>
        {queueRunning && <span className="saved-status">Playing queue: next one is sent when the Agent finishes</span>}
        <span className="spacer" />
        {queueRunning ? (
          <button type="button" className="small" title="Stop after the current turn" onClick={() => onQueueToggle(false)}>
            {"\u23f8"} Pause
          </button>
        ) : (
          <button
            type="button"
            className="small primary"
            title="Send the saved messages one by one, each after the previous turn ends"
            disabled={!canSend || messages.length === 0}
            onClick={() => onQueueToggle(true)}
          >
            {"\u25b6"} Play all
          </button>
        )}
      </header>
      {open && (
        <ol className="saved-list">
          {messages.map((m, i) => (
            <li key={m.id} className={expanded === m.id ? "expanded" : ""}>
              <span className="saved-pos">{i + 1}.</span>
              <button
                type="button"
                className="saved-text"
                title={expanded === m.id ? "Collapse" : "Show the full message"}
                onClick={() => setExpanded((cur) => (cur === m.id ? null : m.id))}
              >
                {expanded === m.id ? <pre>{m.text}</pre> : preview(m.text)}
              </button>
              <span className="saved-actions">
                <button type="button" className="small" title="Move up" disabled={i === 0} onClick={() => onMove(m, i - 1)}>
                  {"\u2191"}
                </button>
                <button
                  type="button"
                  className="small"
                  title="Move down"
                  disabled={i === messages.length - 1}
                  onClick={() => onMove(m, i + 1)}
                >
                  {"\u2193"}
                </button>
                <button type="button" className="small" title="Put it in the composer (keeps it saved)" onClick={() => onLoad(m)}>
                  Load
                </button>
                <button type="button" className="small" title="Send it now and remove it from the list" disabled={!canSend} onClick={() => onSend(m)}>
                  Send
                </button>
                <button type="button" className="small danger" title="Delete" onClick={() => onDelete(m)}>
                  {"\u00d7"}
                </button>
              </span>
            </li>
          ))}
          {messages.length === 0 && <li className="empty">Queue drained.</li>}
        </ol>
      )}
    </section>
  );
}
