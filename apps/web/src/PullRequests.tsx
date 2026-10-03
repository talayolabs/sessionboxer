import { MERGE_METHODS, PR_PROVIDER_LABEL, type MergeMethod, type PrAction, type PrCheckItem, type PrItem, type PullRequest, type Session } from "@sessionboxer/protocol";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { ConnectorIcon } from "./ConnectorIcon";
import { PrChecks, PrThreads, ago, checksSummary, usePrSelection } from "./PrThreads";
import { cx, Menu, MenuItem, Popover, Tip } from "./ui";

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

export { ago };

const STATE_LABEL: Record<PullRequest["state"], string> = { open: "Open", draft: "Draft", closed: "Closed", merged: "Merged" };
const DECISION_LABEL: Record<NonNullable<PullRequest["reviewDecision"]>, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  review_required: "review required",
};
const ACTION_LABEL: Record<PrAction, string> = { prompt: "To prompt", address: "Address", address_reply: "Address & reply" };
/** The same actions on a failed check: there is nobody to reply to, the push makes the checks run again. */
const CHECK_ACTION_LABEL: Record<PrAction, string> = { prompt: "To prompt", address: "Fix", address_reply: "Fix & push" };
const METHOD_LABEL: Record<MergeMethod, string> = { merge: "merge commit", squash: "squash", rebase: "rebase" };

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
    case "blocked": {
      const reasons: string[] = [];
      if (failed.length > 0) reasons.push(`${failed.length} failed — ${names(failed)}`);
      if (pending.length > 0) reasons.push(`${pending.length} running — ${names(pending)}`);
      if (pr.reviewDecision === "review_required") reasons.push("an approval from a reviewer");
      else if (pr.reviewDecision === "changes_requested") reasons.push("changes were requested by a reviewer");
      if (reasons.length === 0) reasons.push(pr.reviewDecision === "approved" ? "blocked by branch protection" : "reviews required");
      return { text: `waiting: ${reasons.join("; ")}`, level: failed.length > 0 ? "error" : "warn" };
    }
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

// --- Shared bits ---------------------------------------------------------------------------

const ACTIONS = ["prompt", "address", "address_reply"] as const;
export const DECISION_GLYPH: Record<NonNullable<PullRequest["reviewDecision"]>, string> = { approved: "\u2713", changes_requested: "\u2717", review_required: "\u25CC" };

function prRef(pr: PullRequest): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

function finished(pr: PullRequest): boolean {
  return pr.state === "merged" || pr.state === "closed";
}

/** Something new to look at: unread comments, or a check that failed. Those rows sort first and carry the dot. */
function needsAttention(pr: PullRequest): boolean {
  return pr.unread > 0 || pr.checksFailed > 0;
}

/** State and review decision in one chip: the label is the state, the review folds in as colour and glyph. */
export function StateChip({ pr }: { pr: Pick<PullRequest, "state" | "reviewDecision"> }) {
  const d = pr.state === "open" || pr.state === "draft" ? pr.reviewDecision : null;
  const tip = d ? `${STATE_LABEL[pr.state]} \u00b7 ${DECISION_LABEL[d]}` : STATE_LABEL[pr.state];
  return (
    <Tip text={tip}>
      <span className={cx("pill pr-chip", `pr-state-${pr.state}`, d && `pr-decision-${d}`)}>
        {d && <span aria-hidden="true">{DECISION_GLYPH[d]} </span>}
        {STATE_LABEL[pr.state]}
      </span>
    </Tip>
  );
}

/** A plain element, not a component: Radix merges the trigger props onto it (`asChild` needs a ref). */
export function moreButton(label: string) {
  return (
    <button type="button" className="icon-button pr-more" aria-label={label} title={label} onClick={(e) => e.stopPropagation()}>
      {"\u22ef"}
    </button>
  );
}

function confirmDetach(pr: PullRequest): boolean {
  return confirm(`Detach ${prRef(pr)} from this Session? Its comments are forgotten here (nothing changes on ${PR_PROVIDER_LABEL[pr.provider]}).`);
}

