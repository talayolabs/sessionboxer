import { WINDOWS_NO_SNAPSHOT, type Session, type Snapshot } from "@sessionboxer/protocol";
import { formatMb, formatTime } from "./format";
import { Modal } from "./ui";

/**
 * Opened from a Session's size line in the sidebar: the per-Session
 * auto-snapshot switch, the storage totals and every Snapshot with its size,
 * Fork and Delete, plus "Delete all" and "Rebuild Sandbox" (recovery for a Sandbox
 * whose image lost content in Docker and can no longer be committed).
 */
export function SnapshotsDialog({
  session,
  snapshots,
  globalAutoSnapshot,
  snapshotting,
  notice,
  onDismissNotice,
  onAutoSnapshotChange,
  onSnapshotNow,
  onRebuild,
  onFork,
  onDelete,
  onDeleteAll,
  onClose,
}: {
  session: Session;
  /** `null` while loading. */
  snapshots: Snapshot[] | null;
  globalAutoSnapshot: boolean;
  snapshotting: boolean;
  /** Error/feedback from the last action, shown inside the dialog (the page banner sits behind the backdrop). */
  notice: string | null;
  onDismissNotice: () => void;
  /** `null` clears the per-Session override. */
  onAutoSnapshotChange: (value: boolean | null) => void;
  onSnapshotNow: () => void;
  onRebuild: () => void;
  onFork: (snapshot: Snapshot) => void;
  onDelete: (snapshot: Snapshot) => void;
  onDeleteAll: () => void;
  onClose: () => void;
}) {
  const effective = session.settings.autoSnapshot ?? globalAutoSnapshot;
  const overridden = session.settings.autoSnapshot !== null;
  const windows = session.settings.sandbox.environment === "qemu-windows";
  const isLive = !windows && (session.status === "idle" || session.status === "running");
  const canRebuild = !windows && (session.status === "idle" || session.status === "stopped" || session.status === "error");
  const rebuilding = session.status === "creating" && snapshotting;
  const list = snapshots ? [...snapshots].reverse() : [];

  return (
    <Modal className="snapshots-dialog" title={`Snapshots of "${session.title}"`} onClose={onClose}>
      {notice && (
        <div className="banner banner-error dialog-banner" role="alert" onClick={onDismissNotice} title="Dismiss">
          {notice}
        </div>
      )}
      <label className="check switch">
        <input type="checkbox" checked={effective} onChange={(e) => onAutoSnapshotChange(e.target.checked)} />
        <span className="slider" aria-hidden="true" />
        Snapshot automatically after every completed turn
        <span className="muted switch-hint">
          {overridden ? (
            <>
              overrides Global settings ({globalAutoSnapshot ? "on" : "off"}){" \u00b7 "}
              <button type="button" className="link" onClick={() => onAutoSnapshotChange(null)}>
                use default
              </button>
            </>
          ) : (
            "Settings default"
          )}
        </span>
      </label>
      {windows && <p className="muted">{WINDOWS_NO_SNAPSHOT}</p>}
      <p className="muted">
        Machine: {session.diskBytes === null ? "unknown" : formatMb(session.diskBytes)} on top of its image
        {" \u00b7 "}
        Snapshots: {formatMb(session.snapshotBytes)} in {session.snapshotCount}
        {session.snapshotCount === 1 ? " snapshot" : " snapshots"}
      </p>
      <ul className="snapshot-list" aria-busy={snapshots === null}>
        {snapshots === null && <li className="empty">Loading\u2026</li>}
        {snapshots?.length === 0 && <li className="empty">No snapshots yet.</li>}
        {list.map((s) => (
          <li key={s.id}>
            <span className="snapshot-name">
              {"\u{1F4F7}"} #{s.ordinal}
              {s.reason === "manual" && <span className="muted"> manual</span>}
              {s.reason === "rebuild" && (
                <span className="muted" title="Full image of the Sandbox's filesystem it was rebuilt from">
                  {" "}
                  rebuild
                </span>
              )}
            </span>
            <span className="muted">{formatTime(s.createdAt)}</span>
            <span className="snapshot-size">{formatMb(s.sizeBytes)}</span>
            {s.queuedMessages.length > 0 && (
              <span className="muted" title="Messages in the queue when the snapshot was taken">
                {s.queuedMessages.length} queued
              </span>
            )}
            <span className="spacer" />
            <button type="button" className="small" onClick={() => onFork(s)} title="New Session and Sandbox from this snapshot">
              Fork
            </button>
            <button type="button" className="small danger" onClick={() => onDelete(s)} title="Delete this snapshot's image">
              Delete
            </button>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button
          type="button"
          className="danger"
          disabled={!snapshots || snapshots.length === 0}
          onClick={onDeleteAll}
          title="Delete every snapshot of this Session (ones a fork was started from are kept)"
        >
          Delete all
        </button>
        <button
          type="button"
          disabled={!canRebuild || snapshotting}
          onClick={onRebuild}
          title={
            windows
              ? WINDOWS_NO_SNAPSHOT
              : "Move the Session onto a new Sandbox built from a full image of the current one's filesystem: the fix when snapshots fail with a missing content digest. Takes minutes."
          }
        >
          {rebuilding ? "Rebuilding\u2026" : "Rebuild Sandbox"}
        </button>
        <span className="spacer" />
        <button
          type="button"
          disabled={!isLive || snapshotting}
          onClick={onSnapshotNow}
          title={windows ? WINDOWS_NO_SNAPSHOT : isLive ? "docker commit the Sandbox now" : "Snapshots need a running Sandbox"}
        >
          {snapshotting ? "Snapshotting\u2026" : "Snapshot now"}
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
