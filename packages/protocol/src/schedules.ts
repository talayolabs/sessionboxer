// ---------------------------------------------------------------------------
// Scheduled tasks (ADR-0047): cron expressions kept in SQLite, ticked by the Control Plane.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { Provider } from "./common.js";
import { RepoSpec } from "./repositories.js";
import { SessionSettingsInput } from "./session-settings.js";

export const SCHEDULE_NAME_MAX_CHARS = 200;
export const SCHEDULE_PROMPT_MAX_CHARS = 20_000;
/** How many runs a schedule keeps in its history. */
export const SCHEDULE_RUNS_KEPT = 100;
/** How many upcoming times a preview lists. */
export const SCHEDULE_PREVIEW_COUNT = 3;

/** What to do with runs that fell due while the Control Plane was not running. */
export const ScheduleMissedPolicy = z.enum(["skip", "catch_up"]);
export type ScheduleMissedPolicy = z.infer<typeof ScheduleMissedPolicy>;

export const SCHEDULE_MISSED_POLICY_LABELS: Record<ScheduleMissedPolicy, string> = {
  skip: "Skip them",
  catch_up: "Run once when the Control Plane is back",
};

export const ScheduleAction = z.discriminatedUnion("type", [
  /** Sends a prompt to an existing Session (resumed if stopped, queued if busy). */
  z.object({
    type: z.literal("prompt"),
    sessionId: z.string().min(1),
    text: z.string().min(1).max(SCHEDULE_PROMPT_MAX_CHARS),
  }),
  /** Starts a new Session from a template and sends it a first prompt. */
  z.object({
    type: z.literal("new_session"),
    title: z.string().min(1).max(200).optional(),
    provider: Provider,
    repos: z.array(RepoSpec).max(50).default([]),
    settings: SessionSettingsInput.default({}),
    prompt: z.string().min(1).max(SCHEDULE_PROMPT_MAX_CHARS),
    /** Stop the Sandbox once the turn (and its verification) has ended, so Sessions do not pile up. */
    stopAfter: z.boolean().default(true),
  }),
]);
export type ScheduleAction = z.infer<typeof ScheduleAction>;

export const ScheduleRunStatus = z.enum(["running", "succeeded", "failed", "skipped"]);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatus>;

export const ScheduleRunTrigger = z.enum(["cron", "manual", "catch_up"]);
export type ScheduleRunTrigger = z.infer<typeof ScheduleRunTrigger>;

export const ScheduleRun = z.object({
  id: z.string(),
  scheduleId: z.string(),
  trigger: ScheduleRunTrigger,
  status: ScheduleRunStatus,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** What happened, in a line: "queued behind the running turn", "Sandbox stopped afterwards"… */
  detail: z.string().nullable(),
  error: z.string().nullable(),
  /** The Session the run prompted or created. */
  sessionId: z.string().nullable(),
});
export type ScheduleRun = z.infer<typeof ScheduleRun>;

export const Schedule = z.object({
  id: z.string(),
  name: z.string(),
  /** Standard 5-field cron expression (`@hourly`-style nicknames accepted). */
  cron: z.string(),
  /** IANA time zone the expression is read in. */
  timezone: z.string(),
  enabled: z.boolean(),
  missedPolicy: ScheduleMissedPolicy,
  action: ScheduleAction,
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastStatus: ScheduleRunStatus.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Schedule = z.infer<typeof Schedule>;

export const CreateScheduleRequest = z.object({
  name: z.string().min(1).max(SCHEDULE_NAME_MAX_CHARS),
  cron: z.string().min(1).max(200),
  timezone: z.string().min(1).max(100),
  enabled: z.boolean().default(true),
  missedPolicy: ScheduleMissedPolicy.default("skip"),
  action: ScheduleAction,
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequest>;

export const UpdateScheduleRequest = CreateScheduleRequest.partial();
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequest>;

export const SchedulePreviewRequest = z.object({
  cron: z.string().min(1).max(200),
  timezone: z.string().min(1).max(100),
});
export type SchedulePreviewRequest = z.infer<typeof SchedulePreviewRequest>;

/** The next few times an expression fires, or why it cannot be read. */
export const SchedulePreview = z.union([
  z.object({ ok: z.literal(true), next: z.array(z.string()) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type SchedulePreview = z.infer<typeof SchedulePreview>;

/** Where a notification about a scheduled task landed before Automations; redirects to `AUTOMATIONS_ROUTE`. */
export const SCHEDULES_ROUTE = "#/schedules";
