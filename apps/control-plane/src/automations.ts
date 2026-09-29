import { Cron } from "croner";
import {
  AUTOMATIONS_ROUTE,
  SCHEDULE_PREVIEW_COUNT,
  automationRoute,
  type Automation,
  type AutomationAction,
  type AutomationRun,
  type AutomationRunResult,
  type AutomationRunTrigger,
  type CreateAutomationRequest,
  type CreateScheduleRequest,
  type CreateSessionRequest,
  type PushMessage,
  type RepoSpec,
  type Schedule,
  type SchedulePreview,
  type ScheduleRun,
  type ScheduleTrigger,
  type Session,
  type SessionBroadcast,
  type UpdateAutomationRequest,
  type UpdateScheduleRequest,
} from "@sessionboxer/protocol";
import type { RunContext } from "./automation-store.js";
import type { Db } from "./db.js";
import { HttpError } from "./http-error.js";
import type { TurnOutcome } from "./sessions.js";

const TICK_MS = 30_000;
/** A due time older than this was missed (the Control Plane was off, the laptop asleep): the missed policy decides. */
const MISSED_GRACE_MS = 5 * 60_000;
const MISSED_COUNT_CAP = 100;

/** What the automations need from the `SessionManager`. */
export interface AutomationSessions {
  get(id: string): Session;
  create(req: CreateSessionRequest): Promise<Session>;
  promptScheduled(id: string, text: string): Promise<"sent" | "queued" | "resumed">;
  stop(id: string): Promise<Session>;
  onTurnSettled(fn: (id: string, outcome: TurnOutcome) => void): () => void;
  subscribe(fn: (msg: SessionBroadcast) => void): () => void;
}

export interface AutomationDeps {
  db: Db;
  sessions: AutomationSessions;
  broadcast: (msg: SessionBroadcast) => void;
  push: (msg: PushMessage) => void;
  log: (msg: string) => void;
}

/** A run waiting for its Session's turn to settle. */
interface TrackedRun {
  runId: string;
  automationId: string;
  stopAfter: boolean;
  timer: NodeJS.Timeout;
}

/**
 * What a PR-triggered run knows about its PR: the placeholders of prompts and the columns of the run
 * row. Filled in by the followed-PR side (`onPrEvent`); empty for schedules and "Run now".
 */
export interface PrRunContext extends RunContext {
  pr?: { number: number; title: string; url: string; repo: string; headSha: string; headRef: string; baseRef: string; author: string };
  eventLabel?: string;
  /** Session(s) the PR is attached to, for `prompt` with `sessionId: "attached"`. */
  attachedSessionIds?: string[];
}

/**
 * A different action per stage: the automation engine calls these for the actions it does not run
 * itself (`auto_review`, `auto_qa`, `attach`); each returns what the run row should record, or throws.
 */
