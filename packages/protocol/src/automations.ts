// ---------------------------------------------------------------------------
// Automations (ADR-0063): trigger + action + limits, run by the Control Plane. Scheduled tasks
// are automations with a `schedule` trigger; the `Schedule*` shapes above stay as the wire format
// of the `/api/schedules*` and `schedule_*` aliases.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { SCHEDULE_NAME_MAX_CHARS, ScheduleMissedPolicy, SCHEDULE_PROMPT_MAX_CHARS } from "./schedules.js";
import { Provider } from "./common.js";
import { RepoSpec } from "./repositories.js";
import { SessionSettingsInput } from "./session-settings.js";
import { INSTRUCTIONS_MAX_CHARS } from "./models.js";
import { McpRunEvent } from "./mcp-events.js";

export const AUTOMATION_NAME_MAX_CHARS = SCHEDULE_NAME_MAX_CHARS;
/** How many runs an automation keeps in its history. */
export const AUTOMATION_RUNS_KEPT = 500;

export const ScheduleTrigger = z.object({
  type: z.literal("schedule"),
  /** Standard 5-field cron expression (`@hourly`-style nicknames accepted). */
  cron: z.string().min(1).max(200),
  /** IANA time zone the expression is read in. */
  timezone: z.string().min(1).max(100),
  missedRun: ScheduleMissedPolicy.default("skip"),
});
export type ScheduleTrigger = z.infer<typeof ScheduleTrigger>;

/** Fires from "Run now" (or `POST /automations/:id/run`) only. */
export const ManualTrigger = z.object({ type: z.literal("manual") });
export type ManualTrigger = z.infer<typeof ManualTrigger>;

/** What the followed-PR poller can notice about a PR (ADR-0063 §2.3). */
export const PrEventType = z.enum([
  "opened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "review_requested",
  "review_submitted",
  "comment",
  "check_failed",
  "merged",
  "closed",
  "reopened",
]);
export type PrEventType = z.infer<typeof PrEventType>;

export const PR_EVENT_LABELS: Record<PrEventType, string> = {
  opened: "opened",
  synchronize: "new commits",
  ready_for_review: "ready for review",
  converted_to_draft: "converted to draft",
  review_requested: "review requested",
  review_submitted: "review submitted",
  comment: "comment",
  check_failed: "check failed",
  merged: "merged",
  closed: "closed",
  reopened: "reopened",
};

export const PrEventFilters = z.object({
  drafts: z.enum(["skip", "include"]).default("skip"),
  forks: z.enum(["skip", "review_only", "allow"]).default("review_only"),
  /** `not_self`: skip PRs a Session of this Control Plane opened under the follow's own login. */
  authors: z.enum(["any", "not_self", "self_only"]).default("not_self"),
  /** Also match events our own connector login caused (our review, our push). */
  includeOwn: z.boolean().default(false),
  /** Only PRs by one of these logins (case-insensitive, a leading `@` is fine); empty = any author. */
  authorLogins: z.array(z.string().min(1).max(100)).max(50).optional(),
  /**
   * Only PRs where one of these is asked to review: a login, or a GitHub team as `org/slug` (a bare
   * `slug` matches that team of any org). For `review_requested` the newly asked one must match.
   */
  reviewers: z.array(z.string().min(1).max(200)).max(50).optional(),
  /** Glob on the base branch, e.g. `main` or `release/*`. */
  baseRef: z.string().max(200).optional(),
  /** Regular expression the title must match, e.g. `^(?!WIP)`. */
  titleMatch: z.string().max(200).optional(),
  /** GitHub labels, any of which must be present. */
  labels: z.array(z.string().max(100)).max(20).optional(),
});
export type PrEventFilters = z.infer<typeof PrEventFilters>;

export const PrEventTrigger = z.object({
  type: z.literal("pr_event"),
  /** `pr_follows` ids; empty = every enabled follow. */
  follows: z.array(z.string()).max(50).default([]),
  events: z.array(PrEventType).min(1),
  filters: PrEventFilters.default({}),
});
export type PrEventTrigger = z.infer<typeof PrEventTrigger>;

/** Authors and requested reviewers (logins, teams as `org/slug`) seen on followed PRs: suggestions for the filters (`GET /api/prs/people`). */
export const PrPeople = z.object({ authors: z.array(z.string()), reviewers: z.array(z.string()) });
export type PrPeople = z.infer<typeof PrPeople>;

/**
 * An event of a registry MCP server (ADR-0081): `events/stream` when the event type offers push and
 * `delivery` allows it, `events/poll` otherwise. `arguments` are the subscription arguments the
 * server's `inputSchema` describes.
 */
export const McpEventTrigger = z.object({
  type: z.literal("mcp_event"),
  serverId: z.string().min(1),
  event: z.string().min(1).max(200),
  arguments: z.record(z.unknown()).default({}),
  delivery: z.enum(["auto", "push", "poll"]).default("auto"),
});
export type McpEventTrigger = z.infer<typeof McpEventTrigger>;

