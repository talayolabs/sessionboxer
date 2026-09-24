import { MERGE_METHODS, PR_PROVIDER_LABEL, type MergeMethod, type PrAction, type PrCheckItem, type PrItem, type PullRequest, type Session } from "@sessionboxer/protocol";
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
/** The same actions on a failed check: there is nobody to reply to, the push makes the checks run again. */
const CHECK_ACTION_LABEL: Record<PrAction, string> = { prompt: "To prompt", address: "Fix", address_reply: "Fix & push" };
const CHECK_STATE_LABEL: Record<PrCheckItem["state"], string> = { pending: "running", passed: "passed", failed: "failed" };
const METHOD_LABEL: Record<MergeMethod, string> = { merge: "merge commit", squash: "squash", rebase: "rebase" };

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
      return { text: pr.provider === "bitbucket" ? `no Bitbucket login for ${pr.host} can read this PR` : "no GitHub login can read this PR", level: "error" };
    case "not_found":
      return { text: "PR not found (or no access)", level: "error" };
    case "rate_limited":
      return { text: `${PR_PROVIDER_LABEL[pr.provider]} rate limit; retrying later`, level: "warn" };
    default:
      return { text: pr.syncErrorDetail ? `error: ${pr.syncErrorDetail}` : "error", level: "error" };
  }
}

/** One line on what auto-merge is doing / waiting for. */
export function mergeNote(pr: PullRequest): { text: string; level: "ok" | "warn" | "error" | "muted" } {
  const m = pr.mergeState;
  if (pr.state === "merged") return m?.merged ? { text: `merged by auto-merge (${METHOD_LABEL[pr.mergeMethod]})`, level: "ok" } : { text: "already merged", level: "muted" };
  if (pr.state === "closed") return { text: "closed without merging", level: "muted" };
  if (!pr.autoMerge) return { text: "off — merges the PR as soon as GitHub allows it (checks green, reviews in, no conflicts)", level: "muted" };
  if (!m) return { text: "checking…", level: "warn" };
  if (m.error) return { text: m.error, level: "error" };
  const failed = m.checks.filter((c) => c.state === "failed");
  const pending = m.checks.filter((c) => c.state === "pending");
  const names = (cs: typeof m.checks) => cs.slice(0, 3).map((c) => c.name).join(", ") + (cs.length > 3 ? ` +${cs.length - 3}` : "");
  switch (m.status) {
    case "draft":
      return { text: "waiting: still a draft", level: "warn" };
    case "dirty":
      return { text: "waiting: conflicts with the base branch", level: "error" };
    case "behind":
      return { text: `waiting: bringing the branch up to date with ${pr.baseRef}`, level: "warn" };
    case "blocked":
      if (failed.length > 0) return { text: `waiting: ${failed.length} failed — ${names(failed)}`, level: "error" };
      if (pending.length > 0) return { text: `waiting: ${pending.length} running — ${names(pending)}`, level: "warn" };
      return { text: pr.reviewDecision === "approved" ? "waiting: blocked by branch protection" : "waiting: reviews required", level: "warn" };
    case "unstable":
      if (failed.length > 0) return { text: `waiting: ${failed.length} failed — ${names(failed)}`, level: "error" };
      return { text: pending.length > 0 ? `waiting: ${pending.length} running — ${names(pending)}` : "waiting: checks not all green", level: "warn" };
    case "clean":
    case "has_hooks":
      return { text: "mergeable — merging now", level: "ok" };
    default:
      return { text: m.mergeable === null ? "waiting: GitHub is still computing mergeability" : "waiting…", level: "warn" };
  }
}

function actionTitle(action: PrAction, pr: PullRequest, n: number): string {
  const what = n === 1 ? "this item" : `these ${n} items`;
  switch (action) {
    case "prompt":
      return `Put ${what}, quoted, into the composer to edit before sending`;
    case "address":
      return pr.local ? `Send ${what} to the Agent now (queued if busy): change the code locally, no replies on ${PR_PROVIDER_LABEL[pr.provider]}` : "The PR's repository is not this Session's Workspace";
    case "address_reply":
      return pr.local
        ? `Send ${what} to the Agent: change the code, push, reply on ${PR_PROVIDER_LABEL[pr.provider]}${pr.provider === "github" ? " and resolve the threads" : ""}`
        : "The PR's repository is not this Session's Workspace";
  }
}

