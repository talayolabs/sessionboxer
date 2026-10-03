// ---------------------------------------------------------------------------
// Session event stream. Persisted by the Control Plane, rendered by the UI.
// `update` events carry ACP `session/update` payloads verbatim.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { Provider, SessionStatus } from "./common.js";
import { InstructionsDelivery, ModelOption, AgentOption } from "./models.js";
import { PromptAttachment } from "./session-settings.js";
import { McpAppCall } from "./mcp-apps.js";
import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import { TurnUsage, ContextBreakdown } from "./context-usage.js";
import { ForkConversation, Snapshot } from "./snapshots.js";
import { RepoSource } from "./repositories.js";
import { E2eRunSummary, E2eRun } from "./e2e.js";
import { LlmCall } from "./llm-inspector.js";
import { Session, SessionFolder } from "./sessions.js";
import { SavedMessage } from "./queue.js";
import { PullRequest, PrItem, PrCheckItem, PrActivity, PrMergedNotice } from "./pull-requests.js";
import { UiHint } from "./sessionboxer-mcp.js";
import { Automation, AutomationRun } from "./automations.js";
import { PrFollow } from "./followed-prs.js";
import { FollowedPr, PrEvent } from "./known-repositories.js";
import { RemoteAccess } from "./auth.js";
import { WindowsBaseStatus, MacosBaseStatus } from "./vm-bases.js";

export type { SessionUpdate, StopReason, ContentBlock, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";

/**
 * Who wrote a `user_prompt` that is not the user's own words (shown as a marker): `e2e` the Control
 * Plane's hidden verification prompt; `handoff_request` its request to write a handoff for a fork;
 * `handoff` the handoff document a fork starts with; an `agent` origin is another Session's Agent
 * (`session_message`, ADR-0062), with how many Agent-to-Agent hops the message has travelled.
 */
export const HiddenPromptOrigin = z.enum(["e2e", "handoff_request", "handoff"]);
export type HiddenPromptOrigin = z.infer<typeof HiddenPromptOrigin>;
export const AgentPromptOrigin = z.object({
  type: z.literal("agent"),
  fromSessionId: z.string(),
  fromTitle: z.string(),
  /** 1 for a message the user's own prompt led to; a Session prompted by an Agent sends at `hops + 1`. */
  hops: z.number().int().positive(),
});
export type AgentPromptOrigin = z.infer<typeof AgentPromptOrigin>;
export type PromptOrigin = HiddenPromptOrigin | AgentPromptOrigin;
/** Agent-to-Agent messages stop travelling after this many hops (a loop of Sessions prompting each other). */
export const AGENT_MESSAGE_MAX_HOPS = 4;

/**
 * The Agent asked for something the user has to allow (`session_create` under `approveCreate`):
 * shown as a card in the chat until settled; the settlement is a second event with the same `id`.
 */
export const AgentApprovalKind = z.enum(["session_create", "session_fork", "schedule_create", "utility_add", "utility_update", "utility_enable", "procedure_save"]);
export type AgentApprovalKind = z.infer<typeof AgentApprovalKind>;
export const AgentApprovalStatus = z.enum(["pending", "allowed", "denied", "expired"]);
export type AgentApprovalStatus = z.infer<typeof AgentApprovalStatus>;
export const AgentApproval = z.object({
  id: z.string(),
  kind: AgentApprovalKind,
  /** What the Agent asked for, in one line ("create a Session “Fix the tests”"). */
  summary: z.string(),
  status: AgentApprovalStatus,
  /** When an unanswered request is denied (`AGENT_APPROVAL_TIMEOUT_MS` after it was made). */
  expiresAt: z.string(),
  /**
   * What the Agent proposes, field by field, for the card to show as a form (a Utility's URL, its
   * credential names…); secret values arrive masked, the Control Plane keeps the real ones.
   */
  details: z.array(z.object({ name: z.string(), value: z.string(), secret: z.boolean() })).default([]),
  /** What the allowed action produced, for the card: the Session created (linked), or just what it is called (a Utility, a procedure). */
  result: z.object({ sessionId: z.string().nullable().default(null), title: z.string() }).nullable().default(null),
  /** Why an allowed action still failed, when it did. */
  error: z.string().nullable().default(null),
});
export type AgentApproval = z.infer<typeof AgentApproval>;
/** `POST /sessions/:id/approvals/:approvalId`: the card's Allow / Deny. */
export const AgentApprovalAnswer = z.object({ allow: z.boolean() });
export type AgentApprovalAnswer = z.infer<typeof AgentApprovalAnswer>;

export const McpExecutionTelemetry = z.object({
  version: z.literal(1),
  executionId: z.string().uuid(),
  /** A built-in (`desktop`, `sessionboxer`) or the name of a user server observed through the tee (ADR-0079). */
  server: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  toolName: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/),
  startedAt: z.string().datetime(),
  executionMs: z.number().finite().nonnegative(),
  toolSchemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  errorCode: z.enum(["invalid_arguments", "permission_denied", "timeout", "rate_limit", "not_found", "edit_match", "cancelled", "network", "nonzero_exit", "tool_error"]).nullable(),
  errorSource: z.enum(["heuristic", "structured"]).nullable(),
  /** Set when the record comes from the exact MCP exchange seen by the tee, with the ACP call it was matched to. */
  exact: z.boolean().optional(),
  toolCallId: z.string().optional(),
  resultIsError: z.boolean().optional(),
  /** The shape of the exact result: content blocks, and the keys of `structuredContent` (values stay out of telemetry). */
  contentBlocks: z.number().int().nonnegative().optional(),
  structuredContentKeys: z.array(z.string().max(200)).max(200).optional(),
});
export type McpExecutionTelemetry = z.infer<typeof McpExecutionTelemetry>;

