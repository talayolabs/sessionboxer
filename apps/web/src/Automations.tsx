import {
  PR_EVENT_LABELS,
  PROVIDER_LABELS,
  type Automation,
  type AutomationAction,
  type AutomationLimits,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationTrigger,
  type CreateAutomationRequest,
  type McpEventSubscription,
  type PublicMcpServerDef,
  type ProviderModels,
  type ProviderOptions,
  type PublicSettings,
  type Session,
} from "@sessionboxer/protocol";
import { describeCron, formatAt, VERDICT_LABELS } from "./automations/display";
import { TriggerStep, useTriggerState } from "./automations/TriggerStep";
import { ActionStep, useActionState } from "./automations/ActionStep";
import { LimitsStep } from "./automations/LimitsStep";
import { buildTrigger, buildAction, getTriggerError, getActionError, getFormError } from "./automations/form-model";
import { useEffect, useState } from "react";
import { api } from "./api";
import { formatDuration } from "./E2e";
import { draftsError, draftsToSpecs } from "./Repos";

export { describeCron, formatAt } from "./automations/display";

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

/** A PR follow the trigger can listen to (from the Pull requests page). */
export interface FollowOption {
  id: string;
  label: string;
}

export const RUN_LABEL: Record<AutomationRunStatus, string> = { queued: "queued", running: "running", succeeded: "succeeded", failed: "failed", skipped: "skipped" };
const TRIGGER_LABEL: Record<AutomationRun["trigger"], string> = { cron: "on schedule", manual: "run now", catch_up: "catch-up", pr_event: "PR event", mcp_event: "MCP event" };
const SUBSCRIPTION_LABEL: Record<McpEventSubscription["state"], string> = { connecting: "connecting", listening: "listening", polling: "polling", error: "not subscribed", off: "off" };
const DEFAULT_LIMITS: AutomationLimits = { maxConcurrent: 2, maxRunsPerDay: 20, maxRunsPerPrPerDay: 4, debounceSeconds: 120, timeoutMinutes: 360 };
const PR_ACTIONS: ReadonlyArray<AutomationAction["type"]> = ["auto_review", "auto_qa", "attach"];

/** "in 2 h", "in 3 d", "5 min ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const unit = abs < 60_000 ? [Math.round(abs / 1000), "s"] : abs < 3_600_000 ? [Math.round(abs / 60_000), "min"] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "h"] : [Math.round(abs / 86_400_000), "d"];
  return diff >= 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
}

/** Whether the automation prompts this Session (the Session's Scheduled pane lists those). */
export function promptsSession(a: Automation, sessionId: string): boolean {
  return a.action.type === "prompt" && a.action.sessionId === sessionId;
}

