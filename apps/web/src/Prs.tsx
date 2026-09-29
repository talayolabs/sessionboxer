import {
  PR_EVENT_LABELS,
  PR_PROVIDER_LABEL,
  PROVIDERS,
  PROVIDER_LABELS,
  type Automation,
  type AutomationRun,
  type FollowedPr,
  type PrCheckItem,
  type PrEvent,
  type PrFollow,
  type PrFollowHook,
  type PrFollowKind,
  type PrItem,
  type Provider,
  type Session,
} from "@sessionboxer/protocol";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { RUN_LABEL, RunHistory, badgeClass } from "./Automations";
import { ConnectorIcon } from "./ConnectorIcon";
import { accountKey, useFollowAccounts } from "./FollowRepo";
import { RepoDatalist, followSuggestions, useKnownRepos } from "./RepoSuggest";
import { FileLink } from "./FileLink";
import { Markdown } from "./Markdown";
import { CHECK_GLYPH, CHECK_STATE_LABEL, Ellipsis, KIND_LABEL, LEVEL_OF_CHECK, StateChip, ago, checkResultTitle, groupThreads, kindGlyph, moreButton } from "./PullRequests";
import { cx, Menu, MenuItem, Modal, Popover, Tip } from "./ui";

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

const KIND_TITLE: Record<PrFollowKind, string> = { repo: "Every open PR of", mine: "PRs opened by", requested: "Reviews requested from" };

/** One line naming a follow, for chips and the automation form's follow picker. */
export function followLabel(f: Pick<PrFollow, "provider" | "host" | "account" | "kind" | "owner" | "repo">): string {
  const where = f.provider === "github" ? "" : ` on ${f.host}`;
  if (f.kind === "repo") return `${f.owner}/${f.repo}${where}`;
  return `${KIND_TITLE[f.kind]} @${f.account}${where}`;
}

function prRef(pr: FollowedPr): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

function finished(pr: FollowedPr): boolean {
  return pr.state === "merged" || pr.state === "closed";
}

function syncText(pr: FollowedPr): { text: string; level: "ok" | "warn" | "error" } {
  switch (pr.syncError) {
    case null:
      return { text: pr.syncedAt ? `synced ${ago(pr.syncedAt)}` : "first sync pending…", level: "ok" };
    case "unauthorized":
      return { text: pr.syncErrorDetail ?? "no connected login can read this PR", level: "error" };
    case "not_found":
      return { text: "PR not found (or no access)", level: "error" };
    case "rate_limited":
      return { text: `${PR_PROVIDER_LABEL[pr.provider]} rate limit; retrying later`, level: "warn" };
    default:
      return { text: pr.syncErrorDetail ? `error: ${pr.syncErrorDetail}` : "error", level: "error" };
  }
}

function followSync(f: PrFollow): string | null {
  if (!f.enabled) return "paused";
  switch (f.syncError) {
    case null:
      return null;
    case "unauthorized":
      return f.syncErrorDetail ?? "cannot read with this login";
    case "not_found":
      return "repository not found (or no access)";
    case "rate_limited":
      return "rate limited; retrying later";
    default:
      return f.syncErrorDetail ? `error: ${f.syncErrorDetail}` : "error";
  }
}