/** Tooltip of a check's result: what the provider literally said, and when it ran. */
function checkResultTitle(c: PrCheckItem): string {
  const lines = [
    c.conclusion ? `conclusion: ${c.conclusion}` : `status: ${CHECK_STATE_LABEL[c.state]}`,
    c.required ? (c.kind === "build" ? "a required build" : "required by branch protection") : "not required",
  ];
  if (c.startedAt) lines.push(`started ${new Date(c.startedAt).toLocaleString()}`);
  if (c.completedAt) lines.push(`finished ${new Date(c.completedAt).toLocaleString()}`);
  return lines.join("\n");
}

function checkActionTitle(action: PrAction, pr: PullRequest, n: number): string {
  const what = n === 1 ? "this failed check" : `these ${n} failed checks`;
  switch (action) {
    case "prompt":
      return `Put ${what} (name, conclusion, log link, summary) into the composer to edit before sending`;
    case "address":
      return pr.local ? `Send ${what} to the Agent now (queued if busy): read the log, fix the cause locally, commit; nothing pushed` : "The PR's repository is not this Session's Workspace";
    case "address_reply":
      return pr.local ? `Send ${what} to the Agent: read the log, fix the cause, commit and push so the checks run again` : "The PR's repository is not this Session's Workspace";
  }
}

