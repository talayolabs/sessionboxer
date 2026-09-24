import {
  PROVIDER_LABELS,
  PROVIDERS,
  SCHEDULE_MISSED_POLICY_LABELS,
  SCHEDULE_PREVIEW_COUNT,
  type CreateScheduleRequest,
  type Provider,
  type ProviderModels,
  type ProviderOptions,
  type PublicSettings,
  type Schedule,
  type ScheduleAction,
  type ScheduleMissedPolicy,
  type ScheduleRun,
  type ScheduleRunStatus,
  type Session,
  type SessionSettingsInput,
} from "@sessionboxer/protocol";
import cronstrue from "cronstrue";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { formatDuration } from "./E2e";
import { RepoEditor, draftsError, draftsToSpecs, githubAccounts, specsToDrafts, type RepoDraft } from "./Repos";
import { SessionSettingsForm, draftFromDefaults, draftToInput, type SessionSettingsDraft } from "./SessionSettingsForm";

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

const CRON_EXAMPLES: Array<[string, string]> = [
  ["0 9 * * 1-5", "weekdays at 09:00"],
  ["0 */2 * * *", "every 2 hours"],
  ["*/30 * * * *", "every 30 minutes"],
  ["0 8 * * 1", "Mondays at 08:00"],
  ["0 0 1 * *", "1st of the month at midnight"],
  ["@hourly", "once an hour"],
  ["@daily", "once a day at midnight"],
];

const RUN_LABEL: Record<ScheduleRunStatus, string> = { running: "running", succeeded: "succeeded", failed: "failed", skipped: "skipped" };
const TRIGGER_LABEL: Record<ScheduleRun["trigger"], string> = { cron: "on schedule", manual: "run now", catch_up: "catch-up" };

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

