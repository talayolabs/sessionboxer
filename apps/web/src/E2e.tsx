import { E2E_MAX_FIX_ATTEMPTS, e2eTally, mediaKind, type E2eCase, type E2eRun, type E2eRunStatus, type Session } from "@sessionboxer/protocol";
import { useEffect, useMemo, useState } from "react";
import { AttachmentCard } from "./Attachments";
import { rawFileUrl } from "./attachment-paths";

const RUN_LABEL: Record<E2eRunStatus, string> = {
  planning: "planning…",
  running: "running",
  fixing: "fixing",
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  aborted: "aborted",
};

const CASE_ICON: Record<E2eCase["status"], string> = { pending: "○", running: "◐", passed: "✓", failed: "✗", skipped: "–" };

/** `m:ss` for a duration, `0:07`-style so timers do not jump width. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Ticks every second while `active`, for live timers. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function isRunOpen(run: E2eRun): boolean {
  return run.status === "planning" || run.status === "running" || run.status === "fixing";
}

/** The latest attempt of each case (by plan index) and every earlier one under it. */
function groupCases(cases: E2eCase[]): Array<{ latest: E2eCase; earlier: E2eCase[] }> {
  const byIndex = new Map<number, E2eCase[]>();
  for (const c of cases) {
    const list = byIndex.get(c.index) ?? [];
    list.push(c);
    byIndex.set(c.index, list);
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, attempts]) => {
      const sorted = [...attempts].sort((a, b) => a.cycle - b.cycle);
      return { latest: sorted[sorted.length - 1]!, earlier: sorted.slice(0, -1) };
    });
}

/** One line for the run: `4/4 passed · 2:13 · cycle 2`. */
export function runHeadline(run: E2eRun, now: number): string {
  if (run.status === "skipped") return "skipped";
  if (run.status === "planning") return "planning the test cases…";
  const { passed, total } = e2eTally(run);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const parts = [`${passed}/${total} passed`, formatDuration(end - Date.parse(run.startedAt))];
  if (run.cycles > 1) parts.push(`cycle ${run.cycles}`);
  if (run.status === "aborted") parts.unshift("aborted");
  return parts.join(" · ");
}

/**
 * Side pane "Verification": the current or last end-to-end verification run of the Session, its
 * cases with live timers, the fix cycles, the screenshots and the video; earlier runs folded below.
 */
export function E2ePane({
  session,
  runs,
  enabled,
  globalEnabled,
  focusRunId,
  onToggle,
  onRunNow,
}: {
  session: Session;
  runs: E2eRun[];
  /** Effective switch for this Session. */
  enabled: boolean;
  globalEnabled: boolean;
  /** Run to show on top (from a transcript marker); `null` = the latest. */
  focusRunId: string | null;
  onToggle: (value: boolean | null) => void;
  /** Starts a verification of the work so far. */
  onRunNow: () => void;
}) {
  const ordered = useMemo(() => [...runs].sort((a, b) => b.turnSeq - a.turnSeq || b.startedAt.localeCompare(a.startedAt)), [runs]);
  const current = (focusRunId ? ordered.find((r) => r.id === focusRunId) : undefined) ?? ordered[0] ?? null;
  const earlier = ordered.filter((r) => r !== current);
  const override = session.settings.e2eVerify;
  const open = runs.some(isRunOpen);
  const runNowHint = open
    ? "A verification run is already open"
    : session.status === "stopped"
      ? "Resume the Session first"
      : session.status !== "idle"
        ? "Wait for the Agent to finish its turn"
        : "Verify the work so far end to end (whatever the switch says)";
  return (
    <div className="pane e2e-pane">
      <div className="pane-toolbar e2e-toolbar">
        <label className="e2e-switch" title={`Verify each turn end to end: ${override === null ? `Global settings default (${globalEnabled ? "on" : "off"})` : "set for this Session"}`}>
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked === globalEnabled ? null : e.target.checked)} />
          Verify each turn
          {override !== null && (
            <button type="button" className="link small-text" title="Follow the Global settings default again" onClick={() => onToggle(null)}>
              (reset)
            </button>
          )}
        </label>
        <span className="spacer" />
        <span className="muted small-text">
          {enabled ? "After each of your turns the Agent plans, runs and records end-to-end checks of its work." : "Off: turns are not verified."}
        </span>
        <button type="button" title={runNowHint} disabled={open || session.status !== "idle"} onClick={onRunNow}>
          Run now
        </button>
      </div>
      {!current && (
        <div className="e2e-empty muted">
          No verification run yet.{" "}
          {enabled ? "One starts when the Agent finishes its next turn, or press Run now." : "Switch the check on above and the next completed turn gets one, or press Run now."}
        </div>
      )}
      {current && <RunCard session={session} run={current} open />}
      {earlier.length > 0 && (
        <details className="e2e-earlier">
          <summary>
            {earlier.length} earlier {earlier.length === 1 ? "run" : "runs"}
          </summary>
          {earlier.map((r) => (
            <RunCard key={r.id} session={session} run={r} open={false} />
          ))}
        </details>
      )}
    </div>
  );
}

