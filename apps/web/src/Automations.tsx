import {
  AUTOMATION_ACTION_LABELS,
  PR_EVENT_LABELS,
  PROVIDER_LABELS,
  PROVIDERS,
  PrEventType,
  SCHEDULE_MISSED_POLICY_LABELS,
  SCHEDULE_PREVIEW_COUNT,
  type Automation,
  type AutomationAction,
  type AutomationLimits,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationTrigger,
  type CreateAutomationRequest,
  type PrEventFilters,
  type PrPeople,
  type Provider,
  type ProviderModels,
  type ProviderOptions,
  type PublicSettings,
  type ReviewVerdict,
  type ScheduleMissedPolicy,
  type Session,
  type SessionSettingsInput,
} from "@sessionboxer/protocol";
import cronstrue from "cronstrue";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { formatDuration } from "./E2e";
import { FollowRepoInline } from "./FollowRepo";
import { LoginList } from "./LoginList";
import { RepoEditor, draftsError, draftsToSpecs, githubAccounts, specsToDrafts, type RepoDraft } from "./Repos";
import { SessionSettingsForm, draftFromDefaults, draftToInput, type SessionSettingsDraft } from "./SessionSettingsForm";

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

/** A PR follow the trigger can listen to (from the Pull requests page). */
export interface FollowOption {
  id: string;
  label: string;
}

const CRON_EXAMPLES: Array<[string, string]> = [
  ["0 9 * * 1-5", "weekdays at 09:00"],
  ["0 */2 * * *", "every 2 hours"],
  ["*/30 * * * *", "every 30 minutes"],
  ["0 8 * * 1", "Mondays at 08:00"],
  ["0 0 1 * *", "1st of the month at midnight"],
  ["@hourly", "once an hour"],
  ["@daily", "once a day at midnight"],
];

export const RUN_LABEL: Record<AutomationRunStatus, string> = { queued: "queued", running: "running", succeeded: "succeeded", failed: "failed", skipped: "skipped" };
const TRIGGER_LABEL: Record<AutomationRun["trigger"], string> = { cron: "on schedule", manual: "run now", catch_up: "catch-up", pr_event: "PR event" };
const DEFAULT_LIMITS: AutomationLimits = { maxConcurrent: 2, maxRunsPerDay: 20, maxRunsPerPrPerDay: 4, debounceSeconds: 120, timeoutMinutes: 360 };
const PR_ACTIONS: ReadonlyArray<AutomationAction["type"]> = ["auto_review", "auto_qa", "attach"];
const VERDICT_LABELS: Record<ReviewVerdict, string> = { comment: "Comment only", request_changes: "May request changes", approve: "May approve" };

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function timeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  return intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : ["UTC"];
}

/** "in 2 h", "in 3 d", "5 min ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? [Math.round(abs / 1000), "s"] : abs < 3_600_000 ? [Math.round(abs / 60_000), "min"] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "h"] : [Math.round(abs / 86_400_000), "d"];
  return diff >= 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
}

export function formatAt(iso: string, timeZone?: string): string {
  try {
    return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** Plain words for a cron expression, or `null` when cronstrue cannot read it (the Control Plane's preview is the authority). */
export function describeCron(cron: string): string | null {
  try {
    return cronstrue.toString(cron.trim(), { use24HourTimeFormat: true, verbose: false });
  } catch {
    return null;
  }
}

/** Whether the automation prompts this Session (the Session's Scheduled pane lists those). */
export function promptsSession(a: Automation, sessionId: string): boolean {
  return a.action.type === "prompt" && a.action.sessionId === sessionId;
}

function triggerSummary(t: AutomationTrigger, follows: FollowOption[]): string {
  if (t.type === "schedule") {
    const words = describeCron(t.cron);
    return `${t.cron}${words ? ` — ${words}` : ""} · ${t.timezone}`;
  }
  if (t.type === "manual") return "Runs only when you press Run now";
  const which = t.follows.length === 0 ? "every followed PR" : t.follows.map((id) => follows.find((f) => f.id === id)?.label ?? id).join(", ");
  return `When a PR is ${t.events.map((e) => PR_EVENT_LABELS[e]).join(" / ")} · ${which}`;
}

function actionSummary(action: AutomationAction, sessions: Session[]): string {
  switch (action.type) {
    case "prompt": {
      if (action.sessionId === "attached") return "Prompt → the Session the PR is attached to";
      const s = sessions.find((x) => x.id === action.sessionId);
      return `Prompt → ${s ? s.title : "a deleted Session"}`;
    }
    case "new_session":
      return `New ${PROVIDER_LABELS[action.provider]} Session${action.title ? ` "${action.title}"` : ""}${action.stopAfter ? ", stopped after the turn" : ""}`;
    case "auto_review":
      return `Auto review (${VERDICT_LABELS[action.maxVerdict].toLowerCase()}${action.deltaOnly ? ", delta only" : ""})`;
    case "auto_qa":
      return `Auto QA with a video (${action.publish === "github_attachment" ? "attached to a PR comment" : "link only"}, up to ${action.maxMinutes} min)`;
    case "attach":
      return "Attach the PR to the Session that pushed it";
    case "notify":
      return `Notify me${action.text ? `: ${action.text}` : ""}`;
  }
}