function copy(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

function checkText(c: PrCheckItem): string {
  const lines = [`${c.name} — ${c.conclusion ?? CHECK_STATE_LABEL[c.state]}${c.source ? ` (${c.source})` : ""}`];
  if (c.summary) lines.push("", c.summary.trim());
  if (c.url) lines.push("", c.url);
  return lines.join("\n");
}

function itemText(it: PrItem): string {
  const where = it.path ? ` on ${it.path}${it.line !== null ? `:${it.line}` : ""}` : "";
  return `${KIND_LABEL[it.kind]} by @${it.author}${where} (${it.htmlUrl}):\n${it.body.trim()}`;
}

// --- Page ------------------------------------------------------------------------------------

export function PrsPage({
  prs,
  follows,
  sessions,
  automations,
  items,
  checks,
  events,
  prRuns,
  loadDetail,
  onOpenSession,
  run,
  focusId,
  onFocus,
}: {
  prs: FollowedPr[];
  follows: PrFollow[];
  sessions: Session[];
  automations: Automation[];
  items: Record<string, PrItem[]>;
  checks: Record<string, PrCheckItem[]>;
  events: Record<string, PrEvent[]>;
  prRuns: Record<string, AutomationRun[]>;
  loadDetail: (prId: string) => void;
  onOpenSession: (id: string) => void;
  run: Runner;
  focusId: string | null;
  onFocus: (id: string | null) => void;
}) {
  const focused = focusId ? (prs.find((p) => p.id === focusId) ?? null) : null;
  if (focused) {
    return (
      <FollowedPrDetail
        key={focused.id}
        pr={focused}
        items={items[focused.id] ?? null}
        checks={checks[focused.id] ?? null}
        events={events[focused.id] ?? null}
        runs={prRuns[focused.id]}
        sessions={sessions}
        automations={automations.filter((a) => a.trigger.type === "pr_event")}
        loadDetail={loadDetail}
        onOpenSession={onOpenSession}
        run={run}
        onBack={() => onFocus(null)}
      />
    );
  }
  return <FollowedPrList prs={prs} follows={follows} automations={automations} run={run} onOpen={(id) => onFocus(id)} onOpenSession={onOpenSession} />;
}

// --- List --------------------------------------------------------------------------------------

function FollowedPrList({
  prs,
  follows,
  automations,
  run,
  onOpen,
  onOpenSession,
}: {
  prs: FollowedPr[];
  follows: PrFollow[];
  automations: Automation[];
  run: Runner;
  onOpen: (id: string) => void;
  onOpenSession: (id: string) => void;
}) {
  const [following, setFollowing] = useState(false);
  const [hookFor, setHookFor] = useState<PrFollow | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const act = (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    void run(fn).finally(() => setBusy(null));
  };
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return prs
      .filter((p) => showClosed || !finished(p))
      .filter((p) => q === "" || prRef(p).toLowerCase().includes(q) || p.title.toLowerCase().includes(q) || p.author.toLowerCase().includes(q) || p.headRef.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(finished(a)) - Number(finished(b)) ||
          Number(b.unread > 0 || b.checksFailed > 0) - Number(a.unread > 0 || a.checksFailed > 0) ||
          Date.parse(b.remoteUpdatedAt ?? b.firstSeenAt) - Date.parse(a.remoteUpdatedAt ?? a.firstSeenAt),
      );
  }, [prs, showClosed, filter]);
  const closed = prs.filter(finished).length;
  const byId = useMemo(() => new Map(automations.map((a) => [a.id, a])), [automations]);
  return (
    <div className="panel prs-page">
      <div className="schedules-head">
        <h2>Pull requests</h2>
        <span className="spacer" />
        <button type="button" className="primary" onClick={() => setFollowing(true)}>
          + Follow
        </button>
      </div>
      <p className="muted">
        Open pull requests of the repositories and logins you follow, read by the Control Plane with your Connectors' tokens: comments, reviews and failing checks to look at
        by hand, attach to a Session or start one from. Automations react to them from the Automations page.
      </p>
      {follows.length === 0 ? (
        <p className="placeholder-inline muted">Nothing followed yet. Follow a repository, the PRs you opened or the reviews asked of you.</p>
      ) : (
        <div className="prs-follows" aria-label="Follows">
          {follows.map((f) => {
            const note = followSync(f);
            return (
              <span key={f.id} className={cx("prs-follow", !f.enabled && "disabled", f.enabled && f.syncError && "error")} title={note ?? `${f.prCount} open · polled ${ago(f.polledAt)} as @${f.account}`}>
                <ConnectorIcon kind={f.provider} size={12} />
                <span className="prs-follow-label">{followLabel(f)}</span>
                <span className="muted">{note ?? f.prCount}</span>
                <Menu align="end" className="pr-menu" trigger={moreButton(`Actions for ${followLabel(f)}`)}>
                  <MenuItem disabled={busy === f.id} onSelect={() => act(f.id, () => api.pollPrFollow(f.id))}>
                    Poll now
                  </MenuItem>
                  <MenuItem disabled={busy === f.id} onSelect={() => act(f.id, () => api.updatePrFollow(f.id, !f.enabled))}>
                    {f.enabled ? "Pause" : "Resume"}
                  </MenuItem>
                  <MenuItem disabled={busy === f.id} onSelect={() => setHookFor(f)}>
                    Webhook…{f.webhook !== "none" && ` (${f.webhook})`}
                  </MenuItem>
                  <MenuItem
                    className="danger"
                    disabled={busy === f.id}
                    onSelect={() => {
                      if (confirm(`Unfollow ${followLabel(f)}? Its PRs leave this page (nothing changes on ${PR_PROVIDER_LABEL[f.provider]}).`)) act(f.id, () => api.deletePrFollow(f.id));
                    }}
                  >
                    Unfollow
                  </MenuItem>
                </Menu>
              </span>
            );
          })}
        </div>
      )}
      {prs.length > 0 && (
        <div className="prs-filters">
          <input type="search" placeholder="Filter by repository, title, author or branch" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {closed > 0 && (
            <label className="check">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
              show {closed} merged / closed
            </label>
          )}
          <span className="muted small-text">
            {visible.length} of {prs.length}
          </span>
        </div>
      )}
      {prs.length === 0 && follows.length > 0 && <p className="placeholder-inline muted">{follows.some((f) => f.polledAt === null) ? "Reading the follows…" : "No open pull requests."}</p>}
      {visible.length > 0 && (
        <ul className="pr-list">
          {visible.map((pr) => (
            <FollowedPrRow key={pr.id} pr={pr} automations={byId} onOpen={() => onOpen(pr.id)} onOpenSession={onOpenSession} />
          ))}
        </ul>
      )}
      {following && <FollowDialog follows={follows} run={run} onClose={() => setFollowing(false)} />}
      {hookFor && <HookDialog follow={follows.find((f) => f.id === hookFor.id) ?? hookFor} run={run} onClose={() => setHookFor(null)} />}
    </div>
  );
}