function RunCard({ session, run, open }: { session: Session; run: E2eRun; open: boolean }) {
  const live = isRunOpen(run);
  const now = useNow(live);
  const groups = groupCases(run.cases);
  const running = run.cases.find((c) => c.status === "running") ?? null;
  const done = groups.filter((g) => g.latest.status !== "pending" && g.latest.status !== "running").length;
  const [expanded, setExpanded] = useState(open);
  useEffect(() => setExpanded(open), [open]);
  return (
    <section className={`e2e-run e2e-run-${run.status}`}>
      <header className="e2e-run-header" onClick={() => !open && setExpanded((v) => !v)}>
        <span className={`e2e-badge e2e-badge-${run.status}`}>{RUN_LABEL[run.status]}</span>
        <span className="e2e-run-headline">{runHeadline(run, now)}</span>
        <span className="spacer" />
        <span className="muted small-text" title={`Started ${new Date(run.startedAt).toLocaleString()}`}>
          {new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </header>
      {expanded && (
        <>
          {live && groups.length > 0 && (
            <div className="e2e-progress" title={`${done} of ${groups.length} cases finished`}>
              <div className={`e2e-progress-bar${running ? " live" : ""}`} style={{ width: `${Math.round(((done + (running ? 0.5 : 0)) / groups.length) * 100)}%` }} />
            </div>
          )}
          {run.status === "planning" && <p className="e2e-note muted">The Agent is looking at what the turn changed and deciding what to test…</p>}
          {run.skipReason && (
            <p className={`e2e-note${run.status === "aborted" ? " warn" : " muted"}`}>
              {run.status === "aborted" ? "Aborted: " : "Skipped: "}
              {run.skipReason}
            </p>
          )}
          {groups.length > 0 && (
            <ol className="e2e-cases">
              {groups.map((g) => (
                <CaseRow key={g.latest.index} session={session} group={g} now={now} />
              ))}
            </ol>
          )}
          {run.status === "fixing" && (
            <p className="e2e-note warn">
              A case failed: the Agent is fixing the code and will rerun it (at most {E2E_MAX_FIX_ATTEMPTS} fix attempts per case).
            </p>
          )}
          {run.summary && <p className="e2e-summary">{run.summary}</p>}
          {run.videoPath && mediaKind(run.videoPath) === "video" && (
            <div className="e2e-video">
              <AttachmentCard sessionId={session.id} attachment={{ path: run.videoPath, name: run.videoPath.slice(run.videoPath.lastIndexOf("/") + 1), kind: "video" }} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CaseRow({ session, group, now }: { session: Session; group: { latest: E2eCase; earlier: E2eCase[] }; now: number }) {
  const c = group.latest;
  const [open, setOpen] = useState(false);
  const elapsed = c.status === "running" && c.startedAt ? now - Date.parse(c.startedAt) : c.durationMs;
  return (
    <li className={`e2e-case e2e-case-${c.status}`}>
      <div className="e2e-case-line" onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}>
        <span className="e2e-case-icon" aria-label={c.status} title={c.status}>
          {CASE_ICON[c.status]}
        </span>
        <span className="e2e-case-index muted">{c.index}.</span>
        <span className="e2e-case-title">{c.title}</span>
        {c.cycle > 1 && (
          <span className="e2e-cycle" title={`Rerun after a fix: attempt ${c.cycle}`}>
            cycle {c.cycle}
          </span>
        )}
        <span className="spacer" />
        {elapsed !== null && <span className={`e2e-case-time${c.status === "running" ? " live" : ""}`}>{formatDuration(elapsed)}</span>}
      </div>
      {c.note && <div className="e2e-case-note">{c.note}</div>}
      {c.screenshotPath && mediaKind(c.screenshotPath) === "image" && (
        <a className="e2e-shot" href={rawFileUrl(session.id, c.screenshotPath)} target="_blank" rel="noreferrer" title={c.screenshotPath}>
          <img src={rawFileUrl(session.id, c.screenshotPath)} alt={`Final state of case ${c.index}`} loading="lazy" />
        </a>
      )}
      {open && (
        <div className="e2e-case-detail">
          <div>
            <strong>Steps</strong>
            <pre>{c.steps || "—"}</pre>
          </div>
          <div>
            <strong>Expected</strong>
            <pre>{c.expected || "—"}</pre>
          </div>
          {group.earlier.length > 0 && (
            <div>
              <strong>Earlier attempts</strong>
              <ul className="e2e-attempts">
                {group.earlier.map((a) => (
                  <li key={a.id} className={`e2e-case-${a.status}`}>
                    {CASE_ICON[a.status]} cycle {a.cycle}: {a.status}
                    {a.durationMs !== null ? ` · ${formatDuration(a.durationMs)}` : ""}
                    {a.note ? ` — ${a.note}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
