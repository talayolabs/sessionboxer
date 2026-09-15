import { z } from "zod";
import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk";

export type { SessionUpdate, StopReason, ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------------------
// Sessions (Control Plane <-> web UI)
// ---------------------------------------------------------------------------

export const SESSION_STATUSES = ["creating", "idle", "running", "stopped", "error"] as const;
export const SessionStatus = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const PROVIDERS = ["claude-code"] as const;
export const Provider = z.enum(PROVIDERS);
export type Provider = z.infer<typeof Provider>;

export const WorkspaceSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("empty") }),
  z.object({ type: z.literal("git"), url: z.string().min(1), ref: z.string().min(1).optional() }),
  z.object({ type: z.literal("copy"), path: z.string().min(1) }),
]);
export type WorkspaceSource = z.infer<typeof WorkspaceSource>;

export const Session = z.object({
  id: z.string(),
  title: z.string(),
  provider: Provider,
  status: SessionStatus,
  workspaceSource: WorkspaceSource,
  containerId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof Session>;

export const CreateSessionRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  provider: Provider.default("claude-code"),
  workspaceSource: WorkspaceSource.default({ type: "empty" }),
  prompt: z.string().min(1).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const UpdateSessionRequest = z.object({
  title: z.string().min(1).max(200),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

export const PromptRequest = z.object({
  text: z.string().min(1),
});
export type PromptRequest = z.infer<typeof PromptRequest>;

// ---------------------------------------------------------------------------
// Settings (stored in ~/.sessionboxer/config.json, 0600)
// ---------------------------------------------------------------------------

export const Settings = z.object({
  gitUserName: z.string().default(""),
  gitUserEmail: z.string().default(""),
  sandboxCpus: z.number().positive().default(2),
  sandboxMemoryGb: z.number().positive().default(4),
  providerSecrets: z
    .object({
      "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.string().default("") }).default({}),
    })
    .default({}),
});
export type Settings = z.infer<typeof Settings>;

/** Settings as returned to the UI: secrets replaced by a boolean "is set". */
export const PublicSettings = Settings.omit({ providerSecrets: true }).extend({
  providerSecretsSet: z.object({ "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.boolean() }) }),
});
export type PublicSettings = z.infer<typeof PublicSettings>;

export const UpdateSettingsRequest = Settings.partial().extend({
  providerSecrets: z
    .object({
      "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.string() }).partial(),
    })
    .partial()
    .optional(),
});
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequest>;

// ---------------------------------------------------------------------------
// Session event stream. Persisted by the Control Plane, rendered by the UI.
// `update` events carry ACP `session/update` payloads verbatim.
// ---------------------------------------------------------------------------

export type SessionEventBody =
  | { type: "user_prompt"; text: string }
  | { type: "update"; update: SessionUpdate }
  | { type: "turn_ended"; stopReason: StopReason }
  | { type: "agent_error"; message: string }
  | { type: "status"; status: SessionStatus; error?: string };

export interface SessionEvent {
  /** Control Plane sequence, monotonic per Session. */
  seq: number;
  sessionId: string;
  ts: string;
  body: SessionEventBody;
}

/** Control Plane -> web UI push messages (`GET /api/ws`). */
export type SessionBroadcast =
  | { type: "session"; session: Session }
  | { type: "session_deleted"; id: string }
  | { type: "event"; event: SessionEvent };

// ---------------------------------------------------------------------------
// Sandbox Daemon RPC (Control Plane <-> Daemon, JSON-RPC 2.0 over WebSocket).
// Method names use ACP's `_<vendor>/` extension convention.
// ---------------------------------------------------------------------------

export const DAEMON_PORT = 7000;

export const DAEMON_METHODS = {
  hello: "_sessionboxer/hello",
  prompt: "_sessionboxer/prompt",
  cancel: "_sessionboxer/cancel",
  status: "_sessionboxer/status",
  event: "_sessionboxer/event",
} as const;

export const DaemonHelloParams = z.object({
  /** Daemon epoch the caller last saw, so the Daemon can replay from `lastSeq`. */
  epoch: z.string().optional(),
  lastSeq: z.number().int().nonnegative().optional(),
});
export type DaemonHelloParams = z.infer<typeof DaemonHelloParams>;

export const DaemonStatus = z.object({
  /** Random id per Daemon process; `seq` restarts from 0 with every epoch. */
  epoch: z.string(),
  lastSeq: z.number().int().nonnegative(),
  acpSessionId: z.string().nullable(),
  turnActive: z.boolean(),
  agentInfo: z.object({ name: z.string(), version: z.string() }).nullable(),
  ready: z.boolean(),
  error: z.string().nullable(),
});
export type DaemonStatus = z.infer<typeof DaemonStatus>;

export const DaemonPromptParams = z.object({ text: z.string().min(1) });
export type DaemonPromptParams = z.infer<typeof DaemonPromptParams>;

/** The turn runs asynchronously; its outcome arrives as `turn_ended`/`agent_error` events. */
export const DaemonPromptResult = z.object({ accepted: z.boolean() });
export type DaemonPromptResult = z.infer<typeof DaemonPromptResult>;

/** Daemon -> Control Plane notification. `body` never carries `status`. */
export interface DaemonEvent {
  epoch: string;
  seq: number;
  ts: string;
  body: Exclude<SessionEventBody, { type: "status" }>;
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC 2.0 framing shared by both ends of the Daemon connection.
// ---------------------------------------------------------------------------

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export function isJsonRpcRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m;
}

export function isJsonRpcNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return "method" in m && !("id" in m);
}

export function isJsonRpcResponse(m: JsonRpcMessage): m is JsonRpcSuccess | JsonRpcFailure {
  return !("method" in m) && "id" in m;
}

export function parseJsonRpc(raw: string): JsonRpcMessage {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || (value as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
    throw new Error("not a JSON-RPC 2.0 message");
  }
  return value as JsonRpcMessage;
}
