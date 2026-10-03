// ---------------------------------------------------------------------------
// The `sessionboxer` MCP in every Sandbox (ADR-0062): the Agent knows it runs inside a Session
// and can ask Sessionboxer to do what only it can. Its tools `POST /sessionboxer` on the Daemon
// with `{ tool, args }`; the Daemon forwards them as JSON-RPC `_sessionboxer/agent/<tool>` over
// its Control Plane WebSocket, and the Control Plane answers for the Session that connection
// belongs to (never for a Session named in the request).
// ---------------------------------------------------------------------------

import { z } from "zod";
import { Provider, Environment, SessionStatus } from "./common.js";
import { E2E_MAX_CASES, E2eRunStatus } from "./e2e.js";
import { RepoSpec } from "./repositories.js";
import { ForkConversation, HANDOFF_DOCUMENT_MAX_CHARS } from "./snapshots.js";
import { UTILITY_NAME_PATTERN, UtilityGroup, UtilityWebFacet, UtilitySshFacet, UtilityMcpFacet, PROCEDURE_NAME_PATTERN } from "./utilities.js";
import { SessionUsage } from "./usage-limits.js";

/**
 * What an Agent may do through the `sessionboxer` MCP: `off` (the server is not passed to it),
 * `session` (self-knowledge and its own Session: PRs, queue, snapshot, verification, panes,
 * schedules for itself) or `all` (plus listing, reading, messaging, creating and stopping other Sessions).
 */
export const AgentToolsPolicy = z.enum(["off", "session", "all"]);
export type AgentToolsPolicy = z.infer<typeof AgentToolsPolicy>;

/** Sessions alive at once that one Agent created (`session_create`); `Settings.agentChildrenCap` bounds the total. */
export const AGENT_CHILDREN_PER_SESSION = 3;
/** An unattended approval (`session_create`) is denied after this long. */
export const AGENT_APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** The Daemon's `POST /sessionboxer` waits this long for the Control Plane; `session_wait` and `approval_wait` return before it. */
export const AGENT_BRIDGE_TIMEOUT_MS = 20_000;
/** Longest `session_get` / `session_wait` last-reply excerpt. */
export const AGENT_LAST_REPLY_MAX_CHARS = 4000;

/** Where the Daemon writes the Session's identity for the Agent, relative to the Workspace. */
export const SESSION_INFO_PATH = ".sessionboxer/session.json";
/** Where the image ships the user guide the `docs` tool answers from. */
export const GUIDE_PATH = "/opt/sessionboxer/docs/GUIDE.md";

/** The object in `SESSION_INFO_PATH`; the Control Plane sends it (`sessionInfoSet`) at boot and whenever it changes. */
export const SessionInfo = z.object({
  id: z.string(),
  title: z.string(),
  /** The Session in the user's browser. */
  url: z.string(),
  provider: Provider,
  /** The Agent's model, once it reported one. */
  model: z.string().nullable(),
  environment: Environment,
  /** The VM the Agent runs in (Windows/macOS Sessions), `null` in a Linux Sandbox. */
  guest: z.object({ os: z.enum(["windows", "macos"]), workspace: z.string() }).nullable(),
  createdAt: z.string(),
  forkedFrom: z.object({ sessionId: z.string(), title: z.string(), snapshotId: z.string() }).nullable(),
  /** The Session an Agent created this one from, if any (`Session.createdBy`). */
  createdBy: z.object({ sessionId: z.string(), title: z.string() }).nullable().default(null),
  /** Conversation branch the transcript shows (`root` until the first revert). */
  branch: z.string(),
  snapshotCount: z.number().int().nonnegative(),
  sessionboxerVersion: z.string(),
  agentTools: AgentToolsPolicy,
});
export type SessionInfo = z.infer<typeof SessionInfo>;

/** Panes of the Session page the Agent can ask to open (`ui_open`). */
export const UiPane = z.enum(["chat", "desktop", "code", "terminal", "app", "context", "prs", "e2e", "schedules"]);
export type UiPane = z.infer<typeof UiPane>;

/** Daemon `POST /sessionboxer` body (the `sessionboxer` MCP): a tool name and its arguments. */
export const AGENT_BRIDGE_PATH = "/sessionboxer";
export const AgentBridgeRequest = z.object({ tool: z.string().min(1).max(64), args: z.unknown() });
export type AgentBridgeRequest = z.infer<typeof AgentBridgeRequest>;