function RunBadges({ pr, automations }: { pr: FollowedPr; automations: Map<string, Automation> }) {
  if (pr.runs.length === 0) return null;
  return (
    <span className="pr-run-badges">
      {pr.runs.map((r) => {
        const a = automations.get(r.automationId);
        return (
          <Tip key={r.id} text={`${a?.name ?? "automation"}: ${RUN_LABEL[r.status]}${r.result?.type === "review" ? ` — ${r.result.findings} finding${r.result.findings === 1 ? "" : "s"}${r.result.high > 0 ? ` (${r.result.high} high)` : ""}, ${r.result.verdict.replace("_", " ")}` : ""}${r.result?.type === "qa" ? ` — ${r.result.skipped ? "QA skipped" : `QA ${r.result.passed}/${r.result.total} passed`}${r.result.videoUrl ? ", video" : ""}` : ""}${r.detail ? ` — ${r.detail}` : ""}${r.error ? ` — ${r.error}` : ""}`}>
            <span className={`pill e2e-badge e2e-badge-${badgeClass(r.status)}`}>
              {a?.action.type === "auto_review" ? "review" : a?.action.type === "auto_qa" ? "QA" : (a?.name ?? "run")} {RUN_LABEL[r.status]}
            </span>
          </Tip>
        );
      })}
    </span>
  );
}

function FollowedPrRow({ pr, automations, onOpen, onOpenSession }: { pr: FollowedPr; automations: Map<string, Automation>; onOpen: () => void; onOpenSession: (id: string) => void }) {
  const done = finished(pr);
  const attn = pr.unread > 0 || pr.checksFailed > 0;
  const sync = syncText(pr);
  const facts: ReactNode[] = [];
  if (pr.unread > 0) facts.push(<span key="unread" className="pr-fact pr-fact-unread">{pr.unread} unread</span>);
  if (pr.checksFailed > 0) facts.push(<span key="failed" className="pr-fact error">{pr.checksFailed} failed</span>);
  if (pr.checksPending > 0) facts.push(<span key="pending" className="pr-fact warn">{pr.checksPending} running</span>);
  if (pr.isFork) facts.push(<span key="fork" className="pr-fact muted">fork</span>);
  if (sync.level !== "ok") facts.push(<span key="sync" className={cx("pr-fact", sync.level)}>{sync.text}</span>);
  return (
    <li
      className={cx("pr-row", attn && "attn", done && "done")}
      title="Open this PR's comments, reviews, checks and events"
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
        <Tip text={pr.title}>
          <button className="link pr-row-title" onClick={onOpen}>
            {pr.title || "(no title yet)"}
          </button>
        </Tip>
        <StateChip pr={pr} />
      </div>
      <div className="pr-row-sub small-text muted">
        <span>@{pr.author}</span>
        {pr.headRef && <code>{pr.headRef}</code>}
        {facts}
        <RunBadges pr={pr} automations={automations} />
        {pr.attached.length > 0 && (
          <button type="button" className="link small-text" onClick={() => onOpenSession(pr.attached[0]!.sessionId)} title="Open the Session this PR is attached to">
            in {pr.attached.length === 1 ? "a Session" : `${pr.attached.length} Sessions`}
          </button>
        )}
        <span className="spacer" />
        <span title={pr.remoteUpdatedAt ?? undefined}>{pr.remoteUpdatedAt ? `updated ${ago(pr.remoteUpdatedAt)}` : `seen ${ago(pr.firstSeenAt)}`}</span>
      </div>
    </li>
  );
}

// --- Webhook dialog (ADR-0067) -----------------------------------------------------------------