function confirmAutoMerge(pr: PullRequest): boolean {
  return confirm(`Merge ${prRef(pr)} into ${pr.baseRef || "its base branch"} (${METHOD_LABEL[pr.mergeMethod]}) as soon as GitHub allows it? The Control Plane checks every 10 seconds while this is on.`);
}

function externalTitle(pr: PullRequest): string {
  return `Open on ${PR_PROVIDER_LABEL[pr.provider]}${pr.provider === "bitbucket" ? ` (${pr.host})` : ""}, in a new tab (leaves Sessionboxer)`;
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
  const [attachOpen, setAttachOpen] = useState(false);
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
      setAttachOpen(false);
    }).finally(() => setAttaching(false));
  };
  // Needs-attention first, then the most recent activity.
  const sorted = useMemo(
    () =>
      [...prs].sort(
        (a, b) =>
          Number(needsAttention(b)) - Number(needsAttention(a)) ||
          (b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0) - (a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0) ||
          Date.parse(b.attachedAt) - Date.parse(a.attachedAt),
      ),
    [prs],
  );
  const showAttach = attachOpen || prs.length === 0;
  return (
    <div className="pane prs-pane">
      <nav className="pr-crumbs" aria-label="Pull requests">
        <span aria-current="page">Pull requests{prs.length > 0 && <span className="muted"> ({prs.length})</span>}</span>
        <span className="spacer" />
        {notifications === "default" && (
          <button className="small" title="Also show a browser notification when feedback arrives while the Agent is idle" onClick={() => void Notification.requestPermission().then(setNotifications)}>
            Notifications
          </button>
        )}
        {prs.length > 0 && (
          <button className="small" aria-expanded={showAttach} onClick={() => setAttachOpen((v) => !v)} title="Attach a pull request by URL or owner/repo#123">
            {showAttach ? "Close" : "+ Attach"}
          </button>
        )}
      </nav>
      {showAttach && (
        <div className="pane-toolbar prs-toolbar">
          <input
            placeholder="PR URL (GitHub or Bitbucket Data Center), owner/repo#123, or #123"
            value={ref}
            autoFocus={prs.length > 0}
            onChange={(e) => setRef(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") attach();
            }}
          />
          <button onClick={attach} disabled={!ref.trim() || attaching}>
            {attaching ? "Attaching\u2026" : "Attach"}
          </button>
        </div>
      )}
      {prs.length === 0 ? (
        <p className="muted prs-empty">
          No pull requests attached. Paste a PR URL in a prompt, ask the Agent to open one, or attach one above; new comments and reviews then show up
          here and as a notification when the Agent is idle.
        </p>
      ) : (
        <ul className="pr-list">
          {sorted.map((pr) => (
            <PrRow key={pr.id} session={session} pr={pr} run={run} onOpen={() => onOpen(pr.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PrRow({ session, pr, run, onOpen }: { session: Session; pr: PullRequest; run: Runner; onOpen: () => void }) {
  const note = syncNote(pr);
  const merge = mergeNote(pr);
  const done = finished(pr);
  const attn = needsAttention(pr);
  const facts: ReactNode[] = [];
  if (pr.unread > 0) facts.push(<span key="unread" className="pr-fact pr-fact-unread">{pr.unread} unread</span>);
  if (pr.openThreads > 0) facts.push(<span key="threads" className="pr-fact">{pr.openThreads} open {pr.openThreads === 1 ? "thread" : "threads"}</span>);
  for (const c of checksSummary(pr)) if (c.level !== "ok") facts.push(<span key={c.level} className={cx("pr-fact", c.level)}>{c.text}</span>);
  if (pr.autoMerge && !done)
    facts.push(
      <Tip key="am" text={merge.text}>
        <span className={cx("pr-fact", merge.level === "muted" ? "" : merge.level)}>auto-merge</span>
      </Tip>,
    );
  if (note.level !== "ok")
    facts.push(
      <span key="sync" className={cx("pr-fact", note.level)}>
        {note.text}
      </span>,
    );
  if (!pr.local) facts.push(<span key="local" className="pr-fact">not this Workspace's repository</span>);
  return (
    <li
      className={cx("pr-row", attn && "attn", done && "done")}
      title="Open this PR's comments, reviews and checks here"
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest("a, button, input, label, [role='menu'], [role='menuitem'], .popover, .tooltip")) return;
        onOpen();
      }}
    >
      <div className="pr-row-main">
        <span className="pr-row-icon" aria-hidden="true">
          <ConnectorIcon kind={pr.provider} size={14} />
          {attn && <span className="pr-dot" />}
        </span>
        <span className="pr-row-ref muted" title={prRef(pr)}>{prRef(pr)}</span>
        {pr.title ? (
          <Tip text={pr.title}>
            <button className="link pr-row-title" onClick={onOpen}>
              {pr.title}
            </button>
          </Tip>
        ) : (
          <span className="pr-row-title muted">{"(loading\u2026)"}</span>
        )}
        <StateChip pr={pr} />
        <PrRowMenu session={session} pr={pr} run={run} onOpen={onOpen} />
      </div>
      <div className="pr-row-sub muted small-text">
        {facts}
        <span className="spacer" />
        <span title={pr.lastActivityAt ?? undefined}>{ago(pr.lastActivityAt)}</span>
      </div>
    </li>
  );
}

function PrRowMenu({ session, pr, run, onOpen }: { session: Session; pr: PullRequest; run: Runner; onOpen: () => void }) {
  const label = PR_PROVIDER_LABEL[pr.provider];
  return (
    <Menu align="end" className="pr-menu" trigger={moreButton(`Actions for ${prRef(pr)}`)}>
      <MenuItem onSelect={onOpen} title="Open this PR here: comments, reviews, checks">
        Open
      </MenuItem>
      <MenuItem onSelect={() => window.open(pr.url, "_blank", "noopener,noreferrer")} title={externalTitle(pr)}>
        Open on {label} {"\u2197"}
      </MenuItem>
      <MenuItem onSelect={() => void run(() => api.refreshPr(session.id, pr.id))} title={`Poll ${label} now`}>
        Refresh
      </MenuItem>
      <MenuItem disabled={pr.unread === 0} onSelect={() => void run(() => api.prSeen(session.id, pr.id))} title="Mark every comment and failed check of this PR as read">
        Mark seen
      </MenuItem>
      <MenuItem
        onSelect={() => void run(() => api.updatePr(session.id, pr.id, { watch: !pr.watch }))}
        title={`Poll ${label} for new comments, reviews and ${pr.provider === "bitbucket" ? "build" : "check"} results`}
      >
        {pr.watch ? "Stop watching" : "Watch"}
      </MenuItem>
      {pr.provider === "github" && !finished(pr) && (
        <MenuItem
          onSelect={() => {
            if (!pr.autoMerge && !confirmAutoMerge(pr)) return;
            void run(() => api.updatePr(session.id, pr.id, { autoMerge: !pr.autoMerge }));
          }}
          title={pr.autoMerge ? mergeNote(pr).text : `Merge it (${METHOD_LABEL[pr.mergeMethod]}) as soon as every check passed and nothing else blocks it`}
        >
          {pr.autoMerge ? "Auto-merge off" : "Auto-merge on"}
        </MenuItem>
      )}
      <MenuItem
        className="danger"
        onSelect={() => {
          if (confirmDetach(pr)) void run(() => api.detachPr(session.id, pr.id));
        }}
      >
        Detach
      </MenuItem>
    </Menu>
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
  onBack,
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
  /** Back to the list of attached PRs (breadcrumb, and after Detach). */
  onBack: () => void;
}) {
  const selection = usePrSelection(items, checks);
  const { selected, setSelected, visible, failedChecks } = selection;
  const [busy, setBusy] = useState<PrAction | null>(null);

  // Looking at the tab reads the items and the failed checks.
  useEffect(() => {
    if (pr.unread > 0 && items && checks) void api.prSeen(session.id, pr.id).catch(() => undefined);
  }, [session.id, pr.id, pr.unread, items, checks]);

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
  const toggleAllChecks = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of failedChecks)
        if (on) next.add(c.id);
        else next.delete(c.id);
      return next;
    });
  const allChecksSelected = failedChecks.length > 0 && failedChecks.every((c) => selected.has(c.id));
  const nChecks = [...selected].filter((id) => checkIds.has(id)).length;
  const onlyChecks = nChecks > 0 && nChecks === selected.size;
  const note = syncNote(pr);
  const merge = mergeNote(pr);
  const n = selected.size;
  const done = finished(pr);
  const label = PR_PROVIDER_LABEL[pr.provider];
  const setAutoMerge = (on: boolean) => {
    if (on && !confirmAutoMerge(pr)) return;
    void run(() => api.updatePr(session.id, pr.id, { autoMerge: on }));
  };

  return (
    <div className={cx("pane prs-pane pr-detail", n > 0 && "pr-picking")}>
      <nav className="pr-crumbs" aria-label="Pull requests">
        <button className="link" onClick={onBack} title="All pull requests attached to this Session">
          Pull requests
        </button>
        <span className="muted" aria-hidden="true">
          {"\u203A"}
        </span>
        <span aria-current="page" className={cx("pr-ellipsis", `pr-tab-${pr.state}`)}>
          {prRef(pr)}
        </span>
        <span className="spacer" />
        <a href={pr.url} target="_blank" rel="noreferrer" className="pr-ext" title={externalTitle(pr)}>
          {label} {"\u2197"}
        </a>
      </nav>

      <header className="pr-head">
        <h2 className="pr-title" title={pr.title}>
          {pr.title || <span className="muted">{"(loading\u2026)"}</span>}
        </h2>
        <div className="pr-chips">
          <StateChip pr={pr} />
          {pr.headRef && (
            <Tip text={`${pr.headRef} \u2192 ${pr.baseRef}`}>
              <span className="pill pr-chip pr-branches">
                <code>{pr.baseRef}</code>
                <span className="muted" aria-hidden="true">
                  {" \u2190 "}
                </span>
                <code>{pr.headRef}</code>
              </span>
            </Tip>
          )}
          {pr.author && <span className="pill pr-chip pr-ellipsis">@{pr.author}</span>}
          <Tip text={pr.provider === "bitbucket" ? `A Bitbucket Data Center (${pr.host}), read with its Connector's token` : externalTitle(pr)}>
            <a href={pr.url} target="_blank" rel="noreferrer" className="pill pr-chip pr-provider">
              <ConnectorIcon kind={pr.provider} size={12} />
              <span className="pr-ellipsis">{pr.provider === "bitbucket" ? pr.host : label}</span>
              {"\u2197"}
            </a>
          </Tip>
        </div>
        <div className="pr-toolbar">
          <button className="small" onClick={() => void run(() => api.refreshPr(session.id, pr.id))} title={`Poll ${label} now`}>
            Refresh
          </button>
          <button className="small" disabled={pr.unread === 0} onClick={() => void run(() => api.prSeen(session.id, pr.id))} title="Mark every comment and failed check as read">
            Mark all seen
          </button>
          {pr.provider === "github" && (
            <Popover
              className="pr-merge-pop"
              trigger={
                <button className={cx("small", pr.autoMerge && !done && "primary")} title="Merge this PR automatically once every check passed and nothing else blocks it">
                  {done ? "Merge" : pr.autoMerge ? "Auto-merge: on" : "Auto-merge"}
                </button>
              }
            >
              <label className="check">
                <input type="checkbox" checked={pr.autoMerge} disabled={done} onChange={(e) => setAutoMerge(e.target.checked)} />
                Auto-merge when checks pass
              </label>
              <label className="pr-merge-method">
                <span className="muted">Method</span>
                <select
                  value={pr.mergeMethod}
                  disabled={done}
                  title="How GitHub merges it"
                  onChange={(e) => void run(() => api.updatePr(session.id, pr.id, { mergeMethod: e.target.value as MergeMethod }))}
                >
                  {MERGE_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABEL[m]}
                    </option>
                  ))}
                </select>
              </label>
              <p className={cx("pr-merge-note", merge.level)}>{merge.text}</p>
              {pr.mergeState && !done && (
                <p className="muted small-text" title={pr.mergeState.headSha}>
                  checked {ago(pr.mergeState.checkedAt)} on {pr.mergeState.headSha.slice(0, 7)}
                </p>
              )}
            </Popover>
          )}
          <span className="spacer" />
          <button
            className="small danger"
            onClick={() => {
              if (confirmDetach(pr)) {
                void run(() => api.detachPr(session.id, pr.id));
                onBack();
              }
            }}
          >
            Detach
          </button>
        </div>
        <div className="pr-status small-text">
          <span className={note.level === "ok" ? "muted" : note.level}>{note.text}</span>
          {pr.provider === "github" && (pr.autoMerge || (done && pr.mergeState?.merged)) && (
            <span className={merge.level === "muted" ? "muted" : merge.level}>
              {" \u00b7 auto-merge: "}
              {merge.text}
            </span>
          )}
          {!pr.local && <span className="warn"> {"\u00b7"} not this Workspace's repository: Address is off</span>}
        </div>
      </header>

      {!done && (
        <PrChecks
          pr={pr}
          selection={selection}
          summaryActions={
            failedChecks.length > 0 && (
              <label className="check small-text muted" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={allChecksSelected} onChange={(e) => toggleAllChecks(e.target.checked)} />
                all failed
              </label>
            )
          }
          menu={(c) =>
            c.state === "failed" ? (
              <Menu align="end" className="pr-menu" trigger={moreButton(`Actions for ${c.name}`)}>
                {ACTIONS.map((a) => (
                  <MenuItem key={a} disabled={busy !== null || (a !== "prompt" && !pr.local)} title={checkActionTitle(a, pr, 1)} onSelect={() => act(a, [c.id])}>
                    {CHECK_ACTION_LABEL[a]}
                  </MenuItem>
                ))}
              </Menu>
            ) : (
              <span className="pr-more" aria-hidden="true" />
            )
          }
        />
      )}

      <PrThreads
        pr={pr}
        items={items}
        selection={selection}
        onToggleAll={toggleAll}
        selectAllTitle={(allSelected) => (allSelected ? "Unselect all" : "Select every comment shown")}
        selfTitle="written with the login this PR is watched with"
        menu={(it) => (
          <Menu align="end" className="pr-menu" trigger={moreButton(`Actions for the comment by ${it.author}`)}>
            {ACTIONS.map((a) => (
              <MenuItem key={a} disabled={busy !== null || (a !== "prompt" && !pr.local)} title={actionTitle(a, pr, 1)} onSelect={() => act(a, [it.id])}>
                {ACTION_LABEL[a]}
              </MenuItem>
            ))}
          </Menu>
        )}
      />

      {n > 0 && (
        <div className="pr-bulk" role="toolbar" aria-label="Selected items">
          <span className="pr-bulk-count">
            {n} selected{nChecks > 0 && nChecks < n ? ` (${nChecks} ${nChecks === 1 ? "check" : "checks"})` : ""}
          </span>
          {ACTIONS.map((a) => (
            <button
              key={a}
              className={cx("small", a === "address_reply" && "primary")}
              disabled={busy !== null || (a !== "prompt" && !pr.local)}
              title={onlyChecks ? checkActionTitle(a, pr, n) : actionTitle(a, pr, n)}
              onClick={() => act(a, [...selected])}
            >
              {busy === a ? "\u2026" : onlyChecks ? CHECK_ACTION_LABEL[a] : ACTION_LABEL[a]}
            </button>
          ))}
          <span className="spacer" />
          <button className="link small-text" onClick={() => setSelected(new Set())}>
            clear
          </button>
        </div>
      )}
    </div>
  );
}