export interface ActionRunner {
  /** Starts the action's Session and returns it with what to track; `done` = over already; `null` = nothing to track, the run is over. */
  start(
    automation: Automation,
    run: AutomationRun,
    ctx: PrRunContext,
  ): Promise<{ sessionId: string; stopAfter: boolean; detail: string } | { skipped: string } | { done: string; sessionId?: string } | null>;
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

/** `{pr.number}`, `{pr.title}`, `{pr.url}`, `{pr.repo}`, `{pr.headSha}`, `{pr.headRef}`, `{pr.baseRef}`, `{pr.author}`, `{event}`. */
export function fillPlaceholders(text: string, ctx: PrRunContext): string {
  const pr = ctx.pr;
  return text.replace(/\{(pr\.(?:number|title|url|repo|headSha|headRef|baseRef|author)|event)\}/g, (whole, key: string) => {
    if (key === "event") return ctx.eventLabel ?? whole;
    if (!pr) return whole;
    const field = key.slice(3) as keyof NonNullable<PrRunContext["pr"]>;
    return String(pr[field]);
  });
}

// --- Scheduled tasks as the wire format of the aliases (ADR-0047 → ADR-0063) ----------------------

/** The automation as `/api/schedules*` shows it; `null` when its trigger is not a schedule. */
export function scheduleOf(a: Automation): Schedule | null {
  if (a.trigger.type !== "schedule") return null;
  if (a.action.type !== "prompt" && a.action.type !== "new_session") return null;
  if (a.action.type === "prompt" && a.action.sessionId === "attached") return null;
  const action = a.action.type === "prompt" ? { type: "prompt" as const, sessionId: a.action.sessionId, text: a.action.text } : legacyNewSession(a.action);
  return {
    id: a.id,
    name: a.name,
    cron: a.trigger.cron,
    timezone: a.trigger.timezone,
    enabled: a.enabled,
    missedPolicy: a.trigger.missedRun,
    action,
    nextRunAt: a.nextRunAt,
    lastRunAt: a.lastRunAt,
    lastStatus: a.lastStatus === "queued" ? "running" : a.lastStatus,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function legacyNewSession(action: Extract<AutomationAction, { type: "new_session" }>): Schedule["action"] {
  return {
    type: "new_session",
    ...(action.title !== undefined ? { title: action.title } : {}),
    provider: action.provider,
    repos: action.repos,
    settings: action.settings,
    prompt: action.prompt,
    stopAfter: action.stopAfter,
  };
}

export function scheduleRunOf(r: AutomationRun): ScheduleRun {
  return {
    id: r.id,
    scheduleId: r.automationId,
    trigger: r.trigger === "pr_event" ? "manual" : r.trigger,
    status: r.status === "queued" ? "running" : r.status,
    startedAt: r.startedAt ?? r.queuedAt,
    finishedAt: r.finishedAt,
    detail: r.detail,
    error: r.error,
    sessionId: r.sessionId,
  };
}

export function automationOfSchedule(req: CreateScheduleRequest): CreateAutomationRequest {
  return {
    name: req.name,
    enabled: req.enabled,
    trigger: { type: "schedule", cron: req.cron, timezone: req.timezone, missedRun: req.missedPolicy },
    action: req.action.type === "prompt" ? req.action : { ...req.action, checkoutPrHead: true },
    limits: { maxConcurrent: 2, maxRunsPerDay: 20, maxRunsPerPrPerDay: 4, debounceSeconds: 120, timeoutMinutes: 360 },
  };
}

/**
 * Automations (ADR-0063): a trigger, an action and limits in SQLite, run by the Control Plane. The
 * schedule triggers are ticked here every 30 s and claimed with a compare-and-set on `next_run_at`,
 * so a slow tick and the next cannot run one twice (ADR-0047). PR-event triggers arrive through
 * `onPrEvent` from the followed-PR poller. A run is over when the Session's turn settles
 * (`onTurnSettled`), fails when the Session errors, is deleted, or is stopped under it.
 */
export class Automations {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly tracked = new Map<string, TrackedRun[]>();
  private readonly unsubscribe: Array<() => void> = [];
  /** Runners for the actions later stages add; an action without one fails its run with a clear message. */
  readonly runners = new Map<AutomationAction["type"], ActionRunner>();

  constructor(private readonly deps: AutomationDeps) {}

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

  /** Runs still "running" or "queued" from before a restart cannot be followed any more. */
  private closeStale(): void {
    for (const run of this.deps.db.automations.listActiveRuns()) {
      this.deps.db.automations.updateRun(run.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: "The Control Plane restarted while the run was in progress.",
      });
    }
  }

  list(): Automation[] {
    return this.deps.db.automations.list();
  }

  get(id: string): Automation {
    const a = this.deps.db.automations.get(id);
    if (!a) throw new HttpError(404, `automation ${id} not found`);
    return a;
  }

  listRuns(id: string): AutomationRun[] {
    this.get(id);
    return this.deps.db.automations.listRuns(id);
  }

  getRun(runId: string): AutomationRun | null {
    return this.deps.db.automations.getRun(runId);
  }

  preview(cron: string, timezone: string): SchedulePreview {
    try {
      const job = parseCron(cron, timezone);
      return { ok: true, next: job.nextRuns(SCHEDULE_PREVIEW_COUNT).map((d) => d.toISOString()) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  create(req: CreateAutomationRequest): Automation {
    const trigger = this.validateTrigger(req.trigger);
    this.validateAction(req.action, req.trigger);
    const automation = this.deps.db.automations.insert({
      name: req.name.trim(),
      enabled: req.enabled,
      trigger,
      action: req.action,
      limits: req.limits,
      nextRunAt: trigger.type === "schedule" && req.enabled ? nextAfter(parseCron(trigger.cron, trigger.timezone), new Date()) : null,
    });
    this.rememberRepos(req.action);
    this.broadcastList();
    return automation;
  }

  update(id: string, req: UpdateAutomationRequest): Automation {
    const current = this.get(id);
    const trigger = req.trigger ? this.validateTrigger(req.trigger) : current.trigger;
    const enabled = req.enabled ?? current.enabled;
    const action = req.action ?? current.action;
    if (req.action || req.trigger) this.validateAction(action, trigger);
    const timingChanged = JSON.stringify(trigger) !== JSON.stringify(current.trigger) || enabled !== current.enabled;
    const nextRunAt = !timingChanged ? current.nextRunAt : trigger.type === "schedule" && enabled ? nextAfter(parseCron(trigger.cron, trigger.timezone), new Date()) : null;
    const next = this.deps.db.automations.update(id, {
      name: req.name?.trim() ?? current.name,
      enabled,
      trigger,
      action,
      limits: req.limits ?? current.limits,
      nextRunAt,
    });
    if (!next) throw new HttpError(404, `automation ${id} not found`);
    if (req.action) this.rememberRepos(req.action);
    this.broadcastList();
    return next;
  }

  /** The repositories a New Session action names go to the suggestions list (ADR-0068). */
  private rememberRepos(action: AutomationAction): void {
    if (action.type !== "new_session") return;
    for (const r of action.repos) {
      if (r.source.type === "git") this.deps.db.repos.remember({ kind: "git", location: r.source.url, by: "automation" });
      else if (r.source.type === "copy") this.deps.db.repos.remember({ kind: "copy", location: r.source.path, by: "automation" });
    }
  }

  delete(id: string): void {
    if (!this.deps.db.automations.delete(id)) throw new HttpError(404, `automation ${id} not found`);
    for (const [sessionId, runs] of this.tracked) {
      const kept = runs.filter((t) => {
        if (t.automationId !== id) return true;
        clearTimeout(t.timer);
        return false;
      });
      if (kept.length === 0) this.tracked.delete(sessionId);
      else this.tracked.set(sessionId, kept);
    }
    this.broadcastList();
  }

  /** "Run now": one run regardless of the trigger or the enabled switch. */
  async runNow(id: string): Promise<AutomationRun> {
    const automation = this.get(id);
    if (automation.trigger.type === "pr_event" && needsPr(automation.action)) {
      throw new HttpError(400, `"${automation.name}" reacts to pull request events; run it from a PR on the Pull requests page.`);
    }
    return this.execute(automation, "manual", {});
  }

  /**
   * A PR event matched this automation (the followed-PR side did the matching, dedupe and caps):
   * runs it with the PR as context. Returns the run.
   */
  async runForPr(automation: Automation, ctx: PrRunContext & { event: NonNullable<RunContext["event"]> }): Promise<AutomationRun> {
    return this.execute(automation, "pr_event", ctx);
  }

  /** Records a run that did not happen and says why (a cap, a filter, an earlier run at this head). */
  recordSkipped(automation: Automation, trigger: AutomationRunTrigger, reason: string, ctx: RunContext = {}): AutomationRun {
    const run = this.deps.db.automations.insertRun(automation.id, trigger, "running", ctx);
    const next = this.deps.db.automations.updateRun(run.id, { status: "skipped", finishedAt: new Date().toISOString(), detail: reason }) ?? run;
    this.broadcastList();
    this.broadcastRuns(automation.id);
    return next;
  }

  /** How many Sessions this automation has running (tracked runs). */
  runningCount(automationId: string): number {
    let n = 0;
    for (const runs of this.tracked.values()) for (const t of runs) if (t.automationId === automationId) n += 1;
    return n;
  }

  // --- Scheduled tasks aliases (`/api/schedules*`, `schedule_*`) ------------------------------------

  listSchedules(): Schedule[] {
    return this.list().map(scheduleOf).filter((s): s is Schedule => s !== null);
  }

  getSchedule(id: string): Schedule {
    const s = scheduleOf(this.get(id));
    if (!s) throw new HttpError(404, `schedule ${id} not found (it is an automation without a schedule trigger)`);
    return s;
  }

  createSchedule(req: CreateScheduleRequest): Schedule {
    return scheduleOf(this.create(automationOfSchedule(req)))!;
  }

  updateSchedule(id: string, req: UpdateScheduleRequest): Schedule {
    const current = this.getSchedule(id);
    const merged: CreateScheduleRequest = {
      name: req.name ?? current.name,
      cron: req.cron ?? current.cron,
      timezone: req.timezone ?? current.timezone,
      enabled: req.enabled ?? current.enabled,
      missedPolicy: req.missedPolicy ?? current.missedPolicy,
      action: req.action ?? current.action,
    };
    const next = automationOfSchedule(merged);
    return scheduleOf(this.update(id, { name: next.name, enabled: next.enabled, trigger: next.trigger, action: next.action }))!;
  }

  listScheduleRuns(id: string): ScheduleRun[] {
    this.getSchedule(id);
    return this.listRuns(id).map(scheduleRunOf);
  }

  // --- Internals ---------------------------------------------------------------------------------

  private validateTrigger(trigger: CreateAutomationRequest["trigger"]): Automation["trigger"] {
    if (trigger.type === "schedule") {
      parseCron(trigger.cron, trigger.timezone);
      return { ...trigger, cron: trigger.cron.trim() };
    }
    if (trigger.type === "pr_event") {
      for (const id of trigger.follows) {
        if (!this.followExists(id)) throw new HttpError(400, `Follow ${id} does not exist.`);
      }
      if (trigger.filters.titleMatch !== undefined) {
        try {
          new RegExp(trigger.filters.titleMatch);
        } catch (e) {
          throw new HttpError(400, `Cannot read the title pattern: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return trigger;
  }

  private validateAction(action: AutomationAction, trigger: Automation["trigger"]): void {
    if (action.type === "prompt") {
      if (action.sessionId === "attached") {
        if (trigger.type !== "pr_event") throw new HttpError(400, `"The Session the PR is attached to" only works with a pull request trigger.`);
      } else if (!this.deps.db.getSession(action.sessionId)) {
        throw new HttpError(400, `Session ${action.sessionId} does not exist.`);
      }
    }
    if (needsPr(action) && trigger.type !== "pr_event") {
      throw new HttpError(400, `The "${action.type.replace("_", " ")}" action needs a pull request trigger.`);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();
      let changed = false;
      for (const automation of this.deps.db.automations.list()) {
        if (!automation.enabled || automation.trigger.type !== "schedule") continue;
        const trigger = automation.trigger;
        let job: Cron;
        try {
          job = parseCron(trigger.cron, trigger.timezone);
        } catch (e) {
          this.deps.log(`automation ${automation.id} (${automation.name}) unreadable: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (!automation.nextRunAt) {
          this.deps.db.automations.update(automation.id, { nextRunAt: nextAfter(job, now) });
          changed = true;
          continue;
        }
        const due = new Date(automation.nextRunAt);
        if (due.getTime() > now.getTime()) continue;
        const next = nextAfter(job, now);
        if (!this.deps.db.automations.claimDue(automation.id, automation.nextRunAt, next)) continue;
        changed = true;
        if (now.getTime() - due.getTime() > MISSED_GRACE_MS) {
          const missed = this.countOccurrences(job, due, now);
          if (trigger.missedRun === "skip") {
            this.recordSkipped(automation, "cron", `Skipped: ${missedSummary(due, missed, trigger.timezone)} while the Control Plane was not running.`);
            this.deps.log(`automation ${automation.id} (${automation.name}) skipped ${missed} missed run(s)`);
          } else {
            void this.execute(automation, "catch_up", {}, `Catching up: ${missedSummary(due, missed, trigger.timezone)}.`);
          }
        } else {
          void this.execute(automation, "cron", {});
        }
      }
      if (changed) this.broadcastList();
    } catch (e) {
      this.deps.log(`automations tick failed: ${e instanceof Error ? e.message : String(e)}`);
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

  private async execute(automation: Automation, trigger: AutomationRunTrigger, ctx: PrRunContext, note?: string): Promise<AutomationRun> {
    const run = this.deps.db.automations.insertRun(automation.id, trigger, "running", ctx);
    this.deps.log(`automation ${automation.id} (${automation.name}) run ${run.id} started (${trigger})`);
    this.broadcastList();
    this.broadcastRuns(automation.id);
    const timeoutMs = automation.limits.timeoutMinutes * 60_000;
    try {
      const action = automation.action;
      if (action.type === "prompt") {
        const targets = action.sessionId === "attached" ? (ctx.attachedSessionIds ?? []) : [action.sessionId];
        if (targets.length === 0) return this.finish(run.id, "skipped", { detail: join(note, "The PR is not attached to any Session.") });
        const text = fillPlaceholders(action.text, ctx);
        const hows = await Promise.all(targets.map((id) => this.deps.sessions.promptScheduled(id, text)));
        const how = hows.includes("queued") ? "queued" : hows.includes("resumed") ? "resumed" : "sent";
        const detail =
          how === "queued"
            ? "Queued behind the running turn; sent when it ends."
            : how === "resumed"
              ? "Sandbox resumed; the prompt goes out once the Daemon is up."
              : "Prompt sent.";
        this.deps.db.automations.updateRun(run.id, { detail: join(note, detail), sessionId: targets[0]!, result: { type: "prompt", how } });
        this.broadcastRuns(automation.id);
        for (const id of targets) this.track(id, run.id, automation.id, false, timeoutMs);
        return this.deps.db.automations.getRun(run.id) ?? run;
      }
      if (action.type === "notify") {
        const text = fillPlaceholders(action.text?.trim() || `{event}`, ctx);
        const body = ctx.pr ? `${ctx.pr.repo}#${ctx.pr.number} ${ctx.pr.title}: ${text}` : text === "{event}" ? "Run now" : text;
        this.deps.push({ title: automation.name, body, tag: `sessionboxer-automation-${automation.id}`, url: ctx.pr ? ctx.pr.url : automationRoute(automation.id) });
        return this.finish(run.id, "succeeded", { detail: join(note, "Notified."), result: { type: "notify" } });
      }
      if (action.type === "new_session") {
        const repos = ctx.pr && action.checkoutPrHead ? await this.prHeadRepos(action, ctx) : action.repos;
        const session = await this.deps.sessions.create({
          title: action.title ? fillPlaceholders(action.title, ctx) : undefined,
          provider: action.provider,
          repos,
          workspaceSource: { type: "empty" },
          settings: action.settings,
          prompt: fillPlaceholders(action.prompt, ctx),
        });
        this.deps.db.automations.updateRun(run.id, { detail: join(note, `Session "${session.title}" started.`), sessionId: session.id });
        this.broadcastRuns(automation.id);
        this.track(session.id, run.id, automation.id, action.stopAfter, timeoutMs);
        return this.deps.db.automations.getRun(run.id) ?? run;
      }
      const runner = this.runners.get(action.type);
      if (!runner) throw new Error(`The "${action.type.replace("_", " ")}" action is not available on this Control Plane.`);
      const started = await runner.start(automation, run, ctx);
      if (started === null) return this.finish(run.id, "succeeded", { detail: note ?? null });
      if ("skipped" in started) return this.finish(run.id, "skipped", { detail: join(note, started.skipped) });
      if ("done" in started) return this.finish(run.id, "succeeded", { detail: join(note, started.done), ...(started.sessionId ? { sessionId: started.sessionId } : {}) });
      this.deps.db.automations.updateRun(run.id, { detail: join(note, started.detail), sessionId: started.sessionId });
      this.broadcastRuns(automation.id);
      this.track(started.sessionId, run.id, automation.id, started.stopAfter, timeoutMs);
      return this.deps.db.automations.getRun(run.id) ?? run;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.finish(run.id, "failed", { detail: note ?? null, error: message });
    }
  }

  /** The PR's base repository at its head as the first repo; the template's repos follow. */
  private async prHeadRepos(action: Extract<AutomationAction, { type: "new_session" }>, ctx: PrRunContext): Promise<RepoSpec[]> {
    const pr = ctx.pr!;
    const head = await this.prHeadRepo(pr.repo, pr.number, ctx.followedPrId);
    return [head, ...action.repos];
  }

  /** Set by the followed-PR side: whether a `pr_follows` row exists. */
  followExists: (id: string) => boolean = () => false;

  /** Set by the followed-PR side: how to clone `owner/repo` at `pull/{n}/head` (provider- and account-aware). */
  prHeadRepo: (repo: string, number: number, followedPrId: string | undefined) => Promise<RepoSpec> = async (repo) => {
    throw new Error(`Cannot check out the head of a PR of ${repo}: followed pull requests are not available.`);
  };

  private track(sessionId: string, runId: string, automationId: string, stopAfter: boolean, timeoutMs: number): void {
    const timer = setTimeout(() => {
      this.untrack(sessionId, runId);
      this.finish(runId, "failed", { error: `The turn did not end within ${Math.round(timeoutMs / 60_000)} minutes.` });
      if (stopAfter) void this.deps.sessions.stop(sessionId).catch(() => undefined);
    }, timeoutMs);
    timer.unref();
    const runs = this.tracked.get(sessionId) ?? [];
    runs.push({ runId, automationId, stopAfter, timer });
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

  /** Set by the action runners: what a settled run's Session produced (a review, a QA result), before the row is closed. */
  readonly settledHooks = new Map<string, (runId: string, sessionId: string, outcome: TurnOutcome) => Promise<{ status?: "succeeded" | "failed"; detail?: string; error?: string; result?: AutomationRunResult } | null>>();

  private async onSettled(sessionId: string, outcome: TurnOutcome): Promise<void> {
    const runs = this.takeAll(sessionId);
    if (runs.length === 0) return;
    let stopAfter = false;
    for (const t of runs) {
      stopAfter ||= t.stopAfter;
      const automation = this.deps.db.automations.get(t.automationId);
      const hook = automation ? this.settledHooks.get(automation.action.type) : undefined;
      let extra: Awaited<ReturnType<NonNullable<typeof hook>>> = null;
      if (hook) {
        try {
          extra = await hook(t.runId, sessionId, outcome);
        } catch (e) {
          extra = { status: "failed", error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (extra?.status) this.finish(t.runId, extra.status, { detail: extra.detail ?? undefined, error: extra.error, result: extra.result });
      else if (outcome === "end_turn") this.finish(t.runId, "succeeded", { detail: extra?.detail, result: extra?.result });
      else if (outcome === "usage_limit") this.finish(t.runId, "failed", { error: "The Provider's usage limit was hit; the Session offers Continue / Auto-continue." });
      else this.finish(t.runId, "failed", { error: outcome === "error" ? "The Agent reported an error." : `The turn ended with "${outcome}".` });
    }
    if (!stopAfter) return;
    try {
      await this.deps.sessions.stop(sessionId);
      for (const t of runs) this.appendDetail(t.runId, "Sandbox stopped afterwards.");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log(`automation stop-after ${sessionId} failed: ${message}`);
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

  private finish(
    runId: string,
    status: "succeeded" | "failed" | "skipped",
    patch: { detail?: string | null; error?: string; sessionId?: string; result?: AutomationRunResult },
  ): AutomationRun {
    const current = this.deps.db.automations.getRun(runId);
    const next = this.deps.db.automations.updateRun(runId, {
      status,
      finishedAt: new Date().toISOString(),
      ...(patch.detail !== undefined ? { detail: patch.detail === null ? null : join(current?.detail ?? undefined, patch.detail) } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
    });
    if (!next || !current) throw new HttpError(404, `run ${runId} not found`);
    this.deps.log(`automation ${next.automationId} run ${runId} ${status}${next.error ? `: ${next.error}` : ""}`);
    this.broadcastList();
    this.broadcastRuns(next.automationId);
    if (status === "failed") {
      const automation = this.deps.db.automations.get(next.automationId);
      this.deps.push({
        title: `Automation failed: ${automation?.name ?? next.automationId}`,
        body: next.error ?? "unknown error",
        tag: `sessionboxer-automation-${next.automationId}`,
        url: automation ? automationRoute(automation.id) : AUTOMATIONS_ROUTE,
      });
    }
    return next;
  }

  /** Lets a runner add a line to a run's detail and a result while the Session is still working. */
  noteRun(runId: string, line: string, result?: AutomationRunResult): void {
    const run = this.deps.db.automations.getRun(runId);
    if (!run) return;
    this.deps.db.automations.updateRun(runId, { detail: join(run.detail ?? undefined, line), ...(result ? { result } : {}) });
    this.broadcastRuns(run.automationId);
  }

  private appendDetail(runId: string, line: string): void {
    this.noteRun(runId, line);
  }

  private broadcastList(): void {
    this.deps.broadcast({ type: "automations", automations: this.deps.db.automations.list() });
  }

  broadcastRuns(automationId: string): void {
    this.deps.broadcast({ type: "automation_runs", automationId, runs: this.deps.db.automations.listRuns(automationId) });
  }
}

/** Actions that only make sense with a PR in hand. */
export function needsPr(action: AutomationAction): boolean {
  return action.type === "auto_review" || action.type === "auto_qa" || action.type === "attach" || (action.type === "prompt" && action.sessionId === "attached");
}

function join(a: string | undefined, b: string): string {
  return a ? `${a} ${b}` : b;
}

function missedSummary(due: Date, missed: number, timezone: string): string {
  const when = due.toLocaleString("en-GB", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
  const first = `the run due ${when} (${timezone})`;
  return missed > 1 ? `${first} and ${missed - 1} more` : first;
}

export type { ScheduleTrigger };