/** The tools of the `sessionboxer` MCP; the Daemon forwards nothing else. */
export const AGENT_TOOLS = [
  // self-knowledge
  "whoami",
  "docs",
  "settings_get",
  // this Session
  "pr_attach",
  "pr_list",
  "pr_items",
  "pr_mark_addressed",
  "snapshot",
  "queue_add",
  "queue_list",
  "title_set",
  "verify",
  "notify",
  "terminal_list",
  "terminal_read",
  "transcribe_media",
  "ui_open",
  "e2e_plan",
  "e2e_case_start",
  "e2e_case_end",
  "e2e_finish",
  "session_fork",
  "approval_wait",
  "schedule_create",
  "schedule_list",
  "automation_create",
  "automation_list",
  "automation_runs",
  "pr_follow",
  "pr_followed_list",
  "pr_review_submit",
  // Utilities and procedures (ADR-0073)
  "utilities_list",
  "utilities_get",
  "utilities_open",
  "utilities_add",
  "utilities_update",
  "utilities_enable",
  "procedure_save",
  // other Sessions (policy `all`)
  "sessions_list",
  "session_get",
  "session_create",
  "session_message",
  "session_wait",
  "session_stop",
] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];
export function isAgentTool(tool: string): tool is AgentTool {
  return (AGENT_TOOLS as ReadonlyArray<string>).includes(tool);
}

export const AGENT_METHOD_PREFIX = "_sessionboxer/agent/";
/** The JSON-RPC method the Daemon sends the Control Plane for a tool. */
export function agentMethod(tool: AgentTool): string {
  return `${AGENT_METHOD_PREFIX}${tool}`;
}
/** The tool a JSON-RPC method stands for; `null` for anything else. */
export function agentToolOf(method: string): AgentTool | null {
  if (!method.startsWith(AGENT_METHOD_PREFIX)) return null;
  const tool = method.slice(AGENT_METHOD_PREFIX.length);
  return isAgentTool(tool) ? tool : null;
}

// The tools' arguments, as the Control Plane validates them (the MCP describes the same shapes to the Agent).
export const AgentDocsArgs = z.object({ query: z.string().min(1).max(200) });
export const AgentPrAttachArgs = z.object({ ref: z.string().min(1).max(500) });
export const AgentPrItemsArgs = z.object({ pr: z.string().min(1) });
export const AgentPrMarkAddressedArgs = z.object({ pr: z.string().min(1), items: z.array(z.string().min(1)).min(1).max(200) });
export const AgentQueueAddArgs = z.object({ text: z.string().min(1).max(20_000) });
export const AgentTitleSetArgs = z.object({ title: z.string().min(1).max(200) });
export const AgentVerifyArgs = z.object({
  /** What the run verifies, in the Agent's words; shown in the Auto QA pane. */
  brief: z.string().min(1).max(2000),
  /** Cases planned at once (else `e2e_plan` follows). */
  cases: z
    .array(z.object({ title: z.string().min(1).max(200), steps: z.string().max(4000), expected: z.string().max(2000) }))
    .max(E2E_MAX_CASES)
    .optional(),
});
export const AgentNotifyArgs = z.object({ text: z.string().min(1).max(500) });
export const AgentTerminalReadArgs = z.object({ id: z.string().min(1), lines: z.number().int().positive().max(2000).default(100) });
/**
 * `transcribe_media`: `path` is a 16 kHz mono 16-bit WAV in the Workspace (the `sessionboxer` MCP
 * extracts it from the video or audio file with ffmpeg first); the Control Plane reads it from
 * the Daemon and runs Whisper on the host. `language` is an ISO 639-1 code or `auto`.
 */
