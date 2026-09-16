import { useEffect, useState } from "react";
import type { ForkSessionRequest, SavedMessage, Session, Snapshot } from "@sessionboxer/protocol";
import { formatMb, formatTime } from "./format";

const PREVIEW_CHARS = 120;

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS)}\u2026` : oneLine;
}

/**
 * "Fork from a snapshot": pick the Snapshot (fork point), what the fork's first
 * message is (one of the queued messages at that point, the current queue, a new
 * prompt, or nothing) and whether the rest of the queue is copied over. The
 * origin Session and its queue are never modified.
 */
export function ForkDialog({
  session,
  snapshots,
  saved,
  initialSnapshotId,
  onSubmit,
  onClose,
  busy,
}: {
  session: Session;
  snapshots: Snapshot[];
  /** The origin's current saved messages, offered next to the ones stored with the Snapshot. */
  saved: SavedMessage[];
  initialSnapshotId: string;
  onSubmit: (req: ForkSessionRequest) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [snapshotId, setSnapshotId] = useState(initialSnapshotId);
  const [title, setTitle] = useState("");
  const [first, setFirst] = useState<"none" | "custom" | `q${number}`>("none");
  const [custom, setCustom] = useState("");
  const [copyRest, setCopyRest] = useState(false);

  const snapshot = snapshots.find((s) => s.id === snapshotId) ?? snapshots[snapshots.length - 1];
  // Messages queued when the Snapshot was taken, then whatever is queued now that wasn't already there.
  const candidates = snapshot
    ? [...snapshot.queuedMessages, ...saved.map((m) => m.text).filter((t) => !snapshot.queuedMessages.includes(t))]
    : saved.map((m) => m.text);
  const snapshotCount = snapshot?.queuedMessages.length ?? 0;

  useEffect(() => {
    if (first.startsWith("q") && Number(first.slice(1)) >= candidates.length) setFirst("none");
  }, [first, candidates.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!snapshot) return null;

  const pickedIndex = first.startsWith("q") ? Number(first.slice(1)) : -1;
  const prompt = first === "custom" ? custom.trim() : pickedIndex >= 0 ? candidates[pickedIndex] : "";
  const others = candidates.filter((_, i) => i !== pickedIndex);
  const rest = copyRest ? others : [];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      snapshotId: snapshot.id,
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(prompt ? { prompt } : {}),
      savedMessages: rest,
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal panel" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="fork-title">
        <h2 id="fork-title">Fork "{session.title}"</h2>
        <p className="muted">
          A new Session with its own Sandbox started from the snapshot image: same files, installed tools and
          conversation up to that point. The original Session, its Sandbox and its queue are left as they are.
        </p>
        <label>
          Fork point
          <select value={snapshot.id} onChange={(e) => setSnapshotId(e.target.value)}>
            {[...snapshots].reverse().map((s) => (
              <option key={s.id} value={s.id}>
                #{s.ordinal}
                {s.reason === "manual" ? " (manual)" : ""} {"\u00b7"} {formatTime(s.createdAt)} {"\u00b7"} {formatMb(s.sizeBytes)}
                {s.queuedMessages.length > 0 ? ` \u00b7 ${s.queuedMessages.length} queued` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Title (optional)
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${session.title} (fork ${snapshot.ordinal})`} />
        </label>
        <fieldset className="choice">
          <legend>First message in the fork</legend>
          <label className="check">
            <input type="radio" name="first" checked={first === "none"} onChange={() => setFirst("none")} />
            Nothing, just open the fork
          </label>
          {candidates.map((text, i) => (
            <label className="check" key={i} title={text}>
              <input type="radio" name="first" checked={first === `q${i}`} onChange={() => setFirst(`q${i}`)} />
              <span className="choice-text">
                <span className="muted">{i < snapshotCount ? "queued at the snapshot: " : "queued now: "}</span>
                {preview(text)}
              </span>
            </label>
          ))}
          <label className="check">
            <input type="radio" name="first" checked={first === "custom"} onChange={() => setFirst("custom")} />
            A new message
          </label>
          {first === "custom" && <textarea rows={4} autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} />}
        </fieldset>
        {others.length > 0 && (
          <label className="check">
            <input type="checkbox" checked={copyRest} onChange={(e) => setCopyRest(e.target.checked)} />
            Copy the {pickedIndex >= 0 ? "other " : ""}
            {others.length} queued message{others.length === 1 ? "" : "s"} to the fork's "Saved for later"
          </label>
        )}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || (first === "custom" && !custom.trim())}>
            {busy ? "Forking\u2026" : "Fork"}
          </button>
        </div>
      </form>
    </div>
  );
}