function formatAt(iso: string, timeZone?: string): string {
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

function actionSummary(action: ScheduleAction, sessions: Session[]): string {
  if (action.type === "prompt") {
    const s = sessions.find((x) => x.id === action.sessionId);
    return `Prompt → ${s ? s.title : "a deleted Session"}`;
  }
  return `New ${PROVIDER_LABELS[action.provider]} Session${action.title ? ` "${action.title}"` : ""}${action.stopAfter ? ", stopped after the turn" : ""}`;
}

export function Schedules({
  schedules: allSchedules,
  runs,
  sessions,
  settings,
  models,
  options,
  onOpenSession,
  loadRuns,
  run,
  forSession,
}: {
  schedules: Schedule[];
  runs: Record<string, ScheduleRun[]>;
  sessions: Session[];
  settings: PublicSettings;
  models: ProviderModels;
  options: ProviderOptions;
  onOpenSession: (id: string) => void;
  loadRuns: (scheduleId: string) => void;
  run: Runner;
  /** Set inside a Session: only the tasks that prompt it, and new ones target it. */
  forSession?: Session;
}) {
  const schedules = forSession ? allSchedules.filter((s) => s.action.type === "prompt" && s.action.sessionId === forSession.id) : allSchedules;
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (history) loadRuns(history);
  }, [history, loadRuns]);

  const editingSchedule = editing && editing !== "new" ? (schedules.find((s) => s.id === editing) ?? null) : null;

  if (editing === "new" || editingSchedule) {
    return (
      <ScheduleForm
        key={editing}
        schedule={editingSchedule}
        sessions={sessions}
        settings={settings}
        models={models}
        options={options}
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

  return (
    <div className="panel schedules-panel">
      <div className="schedules-head">
        <h2>{forSession ? "Scheduled prompts" : "Scheduled tasks"}</h2>
        <span className="spacer" />
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          + New task
        </button>
      </div>
      <p className="muted">
        {forSession
          ? "Prompts the Control Plane sends to this Session on a schedule (cron syntax, in the time zone of your choice); all tasks are under Scheduled tasks in the sidebar."
          : "The Control Plane runs these while it is up (cron syntax, in the time zone of your choice). A task prompts one of your Sessions, or starts a new one from a template."}
      </p>
      {schedules.length === 0 && <p className="placeholder-inline muted">{forSession ? "Nothing scheduled for this Session yet." : "No scheduled tasks yet."}</p>}
      <ul className="schedule-list">
        {schedules.map((s) => {
          const running = (runs[s.id] ?? []).some((r) => r.status === "running");
          const words = describeCron(s.cron);
          return (
            <li key={s.id} className={`schedule${s.enabled ? "" : " disabled"}`}>
              <div className="schedule-line">
                <label className="check schedule-switch" title={s.enabled ? "Enabled: runs on schedule" : "Disabled: only Run now"}>
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    disabled={busy === s.id}
                    onChange={(e) => act(s.id, () => api.updateSchedule(s.id, { enabled: e.target.checked }))}
                  />
                </label>
                <div className="schedule-text">
                  <div className="schedule-title">
                    <strong>{s.name}</strong>
                    {s.lastStatus && <span className={`e2e-badge e2e-badge-${badgeClass(running ? "running" : s.lastStatus)}`}>{running ? "running" : RUN_LABEL[s.lastStatus]}</span>}
                  </div>
                  <div className="muted small-text">
                    <code>{s.cron}</code> {words ? `— ${words}` : ""} · {s.timezone}
                  </div>
                  <div className="small-text">{actionSummary(s.action, sessions)}</div>
                  <div className="muted small-text">
                    {s.enabled && s.nextRunAt ? (
                      <>
                        Next {formatAt(s.nextRunAt)} ({relativeTime(s.nextRunAt)})
                      </>
                    ) : (
                      "Not scheduled"
                    )}
                    {s.lastRunAt && <> · Last {relativeTime(s.lastRunAt)}</>}
                  </div>
                </div>
                <div className="schedule-actions">
                  <button type="button" disabled={busy === s.id || running} title="Run once now, whatever the schedule says" onClick={() => act(s.id, () => api.runSchedule(s.id))}>
                    Run now
                  </button>
                  <button type="button" onClick={() => setHistory(history === s.id ? null : s.id)}>
                    {history === s.id ? "Hide history" : "History"}
                  </button>
                  <button type="button" onClick={() => setEditing(s.id)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy === s.id}
                    onClick={() => {
                      if (confirm(`Delete "${s.name}" and its run history?`)) act(s.id, () => api.deleteSchedule(s.id));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {history === s.id && <RunHistory runs={runs[s.id]} onOpenSession={onOpenSession} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function badgeClass(status: ScheduleRunStatus): string {
  return status === "succeeded" ? "passed" : status;
}

function RunHistory({ runs, onOpenSession }: { runs: ScheduleRun[] | undefined; onOpenSession: (id: string) => void }) {
  const [now, setNow] = useState(() => Date.now());
  const live = runs?.some((r) => r.status === "running") ?? false;
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
            <td title={r.startedAt}>{formatAt(r.startedAt)}</td>
            <td>{TRIGGER_LABEL[r.trigger]}</td>
            <td>
              <span className={`e2e-badge e2e-badge-${badgeClass(r.status)}`}>{RUN_LABEL[r.status]}</span>
            </td>
            <td>{r.status === "skipped" ? "–" : formatDuration((r.finishedAt ? new Date(r.finishedAt).getTime() : now) - new Date(r.startedAt).getTime())}</td>
            <td>
              {r.error && <div className="warn">{r.error}</div>}
              {r.detail && <div className="muted">{r.detail}</div>}
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

function ScheduleForm({
  schedule,
  sessions,
  settings,
  models,
  options,
  run,
  onDone,
  forSession,
}: {
  schedule: Schedule | null;
  sessions: Session[];
  settings: PublicSettings;
  models: ProviderModels;
  options: ProviderOptions;
  run: Runner;
  onDone: () => void;
  forSession?: Session;
}) {
  const [name, setName] = useState(schedule?.name ?? "");
  const [cron, setCron] = useState(schedule?.cron ?? "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? localTimeZone());
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [missedPolicy, setMissedPolicy] = useState<ScheduleMissedPolicy>(schedule?.missedPolicy ?? "skip");
  const [actionType, setActionType] = useState<ScheduleAction["type"]>(
    schedule?.action.type ?? (forSession || sessions.length > 0 ? "prompt" : "new_session"),
  );
  const promptAction = schedule?.action.type === "prompt" ? schedule.action : null;
  const newAction = schedule?.action.type === "new_session" ? schedule.action : null;
  const [sessionId, setSessionId] = useState(promptAction?.sessionId ?? forSession?.id ?? sessions[0]?.id ?? "");
  const [text, setText] = useState(promptAction?.text ?? "");
  const [provider, setProvider] = useState<Provider>(newAction?.provider ?? "claude-code");
  const [repos, setRepos] = useState<RepoDraft[]>(() => specsToDrafts(newAction?.repos ?? []));
  const [draft, setDraft] = useState<SessionSettingsDraft>(() => (newAction ? draftFromInput(newAction.settings, settings) : draftFromDefaults(settings)));
  const [title, setTitle] = useState(newAction?.title ?? "");
  const [prompt, setPrompt] = useState(newAction?.prompt ?? "");
  const [stopAfter, setStopAfter] = useState(newAction?.stopAfter ?? true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ ok: true; next: string[] } | { ok: false; error: string } | null>(null);

  const words = useMemo(() => describeCron(cron), [cron]);
  const zones = useMemo(timeZones, []);

  useEffect(() => {
    if (cron.trim() === "" || timezone.trim() === "") {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .schedulePreview({ cron: cron.trim(), timezone: timezone.trim() })
        .then((p) => !cancelled && setPreview(p))
        .catch((e: unknown) => !cancelled && setPreview({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cron, timezone]);

  const repoError = draftsError(repos);
  const targetSession = sessions.find((s) => s.id === sessionId) ?? null;
  const actionError =
    actionType === "prompt"
      ? !targetSession
        ? "Pick a Session."
        : text.trim() === ""
          ? "Write the prompt."
          : null
      : prompt.trim() === ""
        ? "Write the first prompt."
        : repoError;
  const formError = name.trim() === "" ? "Give the task a name." : preview && !preview.ok ? preview.error : actionError;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formError) return;
    const action: ScheduleAction =
      actionType === "prompt"
        ? { type: "prompt", sessionId, text: text.trim() }
        : {
            type: "new_session",
            provider,
            repos: draftsToSpecs(repos),
            settings: draftToInput(draft),
            prompt: prompt.trim(),
            stopAfter,
            ...(title.trim() ? { title: title.trim() } : {}),
          };
    const req: CreateScheduleRequest = { name: name.trim(), cron: cron.trim(), timezone: timezone.trim(), enabled, missedPolicy, action };
    setBusy(true);
    void run(async () => {
      if (schedule) await api.updateSchedule(schedule.id, req);
      else await api.createSchedule(req);
      onDone();
    }).finally(() => setBusy(false));
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2>{schedule ? "Edit scheduled task" : "New scheduled task"}</h2>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Morning triage" />
      </label>
      <div className="row">
        <label>
          When (cron expression)
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
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <label>
          Runs missed while the Control Plane was off
          <select value={missedPolicy} onChange={(e) => setMissedPolicy(e.target.value as ScheduleMissedPolicy)}>
            {(Object.keys(SCHEDULE_MISSED_POLICY_LABELS) as ScheduleMissedPolicy[]).map((p) => (
              <option key={p} value={p}>
                {SCHEDULE_MISSED_POLICY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!forSession && (
        <fieldset className="choice">
          <legend>What to do</legend>
          <label className="check">
            <input type="radio" name="action" checked={actionType === "prompt"} onChange={() => setActionType("prompt")} />
            Send a prompt to an existing Session
          </label>
          <label className="check">
            <input type="radio" name="action" checked={actionType === "new_session"} onChange={() => setActionType("new_session")} />
            Start a new Session from a template
          </label>
        </fieldset>
      )}
      {actionType === "prompt" && (
        <>
          {!forSession && (
            <label>
              Session
              <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                {sessions.length === 0 && <option value="">No Sessions yet</option>}
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} ({PROVIDER_LABELS[s.provider]}, {s.status})
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="field-hint">
            Sent right away when the Session is idle, queued behind the running turn otherwise; a stopped Session is resumed first. The Session
            keeps its transcript and snapshots.
          </p>
          <label>
            Prompt
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </>
      )}
      {actionType === "new_session" && (
        <>
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
          <fieldset className="choice">
            <legend>Repositories (each goes to <code>/workspace/&lt;name&gt;</code>; cloned fresh on every run)</legend>
            <RepoEditor drafts={repos} onChange={setRepos} disabled={busy} accounts={githubAccounts(settings)} />
          </fieldset>
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
            Session title (optional; defaults to the first prompt)
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            First prompt
            <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={stopAfter} onChange={(e) => setStopAfter(e.target.checked)} />
            Stop the Session when the turn ends (the transcript and snapshots stay; resume it any time)
          </label>
        </>
      )}
      {formError && <p className="field-hint warn">{formError}</p>}
      <div className="actions">
        <button type="button" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || formError !== null}>
          {busy ? "Saving…" : schedule ? "Save" : "Create"}
        </button>
      </div>
    </form>
  );
}

/** A stored template's settings back into the form; omitted parts follow the current defaults. */
function draftFromInput(input: SessionSettingsInput, settings: PublicSettings): SessionSettingsDraft {
  const base = draftFromDefaults(settings);
  return {
    model: input.model ?? base.model,
    options: input.options ?? base.options,
    inspectLlm: input.inspectLlm ?? base.inspectLlm,
    mcpEnabled: input.mcpEnabled ?? base.mcpEnabled,
    instructions: input.instructions ?? base.instructions,
    autoSnapshot: input.autoSnapshot === undefined ? base.autoSnapshot : input.autoSnapshot,
    snapshotKeep: input.snapshotKeep === undefined ? base.snapshotKeep : input.snapshotKeep,
    e2eVerify: input.e2eVerify === undefined ? base.e2eVerify : input.e2eVerify,
    docker: input.sandbox?.docker ?? base.docker,
    cpus: input.sandbox?.cpus === undefined ? base.cpus : input.sandbox.cpus,
    memoryGb: input.sandbox?.memoryGb === undefined ? base.memoryGb : input.sandbox.memoryGb,
    gitName: input.sandbox?.gitIdentity?.name ?? base.gitName,
    gitEmail: input.sandbox?.gitIdentity?.email ?? base.gitEmail,
  };
}
