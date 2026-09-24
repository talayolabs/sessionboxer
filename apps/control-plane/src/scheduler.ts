import { Cron } from "croner";
import {
  SCHEDULES_ROUTE,
  SCHEDULE_PREVIEW_COUNT,
  type CreateScheduleRequest,
  type CreateSessionRequest,
  type PushMessage,
  type Schedule,
  type ScheduleAction,
  type SchedulePreview,
  type ScheduleRun,
  type ScheduleRunTrigger,
  type Session,
  type SessionBroadcast,
  type UpdateScheduleRequest,
} from "@sessionboxer/protocol";
import type { Db } from "./db.js";
import { HttpError } from "./http-error.js";
import type { TurnOutcome } from "./sessions.js";

const TICK_MS = 30_000;
/** A due time older than this was missed (the Control Plane was off, the laptop asleep): the missed policy decides. */
const MISSED_GRACE_MS = 5 * 60_000;
/** A run whose turn has not settled by then is given up on (the Session itself is left alone). */
const RUN_TIMEOUT_MS = 6 * 60 * 60_000;
const MISSED_COUNT_CAP = 100;

/** What the scheduler needs from the `SessionManager`. */
export interface SchedulerSessions {
  get(id: string): Session;
  create(req: CreateSessionRequest): Promise<Session>;
  promptScheduled(id: string, text: string): Promise<"sent" | "queued" | "resumed">;
  stop(id: string): Promise<Session>;
  onTurnSettled(fn: (id: string, outcome: TurnOutcome) => void): () => void;
  subscribe(fn: (msg: SessionBroadcast) => void): () => void;
}

export interface SchedulerDeps {
  db: Db;
  sessions: SchedulerSessions;
  broadcast: (msg: SessionBroadcast) => void;
  push: (msg: PushMessage) => void;
  log: (msg: string) => void;
}

/** A run waiting for its Session's turn to settle. */
interface TrackedRun {
  runId: string;
  scheduleId: string;
  stopAfter: boolean;
  timer: NodeJS.Timeout;
}

/** Throws a 400 when the expression or the time zone cannot be read; returns the parsed job otherwise. */
export function parseCron(cron: string, timezone: string): Cron {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new HttpError(400, `Unknown time zone "${timezone}"; use an IANA name such as Europe/Madrid.`);
  }
  try {
    const job = new Cron(cron, { timezone });
    job.nextRun();
    return job;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new HttpError(400, `Cannot read the cron expression: ${message.replace(/^CronPattern: /, "")}`);
  }
}

function nextAfter(job: Cron, from: Date): string | null {
  return job.nextRun(from)?.toISOString() ?? null;
}