function triggerSummary(t: AutomationTrigger, follows: FollowOption[], servers: PublicMcpServerDef[]): string {
  if (t.type === "schedule") {
    const words = describeCron(t.cron);
    return `${t.cron}${words ? ` — ${words}` : ""} · ${t.timezone}`;
  }
  if (t.type === "manual") return "Runs only when you press Run now";
  if (t.type === "mcp_event") {
    const server = servers.find((s) => s.id === t.serverId)?.name ?? `${t.serverId} (not in the registry)`;
    return `When ${server} reports ${t.event}${t.delivery === "auto" ? "" : ` · ${t.delivery}`}`;
  }
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
  mcpSubscriptions = [],
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
  /** The live MCP event subscriptions (ADR-0081), one per enabled `mcp_event` automation. */
  mcpSubscriptions?: McpEventSubscription[];
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
          : "A trigger, an action and limits, run by the Control Plane while it is up: on a schedule, when a followed pull request opens, gets commits, comments or a failing check, or when an MCP server reports an event. An automation prompts a Session, starts one from a template, reviews or QA-tests a PR, or just notifies you."}
      </p>
      {automations.length === 0 && <p className="placeholder-inline muted">{forSession ? "Nothing prompts this Session yet." : "No automations yet."}</p>}
      <ul className="schedule-list">
        {automations.map((a) => {
          const running = (runs[a.id] ?? []).some((r) => r.status === "running" || r.status === "queued");
          const status = running ? "running" : a.lastStatus;
          const manualOnly = a.trigger.type === "pr_event" && (PR_ACTIONS.includes(a.action.type) || (a.action.type === "prompt" && a.action.sessionId === "attached"));
          const subscription = a.trigger.type === "mcp_event" ? mcpSubscriptions.find((s) => s.automationId === a.id) : undefined;
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
                    {subscription && (
                      <span className={`e2e-badge e2e-badge-${subscription.state === "error" ? "failed" : subscription.state === "off" ? "skipped" : "running"}`} title={subscription.error ?? (subscription.mode ? `${subscription.mode} delivery` : undefined)}>
                        {SUBSCRIPTION_LABEL[subscription.state]}
                      </span>
                    )}
                  </div>
                  <div className="muted small-text">{triggerSummary(a.trigger, follows, settings.mcpServers)}</div>
                  {subscription?.error && <div className="warn small-text">{subscription.error}</div>}
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

/** The first line of an event's payload for the history table. */
function eventPreview(data: Record<string, unknown>): string {
  const json = JSON.stringify(data);
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
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
            <td>{r.event ? `PR ${PR_EVENT_LABELS[r.event.type]}` : r.mcpEvent ? `${r.mcpEvent.server} ${r.mcpEvent.name}` : TRIGGER_LABEL[r.trigger]}</td>
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
              {!compact && r.mcpEvent && (
                <div className="muted small-text" title={JSON.stringify(r.mcpEvent.data, null, 2)}>
                  {r.mcpEvent.eventId} · {eventPreview(r.mcpEvent.data)}
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

export type Step = "trigger" | "action" | "limits";

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
  const [name, setName] = useState(automation?.name ?? "");
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  // Progressive disclosure: trigger, then action, then limits; editing shows everything.
  const [step, setStep] = useState<Step>(automation ? "limits" : "trigger");
  const trigger = useTriggerState(automation?.trigger);
  const { triggerType, cron, timezone } = trigger.values;
  const action = useActionState(automation?.action, sessions, settings, forSession);
  const { actionType, sessionId, repos } = action.values;
  const { setActionType, setSessionId } = action.set;
  // limits
  const [limits, setLimits] = useState<AutomationLimits>(automation?.limits ?? DEFAULT_LIMITS);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ ok: true; next: string[] } | { ok: false; error: string } | null>(null);

  const isPr = triggerType === "pr_event";
  const isMcp = triggerType === "mcp_event";
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

  const triggerError = getTriggerError(trigger.values, preview, follows);
  const repoError = draftsError(repos);
  const targetSession = sessionId === "attached" ? null : (sessions.find((s) => s.id === sessionId) ?? null);
  const actionError = getActionError(action.values, targetSession, repoError);
  const formError = getFormError(name, triggerError, actionError);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formError) return;
    const req: CreateAutomationRequest = { name: name.trim(), enabled, trigger: buildTrigger(trigger.values), action: buildAction(action.values, { draftsToSpecs }), limits };
    setBusy(true);
    void run(async () => {
      if (automation) await api.updateAutomation(automation.id, req);
      else await api.createAutomation(req);
      onDone();
    }).finally(() => setBusy(false));
  };

  const showAction = step !== "trigger";
  const showLimits = step === "limits";

  return (
    <form className="panel automation-form" onSubmit={submit}>
      <h2>{automation ? "Edit automation" : "New automation"}</h2>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder={isPr ? "Review every PR" : isMcp ? "Triage new tickets" : "Morning triage"} />
      </label>

      <TriggerStep {...trigger.values} {...trigger.set} forSession={forSession} follows={follows} busy={busy}
        preview={preview} showAction={showAction} triggerError={triggerError} setStep={setStep} />
      {showAction && <ActionStep {...action.values} {...action.set} forSession={forSession} sessions={sessions}
        settings={settings} models={models} options={options} busy={busy} isPr={isPr} isMcp={isMcp}
        showLimits={showLimits} actionError={actionError} setStep={setStep} />}
      {showLimits && <LimitsStep limits={limits} setLimits={setLimits} enabled={enabled} setEnabled={setEnabled} isPr={isPr} />}

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
