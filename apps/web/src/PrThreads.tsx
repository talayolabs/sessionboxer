import { PR_PROVIDER_LABEL, type PrCheckItem, type PrItem, type PullRequest } from "@sessionboxer/protocol";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileLink } from "./FileLink";
import { Markdown } from "./Markdown";
import { cx, Tip } from "./ui";

// The Checks list and the "Comments & reviews" thread list, shared by the Session's PR pane
// (`PullRequests.tsx` `PrPane`) and the followed-PR page (`Prs.tsx` `FollowedPrDetail`). What
// differs between the two surfaces — the per-item menu, what select-all selects, the wording of a
// few titles — comes in as props.

export const KIND_LABEL: Record<PrItem["kind"], string> = { issue_comment: "comment", review_comment: "inline comment", review: "review" };
const ADDRESS_LABEL: Record<PrItem["address"], string> = { none: "", in_prompt: "in prompt", addressing: "addressing…", addressed: "addressed" };
export const CHECK_STATE_LABEL: Record<PrCheckItem["state"], string> = { pending: "running", passed: "passed", failed: "failed" };
export const CHECK_GLYPH: Record<PrCheckItem["state"], string> = { failed: "\u2717", pending: "\u25CF", passed: "\u2713" };
export const LEVEL_OF_CHECK: Record<PrCheckItem["state"], "error" | "warn" | "ok"> = { failed: "error", pending: "warn", passed: "ok" };

/** What both surfaces read from the PR row: the head's check counts and the provider for labels. */
export type PrCounts = Pick<PullRequest, "provider" | "checksFailed" | "checksPending" | "checksPassed">;

export function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Tooltip of a check's result: what the provider literally said, and when it ran. */
export function checkResultTitle(c: PrCheckItem): string {
  const lines = [
    c.conclusion ? `conclusion: ${c.conclusion}` : `status: ${CHECK_STATE_LABEL[c.state]}`,
    c.required ? (c.kind === "build" ? "a required build" : "required by branch protection") : "not required",
  ];
  if (c.startedAt) lines.push(`started ${new Date(c.startedAt).toLocaleString()}`);
  if (c.completedAt) lines.push(`finished ${new Date(c.completedAt).toLocaleString()}`);
  return lines.join("\n");
}

/** "2 failed · 1 running · 5 passed" for the overview; null when the head has no checks. */
export function checksSummary(pr: PrCounts): Array<{ text: string; level: "error" | "warn" | "ok" }> {
  const out: Array<{ text: string; level: "error" | "warn" | "ok" }> = [];
  if (pr.checksFailed > 0) out.push({ text: `${pr.checksFailed} failed`, level: "error" });
  if (pr.checksPending > 0) out.push({ text: `${pr.checksPending} running`, level: "warn" });
  if (pr.checksPassed > 0) out.push({ text: `${pr.checksPassed} passed`, level: "ok" });
  return out;
}

export function Ellipsis({ text, className }: { text: string; className?: string }) {
  return (
    <Tip text={text}>
      <span className={cx("pr-ellipsis", className)}>{text}</span>
    </Tip>
  );
}

export type Thread = { key: string; path: string | null; line: number | null; outdated: boolean; resolved: boolean; items: PrItem[]; latest: number };

/** Inline comments grouped by review thread (or `path:line` when the provider has no thread id); everything else is the conversation. */
export function groupThreads(items: PrItem[]): Thread[] {
  const map = new Map<string, Thread>();
  for (const it of items) {
    const key = it.path ? `t:${it.threadId ?? `${it.path}:${it.line ?? ""}`}` : "conversation";
    let t = map.get(key);
    if (!t) {
      t = { key, path: it.path, line: it.line, outdated: false, resolved: true, items: [], latest: 0 };
      map.set(key, t);
    }
    t.items.push(it);
    t.outdated ||= it.outdated;
    t.resolved &&= it.resolved;
    t.latest = Math.max(t.latest, Date.parse(it.createdAt));
  }
  const out = [...map.values()];
  for (const t of out) t.items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return out.sort((a, b) => b.latest - a.latest);
}

export function kindGlyph(it: PrItem): { glyph: string; label: string; className: string } {
  if (it.kind === "review") {
    const st = (it.reviewState ?? "").toUpperCase();
    if (st === "APPROVED") return { glyph: "\u2713", label: "approved", className: "ok" };
    if (st === "CHANGES_REQUESTED") return { glyph: "\u2717", label: "changes requested", className: "error" };
    return { glyph: "\u25CE", label: st ? `review: ${st.toLowerCase().replace(/_/g, " ")}` : "review", className: "" };
  }
  if (it.kind === "review_comment") return { glyph: "\u2039/\u203A", label: it.inReplyTo !== null ? "reply on the code" : "comment on the code", className: "" };
  return { glyph: "\u275D", label: "conversation comment", className: "" };
}

// --- Selection ------------------------------------------------------------------------------