/**
 * Scheduled tasks (ADR-0047): cron expressions in SQLite, ticked here every 30 s. A due schedule is
 * claimed with a compare-and-set on `next_run_at`, so a slow tick and the next cannot run it twice.
 * A run is over when the Session's turn settles (`onTurnSettled`), fails when the Session errors,
 * is deleted, or is stopped under it.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly tracked = new Map<string, TrackedRun[]>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.closeStale();
    this.unsubscribe.push(this.deps.sessions.onTurnSettled((id, outcome) => void this.onSettled(id, outcome)));
    this.unsubscribe.push(this.deps.sessions.subscribe((msg) => this.onSessionBroadcast(msg)));
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const fn of this.unsubscribe) fn();
    for (const runs of this.tracked.values()) for (const t of runs) clearTimeout(t.timer);
    this.tracked.clear();
  }

  /** Runs still "running" from before a restart cannot be followed any more. */
  private closeStale(): void {
    for (const run of this.deps.db.schedules.listActiveRuns()) {
      this.deps.db.schedules.updateRun(run.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: "The Control Plane restarted while the run was in progress.",
      });
    }
  }

  list(): Schedule[] {
    return this.deps.db.schedules.list();
  }

  get(id: string): Schedule {
    const s = this.deps.db.schedules.get(id);
    if (!s) throw new HttpError(404, `schedule ${id} not found`);
    return s;
  }

  listRuns(id: string): ScheduleRun[] {
    this.get(id);
    return this.deps.db.schedules.listRuns(id);
  }

  preview(cron: string, timezone: string): SchedulePreview {
    try {
      const job = parseCron(cron, timezone);
      return { ok: true, next: job.nextRuns(SCHEDULE_PREVIEW_COUNT).map((d) => d.toISOString()) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  create(req: CreateScheduleRequest): Schedule {
    const job = parseCron(req.cron, req.timezone);
    this.validateAction(req.action);
    const schedule = this.deps.db.schedules.insert({
      name: req.name.trim(),
      cron: req.cron.trim(),
      timezone: req.timezone,
      enabled: req.enabled,
      missedPolicy: req.missedPolicy,
      action: req.action,
      nextRunAt: req.enabled ? nextAfter(job, new Date()) : null,
    });
    this.broadcastSchedules();
    return schedule;
  }

  update(id: string, req: UpdateScheduleRequest): Schedule {
    const current = this.get(id);
    const cron = req.cron?.trim() ?? current.cron;
    const timezone = req.timezone ?? current.timezone;
    const enabled = req.enabled ?? current.enabled;
    const job = parseCron(cron, timezone);
    if (req.action) this.validateAction(req.action);
    const timingChanged = cron !== current.cron || timezone !== current.timezone || enabled !== current.enabled;
    const next = this.deps.db.schedules.update(id, {
      name: req.name?.trim() ?? current.name,
      cron,
      timezone,
      enabled,
      missedPolicy: req.missedPolicy ?? current.missedPolicy,
      action: req.action ?? current.action,
      nextRunAt: timingChanged ? (enabled ? nextAfter(job, new Date()) : null) : current.nextRunAt,
    });
    if (!next) throw new HttpError(404, `schedule ${id} not found`);
    this.broadcastSchedules();
    return next;
  }

  delete(id: string): void {
    if (!this.deps.db.schedules.delete(id)) throw new HttpError(404, `schedule ${id} not found`);
    for (const [sessionId, runs] of this.tracked) {
      const kept = runs.filter((t) => {
        if (t.scheduleId !== id) return true;
        clearTimeout(t.timer);
        return false;
      });
      if (kept.length === 0) this.tracked.delete(sessionId);
      else this.tracked.set(sessionId, kept);
    }
    this.broadcastSchedules();
  }

  /** "Run now": one run regardless of the expression or the enabled switch. */
  async runNow(id: string): Promise<ScheduleRun> {
    const schedule = this.get(id);
    return this.execute(schedule, "manual");
  }

  private validateAction(action: ScheduleAction): void {
    if (action.type === "prompt" && !this.deps.db.getSession(action.sessionId)) {
      throw new HttpError(400, `Session ${action.sessionId} does not exist.`);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      let changed = false;
      for (const schedule of this.deps.db.schedules.list()) {
        if (!schedule.enabled) continue;
        let job: Cron;
        try {
          job = parseCron(schedule.cron, schedule.timezone);
        } catch (e) {
          this.deps.log(`schedule ${schedule.id} (${schedule.name}) unreadable: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (!schedule.nextRunAt) {
          this.deps.db.schedules.update(schedule.id, { nextRunAt: nextAfter(job, now) });
          changed = true;
          continue;
        }
        const due = new Date(schedule.nextRunAt);
        if (due.getTime() > now.getTime()) continue;
        const next = nextAfter(job, now);
        if (!this.deps.db.schedules.claimDue(schedule.id, schedule.nextRunAt, next)) continue;
        changed = true;
        if (now.getTime() - due.getTime() > MISSED_GRACE_MS) {
          const missed = this.countOccurrences(job, due, now);
          if (schedule.missedPolicy === "skip") {
            this.recordSkipped(schedule, due, missed);
          } else {
            void this.execute(schedule, "catch_up", `Catching up: ${missedSummary(due, missed, schedule.timezone)}.`);
          }
        } else {
          void this.execute(schedule, "cron");
        }
      }
      if (changed) this.broadcastSchedules();
    } catch (e) {
      this.deps.log(`scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Occurrences from `due` (inclusive) to `now`, capped. */
  private countOccurrences(job: Cron, due: Date, now: Date): number {
    let count = 1;
    let at: Date | null = due;
    while (count < MISSED_COUNT_CAP) {
      at = job.nextRun(at);
      if (!at || at.getTime() > now.getTime()) break;
      count += 1;
    }
    return count;
  }

  private recordSkipped(schedule: Schedule, due: Date, missed: number): void {
    const run = this.deps.db.schedules.insertRun(schedule.id, "cron");
    this.deps.db.schedules.updateRun(run.id, {
      status: "skipped",
      finishedAt: new Date().toISOString(),
      detail: `Skipped: ${missedSummary(due, missed, schedule.timezone)} while the Control Plane was not running.`,
    });
    this.deps.log(`schedule ${schedule.id} (${schedule.name}) skipped ${missed} missed run(s)`);
    this.broadcastRuns(schedule.id);
  }

  private async execute(schedule: Schedule, trigger: ScheduleRunTrigger, note?: string): Promise<ScheduleRun> {
    const run = this.deps.db.schedules.insertRun(schedule.id, trigger);
    this.deps.log(`schedule ${schedule.id} (${schedule.name}) run ${run.id} started (${trigger})`);
    this.broadcastSchedules();
    this.broadcastRuns(schedule.id);
    try {
      const action = schedule.action;
      if (action.type === "prompt") {
        const how = await this.deps.sessions.promptScheduled(action.sessionId, action.text);
        const detail =
          how === "queued"
            ? "Queued behind the running turn; sent when it ends."
            : how === "resumed"
              ? "Sandbox resumed; the prompt goes out once the Daemon is up."
              : "Prompt sent.";
        this.deps.db.schedules.updateRun(run.id, { detail: join(note, detail), sessionId: action.sessionId });
        this.broadcastRuns(schedule.id);
        this.track(action.sessionId, run.id, schedule.id, false);
        return this.deps.db.schedules.getRun(run.id) ?? run;
      }
      const session = await this.deps.sessions.create({
        title: action.title,
        provider: action.provider,
        repos: action.repos,
        workspaceSource: { type: "empty" },
        settings: action.settings,
        prompt: action.prompt,
      });
      this.deps.db.schedules.updateRun(run.id, { detail: join(note, `Session "${session.title}" started.`), sessionId: session.id });
      this.broadcastRuns(schedule.id);
      this.track(session.id, run.id, schedule.id, action.stopAfter);
      return this.deps.db.schedules.getRun(run.id) ?? run;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.finish(run.id, "failed", { detail: note ?? null, error: message });
    }
  }

  private track(sessionId: string, runId: string, scheduleId: string, stopAfter: boolean): void {
    const timer = setTimeout(() => {
      this.untrack(sessionId, runId);
      this.finish(runId, "failed", { error: `The turn did not end within ${RUN_TIMEOUT_MS / 3_600_000} hours.` });
    }, RUN_TIMEOUT_MS);
    timer.unref();
    const runs = this.tracked.get(sessionId) ?? [];
    runs.push({ runId, scheduleId, stopAfter, timer });
    this.tracked.set(sessionId, runs);
  }

  private untrack(sessionId: string, runId: string): TrackedRun | null {
    const runs = this.tracked.get(sessionId);
    if (!runs) return null;
    const i = runs.findIndex((t) => t.runId === runId);
    if (i < 0) return null;
    const [t] = runs.splice(i, 1);
    if (runs.length === 0) this.tracked.delete(sessionId);
    if (!t) return null;
    clearTimeout(t.timer);
    return t;
  }

  private takeAll(sessionId: string): TrackedRun[] {
    const runs = this.tracked.get(sessionId) ?? [];
    this.tracked.delete(sessionId);
    for (const t of runs) clearTimeout(t.timer);
    return runs;
  }

  private async onSettled(sessionId: string, outcome: TurnOutcome): Promise<void> {
    const runs = this.takeAll(sessionId);
    if (runs.length === 0) return;
    let stopAfter = false;
    for (const t of runs) {
      stopAfter ||= t.stopAfter;
      if (outcome === "end_turn") this.finish(t.runId, "succeeded", {});
      else this.finish(t.runId, "failed", { error: outcome === "error" ? "The Agent reported an error." : `The turn ended with "${outcome}".` });
    }
    if (!stopAfter) return;
    try {
      await this.deps.sessions.stop(sessionId);
      for (const t of runs) this.appendDetail(t.runId, "Sandbox stopped afterwards.");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log(`schedule stop-after ${sessionId} failed: ${message}`);
      for (const t of runs) this.appendDetail(t.runId, `Could not stop the Sandbox afterwards: ${message}`);
    }
  }

  private onSessionBroadcast(msg: SessionBroadcast): void {
    if (msg.type === "session_deleted") {
      for (const t of this.takeAll(msg.id)) this.finish(t.runId, "failed", { error: "The Session was deleted." });
      return;
    }
    if (msg.type !== "session" || !this.tracked.has(msg.session.id)) return;
    const s = msg.session;
    if (s.status === "error") {
      for (const t of this.takeAll(s.id)) this.finish(t.runId, "failed", { error: s.error ?? "The Session is in error state." });
    } else if (s.status === "stopped") {
      for (const t of this.takeAll(s.id)) this.finish(t.runId, "failed", { error: "The Session was stopped before the turn ended." });
    }
  }

  private finish(runId: string, status: "succeeded" | "failed", patch: { detail?: string | null; error?: string; sessionId?: string }): ScheduleRun {
    const current = this.deps.db.schedules.getRun(runId);
    const next = this.deps.db.schedules.updateRun(runId, {
      status,
      finishedAt: new Date().toISOString(),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
    });
    if (!next || !current) throw new HttpError(404, `run ${runId} not found`);
    this.deps.log(`schedule ${next.scheduleId} run ${runId} ${status}${next.error ? `: ${next.error}` : ""}`);
    this.broadcastSchedules();
    this.broadcastRuns(next.scheduleId);
    if (status === "failed") {
      const schedule = this.deps.db.schedules.get(next.scheduleId);
      this.deps.push({
        title: `Scheduled task failed: ${schedule?.name ?? next.scheduleId}`,
        body: next.error ?? "unknown error",
        tag: `sessionboxer-schedule-${next.scheduleId}`,
        url: SCHEDULES_ROUTE,
      });
    }
    return next;
  }

  private appendDetail(runId: string, line: string): void {
    const run = this.deps.db.schedules.getRun(runId);
    if (!run) return;
    this.deps.db.schedules.updateRun(runId, { detail: join(run.detail ?? undefined, line) });
    this.broadcastRuns(run.scheduleId);
  }

  private broadcastSchedules(): void {
    this.deps.broadcast({ type: "schedules", schedules: this.deps.db.schedules.list() });
  }

  private broadcastRuns(scheduleId: string): void {
    this.deps.broadcast({ type: "schedule_runs", scheduleId, runs: this.deps.db.schedules.listRuns(scheduleId) });
  }
}

function join(a: string | undefined, b: string): string {
  return a ? `${a} ${b}` : b;
}

function missedSummary(due: Date, missed: number, timezone: string): string {
  const when = due.toLocaleString("en-GB", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
  const first = `the run due ${when} (${timezone})`;
  return missed > 1 ? `${first} and ${missed - 1} more` : first;
}