export const AgentTranscribeMediaArgs = z.object({ path: z.string().min(1).max(4096), language: z.string().min(2).max(8).optional() });
export const AgentUiOpenArgs = z.object({
  pane: UiPane,
  /** With `pane: "terminal"`: a new Terminal is opened and this runs in it, visibly. */
  terminal: z.object({ command: z.string().min(1).max(4000) }).optional(),
});
/** Longest prompt an Agent sends another Session or schedules (the Schedules pane's limit too). */
export const AGENT_PROMPT_MAX_CHARS = 20_000;
export const AgentSessionGetArgs = z.object({ id: z.string().min(1) });
export type AgentSessionGetArgs = z.infer<typeof AgentSessionGetArgs>;
export const AgentSessionCreateArgs = z.object({
  title: z.string().min(1).max(200).optional(),
  /** The new Session's Agent; the caller's when omitted. */
  provider: Provider.optional(),
  /** Repositories for the new Workspace (the same shapes the New session form accepts). */
  repos: z.array(RepoSpec).max(20).default([]),
  /** Sent as the Session's first prompt once its Sandbox is ready. */
  first_prompt: z.string().min(1).max(AGENT_PROMPT_MAX_CHARS),
});
export type AgentSessionCreateArgs = z.infer<typeof AgentSessionCreateArgs>;
export const AgentSessionForkArgs = z.object({
  conversation: ForkConversation.default("continue"),
  /** The fork's Agent; the caller's when omitted (`new` or `handoff` needed for another one). */
  provider: Provider.optional(),
  title: z.string().min(1).max(200).optional(),
  /** With `handoff`: the document the fork's Agent starts with, written by the caller (no hidden handoff turn). */
  document: z.string().min(1).max(HANDOFF_DOCUMENT_MAX_CHARS).optional(),
  first_prompt: z.string().min(1).max(AGENT_PROMPT_MAX_CHARS).optional(),
});
export type AgentSessionForkArgs = z.infer<typeof AgentSessionForkArgs>;
export const AgentSessionMessageArgs = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(AGENT_PROMPT_MAX_CHARS),
  /** `now` prompts the target (queued behind its current turn when busy); `queue` always appends to its queue. */
  when: z.enum(["now", "queue"]).default("now"),
});
export type AgentSessionMessageArgs = z.infer<typeof AgentSessionMessageArgs>;
export const AgentSessionWaitArgs = z.object({
  id: z.string().min(1),
  /** Seconds to wait for the target's turn to end, at most the bridge's timeout. */
  timeout_s: z.number().int().positive().max(AGENT_BRIDGE_TIMEOUT_MS / 1000).default(15),
});
export type AgentSessionWaitArgs = z.infer<typeof AgentSessionWaitArgs>;
export const AgentSessionStopArgs = z.object({ id: z.string().min(1) });
export type AgentSessionStopArgs = z.infer<typeof AgentSessionStopArgs>;
export const AgentApprovalWaitArgs = z.object({
  id: z.string().min(1),
  timeout_s: z.number().int().positive().max(AGENT_BRIDGE_TIMEOUT_MS / 1000).default(15),
});
export type AgentApprovalWaitArgs = z.infer<typeof AgentApprovalWaitArgs>;
export const AgentScheduleCreateArgs = z.object({
  name: z.string().min(1).max(200),
  /** Standard 5-field cron expression (`@hourly`-style nicknames accepted). */
  cron: z.string().min(1).max(200),
  /** IANA time zone; the Control Plane's when omitted. */
  timezone: z.string().min(1).max(100).optional(),
  action: z.discriminatedUnion("type", [
    /** Prompts a Session (the caller's own when `sessionId` is omitted). */
    z.object({ type: z.literal("prompt"), sessionId: z.string().min(1).optional(), text: z.string().min(1).max(AGENT_PROMPT_MAX_CHARS) }),
    /** Starts a new Session each time (policy `all`). */
    z.object({
      type: z.literal("new_session"),
      title: z.string().min(1).max(200).optional(),
      provider: Provider.optional(),
      repos: z.array(RepoSpec).max(20).default([]),
      prompt: z.string().min(1).max(AGENT_PROMPT_MAX_CHARS),
      stopAfter: z.boolean().default(true),
    }),
  ]),
});
export type AgentScheduleCreateArgs = z.infer<typeof AgentScheduleCreateArgs>;
export const AgentAutomationRunsArgs = z.object({ id: z.string().min(1) });
export type AgentAutomationRunsArgs = z.infer<typeof AgentAutomationRunsArgs>;

