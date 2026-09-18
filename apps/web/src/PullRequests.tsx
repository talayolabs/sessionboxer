import type { PrAction, PrItem, PullRequest, Session } from "@sessionboxer/protocol";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { FileLink } from "./FileLink";
import { Markdown } from "./Markdown";

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

const STATE_LABEL: Record<PullRequest["state"], string> = { open: "open", draft: "draft", closed: "closed", merged: "merged" };
const DECISION_LABEL: Record<NonNullable<PullRequest["reviewDecision"]>, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  review_required: "review required",
};
const KIND_LABEL: Record<PrItem["kind"], string> = { issue_comment: "comment", review_comment: "inline", review: "review" };
const ADDRESS_LABEL: Record<PrItem["address"], string> = { none: "", in_prompt: "in prompt", addressing: "addressing…", addressed: "addressed" };
const ACTION_LABEL: Record<PrAction, string> = { prompt: "To prompt", address: "Address", address_reply: "Address & reply" };

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** One line on why the watcher is not delivering, for the sync column / header. */
export function syncNote(pr: PullRequest): { text: string; level: "ok" | "warn" | "error" } {
  if (!pr.watch) return { text: "not watching", level: "warn" };
  switch (pr.syncError) {
    case null:
      return { text: pr.syncedAt ? `synced ${ago(pr.syncedAt)}${pr.viaAccount ? ` as @${pr.viaAccount}` : ""}` : "first sync pending…", level: "ok" };
    case "box_stopped":
      return { text: "watching paused — Sandbox stopped", level: "warn" };
    case "unauthorized":
      return { text: "no GitHub login can read this PR", level: "error" };
    case "not_found":
      return { text: "PR not found (or no access)", level: "error" };
    case "rate_limited":
      return { text: "GitHub rate limit; retrying later", level: "warn" };
    default:
      return { text: pr.syncErrorDetail ? `error: ${pr.syncErrorDetail}` : "error", level: "error" };
  }
}

function actionTitle(action: PrAction, pr: PullRequest, n: number): string {
  const what = n === 1 ? "this item" : `these ${n} items`;
  switch (action) {
    case "prompt":
      return `Put ${what}, quoted, into the composer to edit before sending`;
    case "address":
      return pr.local ? `Send ${what} to the Agent now (queued if busy): change the code locally, no replies on GitHub` : "The PR's repository is not this Session's Workspace";
    case "address_reply":
      return pr.local ? `Send ${what} to the Agent: change the code, push, reply on GitHub and resolve the threads` : "The PR's repository is not this Session's Workspace";
  }
}

// --- Overview pane -------------------------------------------------------------------------