export type PrSelection = {
  /** Ids of the picked comments and failed checks. */
  selected: Set<string>;
  setSelected: (update: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  toggle: (id: string, on: boolean) => void;
  showResolved: boolean;
  setShowResolved: (on: boolean) => void;
  /** The comments shown: all of them, or the unresolved ones. */
  visible: PrItem[];
  threads: Thread[];
  /** Resolved comments hidden by the `showResolved` switch. */
  hidden: number;
  /** Failed first, then running, then passed; a failed check can be picked, the others only read. */
  sortedChecks: PrCheckItem[];
  failedChecks: PrCheckItem[];
};

/** The selection and the show-resolved switch of a PR page, with the lists both `PrChecks` and `PrThreads` draw. */
export function usePrSelection(items: PrItem[] | null, checks: PrCheckItem[] | null): PrSelection {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showResolved, setShowResolved] = useState(false);
  const visible = useMemo(() => {
    const all = items ?? [];
    return showResolved ? all : all.filter((i) => !i.resolved);
  }, [items, showResolved]);
  const threads = useMemo(() => groupThreads(visible), [visible]);
  const hidden = (items?.length ?? 0) - visible.length;
  const sortedChecks = useMemo(() => {
    const rank: Record<PrCheckItem["state"], number> = { failed: 0, pending: 1, passed: 2 };
    return [...(checks ?? [])].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
  }, [checks]);
  const failedChecks = useMemo(() => sortedChecks.filter((c) => c.state === "failed"), [sortedChecks]);
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return { selected, setSelected, toggle, showResolved, setShowResolved, visible, threads, hidden, sortedChecks, failedChecks };
}

// --- Checks ---------------------------------------------------------------------------------

export function PrChecks({
  pr,
  selection,
  menu,
  summaryActions,
  summaryLine = false,
}: {
  pr: PrCounts;
  selection: PrSelection;
  /** The row's "⋯" menu (or a `pr-more` placeholder when there is nothing to do). */
  menu: (c: PrCheckItem) => ReactNode;
  /** Right end of the summary line, after the counts (the PR pane's "all failed" switch). */
  summaryActions?: ReactNode;
  /** Show the first line of a failed check's summary next to its source. */
  summaryLine?: boolean;
}) {
  const { selected, toggle, sortedChecks } = selection;
  // The Checks list opens by itself when something fails or runs and stays as the user left it otherwise.
  const [checksOpen, setChecksOpen] = useState(pr.checksFailed > 0 || pr.checksPending > 0);
  useEffect(() => {
    if (pr.checksFailed > 0 || pr.checksPending > 0) setChecksOpen(true);
  }, [pr.checksFailed, pr.checksPending]);
  const checks = sortedChecks;
  if (checks.length === 0) return null;
  const summary = checksSummary(pr);
  const allGreen = pr.checksFailed === 0 && pr.checksPending === 0;

  return (
    <details className="pr-section pr-checks" open={checksOpen} onToggle={(e) => setChecksOpen(e.currentTarget.open)}>
      <summary>
        <span className={cx("pr-check-glyph", allGreen ? "ok" : pr.checksFailed > 0 ? "error" : "warn")} aria-hidden="true">
          {allGreen ? CHECK_GLYPH.passed : pr.checksFailed > 0 ? CHECK_GLYPH.failed : CHECK_GLYPH.pending}
        </span>
        <span className="pr-section-title">
          {allGreen
            ? `${checks.length} ${checks.length === 1 ? "check" : "checks"} passed`
            : summary.map((c, i) => (
                <span key={c.level}>
                  {i > 0 && <span className="muted"> {"\u00b7"} </span>}
                  <span className={c.level}>{c.text}</span>
                </span>
              ))}
        </span>
        <span className="spacer" />
        {summaryActions}
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
                  {summaryLine && failed && c.summary && <> {"\u00b7"} {c.summary.split("\n")[0]}</>}
                </span>
              </span>
              <span className="pr-check-status small-text" title={checkResultTitle(c)}>
                {!c.seen && failed && <span className="count">new</span>}
                {c.address !== "none" && <span className={c.address === "addressed" ? "ok" : "warn"}>{ADDRESS_LABEL[c.address]}</span>}
                <span className={cx("pr-check-result", LEVEL_OF_CHECK[c.state])}>{result}</span>
                <span className="muted">{c.completedAt ? ago(c.completedAt) : c.startedAt ? `since ${ago(c.startedAt)}` : ""}</span>
              </span>
              {c.url && (
                <a href={c.url} target="_blank" rel="noreferrer" className="pr-ext" title="Open the log / details">
                  {"\u2197"}
                </a>
              )}
              {menu(c)}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// --- Comments & reviews ---------------------------------------------------------------------

export function PrThreads({
  pr,
  items,
  selection,
  onToggleAll,
  selectAllTitle,
  selfTitle,
  menu,
}: {
  pr: Pick<PullRequest, "provider">;
  /** null until loaded. */
  items: PrItem[] | null;
  selection: PrSelection;
  /** The header's checkbox: what "every comment shown" does to the selection is the caller's call. */
  onToggleAll: (on: boolean) => void;
  selectAllTitle: (allSelected: boolean) => string;
  /** Tooltip on the author of a comment written with the login the PR is read with. */
  selfTitle: string;
  /** The comment's "⋯" menu. */
  menu: (it: PrItem) => ReactNode;
}) {
  const { selected, toggle, showResolved, setShowResolved, visible, threads, hidden } = selection;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const allSelected = visible.length > 0 && visible.every((i) => selected.has(i.id));
  const label = PR_PROVIDER_LABEL[pr.provider];

  return (
    <section className="pr-section pr-threads" aria-label="Comments and reviews">
      <div className="pr-section-head">
        <label className="check" title={visible.length === 0 ? undefined : selectAllTitle(allSelected)}>
          <input type="checkbox" checked={allSelected} onChange={(e) => onToggleAll(e.target.checked)} disabled={visible.length === 0} />
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
                      <span className="pr-comment-author" title={it.self ? selfTitle : undefined}>
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
                      {it.address !== "none" && <span className={it.address === "addressed" ? "ok" : "warn"}>{ADDRESS_LABEL[it.address]}</span>}
                      <span className="spacer" />
                      <a href={it.htmlUrl} target="_blank" rel="noreferrer" className="pr-ext" title={`Open this ${KIND_LABEL[it.kind]} on ${label}`}>
                        {"\u2197"}
                      </a>
                      {menu(it)}
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
  );
}