/** "2 failed · 1 running · 5 passed" for the overview; null when the head has no checks. */
function checksSummary(pr: PullRequest): Array<{ text: string; level: "error" | "warn" | "ok" }> {
  const out: Array<{ text: string; level: "error" | "warn" | "ok" }> = [];
  if (pr.checksFailed > 0) out.push({ text: `${pr.checksFailed} failed`, level: "error" });
  if (pr.checksPending > 0) out.push({ text: `${pr.checksPending} running`, level: "warn" });
  if (pr.checksPassed > 0) out.push({ text: `${pr.checksPassed} passed`, level: "ok" });
  return out;
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
          placeholder="PR URL (GitHub or Bitbucket Data Center), owner/repo#123, or #123"
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
              <th>Checks</th>
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
                    {pr.autoMerge && pr.state !== "closed" && (
                      <div className={`small-text ${mergeNote(pr).level}`} title={mergeNote(pr).text}>
                        auto-merge
                      </div>
                    )}
                  </td>
                  <td>{pr.reviewDecision ? <span className={`pr-decision pr-decision-${pr.reviewDecision}`}>{DECISION_LABEL[pr.reviewDecision]}</span> : <span className="muted">—</span>}</td>
                  <td>{pr.unread > 0 ? <span className="count">{pr.unread}</span> : <span className="muted">0</span>}</td>
                  <td>{pr.openThreads > 0 ? pr.openThreads : <span className="muted">0</span>}</td>
                  <td className="nowrap small-text">
                    {checksSummary(pr).length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      checksSummary(pr).map((c, i) => (
                        <span key={c.level}>
                          {i > 0 && <span className="muted"> · </span>}
                          <span className={c.level}>{c.text}</span>
                        </span>
                      ))
                    )}
                  </td>
                  <td className="muted" title={pr.lastActivityAt ?? undefined}>
                    {ago(pr.lastActivityAt)}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={pr.watch}
                      title={`Poll ${PR_PROVIDER_LABEL[pr.provider]} for new comments, reviews and ${pr.provider === "bitbucket" ? "build" : "check"} results`}
                      onChange={(e) => void run(() => api.updatePr(session.id, pr.id, { watch: e.target.checked }))}
                    />
                  </td>
                  <td className="prs-actions">
                    <a href={pr.url} target="_blank" rel="noreferrer" className="button small" title={`Open on ${PR_PROVIDER_LABEL[pr.provider]}${pr.provider === "bitbucket" ? ` (${pr.host})` : ""}`}>
                      {PR_PROVIDER_LABEL[pr.provider]} ↗
                    </a>
                    <button className="small" onClick={() => void run(() => api.refreshPr(session.id, pr.id))} title={`Poll ${PR_PROVIDER_LABEL[pr.provider]} now`}>
                      Refresh
                    </button>
                    <button
                      className="small danger"
                      onClick={() => {
                        if (confirm(`Detach ${pr.owner}/${pr.repo}#${pr.number} from this Session? Its comments are forgotten here (nothing changes on ${PR_PROVIDER_LABEL[pr.provider]}).`)) {
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
  checks,
  run,
  onPromptText,
  onDetached,
}: {
  session: Session;
  pr: PullRequest;
  /** null until loaded. */
  items: PrItem[] | null;
  /** The head commit's checks; null until loaded. */
  checks: PrCheckItem[] | null;
  run: Runner;
  /** "To prompt": the text to put in the composer. */
  onPromptText: (text: string) => void;
  onDetached: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<PrAction | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // The Checks list opens by itself when something fails and stays as the user left it otherwise.
  const [checksOpen, setChecksOpen] = useState(pr.checksFailed > 0);
  useEffect(() => {
    if (pr.checksFailed > 0) setChecksOpen(true);
  }, [pr.checksFailed]);

  // Looking at the tab reads the items and the failed checks.
  useEffect(() => {
    if (pr.unread > 0 && items && checks) void api.prSeen(session.id, pr.id).catch(() => undefined);
  }, [session.id, pr.id, pr.unread, items, checks]);

  const visible = useMemo(() => {
    const all = items ?? [];
    const shown = showResolved ? all : all.filter((i) => !i.resolved);
    return [...shown].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [items, showResolved]);
  const hidden = (items?.length ?? 0) - visible.length;
  // Failed first, then running, then passed; a failed check can be picked, the others only read.
  const sortedChecks = useMemo(() => {
    const rank: Record<PrCheckItem["state"], number> = { failed: 0, pending: 1, passed: 2 };
    return [...(checks ?? [])].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
  }, [checks]);
  const failedChecks = useMemo(() => sortedChecks.filter((c) => c.state === "failed"), [sortedChecks]);
  const checkIds = useMemo(() => new Set((checks ?? []).map((c) => c.id)), [checks]);
  useEffect(() => {
    if (!items || !checks) return;
    setSelected((prev) => {
      const ids = new Set([...items.map((i) => i.id), ...checks.filter((c) => c.state === "failed").map((c) => c.id)]);
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items, checks]);

  const act = (action: PrAction, ids: string[]) => {
    if (ids.length === 0 || busy) return;
    const itemIds = ids.filter((id) => !checkIds.has(id));
    const pickedChecks = ids.filter((id) => checkIds.has(id));
    if (action === "address_reply" && itemIds.length > 1 && !confirm(`Ask the Agent to address ${itemIds.length} items and reply to each of them publicly on ${PR_PROVIDER_LABEL[pr.provider]}?`)) return;
    setBusy(action);
    void run(async () => {
      const res = await api.prAction(session.id, { action, itemIds, checkIds: pickedChecks });
      if (action === "prompt") onPromptText(res.text);
      setSelected(new Set());
    }).finally(() => setBusy(null));
  };
  const toggleAll = (on: boolean) => setSelected(on ? new Set(visible.map((i) => i.id)) : new Set());
  const allSelected = visible.length > 0 && visible.every((i) => selected.has(i.id));
  const toggleAllChecks = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of failedChecks)
        if (on) next.add(c.id);
        else next.delete(c.id);
      return next;
    });
  const allChecksSelected = failedChecks.length > 0 && failedChecks.every((c) => selected.has(c.id));
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const nChecks = [...selected].filter((id) => checkIds.has(id)).length;
  const onlyChecks = nChecks > 0 && nChecks === selected.size;
  const note = syncNote(pr);
  const merge = mergeNote(pr);
  const n = selected.size;
  const finished = pr.state === "merged" || pr.state === "closed";
  const setAutoMerge = (on: boolean) => {
    if (on && !confirm(`Merge ${pr.owner}/${pr.repo}#${pr.number} into ${pr.baseRef || "its base branch"} (${METHOD_LABEL[pr.mergeMethod]}) as soon as GitHub allows it? The Control Plane checks every 10 seconds while this is on.`)) return;
    void run(() => api.updatePr(session.id, pr.id, { autoMerge: on }));
  };

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
            {pr.provider === "bitbucket" && (
              <>
                {" · "}
                <span title="A Bitbucket Data Center, read with its Connector's token">{pr.host}</span>
              </>
            )}
            {" · "}
            <span className={note.level === "ok" ? "" : note.level}>{note.text}</span>
            {!pr.local && <span className="warn"> · not this Workspace's repository: Address is off</span>}
          </div>
        </div>
        <span className="spacer" />
        <button className="small" onClick={() => void run(() => api.refreshPr(session.id, pr.id))} title={`Poll ${PR_PROVIDER_LABEL[pr.provider]} now`}>
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
      {pr.provider === "github" && (
        <div className="pr-merge">
          <label className="check" title="Merge this PR automatically once every check passed and nothing else blocks it">
            <input type="checkbox" checked={pr.autoMerge} disabled={finished} onChange={(e) => setAutoMerge(e.target.checked)} />
            Auto-merge when checks pass
          </label>
          <select
            value={pr.mergeMethod}
            disabled={finished}
            title="How GitHub merges it"
            onChange={(e) => void run(() => api.updatePr(session.id, pr.id, { mergeMethod: e.target.value as MergeMethod }))}
          >
            {MERGE_METHODS.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
          <span className={`pr-merge-note ${merge.level}`}>{merge.text}</span>
          {pr.mergeState && !finished && (
            <span className="muted small-text" title={pr.mergeState.headSha}>
              checked {ago(pr.mergeState.checkedAt)}
            </span>
          )}
        </div>
      )}
      {checks !== null && checks.length > 0 && !finished && (
        <details className="pr-checks" open={checksOpen} onToggle={(e) => setChecksOpen(e.currentTarget.open)}>
          <summary>
            <span className="pr-checks-title">Checks</span>
            {checksSummary(pr).map((c, i) => (
              <span key={c.level} className="small-text">
                {i > 0 && <span className="muted"> · </span>}
                <span className={c.level}>{c.text}</span>
              </span>
            ))}
            {failedChecks.length > 0 && <span className="muted small-text">{" — "}pick failed checks and let the Agent fix them</span>}
          </summary>
          <div className="pr-check-scroll">
            <table className="prs-table pr-check-rows">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allChecksSelected}
                      disabled={failedChecks.length === 0}
                      title={failedChecks.length === 0 ? "No failed checks" : "Select every failed check"}
                      onChange={(e) => toggleAllChecks(e.target.checked)}
                    />
                  </th>
                  <th>Check</th>
                  <th>Result</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedChecks.map((c) => (
                  <tr key={c.id} className={[!c.seen && c.state === "failed" ? "unread" : "", `pr-check-${c.state}`].join(" ")}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        disabled={c.state !== "failed"}
                        title={c.state !== "failed" ? "Only failed checks can be addressed" : undefined}
                        onChange={(e) => toggle(c.id, e.target.checked)}
                      />
                    </td>
                    <td className="pr-check-name">
                      {c.url ? (
                        <a href={c.url} target="_blank" rel="noreferrer" title="Open the log / details">
                          {c.name}
                        </a>
                      ) : (
                        c.name
                      )}
                      <div className="muted small-text">
                        {c.source ?? (c.kind === "status" ? "commit status" : c.kind === "build" ? "build status" : "check")}
                        {c.required && " · required"}
                        {" · "}
                        <span title={c.headSha}>{c.headSha.slice(0, 7)}</span>
                      </div>
                    </td>
                    <td className="nowrap" title={checkResultTitle(c)}>
                      <span className={`pr-check-state ${c.state === "failed" ? "error" : c.state === "pending" ? "warn" : "ok"}`}>
                        {c.state === "failed" && c.conclusion && c.conclusion !== "failure" && c.conclusion !== "failed" ? c.conclusion.replace(/_/g, " ") : CHECK_STATE_LABEL[c.state]}
                      </span>
                      {c.completedAt ? (
                        <div className="muted small-text">{ago(c.completedAt)}</div>
                      ) : (
                        c.startedAt && <div className="muted small-text">since {ago(c.startedAt)}</div>
                      )}
                    </td>
                    <td className="nowrap small-text">
                      {!c.seen && c.state === "failed" && <div className="count">new</div>}
                      {c.address !== "none" && <div className={c.address === "addressed" ? "ok" : "warn"}>{ADDRESS_LABEL[c.address]}</div>}
                    </td>
                    <td className="prs-actions">
                      {c.state === "failed" && (
                        <div className="pr-row-actions">
                          {(["prompt", "address", "address_reply"] as const).map((a) => (
                            <button key={a} className="small" disabled={busy !== null || (a !== "prompt" && !pr.local)} title={checkActionTitle(a, pr, 1)} onClick={() => act(a, [c.id])}>
                              {CHECK_ACTION_LABEL[a]}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <div className="pr-bulk">
        <label className="check">
          <input type="checkbox" checked={allSelected} onChange={(e) => toggleAll(e.target.checked)} disabled={visible.length === 0} />
          {n > 0 ? `${n} selected${nChecks > 0 ? ` (${nChecks} ${nChecks === 1 ? "check" : "checks"})` : ""}` : "Select all"}
        </label>
        {(["prompt", "address", "address_reply"] as const).map((a) => (
          <button
            key={a}
            className="small"
            disabled={n === 0 || busy !== null || (a !== "prompt" && !pr.local)}
            title={onlyChecks ? checkActionTitle(a, pr, n) : actionTitle(a, pr, n)}
            onClick={() => act(a, [...selected])}
          >
            {busy === a ? "…" : onlyChecks ? CHECK_ACTION_LABEL[a] : ACTION_LABEL[a]}
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
                    <input type="checkbox" checked={selected.has(it.id)} onChange={(e) => toggle(it.id, e.target.checked)} />
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
                      {PR_PROVIDER_LABEL[pr.provider]} ↗
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