export function PrsPane({
  session,
  prs,
  run,
  onOpen,
}: {
  session: Session;
  prs: PullRequest[];
  run: Runner;
  onOpen: (prId: string) => void;
}) {
  const [ref, setRef] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [notifications, setNotifications] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const attach = () => {
    const r = ref.trim();
    if (!r || attaching) return;
    setAttaching(true);
    void run(async () => {
      await api.attachPr(session.id, r);
      setRef("");
    }).finally(() => setAttaching(false));
  };
  return (
    <div className="pane prs-pane">
      <div className="prs-toolbar">
        <input
          placeholder="PR URL, owner/repo#123, or #123"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") attach();
          }}
        />
        <button onClick={attach} disabled={!ref.trim() || attaching}>
          {attaching ? "Attaching…" : "Attach"}
        </button>
        {notifications === "default" && (
          <button
            className="small"
            title="Also show a browser notification when feedback arrives while the Agent is idle"
            onClick={() => void Notification.requestPermission().then(setNotifications)}
          >
            Enable browser notifications
          </button>
        )}
      </div>
      {prs.length === 0 ? (
        <p className="muted prs-empty">
          No pull requests attached. Paste a PR URL in a prompt, ask the Agent to open one, or attach one above; new comments and reviews then show up
          here and as a notification when the Agent is idle.
        </p>
      ) : (
        <table className="prs-table">
          <thead>
            <tr>
              <th>PR</th>
              <th>State</th>
              <th>Review</th>
              <th>Unread</th>
              <th>Threads</th>
              <th>Activity</th>
              <th>Watch</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {prs.map((pr) => {
              const note = syncNote(pr);
              return (
                <tr key={pr.id} className={pr.unread > 0 ? "unread" : ""}>
                  <td className="prs-title">
                    <button className="link" onClick={() => onOpen(pr.id)} title="Open this PR's tab">
                      <strong>
                        {pr.owner}/{pr.repo}#{pr.number}
                      </strong>{" "}
                      {pr.title || <span className="muted">(loading…)</span>}
                    </button>
                    <div className="muted small-text">
                      {pr.headRef && (
                        <>
                          <code>{pr.headRef}</code> → <code>{pr.baseRef}</code> ·{" "}
                        </>
                      )}
                      {pr.author && <>by @{pr.author} · </>}
                      attached {pr.attachedBy === "prompt" ? "from a prompt" : pr.attachedBy === "agent" ? "by the Agent" : "manually"} ·{" "}
                      <span className={note.level === "ok" ? "" : note.level}>{note.text}</span>
                      {!pr.local && <> · not this Workspace's repository</>}
                    </div>
                  </td>
                  <td>
                    <span className={`pr-state pr-state-${pr.state}`}>{STATE_LABEL[pr.state]}</span>
                  </td>
                  <td>{pr.reviewDecision ? <span className={`pr-decision pr-decision-${pr.reviewDecision}`}>{DECISION_LABEL[pr.reviewDecision]}</span> : <span className="muted">—</span>}</td>
                  <td>{pr.unread > 0 ? <span className="count">{pr.unread}</span> : <span className="muted">0</span>}</td>
                  <td>{pr.openThreads > 0 ? pr.openThreads : <span className="muted">0</span>}</td>
                  <td className="muted" title={pr.lastActivityAt ?? undefined}>
                    {ago(pr.lastActivityAt)}
                  </td>
                  <td>
                    <input type="checkbox" checked={pr.watch} title="Poll GitHub for new comments and reviews" onChange={(e) => void run(() => api.updatePr(session.id, pr.id, { watch: e.target.checked }))} />
                  </td>
                  <td className="prs-actions">
                    <a href={pr.url} target="_blank" rel="noreferrer" className="button small" title="Open on GitHub">
                      GitHub ↗
                    </a>
                    <button className="small" onClick={() => void run(() => api.refreshPr(session.id, pr.id))} title="Poll GitHub now">
                      Refresh
                    </button>
                    <button
                      className="small danger"
                      onClick={() => {
                        if (confirm(`Detach ${pr.owner}/${pr.repo}#${pr.number} from this Session? Its comments are forgotten here (nothing changes on GitHub).`)) {
                          void run(() => api.detachPr(session.id, pr.id));
                        }
                      }}
                    >
                      Detach
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- One PR ---------------------------------------------------------------------------------

export function PrPane({
  session,
  pr,
  items,
  run,
  onPromptText,
  onDetached,
}: {
  session: Session;
  pr: PullRequest;
  /** null until loaded. */
  items: PrItem[] | null;
  run: Runner;
  /** "To prompt": the text to put in the composer. */
  onPromptText: (text: string) => void;
  onDetached: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<PrAction | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Looking at the tab reads the items.
  useEffect(() => {
    if (pr.unread > 0 && items) void api.prSeen(session.id, pr.id).catch(() => undefined);
  }, [session.id, pr.id, pr.unread, items]);

  const visible = useMemo(() => {
    const all = items ?? [];
    const shown = showResolved ? all : all.filter((i) => !i.resolved);
    return [...shown].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [items, showResolved]);
  const hidden = (items?.length ?? 0) - visible.length;
  useEffect(() => {
    if (!items) return;
    setSelected((prev) => {
      const ids = new Set(items.map((i) => i.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const act = (action: PrAction, ids: string[]) => {
    if (ids.length === 0 || busy) return;
    if (action === "address_reply" && ids.length > 1 && !confirm(`Ask the Agent to address ${ids.length} items and reply to each of them publicly on GitHub?`)) return;
    setBusy(action);
    void run(async () => {
      const res = await api.prAction(session.id, { action, itemIds: ids });
      if (action === "prompt") onPromptText(res.text);
      setSelected(new Set());
    }).finally(() => setBusy(null));
  };
  const toggleAll = (on: boolean) => setSelected(on ? new Set(visible.map((i) => i.id)) : new Set());
  const allSelected = visible.length > 0 && visible.every((i) => selected.has(i.id));
  const note = syncNote(pr);
  const n = selected.size;

  return (
    <div className="pane prs-pane">
      <div className="pr-head">
        <div className="pr-head-title">
          <a href={pr.url} target="_blank" rel="noreferrer">
            <strong>
              {pr.owner}/{pr.repo}#{pr.number}
            </strong>{" "}
            {pr.title}
          </a>
          <div className="muted small-text">
            <span className={`pr-state pr-state-${pr.state}`}>{STATE_LABEL[pr.state]}</span>
            {pr.reviewDecision && (
              <>
                {" · "}
                <span className={`pr-decision pr-decision-${pr.reviewDecision}`}>{DECISION_LABEL[pr.reviewDecision]}</span>
              </>
            )}
            {pr.headRef && (
              <>
                {" · "}
                <code>{pr.headRef}</code> → <code>{pr.baseRef}</code>
              </>
            )}
            {" · "}
            <span className={note.level === "ok" ? "" : note.level}>{note.text}</span>
            {!pr.local && <span className="warn"> · not this Workspace's repository: Address is off</span>}
          </div>
        </div>
        <span className="spacer" />
        <button className="small" onClick={() => void run(() => api.refreshPr(session.id, pr.id))} title="Poll GitHub now">
          Refresh
        </button>
        <button
          className="small danger"
          onClick={() => {
            if (confirm(`Detach ${pr.owner}/${pr.repo}#${pr.number} from this Session?`)) {
              void run(() => api.detachPr(session.id, pr.id));
              onDetached();
            }
          }}
        >
          Detach
        </button>
      </div>
      <div className="pr-bulk">
        <label className="check">
          <input type="checkbox" checked={allSelected} onChange={(e) => toggleAll(e.target.checked)} disabled={visible.length === 0} />
          {n > 0 ? `${n} selected` : "Select all"}
        </label>
        {(["prompt", "address", "address_reply"] as const).map((a) => (
          <button
            key={a}
            className="small"
            disabled={n === 0 || busy !== null || (a !== "prompt" && !pr.local)}
            title={actionTitle(a, pr, n)}
            onClick={() => act(a, [...selected])}
          >
            {busy === a ? "…" : ACTION_LABEL[a]}
            {n > 0 ? ` (${n})` : ""}
          </button>
        ))}
        <span className="spacer" />
        {hidden > 0 && (
          <label className="check muted">
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
            show {hidden} resolved
          </label>
        )}
      </div>
      {items === null ? (
        <p className="muted prs-empty">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="muted prs-empty">{items.length === 0 ? "No comments or reviews yet." : "All threads resolved."}</p>
      ) : (
        <table className="prs-table pr-items">
          <thead>
            <tr>
              <th></th>
              <th>Kind</th>
              <th>Author</th>
              <th>Comment</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((it) => {
              const open = expanded.has(it.id);
              const long = it.body.length > 300 || it.body.split("\n").length > 4;
              return (
                <tr key={it.id} className={[!it.seen ? "unread" : "", it.resolved ? "resolved" : ""].join(" ")}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(it.id)}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(it.id);
                          else next.delete(it.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="nowrap">
                    <span className={`pr-kind pr-kind-${it.kind}`}>{KIND_LABEL[it.kind]}</span>
                    {it.reviewState && it.kind === "review" && <div className={`small-text pr-review-${it.reviewState.toLowerCase()}`}>{it.reviewState.toLowerCase().replace("_", " ")}</div>}
                    {it.inReplyTo !== null && <div className="muted small-text">reply</div>}
                  </td>
                  <td className="pr-author">
                    <span title={it.self ? "written with the login this PR is watched with" : undefined}>@{it.author}</span>
                    {it.self && <span className="muted"> (you)</span>}
                    <div className="muted small-text" title={new Date(it.createdAt).toLocaleString()}>
                      {ago(it.createdAt)}
                    </div>
                  </td>
                  <td className="pr-body">
                    {it.path && (
                      <div className="pr-where">
                        <FileLink fileRef={it.line !== null ? { path: it.path, line: it.line } : { path: it.path }}>
                          <code>
                            {it.path}
                            {it.line !== null ? `:${it.line}` : ""}
                          </code>
                        </FileLink>
                        {it.outdated && <span className="muted"> (outdated)</span>}
                      </div>
                    )}
                    <div className={long && !open ? "pr-text clamped" : "pr-text"}>
                      <Markdown text={it.body || "*(no text)*"} />
                    </div>
                    {long && (
                      <button
                        className="link small-text"
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (!next.delete(it.id)) next.add(it.id);
                            return next;
                          })
                        }
                      >
                        {open ? "less" : "more"}
                      </button>
                    )}
                  </td>
                  <td className="nowrap small-text">
                    {!it.seen && <div className="count">new</div>}
                    {it.resolved && <div className="muted">resolved</div>}
                    {it.address !== "none" && <div className={it.address === "addressed" ? "ok" : "warn"}>{ADDRESS_LABEL[it.address]}</div>}
                    <a href={it.htmlUrl} target="_blank" rel="noreferrer" className="muted">
                      GitHub ↗
                    </a>
                  </td>
                  <td className="prs-actions">
                    <div className="pr-row-actions">
                      {(["prompt", "address", "address_reply"] as const).map((a) => (
                        <button key={a} className="small" disabled={busy !== null || (a !== "prompt" && !pr.local)} title={actionTitle(a, pr, 1)} onClick={() => act(a, [it.id])}>
                          {ACTION_LABEL[a]}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
