import { PR_PROVIDER_LABEL, type PullRequest, type Session } from "@sessionboxer/protocol";
import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { api } from "./api";
import { ConnectorIcon } from "./ConnectorIcon";
import { ago, checksSummary } from "./PrThreads";
import { confirmAutoMerge, confirmDetach, externalTitle, finished, mergeNote, METHOD_LABEL, moreButton, prRef, StateChip, syncNote } from "./PullRequests";
import { detachSelectedPrs, updatePrSelection } from "./pr-list-actions";
import { cx, Menu, MenuItem, Tip } from "./ui";

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

function needsAttention(pr: PullRequest): boolean {
  return pr.unread > 0 || pr.checksFailed > 0;
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
  const [selected, select] = useReducer(updatePrSelection, new Set<string>());
  const [detaching, setDetaching] = useState(false);
  const selectedPrs = prs.filter((pr) => selected.has(pr.id));
  useEffect(() => select({ type: "retain", ids: prs.map((pr) => pr.id) }), [prs]);
  const detach = () => {
    if (detaching || selectedPrs.length === 0) return;
    setDetaching(true);
    void run(() => detachSelectedPrs(
      selectedPrs,
      (id) => api.detachPr(session.id, id),
      (id) => select({ type: "remove", id }),
    )).finally(() => setDetaching(false));
  };
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
      {prs.length > 0 && (
        <div className="pr-bulk-toolbar">
          <label className="check">
            <input
              type="checkbox"
              checked={selectedPrs.length === prs.length}
              ref={(input) => { if (input) input.indeterminate = selectedPrs.length > 0 && selectedPrs.length < prs.length; }}
              disabled={detaching}
              onChange={(e) => select({ type: "set", ids: e.target.checked ? prs.map((pr) => pr.id) : [] })}
            />
            Select all
          </label>
          <span className="muted small-text" role="status">{selectedPrs.length} selected</span>
          <button className="small" disabled={detaching || selectedPrs.length === 0} onClick={detach}>
            {detaching ? "Detaching\u2026" : "Detach selected"}
          </button>
          {selectedPrs.length > 0 && <p className="muted small-text">Forgets selected PRs and their comments in this Session only; nothing changes on GitHub or Bitbucket.</p>}
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
            <PrRow key={pr.id} session={session} pr={pr} run={run} onOpen={() => onOpen(pr.id)}
              selected={selected.has(pr.id)} disabled={detaching} onSelect={() => select({ type: "toggle", id: pr.id })} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PrRow({ session, pr, run, onOpen, selected, disabled, onSelect }: {
  session: Session; pr: PullRequest; run: Runner; onOpen: () => void;
  selected: boolean; disabled: boolean; onSelect: () => void;
}) {
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
      className={cx("pr-row", "pr-row-selectable", selected && "selected", attn && "attn", done && "done")}
      title="Open this PR's comments, reviews and checks here"
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest("a, button, input, label, [role='menu'], [role='menuitem'], .popover, .tooltip")) return;
        onOpen();
      }}
    >
      <div className="pr-row-main">
        <input className="pr-row-select" type="checkbox" aria-label={`Select ${prRef(pr)}`} title={`Select ${prRef(pr)}`}
          checked={selected} disabled={disabled} onChange={onSelect} onClick={(e) => e.stopPropagation()} />
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
        {disabled ? <span className="pr-more" /> : <PrRowMenu session={session} pr={pr} run={run} onOpen={onOpen} />}
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