export interface TurnContextTelemetry {
  version: 1;
  turnId: string;
  provider: Provider;
  model: string | null;
  agentInfo: { name: string; version: string } | null;
  configuredInstructionsHash: string;
  instructionsScope: "sessionboxer-configured";
  instructionsDelivery: InstructionsDelivery;
  mcpServers: string[];
}

export interface ExecutionEvidence {
  exitCode: number | null;
  terminationSignal: string | number | null;
  timedOut: boolean | null;
  interrupted: boolean | null;
  waitTimedOut: boolean | null;
  processOutcome: "succeeded" | "failed" | "signalled" | "timed_out" | "interrupted" | "running" | "unknown";
  transportOutcome: "succeeded" | "failed" | "unknown";
  expectedExitCodes: number[] | null;
  diagnosticSource: "declared" | null;
  sources: Record<string, string>;
  context: {
    commandHash: string | null;
    cwdHash: string | null;
    taskHash: string | null;
    processRefs: string[];
    targetHashes: string[];
  };
}

export interface ToolExecutionTelemetry {
  version: 1 | 2;
  execution?: ExecutionEvidence;
  turnId: string | null;
  toolCallId: string;
  toolName: string | null;
  status: "completed" | "failed";
  startedAt: string | null;
  observedDurationMs: number | null;
  executionId: string | null;
  executionMs: number | null;
  toolSchemaHash: string | null;
  resultIsError: boolean | null;
  errorCode: string | null;
  errorSource: "heuristic" | "structured" | "acp_status" | null;
  /** The MCP server and tool behind the call when the tee saw the exact exchange (ADR-0079). */
  mcp?: { server: string; tool: string; exact: true; contentBlocks: number; structuredContentKeys: string[] };
}

export type SessionEventBody =
  | { type: "user_prompt"; text: string; attachments?: PromptAttachment[]; origin?: PromptOrigin; turnId?: string }
  | { type: "turn_context"; context: TurnContextTelemetry }
  | { type: "tool_execution"; execution: ToolExecutionTelemetry }
  | { type: "mcp_execution"; execution: McpExecutionTelemetry }
  /** An Agent MCP tool call (seen through the tee) whose tool has an MCP App view; the transcript renders the card (ADR-0079). */
  | { type: "mcp_app_call"; call: McpAppCall }
  | { type: "update"; update: SessionUpdate }
  | { type: "turn_ended"; stopReason: StopReason; usage?: TurnUsage; turnId?: string }
  /** `limit`: the Provider refused for lack of usage credit (the prompt can be sent again after the reset). */
  | { type: "agent_error"; message: string; limit?: { resetsAt: string | null }; turnId?: string }
  | { type: "status"; status: SessionStatus; error?: string }
  /** First event of a forked Session: everything before it was copied from the origin (nothing, with `conversation: "new"`). */
  | {
      type: "forked";
      fromSessionId: string;
      fromTitle: string;
      snapshotId: string;
      snapshotOrdinal: number;
      conversation?: ForkConversation;
      /** The origin's Agent, when the fork runs another one. */
      fromProvider?: Provider;
    }
  /** The Daemon restarted the Agent with a new MCP server set (names, `desktop` excluded). */
  | { type: "mcp_changed"; servers: string[] }
  /** The Session's enabled Utilities changed (a switch, `utilities_enable`, the registry): the names now on. */
  | { type: "utilities_changed"; utilities: string[] }
  /** The Utilities on for this Session changed (names as `utilities.json` lists them). */
  | { type: "utilities_changed"; utilities: string[] }
  /** The Agent switched model (`name` is the human label, `model` the value). */
  | { type: "model_changed"; model: string; name: string }
  /** One of the Agent's other options changed (`name`/`valueName` are the human labels). */
  | { type: "option_changed"; id: string; name: string; value: string; valueName: string }
  /** The Agent was asked `/context` outside the conversation; this is what it reported. */
  | { type: "context_breakdown"; breakdown: ContextBreakdown }
  /** A repository was added to (cloned/copied into) or removed from the Workspace while the Session ran. */
  | { type: "repo_changed"; action: "added" | "removed"; name: string; source: RepoSource }
  /** A USB device of the host was connected to / disconnected from the Sandbox (`node`: its path inside, for `connected`). */
  | { type: "usb_changed"; action: "connected" | "disconnected"; name: string; node: string | null }
  /** An end-to-end verification run of the previous turn ended (passed, failed, skipped or aborted); the UI shows a marker that opens the E2E pane. */
  | { type: "e2e_run"; run: E2eRunSummary }
  /**
   * The Agent did something through the `sessionboxer` MCP (ADR-0062): a compact marker ("attached PR #12",
   * "snapshot"). `pane` is where the marker leads; `sessionId` the other Session it concerns, when any.
   */
  | { type: "agent_action"; tool: string; text: string; pane?: string; sessionId?: string }
  /** The Agent asked for the user's permission (a card in the chat), or that request settled (same `approval.id`). */
  | { type: "agent_approval"; approval: AgentApproval }
  /**
   * The inspector saw one model API call complete (summary only; bodies stay in the Sandbox).
   * Emitted after the transcript updates the response produced, so a `turn` call claims the
   * agent messages / tool calls since the previous one.
   */
  | { type: "llm_call"; call: LlmCall };