// Utilities (ADR-0073): the Agent reads the catalogue and proposes changes; every change is a card the user allows.
export const AgentUtilitiesGetArgs = z.object({ name: z.string().min(1).max(64), environment: z.string().max(64).optional() });
export type AgentUtilitiesGetArgs = z.infer<typeof AgentUtilitiesGetArgs>;
export const AgentUtilitiesOpenArgs = z.object({
  name: z.string().min(1).max(64),
  environment: z.string().max(64).optional(),
  /** A path or URL under the web facet's URL to open instead of its front page. */
  path: z.string().max(4000).optional(),
});
export type AgentUtilitiesOpenArgs = z.infer<typeof AgentUtilitiesOpenArgs>;
/** A credential as the Agent passes it (`utilities_add` / `utilities_update`); the value never comes back. */
export const AgentUtilityCredential = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), value: z.string().max(10_000) });
export const AgentUtilitiesAddArgs = z.object({
  name: z.string().regex(UTILITY_NAME_PATTERN),
  label: z.string().max(200).optional(),
  group: UtilityGroup.optional(),
  environment: z.string().max(64).optional(),
  /** A preset name (`utilities_list` names them) fills the facets in; the credentials it asks for are in its description. */
  preset: z.string().max(64).optional(),
  credentials: z.array(AgentUtilityCredential).max(20).default([]),
  readOnly: z.boolean().optional(),
  notes: z.string().max(20_000).optional(),
  web: UtilityWebFacet.partial().optional(),
  http: z.object({ baseUrl: z.string().max(4000), headers: z.array(AgentUtilityCredential).max(20).default([]) }).optional(),
  ssh: UtilitySshFacet.partial().optional(),
  cli: z.object({ install: z.string().max(4000).default(""), env: z.array(AgentUtilityCredential).max(20).default([]) }).optional(),
  mcp: UtilityMcpFacet.partial().optional(),
  /** Switch it on for this Session once stored (default). */
  enable: z.boolean().default(true),
});
export type AgentUtilitiesAddArgs = z.infer<typeof AgentUtilitiesAddArgs>;
export const AgentUtilitiesUpdateArgs = AgentUtilitiesAddArgs.omit({ enable: true, name: true }).partial().extend({
  name: z.string().min(1).max(64),
  /** Credentials given replace the stored ones of the same name; others stay. */
  credentials: z.array(AgentUtilityCredential).max(20).default([]),
});
export type AgentUtilitiesUpdateArgs = z.infer<typeof AgentUtilitiesUpdateArgs>;
export const AgentUtilitiesEnableArgs = z.object({
  /** Utility names (`name` or `name@environment`); an Environment or group name switches all of it. */
  names: z.array(z.string().min(1).max(130)).min(1).max(100),
  enabled: z.boolean().default(true),
});
export type AgentUtilitiesEnableArgs = z.infer<typeof AgentUtilitiesEnableArgs>;
export const AgentProcedureSaveArgs = z.object({
  name: z.string().regex(PROCEDURE_NAME_PATTERN),
  description: z.string().min(1).max(1024),
  body: z.string().min(1).max(200_000),
  utilities: z.array(z.string().max(64)).max(50).default([]),
  environments: z.array(z.string().max(64)).max(20).default([]),
});
export type AgentProcedureSaveArgs = z.infer<typeof AgentProcedureSaveArgs>;

/** `sessions_list` rows and `session_get` (which adds the last reply). */
export const AgentSessionSummary = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  status: SessionStatus,
  provider: Provider,
  environment: Environment,
  repos: z.array(z.string()),
  createdAt: z.string(),
  /** The Session whose Agent created it, when one did. */
  createdBy: z.object({ sessionId: z.string(), title: z.string() }).nullable(),
  forkedFrom: z.object({ sessionId: z.string(), title: z.string() }).nullable(),
  /** The calling Session itself. */
  self: z.boolean(),
  /** Created by the calling Session's Agent (so `session_stop` may stop it). */
  mine: z.boolean(),
  queueLength: z.number().int().nonnegative(),
});
export type AgentSessionSummary = z.infer<typeof AgentSessionSummary>;

/** `whoami`: `SessionInfo` plus what is live. */
export const AgentWhoAmI = SessionInfo.extend({
  status: SessionStatus,
  usage: SessionUsage,
  /** The last `/context` report (`context_breakdown` event), when any. */
  context: z.object({ usedTokens: z.number().int().nonnegative(), maxTokens: z.number().int().nonnegative(), percent: z.number() }).nullable(),
  queueLength: z.number().int().nonnegative(),
  /** Panes the user has open on this Session right now (from the browsers connected). */
  panes: z.array(z.string()),
  terminals: z.array(z.object({ id: z.string(), createdAt: z.string(), exitCode: z.number().int().nullable() })),
  prs: z.array(z.object({ id: z.string(), ref: z.string(), title: z.string(), state: z.string(), checks: z.number().int().nonnegative(), comments: z.number().int().nonnegative(), unseen: z.number().int().nonnegative() })),
  verification: z.object({ id: z.string(), status: E2eRunStatus, brief: z.string().nullable() }).nullable(),
  repos: z.array(z.object({ name: z.string(), path: z.string() })),
});
export type AgentWhoAmI = z.infer<typeof AgentWhoAmI>;

/** Control Plane → web: the Agent asked for a pane (`ui_open`); honoured only on this Session's page and not mid-typing. */
export const UiHint = z.object({
  sessionId: z.string(),
  pane: UiPane,
  /** With `pane: "terminal"`: the Terminal opened for the Agent's command. */
  terminalId: z.string().nullable().default(null),
});
export type UiHint = z.infer<typeof UiHint>;

/** The Daemon's answer to `ptyRead`: the Terminal's retained output, last `lines` lines. */
export const PtyReadResult = z.object({ id: z.string(), text: z.string(), exitCode: z.number().int().nullable() });
export type PtyReadResult = z.infer<typeof PtyReadResult>;
export const PtyReadParams = z.object({ id: z.string(), lines: z.number().int().positive().max(2000).default(100) });
export type PtyReadParams = z.infer<typeof PtyReadParams>;
