import { useCallback, useEffect, useState } from "react";
import type { Session, SyncEntry, SyncPlan, SyncResult } from "@sessionboxer/protocol";
import { api } from "./api";
import { formatBytes } from "./format";

const ACTION_MARK: Record<SyncEntry["action"], [mark: string, title: string]> = {
  add: ["+", "New in the box"],
  update: ["~", "Changed in the box"],
  delete: ["\u2212", "Deleted in the box"],
};

function summary(entries: SyncEntry[]): string {
  const n = (action: SyncEntry["action"]) => entries.filter((e) => e.action === action).length;
  const parts: string[] = [];
  if (n("add")) parts.push(`${n("add")} new`);
  if (n("update")) parts.push(`${n("update")} changed`);
  if (n("delete")) parts.push(`${n("delete")} deleted`);
  return parts.join(", ");
}

/**
 * "Pull changes to my folder" for a Session started from a copy of a host folder: shows what
 * the box would write into / remove from that folder (a dry run), flags files that changed on
 * the host too, and applies the rest on confirmation.
 */
export function SyncDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState<"plan" | "pull" | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);

  const refresh = useCallback(async () => {
    setBusy("plan");
    setError(null);
    try {
      setPlan(await api.syncPlan(session.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [session.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const folder = session.workspaceSource.type === "copy" ? session.workspaceSource.path : "";
  const conflicts = plan?.entries.filter((e) => e.conflict && e.blocked === null) ?? [];
  const applying = plan ? plan.entries.filter((e) => e.blocked === null && (overwrite || !e.conflict)) : [];
  const bytes = applying.reduce((sum, e) => sum + e.size, 0);

  const pull = async () => {
    if (!plan) return;
    if (overwrite && conflicts.length > 0) {
      const n = conflicts.length;
      if (!confirm(`Overwrite ${n} file${n === 1 ? "" : "s"} you changed on your machine with the box's version? This cannot be undone.`)) return;
    }
    setBusy("pull");
    setError(null);
    try {
      setResult(await api.syncPull(session.id, { overwriteLocal: overwrite }));
      setOverwrite(false);
      setPlan(await api.syncPlan(session.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal panel sync-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-title">
        <h2 id="sync-title">Pull changes to my folder</h2>
        <p className="muted">
          Copies what changed in the box's Workspace into <code title={folder}>{folder}</code>. Files ignored by git
          (node_modules, build output) and <code>.git</code> itself stay in the box; changes you made only on your machine
          are kept.
        </p>
        {error && (
          <div className="banner banner-error dialog-banner" role="alert" onClick={() => setError(null)} title="Dismiss">
            {error}
          </div>
        )}
        {result && (
          <div className="banner banner-ok dialog-banner" role="status">
            Pulled {result.added + result.updated + result.deleted} change{result.added + result.updated + result.deleted === 1 ? "" : "s"}
            {result.added + result.updated + result.deleted > 0 && (
              <>
                {" ("}
                {[
                  result.added && `${result.added} new`,
                  result.updated && `${result.updated} changed`,
                  result.deleted && `${result.deleted} deleted`,
                ]
                  .filter(Boolean)
                  .join(", ")}
                , {formatBytes(result.bytes)})
              </>
            )}
            {result.skipped > 0 && `; ${result.skipped} file${result.skipped === 1 ? "" : "s"} left alone`}.
          </div>
        )}
        {plan && !plan.threeWay && plan.entries.length > 0 && (
          <p className="muted warn">
            No record of what was copied into this box (older Session), so changes you made on your machine since then
            cannot be told apart: new and changed files will overwrite yours; deletions are listed as conflicts.
          </p>
        )}
        <ul className="sync-list" aria-busy={busy === "plan"}>
          {!plan && !error && <li className="empty">Comparing the box with your folder\u2026</li>}
          {plan?.entries.length === 0 && <li className="empty">Your folder already matches the box.</li>}
          {plan?.entries.map((e) => (
            <li key={e.path} className={e.blocked !== null || (e.conflict && !overwrite) ? "skipped" : undefined}>
              <span className={`sync-mark sync-${e.action}`} title={ACTION_MARK[e.action][1]}>
                {ACTION_MARK[e.action][0]}
              </span>
              <span className="sync-path" title={e.path}>
                {e.path}
              </span>
              {e.blocked !== null && (
                <span className="warn" title={e.blocked}>
                  not pulled: {e.blocked}
                </span>
              )}
              {e.conflict && e.blocked === null && (
                <span
                  className="warn"
                  title={
                    e.action === "delete"
                      ? plan.threeWay
                        ? "Changed on your machine since the copy; deleting would lose that"
                        : "Only on your machine; cannot tell whether the box deleted it or you added it"
                      : "Changed on your machine too; pulling would overwrite your version"
                  }
                >
                  {"\u26a0"} {overwrite ? "will overwrite yours" : "kept yours"}
                </span>
              )}
              {e.action !== "delete" && <span className="muted sync-size">{formatBytes(e.size)}</span>}
            </li>
          ))}
        </ul>
        {plan && (
          <p className="muted">
            {plan.unchanged} unchanged
            {plan.localOnly > 0 && ` \u00b7 ${plan.localOnly} changed only on your machine (kept)`}
            {plan.entries.length > 0 && ` \u00b7 to pull: ${summary(applying) || "nothing"}`}
            {" \u00b7 compared "}
            {new Date(plan.computedAt).toLocaleTimeString()}
          </p>
        )}
        {conflicts.length > 0 && (
          <label className="check">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} disabled={busy !== null} />
            Also overwrite the {conflicts.length} file{conflicts.length === 1 ? "" : "s"} changed on my machine with the box's version
          </label>
        )}
        <div className="actions">
          <button type="button" disabled={busy !== null} onClick={() => void refresh()} title="Compare again">
            {busy === "plan" ? "Comparing\u2026" : "Refresh"}
          </button>
          <span className="spacer" />
          <button type="button" disabled={busy !== null} onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy !== null || applying.length === 0}
            onClick={() => void pull()}
            title={applying.length === 0 ? "Nothing to pull" : `Write ${applying.length} change${applying.length === 1 ? "" : "s"} (${formatBytes(bytes)}) into ${folder}`}
          >
            {busy === "pull" ? "Pulling\u2026" : `Pull ${applying.length > 0 ? `${applying.length} change${applying.length === 1 ? "" : "s"}` : "changes"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