export interface SessionEvent {
  /** Control Plane sequence, monotonic per Session (across branches). */
  seq: number;
  sessionId: string;
  branchId: string;
  ts: string;
  body: SessionEventBody;
}

/** Control Plane -> web UI push messages (`GET /api/ws`). */
export type SessionBroadcast =
  | { type: "session"; session: Session }
  | { type: "session_deleted"; id: string }
  /** The folder list changed (created, renamed, deleted); carries the whole list. */
  | { type: "folders"; folders: SessionFolder[] }
  | { type: "event"; event: SessionEvent }
  | { type: "saved_messages"; sessionId: string; messages: SavedMessage[] }
  | { type: "snapshots"; sessionId: string; snapshots: Snapshot[] }
  /** A `docker commit` is in progress (the Sandbox is paused for a few seconds). */
  | { type: "snapshotting"; sessionId: string; active: boolean }
  /** An automatic Snapshot could not be taken (manual ones report through their request). */
  | { type: "snapshot_failed"; sessionId: string; message: string }
  /** A Provider's Agent reported its model list (differs from what was remembered). */
  | { type: "models"; provider: Provider; models: ModelOption[] }
  /** A Provider's Agent advertised options not remembered before (or changed ones). */
  | { type: "options"; provider: Provider; options: AgentOption[] }
  /** The Session's attached Pull Requests changed (attached, detached, polled). */
  | { type: "prs"; sessionId: string; prs: PullRequest[] }
  /** The comment/review rows of one Pull Request changed. */
  | { type: "pr_items"; sessionId: string; prId: string; items: PrItem[] }
  /** The checks (check runs / commit statuses) of one Pull Request's head changed. */
  | { type: "pr_checks"; sessionId: string; prId: string; checks: PrCheckItem[] }
  /**
   * New feedback arrived on attached Pull Requests and the Session is idle (or stopped): the UI
   * notifies. While the Agent is busy the Control Plane holds this until `turn_ended`.
   */
  | { type: "pr_activity"; sessionId: string; sessionTitle: string; prs: PrActivity[] }
  /** Auto-merge merged an attached Pull Request. */
  | { type: "pr_merged"; sessionId: string; sessionTitle: string; pr: PrMergedNotice }
  /** An end-to-end verification run of the Session changed (created, a case started or ended, finished). */
  | { type: "e2e_changed"; sessionId: string; run: E2eRun }
  /** A Workspace file the UI asked to watch (`fs/watch`) changed; the App pane reloads its Artifact. */
  | { type: "fs_changed"; sessionId: string; path: string; exists: boolean }
  /** The Agent asked for a pane (`ui_open`); the page switches only when it shows this Session and the user is not typing. */
  | { type: "ui_hint"; hint: UiHint }
  /** The list of automations (one created, edited, deleted, or its next/last run moved). */
  | { type: "automations"; automations: Automation[] }
  /** The run history of one automation changed. */
  | { type: "automation_runs"; automationId: string; runs: AutomationRun[] }
  /** The follows changed (one added, paused, removed, or polled). */
  | { type: "pr_follows"; follows: PrFollow[] }
  /** Followed PRs appeared, changed or went away. */
  | { type: "followed_prs"; prs: FollowedPr[] }
  | { type: "followed_pr_items"; prId: string; items: PrItem[] }
  | { type: "followed_pr_checks"; prId: string; checks: PrCheckItem[] }
  | { type: "pr_events"; prId: string; events: PrEvent[] }
  /** A transport came up, went down or failed (`PublicSettings.remote` changed). */
  | { type: "remote"; remote: RemoteAccess }
  /** The shared Windows base disk changed state (install started, progressed, finished or failed). */
  | { type: "windows_base"; status: WindowsBaseStatus }
  /** The shared macOS base disk changed state (ADR-0059). */
  | { type: "macos_base"; status: MacosBaseStatus }
  /** Answer to the UI's `ping`. */
  | { type: "pong" };
