import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AUTOMATION_RUNS_KEPT,
  AutomationAction,
  AutomationLimits,
  AutomationRunResult,
  AutomationRunStatus,
  AutomationRunTrigger,
  AutomationTrigger,
  PrEventType,
  type Automation,
  type AutomationRun,
} from "@sessionboxer/protocol";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  limits TEXT NOT NULL DEFAULT '{}',
  next_run_at TEXT,
  last_run_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  event_id TEXT,
  event_type TEXT,
  head_sha TEXT,
  followed_pr_id TEXT,
  pr_url TEXT,
  pr_title TEXT,
  session_id TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  detail TEXT,
  error TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS automation_runs_automation ON automation_runs (automation_id, queued_at);
CREATE INDEX IF NOT EXISTS automation_runs_pr ON automation_runs (followed_pr_id, queued_at);
CREATE TABLE IF NOT EXISTS automation_pr_state (
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  followed_pr_id TEXT NOT NULL,
  last_reviewed_sha TEXT,
  last_run_id TEXT,
  last_url TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (automation_id, followed_pr_id)
);
`;

/** What an automation last did to one PR (the delta of the next review starts here). */
export interface AutomationPrState {
  automationId: string;
  followedPrId: string;
  lastReviewedSha: string | null;
  lastRunId: string | null;
  lastUrl: string | null;
  updatedAt: string;
}

interface AutomationRow {
  id: string;
  name: string;
  enabled: number;
  trigger: string;
  action: string;
  limits: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
  runs_today: number;
}

interface RunRow {
  id: string;
  automation_id: string;
  trigger: string;
  status: string;
  event_id: string | null;
  event_type: string | null;
  head_sha: string | null;
  followed_pr_id: string | null;
  pr_url: string | null;
  pr_title: string | null;
  session_id: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  detail: string | null;
  error: string | null;
  result: string | null;
}

/** Rows of the `schedules` / `schedule_runs` tables of a database from before ADR-0063. */
interface LegacyScheduleRow {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: number;
  missed_policy: string;
  action: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}
interface LegacyRunRow {
  id: string;
  schedule_id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  detail: string | null;
  error: string | null;
  session_id: string | null;
}

const DAY_MS = 24 * 60 * 60_000;
const SELECT = `SELECT a.*, (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.queued_at >= ?) AS runs_today FROM automations a`;

function rowToAutomation(r: AutomationRow): Automation {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    trigger: AutomationTrigger.parse(JSON.parse(r.trigger)),
    action: AutomationAction.parse(JSON.parse(r.action)),
    limits: AutomationLimits.parse(JSON.parse(r.limits)),
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status === null ? null : AutomationRunStatus.parse(r.last_status),
    runsToday: r.runs_today,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRun(r: RunRow): AutomationRun {
  return {
    id: r.id,
    automationId: r.automation_id,
    trigger: AutomationRunTrigger.parse(r.trigger),
    status: AutomationRunStatus.parse(r.status),
    event: r.event_id && r.event_type && r.head_sha !== null ? { id: r.event_id, type: PrEventType.parse(r.event_type), headSha: r.head_sha } : null,
    followedPrId: r.followed_pr_id,
    prUrl: r.pr_url,
    prTitle: r.pr_title,
    sessionId: r.session_id,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    detail: r.detail,
    error: r.error,
    result: r.result === null ? null : AutomationRunResult.parse(JSON.parse(r.result)),
  };
}

export type AutomationPatch = Partial<Pick<Automation, "name" | "enabled" | "trigger" | "action" | "limits" | "nextRunAt">>;
export type RunPatch = Partial<Pick<AutomationRun, "status" | "startedAt" | "finishedAt" | "detail" | "error" | "sessionId" | "result">>;

/** What a new run is about: the PR event that fired it, when there is one. */
export interface RunContext {
  event?: { id: string; type: PrEventType; headSha: string };
  followedPrId?: string;
  prUrl?: string;
  prTitle?: string;
}

export class AutomationStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(SCHEMA);
    this.migrateSchedules();
  }

  /**
   * A database from before ADR-0063 has `schedules` and `schedule_runs`: each schedule becomes an
   * automation with a `schedule` trigger (same id, same action JSON), each run a run with no PR
   * context; the old tables are dropped afterwards so this runs once.
   */
  private migrateSchedules(): void {
    const has = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedules'").get() as { name: string } | undefined;
    if (!has) return;
    this.db.transaction(() => {
      const schedules = this.db.prepare("SELECT * FROM schedules").all() as LegacyScheduleRow[];
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO automations (id, name, enabled, trigger, action, limits, next_run_at, last_run_at, last_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
      );
      for (const s of schedules) {
        const trigger = JSON.stringify({ type: "schedule", cron: s.cron, timezone: s.timezone, missedRun: s.missed_policy });
        insert.run(s.id, s.name, s.enabled, trigger, s.action, s.next_run_at, s.last_run_at, s.last_status, s.created_at, s.updated_at);
      }
      const hasRuns = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedule_runs'").get();
      if (hasRuns) {
        const runs = this.db.prepare("SELECT * FROM schedule_runs").all() as LegacyRunRow[];
        const insertRun = this.db.prepare(
          `INSERT OR IGNORE INTO automation_runs (id, automation_id, trigger, status, session_id, queued_at, started_at, finished_at, detail, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const r of runs) insertRun.run(r.id, r.schedule_id, r.trigger, r.status, r.session_id, r.started_at, r.started_at, r.finished_at, r.detail, r.error);
        this.db.exec("DROP TABLE schedule_runs");
      }
      this.db.exec("DROP TABLE schedules");
    })();
  }

  private since(): string {
    return new Date(Date.now() - DAY_MS).toISOString();
  }

  list(): Automation[] {
    const rows = this.db.prepare(`${SELECT} ORDER BY a.created_at ASC`).all(this.since()) as AutomationRow[];
    return rows.map(rowToAutomation);
  }

  get(id: string): Automation | null {
    const row = this.db.prepare(`${SELECT} WHERE a.id = ?`).get(this.since(), id) as AutomationRow | undefined;
    return row ? rowToAutomation(row) : null;
  }

  insert(input: Omit<Automation, "id" | "lastRunAt" | "lastStatus" | "runsToday" | "createdAt" | "updatedAt">): Automation {
    const now = new Date().toISOString();
    const automation: Automation = { ...input, id: randomBytes(6).toString("hex"), lastRunAt: null, lastStatus: null, runsToday: 0, createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO automations (id, name, enabled, trigger, action, limits, next_run_at, last_run_at, last_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        automation.id,
        automation.name,
        automation.enabled ? 1 : 0,
        JSON.stringify(automation.trigger),
        JSON.stringify(automation.action),
        JSON.stringify(automation.limits),
        automation.nextRunAt,
        now,
        now,
      );
    return automation;
  }

  update(id: string, patch: AutomationPatch): Automation | null {
    const current = this.get(id);
    if (!current) return null;
    const next: Automation = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(`UPDATE automations SET name = ?, enabled = ?, trigger = ?, action = ?, limits = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
      .run(next.name, next.enabled ? 1 : 0, JSON.stringify(next.trigger), JSON.stringify(next.action), JSON.stringify(next.limits), next.nextRunAt, next.updatedAt, id);
    return next;
  }

  /**
   * Claims a due tick: moves `next_run_at` forward only if it still holds the value the caller saw,
   * so two overlapping ticks cannot both run the same occurrence.
   */
  claimDue(id: string, seenNextRunAt: string, nextRunAt: string | null): boolean {
    const res = this.db
      .prepare("UPDATE automations SET next_run_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?")
      .run(nextRunAt, id, seenNextRunAt);
    return res.changes === 1;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM automations WHERE id = ?").run(id).changes === 1;
  }

  listRuns(automationId: string): AutomationRun[] {
    const rows = this.db
      .prepare("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT ?")
      .all(automationId, AUTOMATION_RUNS_KEPT) as RunRow[];
    return rows.map(rowToRun);
  }

  /** Every run about one followed PR, newest first (the PRs page's badges and history). */
  listRunsForPr(followedPrId: string): AutomationRun[] {
    const rows = this.db.prepare("SELECT * FROM automation_runs WHERE followed_pr_id = ? ORDER BY queued_at DESC, rowid DESC").all(followedPrId) as RunRow[];
    return rows.map(rowToRun);
  }

  getRun(id: string): AutomationRun | null {
    const row = this.db.prepare("SELECT * FROM automation_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  /** Runs that are `queued` or `running`. */
  listActiveRuns(automationId?: string): AutomationRun[] {
    const rows = (
      automationId
        ? this.db.prepare("SELECT * FROM automation_runs WHERE automation_id = ? AND status IN ('queued', 'running')").all(automationId)
        : this.db.prepare("SELECT * FROM automation_runs WHERE status IN ('queued', 'running')").all()
    ) as RunRow[];
    return rows.map(rowToRun);
  }

  /** The running run whose Session is `sessionId` (the review or QA Session asking to post), if any. */
  findRunningForSession(sessionId: string): AutomationRun | null {
    const row = this.db.prepare("SELECT * FROM automation_runs WHERE session_id = ? AND status = 'running' ORDER BY queued_at DESC LIMIT 1").get(sessionId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  getPrState(automationId: string, followedPrId: string): AutomationPrState | null {
    const row = this.db.prepare("SELECT * FROM automation_pr_state WHERE automation_id = ? AND followed_pr_id = ?").get(automationId, followedPrId) as
      | { automation_id: string; followed_pr_id: string; last_reviewed_sha: string | null; last_run_id: string | null; last_url: string | null; updated_at: string }
      | undefined;
    if (!row) return null;
    return { automationId: row.automation_id, followedPrId: row.followed_pr_id, lastReviewedSha: row.last_reviewed_sha, lastRunId: row.last_run_id, lastUrl: row.last_url, updatedAt: row.updated_at };
  }

  setPrState(automationId: string, followedPrId: string, state: { lastReviewedSha: string; lastRunId: string; lastUrl: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO automation_pr_state (automation_id, followed_pr_id, last_reviewed_sha, last_run_id, last_url, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (automation_id, followed_pr_id) DO UPDATE SET last_reviewed_sha = excluded.last_reviewed_sha, last_run_id = excluded.last_run_id, last_url = excluded.last_url, updated_at = excluded.updated_at`,
      )
      .run(automationId, followedPrId, state.lastReviewedSha, state.lastRunId, state.lastUrl, new Date().toISOString());
  }

  /** Runs of one automation about one PR in the last 24 hours (the per-PR daily cap). */
  countRunsForPrToday(automationId: string, followedPrId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ? AND followed_pr_id = ? AND queued_at >= ? AND status <> 'skipped'")
      .get(automationId, followedPrId, this.since()) as { n: number };
    return row.n;
  }

  /** Whether this automation already ran (or is running) for this event type at this head. */
  hasRunFor(automationId: string, followedPrId: string, eventType: PrEventType, headSha: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM automation_runs WHERE automation_id = ? AND followed_pr_id = ? AND event_type = ? AND head_sha = ? AND status <> 'skipped' LIMIT 1`,
      )
      .get(automationId, followedPrId, eventType, headSha);
    return row !== undefined;
  }

  insertRun(automationId: string, trigger: AutomationRun["trigger"], status: "queued" | "running", ctx: RunContext = {}): AutomationRun {
    const now = new Date().toISOString();
    const run: AutomationRun = {
      id: randomBytes(6).toString("hex"),
      automationId,
      trigger,
      status,
      event: ctx.event ?? null,
      followedPrId: ctx.followedPrId ?? null,
      prUrl: ctx.prUrl ?? null,
      prTitle: ctx.prTitle ?? null,
      sessionId: null,
      queuedAt: now,
      startedAt: status === "running" ? now : null,
      finishedAt: null,
      detail: null,
      error: null,
      result: null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO automation_runs (id, automation_id, trigger, status, event_id, event_type, head_sha, followed_pr_id, pr_url, pr_title, session_id, queued_at, started_at, finished_at, detail, error, result)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(
          run.id,
          automationId,
          trigger,
          status,
          run.event?.id ?? null,
          run.event?.type ?? null,
          run.event?.headSha ?? null,
          run.followedPrId,
          run.prUrl,
          run.prTitle,
          run.queuedAt,
          run.startedAt,
        );
      this.db.prepare("UPDATE automations SET last_run_at = ?, last_status = ? WHERE id = ?").run(now, status, automationId);
      this.db
        .prepare(
          `DELETE FROM automation_runs WHERE automation_id = ? AND status NOT IN ('queued', 'running') AND id NOT IN (
             SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT ?)`,
        )
        .run(automationId, automationId, AUTOMATION_RUNS_KEPT);
    })();
    return run;
  }

  updateRun(id: string, patch: RunPatch): AutomationRun | null {
    const current = this.getRun(id);
    if (!current) return null;
    const next: AutomationRun = { ...current, ...patch };
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE automation_runs SET status = ?, started_at = ?, finished_at = ?, detail = ?, error = ?, session_id = ?, result = ? WHERE id = ?")
        .run(next.status, next.startedAt, next.finishedAt, next.detail, next.error, next.sessionId, next.result === null ? null : JSON.stringify(next.result), id);
      if (next.status !== current.status) {
        this.db.prepare("UPDATE automations SET last_status = ? WHERE id = ? AND last_run_at = ?").run(next.status, next.automationId, current.queuedAt);
      }
    })();
    return next;
  }
}