function HookDialog({ follow, run, onClose }: { follow: PrFollow; run: Runner; onClose: () => void }) {
  const [hook, setHook] = useState<PrFollowHook | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.prFollowHook(follow.id).then(setHook, () => setHook(null));
  }, [follow.id]);
  const manual = follow.provider === "bitbucket" || follow.kind !== "repo";
  const act = async (fn: () => Promise<PrFollowHook>) => {
    setBusy(true);
    await run(async () => setHook(await fn()));
    setBusy(false);
  };
  const on = hook !== null && hook.webhook !== "none";
  return (
    <Modal
      title={`Webhook for ${followLabel(follow)}`}
      description="Optional. A delivery only makes the Control Plane poll that PR right away; polling every minute stays the source of truth, so nothing breaks when the hook is down. Worth it when a tunnel with a stable hostname is up."
      dismissible={!busy}
      onClose={onClose}
    >
      <div className="follow-form">
        {hook === null && <p className="muted small-text">Loading…</p>}
        {hook !== null && !on && (
          <>
            <label>
              Public URL of this Control Plane (a tunnel)
              <input type="url" placeholder={`${location.origin} (this origin)`} value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" />
            </label>
            <p className="muted small-text">
              {manual
                ? `This follow cannot be registered from here: you get a URL and a secret to paste into the repository's webhook settings on ${PR_PROVIDER_LABEL[follow.provider]} (events: pull requests, comments, builds).`
                : `Registers a repository webhook on ${PR_PROVIDER_LABEL[follow.provider]} as @${follow.account} (needs admin on ${follow.owner}/${follow.repo}); it is removed when you turn it off or unfollow.`}
            </p>
            <div className="actions">
              <button type="button" className="primary" disabled={busy} onClick={() => act(() => api.enablePrFollowHook(follow.id, url.trim() || undefined))}>
                {manual ? "Create URL and secret" : "Register webhook"}
              </button>
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
        {hook !== null && on && (
          <>
            <p className="small-text">
              {hook.webhook === "healthy" ? "Healthy: " : hook.registeredId ? "Registered: " : "Configured: "}
              {hook.seenAt ? `last delivery ${ago(hook.seenAt)}` : "no delivery seen yet"}
              {hook.webhook === "healthy" && " · the list is polled every 5 min while deliveries keep coming"}
            </p>
            <label>
              Payload URL
              <input type="text" readOnly value={hook.url ?? ""} onFocus={(e) => e.currentTarget.select()} />
            </label>
            {hook.secret && (
              <label>
                Secret (HMAC-SHA-256; the platform sends it as a sha256= signature header)
                <input type="text" readOnly value={hook.secret} onFocus={(e) => e.currentTarget.select()} />
              </label>
            )}
            <div className="actions">
              <button type="button" className="danger" disabled={busy} onClick={() => act(() => api.disablePrFollowHook(follow.id))}>
                {hook.registeredId ? "Remove webhook" : "Turn off"}
              </button>
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// --- Follow dialog ---------------------------------------------------------------------------

function FollowDialog({ follows, run, onClose }: { follows: PrFollow[]; run: Runner; onClose: () => void }) {
  const accounts = useFollowAccounts();
  const known = useKnownRepos();
  const listId = useId();
  const [kind, setKind] = useState<PrFollowKind>("repo");
  const [account, setAccount] = useState<string>("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (accounts && accounts.length > 0 && account === "") setAccount(accountKey(accounts[0]!));
  }, [accounts, account]);
  const picked = accounts?.find((a) => accountKey(a) === account) ?? null;
  const duplicate = picked && kind !== "repo" && follows.some((f) => f.kind === kind && f.provider === picked.kind && f.account.toLowerCase() === picked.account.toLowerCase());
  const submit = () => {
    if (!picked || busy) return;
    setBusy(true);
    void run(async () => {
      await api.createPrFollow({ provider: picked.kind, host: picked.host, account: picked.account, kind, ...(kind === "repo" ? { repo: repo.trim() } : {}) });
      onClose();
    }).finally(() => setBusy(false));
  };
  return (
    <Modal title="Follow pull requests" description="The Control Plane polls them every minute with the login's token; nothing is posted." onClose={onClose} onSubmit={submit}>
      <div className="follow-form">
        <div className="segmented small" role="tablist" aria-label="What to follow">
          {(["repo", "mine", "requested"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
              {k === "repo" ? "A repository" : k === "mine" ? "My PRs" : "Reviews asked of me"}
            </button>
          ))}
        </div>
        {accounts === null ? (
          <p className="muted">Loading logins…</p>
        ) : accounts.length === 0 ? (
          <p className="warn">No GitHub or Bitbucket account is connected: add one under Global settings → MCP &amp; connectors first.</p>
        ) : (
          <label>
            {kind === "repo" ? "Read with" : "Login"}
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              {accounts.map((a) => (
                <option key={`${a.kind}|${a.host}|${a.account}`} value={`${a.kind}|${a.host}|${a.account}`}>
                  @{a.account} · {a.kind === "github" ? "GitHub" : a.host}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === "repo" && (
          <label>
            Repository
            <input
              autoFocus
              placeholder={picked?.kind === "bitbucket" ? "PROJECT/slug, or the repository's URL" : "owner/repo, or the repository's URL"}
              value={repo}
              list={listId}
              spellCheck={false}
              onChange={(e) => setRepo(e.target.value)}
            />
            {picked && <RepoDatalist id={listId} options={followSuggestions(known, picked.kind, picked.host)} />}
          </label>
        )}
        <p className="muted small-text">
          {kind === "repo"
            ? "Every open PR of the repository, whoever opened it (forks included; automations decide what to do with those)."
            : kind === "mine"
              ? "The open PRs this login opened, in any repository it can see."
              : "The open PRs this login is asked to review, in any repository it can see."}
        </p>
        {duplicate && <p className="warn small-text">Already followed.</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !picked || !!duplicate || (kind === "repo" && repo.trim() === "")}>
            {busy ? "Following…" : "Follow"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- Detail ------------------------------------------------------------------------------------

function FollowedPrDetail({
  pr,
  items,
  checks,
  events,
  runs,
  sessions,
  automations,
  loadDetail,
  onOpenSession,
  run,
  onBack,
}: {
  pr: FollowedPr;
  items: PrItem[] | null;
  checks: PrCheckItem[] | null;
  events: PrEvent[] | null;
  runs: AutomationRun[] | undefined;
  sessions: Session[];
  automations: Automation[];
  loadDetail: (prId: string) => void;
  onOpenSession: (id: string) => void;
  run: Runner;
  onBack: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showResolved, setShowResolved] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [checksOpen, setChecksOpen] = useState(pr.checksFailed > 0 || pr.checksPending > 0);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => loadDetail(pr.id), [pr.id, loadDetail]);
  useEffect(() => {
    if (pr.checksFailed > 0 || pr.checksPending > 0) setChecksOpen(true);
  }, [pr.checksFailed, pr.checksPending]);
  useEffect(() => {
    if (pr.unread > 0 && items && checks) void api.followedPrSeen(pr.id).catch(() => undefined);
  }, [pr.id, pr.unread, items, checks]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const visible = useMemo(() => (showResolved ? (items ?? []) : (items ?? []).filter((i) => !i.resolved)), [items, showResolved]);
  const threads = useMemo(() => groupThreads(visible), [visible]);
  const hidden = (items?.length ?? 0) - visible.length;
  const sortedChecks = useMemo(() => {
    const rank: Record<PrCheckItem["state"], number> = { failed: 0, pending: 1, passed: 2 };
    return [...(checks ?? [])].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
  }, [checks]);
  const failedChecks = sortedChecks.filter((c) => c.state === "failed");
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const copyText = (what: string, text: string) => {
    void copy(text).then(
      () => setCopied(what),
      () => setCopied(null),
    );
  };
  const copySelected = () => {
    const parts: string[] = [];
    for (const c of failedChecks) if (selected.has(c.id)) parts.push(checkText(c));
    for (const it of items ?? []) if (selected.has(it.id)) parts.push(itemText(it));
    copyText("selection", `${prRef(pr)} — ${pr.title}\n${pr.url}\n\n${parts.join("\n\n---\n\n")}`);
  };
  const copyFailures = () => copyText("failures", `${prRef(pr)} — failing checks on ${pr.headSha.slice(0, 7)}\n\n${failedChecks.map(checkText).join("\n\n---\n\n")}`);
  const sync = syncText(pr);
  const done = finished(pr);
  const label = PR_PROVIDER_LABEL[pr.provider];
  const allGreen = checks !== null && checks.length > 0 && pr.checksFailed === 0 && pr.checksPending === 0;
  const attachable = sessions.filter((s) => s.status !== "error" && !pr.attached.some((a) => a.sessionId === s.id));
  const n = selected.size;

  return (
    <div className={cx("panel prs-page pr-detail", n > 0 && "pr-picking")}>
      <nav className="pr-crumbs" aria-label="Pull requests">
        <button className="link" onClick={onBack} title="All followed pull requests">
          Pull requests
        </button>
        <span className="muted" aria-hidden="true">
          {"\u203A"}
        </span>
        <span aria-current="page" className={cx("pr-ellipsis", `pr-tab-${pr.state}`)}>
          {prRef(pr)}
        </span>
        <span className="spacer" />
        <a href={pr.url} target="_blank" rel="noreferrer" className="pr-ext" title={`Open on ${label}, in a new tab`}>
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
            <Tip text={`${pr.headRef} \u2192 ${pr.baseRef}${pr.isFork ? ` (from the fork ${pr.headRepo})` : ""}`}>
              <span className="pill pr-chip pr-branches">
                <code>{pr.baseRef}</code>
                <span className="muted" aria-hidden="true">
                  {" \u2190 "}
                </span>
                <code>{pr.isFork ? `${pr.headRepo}:` : ""}{pr.headRef}</code>
              </span>
            </Tip>
          )}
          {pr.author && <span className="pill pr-chip pr-ellipsis">@{pr.author}</span>}
          {pr.requestedReviewers.length > 0 && (
            <Tip text={`Review requested from ${pr.requestedReviewers.map((r) => `@${r}`).join(", ")}`}>
              <span className="pill pr-chip">
                {pr.requestedReviewers.length} {pr.requestedReviewers.length === 1 ? "reviewer" : "reviewers"}
              </span>
            </Tip>
          )}
          {pr.labels.length > 0 && (
            <span className="pr-labels">
              {pr.labels.map((l) => (
                <span key={l} className="pr-label">
                  {l}
                </span>
              ))}
            </span>
          )}
          <a href={pr.url} target="_blank" rel="noreferrer" className="pill pr-chip pr-provider">
            <ConnectorIcon kind={pr.provider} size={12} />
            <span className="pr-ellipsis">{pr.provider === "bitbucket" ? pr.host : label}</span>
            {"\u2197"}
          </a>
        </div>
        <div className="pr-toolbar">
          <button className="small" onClick={() => void run(() => api.refreshFollowedPr(pr.id))} title={`Poll ${label} now`}>
            Refresh
          </button>
          <button className="small" disabled={pr.unread === 0} onClick={() => void run(() => api.followedPrSeen(pr.id))} title="Mark every comment and failed check as read">
            Mark all seen
          </button>
          {failedChecks.length > 0 && (
            <button className="small" onClick={copyFailures} title="Copy the name, result, summary and link of every failing check">
              {copied === "failures" ? "Copied" : "Copy failures"}
            </button>
          )}
          <Popover
            trigger={
              <button className="small" disabled={sessions.length === 0} title="Attach this PR to a Session: its PRs pane then follows it and Address works there">
                Attach to Session
              </button>
            }
          >
            {pr.attached.length > 0 && (
              <p className="muted small-text">
                Attached to{" "}
                {pr.attached.map((a, i) => (
                  <span key={a.sessionId}>
                    {i > 0 && ", "}
                    <button type="button" className="link" onClick={() => onOpenSession(a.sessionId)}>
                      {sessions.find((s) => s.id === a.sessionId)?.title ?? a.sessionId.slice(0, 8)}
                    </button>
                  </span>
                ))}
              </p>
            )}
            {attachable.length === 0 ? (
              <p className="muted small-text">No other Session.</p>
            ) : (
              <select
                defaultValue=""
                disabled={busy}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) return;
                  setBusy(true);
                  void run(() => api.attachFollowedPr(pr.id, { sessionId: id })).finally(() => setBusy(false));
                }}
              >
                <option value="">Pick a Session…</option>
                {attachable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            )}
          </Popover>
          <button className="small primary" disabled={done || pr.headRef === ""} onClick={() => setStarting(true)} title="A new Session with this PR's branch checked out and the PR attached">
            Start Session
          </button>
          {automations.length > 0 && (
            <Menu align="end" className="pr-menu" trigger={<button className="small">Run automation…</button>}>
              {automations.map((a) => (
                <MenuItem key={a.id} disabled={busy} onSelect={() => void run(() => api.runPrAutomation(pr.id, { automationId: a.id }))}>
                  {a.name}
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>
        <div className="pr-status small-text">
          <span className={sync.level === "ok" ? "muted" : sync.level}>{sync.text}</span>
          {pr.headSha && (
            <span className="muted">
              {" \u00b7 "}head <code>{pr.headSha.slice(0, 7)}</code>
            </span>
          )}
          {pr.follows.length > 0 && <span className="muted">{" \u00b7 "}via {pr.follows.length === 1 ? "one follow" : `${pr.follows.length} follows`}</span>}
        </div>
      </header>

      {checks !== null && checks.length > 0 && (
        <details className="pr-section pr-checks" open={checksOpen} onToggle={(e) => setChecksOpen(e.currentTarget.open)}>
          <summary>
            <span className={cx("pr-check-glyph", allGreen ? "ok" : pr.checksFailed > 0 ? "error" : "warn")} aria-hidden="true">
              {allGreen ? CHECK_GLYPH.passed : pr.checksFailed > 0 ? CHECK_GLYPH.failed : CHECK_GLYPH.pending}
            </span>
            <span className="pr-section-title">
              {allGreen
                ? `${checks.length} ${checks.length === 1 ? "check" : "checks"} passed`
                : [pr.checksFailed > 0 && <span key="f" className="error">{pr.checksFailed} failed</span>, pr.checksPending > 0 && <span key="p" className="warn">{pr.checksPending} running</span>, pr.checksPassed > 0 && <span key="ok" className="ok">{pr.checksPassed} passed</span>]
                    .filter(Boolean)
                    .map((el, i) => (
                      <span key={i}>
                        {i > 0 && <span className="muted"> {"\u00b7"} </span>}
                        {el}
                      </span>
                    ))}
            </span>
            <span className="spacer" />
          </summary>
          <ul className="pr-check-list">
            {sortedChecks.map((c) => {
              const failed = c.state === "failed";
              const result = failed && c.conclusion && c.conclusion !== "failure" && c.conclusion !== "failed" ? c.conclusion.replace(/_/g, " ") : CHECK_STATE_LABEL[c.state];
              return (
                <li key={c.id} className={cx("pr-check", `pr-check-${c.state}`, !c.seen && failed && "unread", selected.has(c.id) && "picked")}>
                  {failed ? (
                    <input type="checkbox" className="pr-pick" checked={selected.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} aria-label={`Select ${c.name}`} />
                  ) : (
                    <span className="pr-pick" aria-hidden="true" />
                  )}
                  <span className={cx("pr-check-glyph", LEVEL_OF_CHECK[c.state])} aria-hidden="true">
                    {CHECK_GLYPH[c.state]}
                  </span>
                  <span className="pr-check-main">
                    <Ellipsis className="pr-check-name" text={c.name} />
                    <span className="muted small-text pr-check-src">
                      {c.source ?? (c.kind === "status" ? "commit status" : c.kind === "build" ? "build status" : "check")}
                      {c.required && " \u00b7 required"}
                      {failed && c.summary && <> {"\u00b7"} {c.summary.split("\n")[0]}</>}
                    </span>
                  </span>
                  <span className="pr-check-status small-text" title={checkResultTitle(c)}>
                    {!c.seen && failed && <span className="count">new</span>}
                    <span className={cx("pr-check-result", LEVEL_OF_CHECK[c.state])}>{result}</span>
                    <span className="muted">{c.completedAt ? ago(c.completedAt) : c.startedAt ? `since ${ago(c.startedAt)}` : ""}</span>
                  </span>
                  {c.url && (
                    <a href={c.url} target="_blank" rel="noreferrer" className="pr-ext" title="Open the log / details">
                      {"\u2197"}
                    </a>
                  )}
                  <Menu align="end" className="pr-menu" trigger={moreButton(`Actions for ${c.name}`)}>
                    <MenuItem onSelect={() => copyText(c.id, checkText(c))}>Copy</MenuItem>
                    {c.url && <MenuItem onSelect={() => copyText(c.id, c.url!)}>Copy link</MenuItem>}
                  </Menu>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      <section className="pr-section pr-threads" aria-label="Comments and reviews">
        <div className="pr-section-head">
          <label className="check" title={visible.length === 0 ? undefined : "Select every comment shown"}>
            <input
              type="checkbox"
              checked={visible.length > 0 && visible.every((i) => selected.has(i.id))}
              onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...visible.map((i) => i.id)]) : new Set([...selected].filter((id) => !visible.some((i) => i.id === id))))}
              disabled={visible.length === 0}
            />
            <span className="pr-section-title">Comments &amp; reviews{items && items.length > 0 && <span className="muted"> ({visible.length})</span>}</span>
          </label>
          <span className="spacer" />
          {hidden > 0 && (
            <label className="check muted small-text">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
              show {hidden} resolved
            </label>
          )}
        </div>
        {items === null ? (
          <p className="muted prs-empty">{"Loading\u2026"}</p>
        ) : visible.length === 0 ? (
          <p className="muted prs-empty">{items.length === 0 ? "No comments or reviews yet." : "All threads resolved."}</p>
        ) : (
          threads.map((t) => (
            <div key={t.key} className={cx("pr-thread", t.resolved && "resolved")}>
              <div className="pr-thread-head small-text">
                {t.path ? (
                  <FileLink fileRef={t.line !== null ? { path: t.path, line: t.line } : { path: t.path }} className="pr-thread-path">
                    <code title={t.path}>
                      {t.path}
                      {t.line !== null ? `:${t.line}` : ""}
                    </code>
                  </FileLink>
                ) : (
                  <span className="pr-thread-path muted">Conversation</span>
                )}
                {t.outdated && <span className="muted">outdated</span>}
                {t.resolved && <span className="muted">resolved</span>}
                {t.items.length > 1 && <span className="muted">{t.items.length}</span>}
              </div>
              {t.items.map((it) => {
                const open = expanded.has(it.id);
                const long = it.body.length > 300 || it.body.split("\n").length > 4;
                const k = kindGlyph(it);
                return (
                  <article key={it.id} className={cx("pr-comment", !it.seen && "unread", it.resolved && "resolved", selected.has(it.id) && "picked")}>
                    <input type="checkbox" className="pr-pick" checked={selected.has(it.id)} onChange={(e) => toggle(it.id, e.target.checked)} aria-label={`Select the comment by ${it.author}`} />
                    <span className="pr-avatar" aria-hidden="true">
                      {(it.author[0] ?? "?").toUpperCase()}
                    </span>
                    <div className="pr-comment-body">
                      <div className="pr-comment-meta small-text">
                        <span className="pr-comment-author" title={it.self ? "written with the login this PR is followed with" : undefined}>
                          @{it.author}
                          {it.self && <span className="muted"> (you)</span>}
                        </span>
                        <Tip text={k.label}>
                          <span className={cx("pr-kind", k.className)}>{k.glyph}</span>
                        </Tip>
                        <span className="muted" title={new Date(it.createdAt).toLocaleString()}>
                          {ago(it.createdAt)}
                        </span>
                        {!it.seen && <span className="count">new</span>}
                        <span className="spacer" />
                        <a href={it.htmlUrl} target="_blank" rel="noreferrer" className="pr-ext" title={`Open this ${KIND_LABEL[it.kind]} on ${label}`}>
                          {"\u2197"}
                        </a>
                        <Menu align="end" className="pr-menu" trigger={moreButton(`Actions for the comment by ${it.author}`)}>
                          <MenuItem onSelect={() => copyText(it.id, itemText(it))}>Copy</MenuItem>
                          <MenuItem onSelect={() => copyText(it.id, it.htmlUrl)}>Copy link</MenuItem>
                        </Menu>
                      </div>
                      <div className={cx("pr-text", long && !open && "clamped")}>
                        <Markdown text={it.body || "*(no text)*"} html />
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
                    </div>
                  </article>
                );
              })}
            </div>
          ))
        )}
      </section>

      <section className="pr-section" aria-label="Events">
        <div className="pr-section-head">
          <span className="pr-section-title">Events{events && events.length > 0 && <span className="muted"> ({events.length})</span>}</span>
          <span className="spacer" />
          <span className="muted small-text">what the poller noticed; automations react to these</span>
        </div>
        {events === null ? (
          <p className="muted prs-empty">{"Loading\u2026"}</p>
        ) : events.length === 0 ? (
          <p className="muted prs-empty">Nothing yet: the PR was already there when its follow was added, or has not changed since.</p>
        ) : (
          <ul className="pr-events">
            {events.map((e) => (
              <li key={e.id} className="pr-event">
                <time dateTime={e.detectedAt} title={new Date(e.detectedAt).toLocaleString()}>
                  {ago(e.detectedAt)}
                </time>
                <span>
                  {PR_EVENT_LABELS[e.type]}
                  {e.type === "check_failed" && e.ref && <>: {e.ref}</>}
                  {e.type === "review_requested" && e.ref && <>: @{e.ref}</>}
                  {e.actor && (e.type === "comment" || e.type === "review_submitted" || e.type === "opened") && <span className="muted"> by @{e.actor}</span>}
                </span>
                <span className="spacer" />
                {e.headSha && <code className="muted">{e.headSha.slice(0, 7)}</code>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pr-section" aria-label="Automation runs">
        <div className="pr-section-head">
          <span className="pr-section-title">Automation runs{runs && runs.length > 0 && <span className="muted"> ({runs.length})</span>}</span>
        </div>
        {runs && runs.length > 0 ? <RunHistory runs={runs} onOpenSession={onOpenSession} compact /> : <p className="muted prs-empty">{runs ? "No automation ran on this PR." : "Loading\u2026"}</p>}
      </section>

      {n > 0 && (
        <div className="pr-bulk" role="toolbar" aria-label="Selected items">
          <span className="pr-bulk-count">{n} selected</span>
          <button className="small primary" onClick={copySelected} title="Copy the selected comments and failing checks as text, with the PR's link">
            {copied === "selection" ? "Copied" : "Copy"}
          </button>
          <span className="spacer" />
          <button className="link small-text" onClick={() => setSelected(new Set())}>
            clear
          </button>
        </div>
      )}
      {starting && <StartSessionDialog pr={pr} run={run} onClose={() => setStarting(false)} onStarted={onOpenSession} />}
    </div>
  );
}

function StartSessionDialog({ pr, run, onClose, onStarted }: { pr: FollowedPr; run: Runner; onClose: () => void; onStarted: (sessionId: string) => void }) {
  const [provider, setProvider] = useState<Provider>("claude-code");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = () => {
    if (busy) return;
    setBusy(true);
    void run(async () => {
      const s = await api.startPrSession(pr.id, { provider, settings: {}, ...(prompt.trim() ? { prompt: prompt.trim() } : {}) });
      onClose();
      onStarted(s.id);
    }).finally(() => setBusy(false));
  };
  return (
    <Modal title={`Start a Session on ${prRef(pr)}`} description={`Clones ${pr.headRepo} at ${pr.headRef} and attaches the PR; the Session's settings are the defaults.`} onClose={onClose} onSubmit={submit}>
      <div className="follow-form">
        <label>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          First prompt <span className="muted">(optional; a brief naming the PR is sent otherwise)</span>
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={`e.g. Review this PR and fix what its failing checks complain about.`} />
        </label>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Starting…" : "Start Session"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