export function Automations({
  automations: all,
  runs,
  sessions,
  settings,
  models,
  options,
  onOpenSession,
  loadRuns,
  run,
  forSession,
  follows = [],
  focusId = null,
  onFocus,
}: {
  automations: Automation[];
  runs: Record<string, AutomationRun[]>;
  sessions: Session[];
  settings: PublicSettings;
  models: ProviderModels;
  options: ProviderOptions;
  onOpenSession: (id: string) => void;
  loadRuns: (automationId: string) => void;
  run: Runner;
  /** Set inside a Session: only the automations that prompt it, and new ones target it. */
  forSession?: Session;
  /** The PR follows a `pr_event` trigger can pick from; the form can also follow a repository on the spot. */
  follows?: FollowOption[];
  /** `#/automations/<id>`: that one opens with its history. */
  focusId?: string | null;
  onFocus?: (id: string | null) => void;
}) {
  const automations = forSession ? all.filter((a) => promptsSession(a, forSession.id)) : all;
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [history, setHistory] = useState<string | null>(focusId);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (focusId) setHistory(focusId);
  }, [focusId]);
  useEffect(() => {
    if (history) loadRuns(history);
  }, [history, loadRuns]);

  const editingAutomation = editing && editing !== "new" ? (automations.find((a) => a.id === editing) ?? null) : null;

  if (editing === "new" || editingAutomation) {
    return (
      <AutomationForm
        key={editing}
        automation={editingAutomation}
        sessions={sessions}
        settings={settings}
        models={models}
        options={options}
        follows={follows}
        run={run}
        onDone={() => setEditing(null)}
        forSession={forSession}
      />
    );
  }

  const act = (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    void run(fn).finally(() => setBusy(null));
  };
  const toggleHistory = (id: string) => {
    const next = history === id ? null : id;
    setHistory(next);
    onFocus?.(next);
  };

  return (
    <div className="panel schedules-panel">
      <div className="schedules-head">
        <h2>{forSession ? "Automations that prompt this Session" : "Automations"}</h2>
        <span className="spacer" />
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          + New automation
        </button>
      </div>
      <p className="muted">
        {forSession
          ? "Prompts the Control Plane sends to this Session on a schedule (cron syntax, in the time zone of your choice); every automation is under Automations in the sidebar."
          : "A trigger, an action and limits, run by the Control Plane while it is up: on a schedule, or when a followed pull request opens, gets commits, comments or a failing check. An automation prompts a Session, starts one from a template, reviews or QA-tests a PR, or just notifies you."}
      </p>
      {automations.length === 0 && <p className="placeholder-inline muted">{forSession ? "Nothing prompts this Session yet." : "No automations yet."}</p>}
      <ul className="schedule-list">
        {automations.map((a) => {
          const running = (runs[a.id] ?? []).some((r) => r.status === "running" || r.status === "queued");
          const status = running ? "running" : a.lastStatus;
          const manualOnly = a.trigger.type === "pr_event" && (PR_ACTIONS.includes(a.action.type) || (a.action.type === "prompt" && a.action.sessionId === "attached"));
          return (
            <li key={a.id} id={`automation-${a.id}`} className={`schedule${a.enabled ? "" : " disabled"}`}>
              <div className="schedule-line">
                <label className="check schedule-switch" title={a.enabled ? "Enabled: runs on its trigger" : "Disabled: only Run now"}>
                  <input type="checkbox" checked={a.enabled} disabled={busy === a.id} onChange={(e) => act(a.id, () => api.updateAutomation(a.id, { enabled: e.target.checked }))} />
                </label>
                <div className="schedule-text">
                  <div className="schedule-title">
                    <strong>{a.name}</strong>
                    {status && <span className={`e2e-badge e2e-badge-${badgeClass(status)}`}>{RUN_LABEL[status]}</span>}
                  </div>
                  <div className="muted small-text">{triggerSummary(a.trigger, follows)}</div>
                  <div className="small-text">{actionSummary(a.action, sessions)}</div>
                  <div className="muted small-text">
                    {a.trigger.type === "schedule" &&
                      (a.enabled && a.nextRunAt ? (
                        <>
                          Next {formatAt(a.nextRunAt)} ({relativeTime(a.nextRunAt)})
                        </>
                      ) : (
                        "Not scheduled"
                      ))}
                    {a.trigger.type !== "schedule" && `${a.runsToday} run${a.runsToday === 1 ? "" : "s"} today of ${a.limits.maxRunsPerDay}`}
                    {a.lastRunAt && <> · Last {relativeTime(a.lastRunAt)}</>}
                  </div>
                </div>
                <div className="schedule-actions">
                  <button
                    type="button"
                    disabled={busy === a.id || running || manualOnly}
                    title={manualOnly ? "Needs a pull request: run it from the Pull requests page" : "Run once now, whatever the trigger says"}
                    onClick={() => act(a.id, () => api.runAutomation(a.id))}
                  >
                    Run now
                  </button>
                  <button type="button" onClick={() => toggleHistory(a.id)}>
                    {history === a.id ? "Hide history" : "History"}
                  </button>
                  <button type="button" onClick={() => setEditing(a.id)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy === a.id}
                    onClick={() => {
                      if (confirm(`Delete "${a.name}" and its run history?`)) act(a.id, () => api.deleteAutomation(a.id));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {history === a.id && <RunHistory runs={runs[a.id]} onOpenSession={onOpenSession} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function badgeClass(status: AutomationRunStatus): string {
  return status === "succeeded" ? "passed" : status === "queued" ? "running" : status;
}

export function RunHistory({ runs, onOpenSession, compact }: { runs: AutomationRun[] | undefined; onOpenSession: (id: string) => void; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const live = runs?.some((r) => r.status === "running" || r.status === "queued") ?? false;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!runs) return <p className="muted small-text schedule-history-empty">Loading…</p>;
  if (runs.length === 0) return <p className="muted small-text schedule-history-empty">No runs yet.</p>;
  return (
    <table className="prs-table schedule-runs">
      <thead>
        <tr>
          <th>Started</th>
          <th>Trigger</th>
          <th>Status</th>
          <th>Took</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className={`schedule-run-${r.status}`}>
            <td title={r.queuedAt}>{formatAt(r.queuedAt)}</td>
            <td>{r.event ? `PR ${PR_EVENT_LABELS[r.event.type]}` : TRIGGER_LABEL[r.trigger]}</td>
            <td>
              <span className={`e2e-badge e2e-badge-${badgeClass(r.status)}`}>{RUN_LABEL[r.status]}</span>
            </td>
            <td>{r.status === "skipped" || !r.startedAt ? "–" : formatDuration((r.finishedAt ? new Date(r.finishedAt).getTime() : now) - new Date(r.startedAt).getTime())}</td>
            <td>
              {!compact && r.prUrl && (
                <div>
                  <a href={r.prUrl} target="_blank" rel="noreferrer">
                    {r.prTitle ?? r.prUrl}
                  </a>
                </div>
              )}
              {r.error && <div className="warn">{r.error}</div>}
              {r.detail && <div className="muted">{r.detail}</div>}
              <RunResult result={r.result} />
              {r.sessionId && (
                <button type="button" className="link small-text" onClick={() => onOpenSession(r.sessionId!)}>
                  Open Session
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunResult({ result }: { result: AutomationRun["result"] }) {
  if (!result) return null;
  if (result.type === "review") {
    return (
      <div className="small-text">
        Review: {result.findings} finding{result.findings === 1 ? "" : "s"}
        {result.high > 0 && ` (${result.high} high)`}, {result.verdict.replace("_", " ")}
        {result.url && (
          <>
            {" · "}
            <a href={result.url} target="_blank" rel="noreferrer">
              on the PR
            </a>
          </>
        )}
      </div>
    );
  }
  if (result.type === "qa") {
    return (
      <div className="small-text">
        {result.skipped ? "QA skipped" : `QA ${result.passed}/${result.total} passed`}
        {result.videoUrl && (
          <>
            {" · "}
            <a href={result.videoUrl} target="_blank" rel="noreferrer">
              video
            </a>
          </>
        )}
        {result.commentUrl && (
          <>
            {" · "}
            <a href={result.commentUrl} target="_blank" rel="noreferrer">
              comment
            </a>
          </>
        )}
      </div>
    );
  }
  return null;
}

type Step = "trigger" | "action" | "limits";

function AutomationForm({
  automation,
  sessions,
  settings,
  models,
  options,
  follows,
  run,
  onDone,
  forSession,
}: {
  automation: Automation | null;
  sessions: Session[];
  settings: PublicSettings;
  models: ProviderModels;
  options: ProviderOptions;
  follows: FollowOption[];
  run: Runner;
  onDone: () => void;
  forSession?: Session;
}) {
  const t = automation?.trigger;
  const a = automation?.action;
  const [name, setName] = useState(automation?.name ?? "");
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  // Progressive disclosure: trigger, then action, then limits; editing shows everything.
  const [step, setStep] = useState<Step>(automation ? "limits" : "trigger");
  // trigger
  const [triggerType, setTriggerType] = useState<AutomationTrigger["type"]>(t?.type ?? "schedule");
  const [cron, setCron] = useState(t?.type === "schedule" ? t.cron : "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(t?.type === "schedule" ? t.timezone : localTimeZone());
  const [missedRun, setMissedRun] = useState<ScheduleMissedPolicy>(t?.type === "schedule" ? t.missedRun : "skip");
  const [prFollows, setPrFollows] = useState<string[]>(t?.type === "pr_event" ? t.follows : []);
  const [prEvents, setPrEvents] = useState<PrEventType[]>(t?.type === "pr_event" ? t.events : ["opened", "synchronize", "ready_for_review"]);
  const [filters, setFilters] = useState<PrEventFilters>(
    t?.type === "pr_event" ? t.filters : { drafts: "skip", forks: "review_only", authors: "not_self", includeOwn: false },
  );
  // action
  const [actionType, setActionType] = useState<AutomationAction["type"]>(a?.type ?? (forSession || sessions.length > 0 ? "prompt" : "new_session"));
  const promptAction = a?.type === "prompt" ? a : null;
  const newAction = a?.type === "new_session" ? a : null;
  const reviewAction = a?.type === "auto_review" ? a : null;
  const qaAction = a?.type === "auto_qa" ? a : null;
  const [sessionId, setSessionId] = useState(promptAction?.sessionId ?? forSession?.id ?? sessions[0]?.id ?? "");
  const [text, setText] = useState(promptAction?.text ?? "");
  const [provider, setProvider] = useState<Provider>(newAction?.provider ?? reviewAction?.provider ?? qaAction?.provider ?? "claude-code");
  const [repos, setRepos] = useState<RepoDraft[]>(() => specsToDrafts(newAction?.repos ?? []));
  const [draft, setDraft] = useState<SessionSettingsDraft>(() =>
    newAction ? { ...draftFromInput(newAction.settings, settings), snapshotId: newAction.snapshotId ?? null } : draftFromDefaults(settings),
  );
  const [title, setTitle] = useState(newAction?.title ?? "");
  const [prompt, setPrompt] = useState(newAction?.prompt ?? "");
  const [stopAfter, setStopAfter] = useState(newAction?.stopAfter ?? reviewAction?.stopAfter ?? qaAction?.stopAfter ?? true);
  const [checkoutPrHead, setCheckoutPrHead] = useState(newAction?.checkoutPrHead ?? true);
  const [notifyText, setNotifyText] = useState(a?.type === "notify" ? (a.text ?? "") : "");
  const [instructions, setInstructions] = useState(reviewAction?.instructions ?? qaAction?.instructions ?? "");
  const [maxVerdict, setMaxVerdict] = useState<ReviewVerdict>(reviewAction?.maxVerdict ?? "comment");
  const [deltaOnly, setDeltaOnly] = useState(reviewAction?.deltaOnly ?? true);
  const [notifyOn, setNotifyOn] = useState<"always" | "findings" | "never">(reviewAction?.notifyOn ?? "findings");
  const [publish, setPublish] = useState<"github_attachment" | "link_only">(qaAction?.publish ?? "github_attachment");
  const [commentOnSkip, setCommentOnSkip] = useState(qaAction?.commentOnSkip ?? false);
  const [maxMinutes, setMaxMinutes] = useState(qaAction?.maxMinutes ?? 10);
  // limits
  const [limits, setLimits] = useState<AutomationLimits>(automation?.limits ?? DEFAULT_LIMITS);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ ok: true; next: string[] } | { ok: false; error: string } | null>(null);

  const words = useMemo(() => describeCron(cron), [cron]);
  const zones = useMemo(timeZones, []);
  const isPr = triggerType === "pr_event";
  const [people, setPeople] = useState<PrPeople | null>(null);
  useEffect(() => {
    if (!isPr) return;
    void api.prPeople().then(setPeople, () => undefined);
  }, [isPr]);

  useEffect(() => {
    if (triggerType !== "schedule" || cron.trim() === "" || timezone.trim() === "") {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const h = setTimeout(() => {
      api
        .schedulePreview({ cron: cron.trim(), timezone: timezone.trim() })
        .then((p) => !cancelled && setPreview(p))
        .catch((e: unknown) => !cancelled && setPreview({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [cron, timezone, triggerType]);

  // An action that needs a PR does not survive a switch to another trigger.
  useEffect(() => {
    if (!isPr && (PR_ACTIONS.includes(actionType) || (actionType === "prompt" && sessionId === "attached"))) {
      setActionType(sessions.length > 0 ? "prompt" : "new_session");
      if (sessionId === "attached") setSessionId(sessions[0]?.id ?? "");
    }
  }, [isPr, actionType, sessionId, sessions]);

  const triggerError =
    triggerType === "schedule"
      ? preview && !preview.ok
        ? preview.error
        : null
      : triggerType === "pr_event"
        ? prEvents.length === 0
          ? "Pick at least one event."
          : follows.length === 0 && prFollows.length === 0
            ? "Follow a repository below, or your PRs on the Pull requests page."
            : null
        : null;
  const repoError = draftsError(repos);
  const targetSession = sessionId === "attached" ? null : (sessions.find((s) => s.id === sessionId) ?? null);
  const actionError =
    actionType === "prompt"
      ? sessionId !== "attached" && !targetSession
        ? "Pick a Session."
        : text.trim() === ""
          ? "Write the prompt."
          : null
      : actionType === "new_session"
        ? prompt.trim() === ""
          ? "Write the first prompt."
          : repoError
        : null;
  const formError = name.trim() === "" ? "Give the automation a name." : (triggerError ?? actionError);

  const buildTrigger = (): AutomationTrigger =>
    triggerType === "schedule"
      ? { type: "schedule", cron: cron.trim(), timezone: timezone.trim(), missedRun }
      : triggerType === "pr_event"
        ? { type: "pr_event", follows: prFollows, events: prEvents, filters: cleanFilters(filters) }
        : { type: "manual" };

  const buildAction = (): AutomationAction => {
    switch (actionType) {
      case "prompt":
        return { type: "prompt", sessionId, text: text.trim() };
      case "new_session":
        return {
          type: "new_session",
          provider,
          repos: draft.snapshotId ? [] : draftsToSpecs(repos),
          ...(draft.snapshotId ? { snapshotId: draft.snapshotId } : {}),
          settings: draftToInput(draft),
          prompt: prompt.trim(),
          stopAfter,
          checkoutPrHead,
          ...(title.trim() ? { title: title.trim() } : {}),
        };
      case "auto_review":
        return { type: "auto_review", provider, maxVerdict, deltaOnly, notifyOn, stopAfter, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) };
      case "auto_qa":
        return { type: "auto_qa", provider, publish, commentOnSkip, maxMinutes, stopAfter, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) };
      case "attach":
        return { type: "attach" };
      case "notify":
        return { type: "notify", ...(notifyText.trim() ? { text: notifyText.trim() } : {}) };
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formError) return;
    const req: CreateAutomationRequest = { name: name.trim(), enabled, trigger: buildTrigger(), action: buildAction(), limits };
    setBusy(true);
    void run(async () => {
      if (automation) await api.updateAutomation(automation.id, req);
      else await api.createAutomation(req);
      onDone();
    }).finally(() => setBusy(false));
  };

  const actionChoices: AutomationAction["type"][] = isPr ? ["auto_review", "auto_qa", "prompt", "new_session", "attach", "notify"] : ["prompt", "new_session", "notify"];
  const showAction = step !== "trigger";
  const showLimits = step === "limits";

  return (
    <form className="panel automation-form" onSubmit={submit}>
      <h2>{automation ? "Edit automation" : "New automation"}</h2>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={isPr ? "Review every PR" : "Morning triage"} />
      </label>

      <section className="automation-step">
        <h3>
          <span className="automation-step-n">1</span> When
        </h3>
        {!forSession && (
          <fieldset className="choice">
            <legend>Trigger</legend>
            <label className="check">
              <input type="radio" name="trigger" checked={triggerType === "schedule"} onChange={() => setTriggerType("schedule")} />
              On a schedule
            </label>
            <label className="check">
              <input type="radio" name="trigger" checked={triggerType === "pr_event"} onChange={() => setTriggerType("pr_event")} />
              When a followed pull request changes
            </label>
            <label className="check">
              <input type="radio" name="trigger" checked={triggerType === "manual"} onChange={() => setTriggerType("manual")} />
              Only when I press Run now
            </label>
          </fieldset>
        )}
        {triggerType === "schedule" && (
          <>
            <div className="row">
              <label>
                Cron expression
                <input value={cron} onChange={(e) => setCron(e.target.value)} list="cron-examples" spellCheck={false} />
                <datalist id="cron-examples">
                  {CRON_EXAMPLES.map(([expr, label]) => (
                    <option key={expr} value={expr}>
                      {label}
                    </option>
                  ))}
                </datalist>
              </label>
              <label>
                Time zone
                <input value={timezone} onChange={(e) => setTimezone(e.target.value)} list="time-zones" spellCheck={false} />
                <datalist id="time-zones">
                  {zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </label>
            </div>
            <div className="schedule-preview">
              {preview && !preview.ok ? (
                <p className="field-hint warn">{preview.error}</p>
              ) : (
                <>
                  {words && <p className="field-hint">{words}</p>}
                  {preview?.ok && (
                    <p className="field-hint">
                      Next {SCHEDULE_PREVIEW_COUNT}:{" "}
                      {preview.next.map((iso, i) => (
                        <span key={iso}>
                          {i > 0 && ", "}
                          <span title={`${formatAt(iso, timezone)} in ${timezone}`}>{formatAt(iso)}</span>
                        </span>
                      ))}
                      {preview.next.length === 0 && "never (the expression matches no future time)"}
                      {preview.next.length > 0 && timezone.trim() !== localTimeZone() && ` (your time, ${localTimeZone()})`}
                    </p>
                  )}
                </>
              )}
            </div>
            <label>
              Runs missed while the Control Plane was off
              <select value={missedRun} onChange={(e) => setMissedRun(e.target.value as ScheduleMissedPolicy)}>
                {(Object.keys(SCHEDULE_MISSED_POLICY_LABELS) as ScheduleMissedPolicy[]).map((p) => (
                  <option key={p} value={p}>
                    {SCHEDULE_MISSED_POLICY_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {triggerType === "pr_event" && (
          <>
            <fieldset className="choice">
              <legend>Pull requests</legend>
              <label className="check">
                <input type="checkbox" checked={prFollows.length === 0} onChange={(e) => e.target.checked && setPrFollows([])} />
                Every followed pull request
              </label>
              {follows.map((f) => (
                <label key={f.id} className="check">
                  <input
                    type="checkbox"
                    checked={prFollows.includes(f.id)}
                    onChange={(e) => setPrFollows((cur) => (e.target.checked ? [...cur, f.id] : cur.filter((x) => x !== f.id)))}
                  />
                  {f.label}
                </label>
              ))}
              <FollowRepoInline disabled={busy} onFollowed={(f) => setPrFollows((cur) => (cur.includes(f.id) ? cur : [...cur, f.id]))} />
              <p className="field-hint">
                {follows.length === 0
                  ? "Nothing is followed yet: name a repository to follow every open PR of it. My PRs and Reviews asked of me are followed from the Pull requests page."
                  : "Follow another repository here, or My PRs and Reviews asked of me from the Pull requests page."}
              </p>
            </fieldset>
            <fieldset className="choice">
              <legend>Events</legend>
              <div className="automation-events">
                {PrEventType.options.map((ev) => (
                  <label key={ev} className="check">
                    <input type="checkbox" checked={prEvents.includes(ev)} onChange={(e) => setPrEvents((cur) => (e.target.checked ? [...cur, ev] : cur.filter((x) => x !== ev)))} />
                    {PR_EVENT_LABELS[ev]}
                  </label>
                ))}
              </div>
            </fieldset>
            <details className="automation-filters">
              <summary>Filters</summary>
              <div className="row">
                <label>
                  Draft PRs
                  <select value={filters.drafts} onChange={(e) => setFilters({ ...filters, drafts: e.target.value as PrEventFilters["drafts"] })}>
                    <option value="skip">Skip until ready for review</option>
                    <option value="include">Include</option>
                  </select>
                </label>
                <label>
                  PRs from forks
                  <select value={filters.forks} onChange={(e) => setFilters({ ...filters, forks: e.target.value as PrEventFilters["forks"] })}>
                    <option value="skip">Skip</option>
                    <option value="review_only">Review only (no QA, no new Session on their code)</option>
                    <option value="allow">Allow everything</option>
                  </select>
                </label>
              </div>
              <div className="row">
                <label>
                  Authors
                  <select value={filters.authors} onChange={(e) => setFilters({ ...filters, authors: e.target.value as PrEventFilters["authors"] })}>
                    <option value="any">Anyone</option>
                    <option value="not_self">Not my own PRs</option>
                    <option value="self_only">Only my own PRs</option>
                  </select>
                </label>
                <label>
                  Base branch (glob, optional)
                  <input value={filters.baseRef ?? ""} onChange={(e) => setFilters({ ...filters, baseRef: e.target.value })} placeholder="main, release/*" spellCheck={false} />
                </label>
              </div>
              <div className="row">
                <label>
                  Only PRs by these authors (optional)
                  <LoginList
                    value={filters.authorLogins ?? []}
                    onChange={(authorLogins) => setFilters({ ...filters, authorLogins })}
                    suggestions={people?.authors ?? []}
                    placeholder="login — Enter adds"
                  />
                </label>
                <label>
                  Only PRs where one of these is asked to review (optional)
                  <LoginList
                    value={filters.reviewers ?? []}
                    onChange={(reviewers) => setFilters({ ...filters, reviewers })}
                    suggestions={people?.reviewers ?? []}
                    placeholder="login, or a team as org/slug"
                  />
                </label>
              </div>
              <div className="row">
                <label>
                  Title must match (regular expression, optional)
                  <input value={filters.titleMatch ?? ""} onChange={(e) => setFilters({ ...filters, titleMatch: e.target.value })} placeholder="^(?!WIP)" spellCheck={false} />
                </label>
                <label>
                  Any of these labels (comma-separated, optional)
                  <input
                    value={(filters.labels ?? []).join(", ")}
                    onChange={(e) =>
                      setFilters({
                        ...filters,
                        labels: e.target.value
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="needs-review"
                  />
                </label>
              </div>
              <label className="check">
                <input type="checkbox" checked={filters.includeOwn} onChange={(e) => setFilters({ ...filters, includeOwn: e.target.checked })} />
                Also react to what my own account did (my review, my push)
              </label>
            </details>
          </>
        )}
        {triggerType === "manual" && <p className="field-hint">Nothing starts it but the Run now button (or an agent's `automation_run`); useful to keep a template at hand.</p>}
        {!showAction && (
          <div className="actions">
            <button type="button" className="primary" disabled={triggerError !== null} onClick={() => setStep("action")}>
              Next: what to do
            </button>
          </div>
        )}
      </section>

      {showAction && (
        <section className="automation-step">
          <h3>
            <span className="automation-step-n">2</span> Do
          </h3>
          {!forSession && (
            <fieldset className="choice">
              <legend>Action</legend>
              {actionChoices.map((type) => (
                <label key={type} className="check">
                  <input type="radio" name="action" checked={actionType === type} onChange={() => setActionType(type)} />
                  {AUTOMATION_ACTION_LABELS[type]}
                </label>
              ))}
            </fieldset>
          )}
          {actionType === "prompt" && (
            <>
              {!forSession && (
                <label>
                  Session
                  <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                    {isPr && <option value="attached">The Session the PR is attached to</option>}
                    {sessions.length === 0 && !isPr && <option value="">No Sessions yet</option>}
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title} ({PROVIDER_LABELS[s.provider]}, {s.status})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="field-hint">
                Sent right away when the Session is idle, queued behind the running turn otherwise; a stopped Session is resumed first. The Session keeps its transcript and
                snapshots.{isPr && <> Placeholders: <code>{"{pr.url}"}</code>, <code>{"{pr.number}"}</code>, <code>{"{pr.title}"}</code>, <code>{"{pr.repo}"}</code>, <code>{"{pr.headSha}"}</code>, <code>{"{event}"}</code>.</>}
              </p>
              <label>
                Prompt
                <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={isPr ? "PR {pr.url} was {event}: address the new comments and failing checks." : undefined} />
              </label>
            </>
          )}
          {(actionType === "new_session" || actionType === "auto_review" || actionType === "auto_qa") && (
            <label>
              Provider
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as Provider);
                  setDraft((d) => ({ ...d, model: null, options: {}, inspectLlm: true }));
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {actionType === "new_session" && (
            <>
              {isPr && (
                <label className="check">
                  <input type="checkbox" checked={checkoutPrHead} onChange={(e) => setCheckoutPrHead(e.target.checked)} />
                  {draft.snapshotId
                    ? "Open the prompt with fetching the PR head into the snapshot's repository (nothing is cloned)"
                    : "Clone the PR's repository at the PR head as the first repository"}
                </label>
              )}
              {draft.snapshotId ? (
                <p className="field-hint">The repositories come with the snapshot picked under Environment; each run starts a fresh Sandbox from that image.</p>
              ) : (
                <fieldset className="choice">
                  <legend>
                    {isPr && checkoutPrHead ? "Other repositories" : "Repositories"} (each goes to <code>/workspace/&lt;name&gt;</code>; cloned fresh on every run)
                  </legend>
                  <RepoEditor drafts={repos} onChange={setRepos} disabled={busy} accounts={githubAccounts(settings)} />
                </fieldset>
              )}
              <SessionSettingsForm
                mode="create"
                provider={provider}
                settings={settings}
                models={models[provider]}
                options={options[provider]}
                value={draft}
                onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
                disabled={busy}
              />
              <label>
                Session title (optional; defaults to the first prompt{isPr && "; placeholders work"})
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isPr ? "PR #{pr.number}: {pr.title}" : undefined} />
              </label>
              <label>
                First prompt
                <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={isPr ? "Pull request {pr.url} ({event}). …" : undefined} />
              </label>
            </>
          )}
          {actionType === "auto_review" && (
            <>
              <p className="field-hint">
                A new Session clones the repository at the PR head, reviews the diff (the PR's text is data, not instructions) and hands its findings to the Control Plane, which posts one review
                comment on the PR under your connector account with a link back here.
              </p>
              <div className="row">
                <label>
                  Verdict
                  <select value={maxVerdict} onChange={(e) => setMaxVerdict(e.target.value as ReviewVerdict)}>
                    {(Object.keys(VERDICT_LABELS) as ReviewVerdict[]).map((v) => (
                      <option key={v} value={v}>
                        {VERDICT_LABELS[v]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Notify me
                  <select value={notifyOn} onChange={(e) => setNotifyOn(e.target.value as typeof notifyOn)}>
                    <option value="findings">When there are findings</option>
                    <option value="always">After every review</option>
                    <option value="never">Never</option>
                  </select>
                </label>
              </div>
              <label className="check">
                <input type="checkbox" checked={deltaOnly} onChange={(e) => setDeltaOnly(e.target.checked)} />
                On new commits, review only what changed since the last review
              </label>
              <label>
                Instructions for the reviewer (optional: conventions, what to ignore)
                <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
              </label>
            </>
          )}
          {actionType === "auto_qa" && (
            <>
              <p className="field-hint">
                A new Session clones the repository at the PR head, plans 2–5 cases from the PR's title, description and diff, runs them on its desktop and records a video; the result is posted
                on the PR with a link back here.
              </p>
              <div className="row">
                <label>
                  Publish the video
                  <select value={publish} onChange={(e) => setPublish(e.target.value as typeof publish)}>
                    <option value="github_attachment">Attached to the PR comment (GitHub)</option>
                    <option value="link_only">Link to Sessionboxer only</option>
                  </select>
                </label>
                <label>
                  Time limit (minutes)
                  <input type="number" min={1} max={30} value={maxMinutes} onChange={(e) => setMaxMinutes(Math.max(1, Math.min(30, Number(e.target.value) || 10)))} />
                </label>
              </div>
              <label className="check">
                <input type="checkbox" checked={commentOnSkip} onChange={(e) => setCommentOnSkip(e.target.checked)} />
                Comment on the PR even when nothing is testable on a desktop
              </label>
              <label>
                Instructions for QA (optional: how to start the app, test accounts)
                <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
              </label>
            </>
          )}
          {(actionType === "new_session" || actionType === "auto_review" || actionType === "auto_qa") && (
            <label className="check">
              <input type="checkbox" checked={stopAfter} onChange={(e) => setStopAfter(e.target.checked)} />
              Stop the Session when the turn ends (the transcript and snapshots stay; resume it any time)
            </label>
          )}
          {actionType === "attach" && <p className="field-hint">When a followed PR's head branch was pushed from one of your Sessions, the PR appears in that Session's PRs pane without pasting its URL.</p>}
          {actionType === "notify" && (
            <label>
              Text (optional; placeholders work)
              <input value={notifyText} onChange={(e) => setNotifyText(e.target.value)} placeholder={isPr ? "{pr.title} was {event}" : "Time for the morning triage"} />
            </label>
          )}
          {!showLimits && (
            <div className="actions">
              <button type="button" className="primary" disabled={actionError !== null} onClick={() => setStep("limits")}>
                Next: limits
              </button>
            </div>
          )}
        </section>
      )}

      {showLimits && (
        <section className="automation-step">
          <h3>
            <span className="automation-step-n">3</span> Limits
          </h3>
          <div className="row">
            <label>
              Sessions at once
              <input type="number" min={1} max={20} value={limits.maxConcurrent} onChange={(e) => setLimits({ ...limits, maxConcurrent: clamp(e.target.value, 1, 20, 2) })} />
            </label>
            <label>
              Runs per day
              <input type="number" min={1} max={1000} value={limits.maxRunsPerDay} onChange={(e) => setLimits({ ...limits, maxRunsPerDay: clamp(e.target.value, 1, 1000, 20) })} />
            </label>
            <label>
              Time limit per run (minutes)
              <input type="number" min={1} max={1440} value={limits.timeoutMinutes} onChange={(e) => setLimits({ ...limits, timeoutMinutes: clamp(e.target.value, 1, 1440, 360) })} />
            </label>
          </div>
          {isPr && (
            <div className="row">
              <label>
                Runs per PR per day
                <input type="number" min={1} max={100} value={limits.maxRunsPerPrPerDay} onChange={(e) => setLimits({ ...limits, maxRunsPerPrPerDay: clamp(e.target.value, 1, 100, 4) })} />
              </label>
              <label>
                Quiet period after a push (seconds)
                <input type="number" min={0} max={3600} value={limits.debounceSeconds} onChange={(e) => setLimits({ ...limits, debounceSeconds: clamp(e.target.value, 0, 3600, 120) })} />
              </label>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
        </section>
      )}

      {showLimits && formError && <p className="field-hint warn">{formError}</p>}
      <div className="actions">
        <button type="button" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        {showLimits && (
          <button type="submit" className="primary" disabled={busy || formError !== null}>
            {busy ? "Saving…" : automation ? "Save" : "Create"}
          </button>
        )}
      </div>
    </form>
  );
}

function clamp(raw: string, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && raw !== "" ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

/** Empty optional filters are left out rather than sent as "". */
function cleanFilters(f: PrEventFilters): PrEventFilters {
  return {
    drafts: f.drafts,
    forks: f.forks,
    authors: f.authors,
    includeOwn: f.includeOwn,
    ...(f.authorLogins && f.authorLogins.length > 0 ? { authorLogins: f.authorLogins } : {}),
    ...(f.reviewers && f.reviewers.length > 0 ? { reviewers: f.reviewers } : {}),
    ...(f.baseRef?.trim() ? { baseRef: f.baseRef.trim() } : {}),
    ...(f.titleMatch?.trim() ? { titleMatch: f.titleMatch.trim() } : {}),
    ...(f.labels && f.labels.length > 0 ? { labels: f.labels } : {}),
  };
}

/** A stored template's settings back into the form; omitted parts follow the current defaults. */
function draftFromInput(input: SessionSettingsInput, settings: PublicSettings): SessionSettingsDraft {
  const base = draftFromDefaults(settings);
  return {
    model: input.model ?? base.model,
    options: input.options ?? base.options,
    inspectLlm: input.inspectLlm ?? base.inspectLlm,
    mcpEnabled: input.mcpEnabled ?? base.mcpEnabled,
    utilitiesEnabled: input.utilitiesEnabled ?? base.utilitiesEnabled,
    instructions: input.instructions ?? base.instructions,
    autoSnapshot: input.autoSnapshot === undefined ? base.autoSnapshot : input.autoSnapshot,
    snapshotKeep: input.snapshotKeep === undefined ? base.snapshotKeep : input.snapshotKeep,
    e2eVerify: input.e2eVerify === undefined ? base.e2eVerify : input.e2eVerify,
    agentTools: input.agentTools === undefined ? base.agentTools : input.agentTools,
    approveCreate: input.approveCreate === undefined ? base.approveCreate : input.approveCreate,
    environment: input.sandbox?.environment ?? base.environment,
    snapshotId: base.snapshotId,
    docker: input.sandbox?.docker ?? base.docker,
    cpus: input.sandbox?.cpus === undefined ? base.cpus : input.sandbox.cpus,
    memoryGb: input.sandbox?.memoryGb === undefined ? base.memoryGb : input.sandbox.memoryGb,
    gitName: input.sandbox?.gitIdentity?.name ?? base.gitName,
    gitEmail: input.sandbox?.gitIdentity?.email ?? base.gitEmail,
  };
}