export const AutomationTrigger = z.discriminatedUnion("type", [ScheduleTrigger, PrEventTrigger, ManualTrigger, McpEventTrigger]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

/** Sends a prompt to an existing Session (resumed if stopped, queued if busy); `attached` = whichever Session the PR is attached to. */
export const PromptAction = z.object({
  type: z.literal("prompt"),
  sessionId: z.union([z.string().min(1), z.literal("attached")]),
  /** `{pr.number}`, `{pr.title}`, `{pr.url}`, `{pr.repo}`, `{pr.headSha}`, `{event}` are filled in for PR events. */
  text: z.string().min(1).max(SCHEDULE_PROMPT_MAX_CHARS),
});
export type PromptAction = z.infer<typeof PromptAction>;

/** Starts a new Session from a template and sends it a first prompt (placeholders as `PromptAction`). */
export const NewSessionAction = z.object({
  type: z.literal("new_session"),
  title: z.string().min(1).max(200).optional(),
  provider: Provider,
  repos: z.array(RepoSpec).max(50).default([]),
  /** Start from this Snapshot instead of a fresh Sandbox (ADR-0069); `repos` are then ignored and `checkoutPrHead` becomes a line in the prompt. */
  snapshotId: z.string().min(1).optional(),
  settings: SessionSettingsInput.default({}),
  prompt: z.string().min(1).max(SCHEDULE_PROMPT_MAX_CHARS),
  /** Stop the Sandbox once the turn (and its verification) has ended, so Sessions do not pile up. */
  stopAfter: z.boolean().default(true),
  /** PR events only: clone the PR's base repository at the PR head (`pull/{n}/head`) as the first repo. */
  checkoutPrHead: z.boolean().default(true),
});
export type NewSessionAction = z.infer<typeof NewSessionAction>;

export const ReviewVerdict = z.enum(["comment", "request_changes", "approve"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/** A Session on the PR head reviews it and hands the review to the Control Plane (`pr_review_submit`), which posts it. */
export const AutoReviewAction = z.object({
  type: z.literal("auto_review"),
  provider: Provider.optional(),
  model: z.string().max(200).optional(),
  /** Repository-specific guidance, appended to the review prompt. */
  instructions: z.string().max(INSTRUCTIONS_MAX_CHARS).optional(),
  /** The strongest verdict the Control Plane lets through. */
  maxVerdict: ReviewVerdict.default("comment"),
  /** On new commits, review only the diff since the last reviewed head. */
  deltaOnly: z.boolean().default(true),
  notifyOn: z.enum(["always", "findings", "never"]).default("findings"),
  stopAfter: z.boolean().default(true),
});
export type AutoReviewAction = z.infer<typeof AutoReviewAction>;

export const QaPublish = z.enum(["github_attachment", "link_only"]);
export type QaPublish = z.infer<typeof QaPublish>;

/** A Session on the PR head runs the `e2e-verification` flow against a brief built from the PR and posts the result with the video. */
export const AutoQaAction = z.object({
  type: z.literal("auto_qa"),
  provider: Provider.optional(),
  model: z.string().max(200).optional(),
  /** How to start the app, which account to use… appended to the brief. */
  instructions: z.string().max(INSTRUCTIONS_MAX_CHARS).optional(),
  publish: QaPublish.default("github_attachment"),
  /** Post a comment even when the run was skipped (nothing desktop-observable). */
  commentOnSkip: z.boolean().default(false),
  maxMinutes: z.number().int().min(1).max(30).default(10),
  stopAfter: z.boolean().default(true),
});
export type AutoQaAction = z.infer<typeof AutoQaAction>;

/** Attaches the PR to the Session that pushed its head branch (agent-opened PRs show up without pasting). */
export const AttachAction = z.object({ type: z.literal("attach") });
export type AttachAction = z.infer<typeof AttachAction>;

/** Push notification / in-app toast only. */
export const NotifyAction = z.object({
  type: z.literal("notify"),
  /** Placeholders as `PromptAction`; defaults to "<automation name>: <event>". */
  text: z.string().max(500).optional(),
});
export type NotifyAction = z.infer<typeof NotifyAction>;

export const AutomationAction = z.discriminatedUnion("type", [PromptAction, NewSessionAction, AutoReviewAction, AutoQaAction, AttachAction, NotifyAction]);
export type AutomationAction = z.infer<typeof AutomationAction>;

export const AUTOMATION_ACTION_LABELS: Record<AutomationAction["type"], string> = {
  prompt: "Prompt a Session",
  new_session: "New Session",
  auto_review: "Auto review",
  auto_qa: "Auto QA (video)",
  attach: "Attach the PR to its Session",
  notify: "Notify me",
};

export const AutomationLimits = z.object({
  /** Sessions this automation may have running at once. */
  maxConcurrent: z.number().int().min(1).max(20).default(2),
  /** Runs in any rolling 24 hours. */
  maxRunsPerDay: z.number().int().min(1).max(1000).default(20),
  /** Runs per PR in any rolling 24 hours (PR events only). */
  maxRunsPerPrPerDay: z.number().int().min(1).max(100).default(4),
  /** Quiet period after a push before `synchronize` fires; later pushes restart it. */
  debounceSeconds: z.number().int().min(0).max(3600).default(120),
  /** A run whose Session has not settled by then fails. */
  timeoutMinutes: z.number().int().min(1).max(24 * 60).default(360),
});
export type AutomationLimits = z.infer<typeof AutomationLimits>;

export const AutomationRunTrigger = z.enum(["cron", "manual", "catch_up", "pr_event", "mcp_event"]);
export type AutomationRunTrigger = z.infer<typeof AutomationRunTrigger>;

export const AutomationRunStatus = z.enum(["queued", "running", "succeeded", "failed", "skipped"]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatus>;

/** What the action produced, for the history row and the PRs page badge. */
export const AutomationRunResult = z.discriminatedUnion("type", [
  z.object({ type: z.literal("review"), verdict: ReviewVerdict, findings: z.number().int(), high: z.number().int(), url: z.string().nullable() }),
  z.object({
    type: z.literal("qa"),
    passed: z.number().int(),
    total: z.number().int(),
    skipped: z.boolean(),
    videoUrl: z.string().nullable(),
    commentUrl: z.string().nullable(),
    e2eRunId: z.string(),
  }),
  z.object({ type: z.literal("prompt"), how: z.enum(["sent", "queued", "resumed"]) }),
  z.object({ type: z.literal("attach"), pullRequestId: z.string() }),
  z.object({ type: z.literal("notify") }),
]);
export type AutomationRunResult = z.infer<typeof AutomationRunResult>;

export const AutomationRunEvent = z.object({ id: z.string(), type: PrEventType, headSha: z.string() });
export type AutomationRunEvent = z.infer<typeof AutomationRunEvent>;

export const AutomationRun = z.object({
  id: z.string(),
  automationId: z.string(),
  trigger: AutomationRunTrigger,
  status: AutomationRunStatus,
  /** The PR event that fired it, when the trigger is `pr_event`. */
  event: AutomationRunEvent.nullable(),
  /** The MCP event that fired it, when the trigger is `mcp_event`. */
  mcpEvent: McpRunEvent.nullable().default(null),
  followedPrId: z.string().nullable(),
  prUrl: z.string().nullable(),
  prTitle: z.string().nullable(),
  /** The Session the run prompted or created. */
  sessionId: z.string().nullable(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** What happened, in a line: "queued behind the running turn", "Sandbox stopped afterwards"… */
  detail: z.string().nullable(),
  error: z.string().nullable(),
  result: AutomationRunResult.nullable(),
});
export type AutomationRun = z.infer<typeof AutomationRun>;

export const Automation = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  trigger: AutomationTrigger,
  action: AutomationAction,
  limits: AutomationLimits,
  /** Schedule triggers only. */
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastStatus: AutomationRunStatus.nullable(),
  /** Runs queued or started in the last 24 hours. */
  runsToday: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Automation = z.infer<typeof Automation>;

export const CreateAutomationRequest = z.object({
  name: z.string().min(1).max(AUTOMATION_NAME_MAX_CHARS),
  enabled: z.boolean().default(true),
  trigger: AutomationTrigger,
  action: AutomationAction,
  limits: AutomationLimits.default({}),
});
export type CreateAutomationRequest = z.infer<typeof CreateAutomationRequest>;

export const UpdateAutomationRequest = CreateAutomationRequest.partial();
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequest>;

/** `automation_create`: like `CreateAutomationRequest`, with the prompt's Session and the new Session's Provider defaulting to the caller's. */
export const AgentAutomationCreateArgs = z.object({
  name: z.string().min(1).max(AUTOMATION_NAME_MAX_CHARS),
  enabled: z.boolean().default(true),
  trigger: AutomationTrigger,
  action: z.discriminatedUnion("type", [
    PromptAction.extend({ sessionId: PromptAction.shape.sessionId.optional() }),
    NewSessionAction.extend({ provider: Provider.optional() }),
    AutoReviewAction,
    AutoQaAction,
    AttachAction,
    NotifyAction,
  ]),
  limits: AutomationLimits.partial().default({}),
});
export type AgentAutomationCreateArgs = z.infer<typeof AgentAutomationCreateArgs>;

export const AUTOMATIONS_ROUTE = "#/automations";
export function automationRoute(id: string): string {
  return `${AUTOMATIONS_ROUTE}/${id}`;
}
