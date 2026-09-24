import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import {
  SCHEDULE_RUNS_KEPT,
  ScheduleAction,
  ScheduleMissedPolicy,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  type Schedule,
  type ScheduleRun,
} from "@sessionboxer/protocol";

const SCHEDULE_SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  missed_policy TEXT NOT NULL DEFAULT 'skip',
  action TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  detail TEXT,
  error TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs (schedule_id, started_at);
`;

interface ScheduleRow {
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

interface RunRow {
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

function rowToSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    name: r.name,
    cron: r.cron,
    timezone: r.timezone,
    enabled: r.enabled === 1,
    missedPolicy: ScheduleMissedPolicy.parse(r.missed_policy),
    action: ScheduleAction.parse(JSON.parse(r.action)),
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status === null ? null : ScheduleRunStatus.parse(r.last_status),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRun(r: RunRow): ScheduleRun {
  return {
    id: r.id,
    scheduleId: r.schedule_id,
    trigger: ScheduleRunTrigger.parse(r.trigger),
    status: ScheduleRunStatus.parse(r.status),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    detail: r.detail,
    error: r.error,
    sessionId: r.session_id,
  };
}

export type SchedulePatch = Partial<Pick<Schedule, "name" | "cron" | "timezone" | "enabled" | "missedPolicy" | "action" | "nextRunAt">>;

export class ScheduleStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(SCHEDULE_SCHEMA);
  }

  list(): Schedule[] {
    const rows = this.db.prepare("SELECT * FROM schedules ORDER BY created_at ASC").all() as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  get(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  insert(input: Omit<Schedule, "id" | "lastRunAt" | "lastStatus" | "createdAt" | "updatedAt">): Schedule {
    const now = new Date().toISOString();
    const schedule: Schedule = { ...input, id: randomBytes(6).toString("hex"), lastRunAt: null, lastStatus: null, createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO schedules (id, name, cron, timezone, enabled, missed_policy, action, next_run_at, last_run_at, last_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        schedule.id,
        schedule.name,
        schedule.cron,
        schedule.timezone,
        schedule.enabled ? 1 : 0,
        schedule.missedPolicy,
        JSON.stringify(schedule.action),
        schedule.nextRunAt,
        now,
        now,
      );
    return schedule;
  }

  update(id: string, patch: SchedulePatch): Schedule | null {
    const current = this.get(id);
    if (!current) return null;
    const next: Schedule = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE schedules SET name = ?, cron = ?, timezone = ?, enabled = ?, missed_policy = ?, action = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.name, next.cron, next.timezone, next.enabled ? 1 : 0, next.missedPolicy, JSON.stringify(next.action), next.nextRunAt, next.updatedAt, id);
    return next;
  }

  /**
   * Claims a due tick: moves `next_run_at` forward only if it still holds the value the caller saw,
   * so two overlapping ticks cannot both run the same occurrence.
   */
  claimDue(id: string, seenNextRunAt: string, nextRunAt: string | null): boolean {
    const res = this.db
      .prepare("UPDATE schedules SET next_run_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?")
      .run(nextRunAt, id, seenNextRunAt);
    return res.changes === 1;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes === 1;
  }

  listRuns(scheduleId: string): ScheduleRun[] {
    const rows = this.db
      .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?")
      .all(scheduleId, SCHEDULE_RUNS_KEPT) as RunRow[];
    return rows.map(rowToRun);
  }

  getRun(id: string): ScheduleRun | null {
    const row = this.db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listActiveRuns(): ScheduleRun[] {
    const rows = this.db.prepare("SELECT * FROM schedule_runs WHERE status = 'running'").all() as RunRow[];
    return rows.map(rowToRun);
  }

  insertRun(scheduleId: string, trigger: ScheduleRun["trigger"]): ScheduleRun {
    const run: ScheduleRun = {
      id: randomBytes(6).toString("hex"),
      scheduleId,
      trigger,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      detail: null,
      error: null,
      sessionId: null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO schedule_runs (id, schedule_id, trigger, status, started_at, finished_at, detail, error, session_id)
           VALUES (?, ?, ?, 'running', ?, NULL, NULL, NULL, NULL)`,
        )
        .run(run.id, scheduleId, trigger, run.startedAt);
      this.db.prepare("UPDATE schedules SET last_run_at = ?, last_status = 'running' WHERE id = ?").run(run.startedAt, scheduleId);
      this.db
        .prepare(
          `DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN (
             SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`,
        )
        .run(scheduleId, scheduleId, SCHEDULE_RUNS_KEPT);
    })();
    return run;
  }

  updateRun(id: string, patch: Partial<Pick<ScheduleRun, "status" | "finishedAt" | "detail" | "error" | "sessionId">>): ScheduleRun | null {
    const current = this.getRun(id);
    if (!current) return null;
    const next: ScheduleRun = { ...current, ...patch };
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE schedule_runs SET status = ?, finished_at = ?, detail = ?, error = ?, session_id = ? WHERE id = ?")
        .run(next.status, next.finishedAt, next.detail, next.error, next.sessionId, id);
      if (next.status !== current.status) {
        this.db
          .prepare("UPDATE schedules SET last_status = ? WHERE id = ? AND last_run_at = ?")
          .run(next.status, next.scheduleId, next.startedAt);
      }
    })();
    return next;
  }
}
