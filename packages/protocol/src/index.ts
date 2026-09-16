import { z } from "zod";
import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk";

export type { SessionUpdate, StopReason, ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------------------
// Sessions (Control Plane <-> web UI)
// ---------------------------------------------------------------------------

export const SESSION_STATUSES = ["creating", "idle", "running", "stopped", "error"] as const;
export const SessionStatus = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const PROVIDERS = ["claude-code", "devin"] as const;
export const Provider = z.enum(PROVIDERS);
export type Provider = z.infer<typeof Provider>;

export const PROVIDER_LABELS: Record<Provider, string> = {
  "claude-code": "Claude Code",
  devin: "Devin",
};

/**
 * How a Sandbox gets its own Docker daemon: `sysbox` runs it under the Sysbox
 * runtime (unprivileged, isolation intact), `privileged` falls back to
 * `--privileged` (root-equivalent on the host), `none` ships no daemon.
 */
export const DOCKER_MODES = ["none", "sysbox", "privileged"] as const;
export const DockerMode = z.enum(DOCKER_MODES);
export type DockerMode = z.infer<typeof DockerMode>;

export const DOCKER_MODE_LABELS: Record<DockerMode, string> = {
  none: "no Docker",
  sysbox: "Docker (Sysbox)",
  privileged: "Docker (privileged)",
};

export const WorkspaceSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("empty") }),
  z.object({ type: z.literal("git"), url: z.string().min(1), ref: z.string().min(1).optional() }),
  z.object({ type: z.literal("copy"), path: z.string().min(1) }),
  /** The Sandbox started from another Session's Snapshot image (whole filesystem, not just the Workspace). */
  z.object({
    type: z.literal("fork"),
    sessionId: z.string(),
    snapshotId: z.string(),
    /** Human-readable origin, e.g. "My session @ snapshot 3", kept even if the origin is deleted. */
    label: z.string(),
  }),
]);
export type WorkspaceSource = z.infer<typeof WorkspaceSource>;

// ---------------------------------------------------------------------------
// MCP servers: registered once in Settings, enabled per Session. The built-in
// `desktop` server is implicit and always on. Enabling/disabling restarts the
// Agent in place (ACP `session/load`), so the conversation is kept.
// ---------------------------------------------------------------------------

export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export const McpTransport = z.enum(MCP_TRANSPORTS);
export type McpTransport = z.infer<typeof McpTransport>;

/** Environment variable (stdio) or HTTP header (http/sse); `secret` values are never sent back to the UI. */
export const McpKeyValue = z.object({
  name: z.string().min(1).max(200),
  value: z.string().max(10_000).default(""),
  secret: z.boolean().default(false),
});
export type McpKeyValue = z.infer<typeof McpKeyValue>;

/** Names become tool prefixes (`mcp__<name>__<tool>`), so keep them identifier-like; `desktop` is reserved. */
export const MCP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const MCP_RESERVED_NAMES = ["desktop"] as const;

export const McpServerDef = z.object({
  id: z.string().min(1),
  name: z.string().regex(MCP_NAME_PATTERN, "letters, digits, `_` and `-` only"),
  transport: McpTransport,
  /** stdio: program run inside the Sandbox (`npx`, `uvx`, `node`, …). */
  command: z.string().max(4000).default(""),
  args: z.array(z.string().max(4000)).default([]),
  env: z.array(McpKeyValue).default([]),
  /** http/sse: `localhost` and `127.0.0.1` are rewritten to the Sandbox's host alias. */
  url: z.string().max(4000).default(""),
  headers: z.array(McpKeyValue).default([]),
  /** Pre-selected for new Sessions. */
  enabledByDefault: z.boolean().default(true),
});
export type McpServerDef = z.infer<typeof McpServerDef>;

/**
 * `McpServerDef` as seen by the UI: secret values are replaced by `null` when set (and by `""` when
 * empty). Sending `null` back keeps the stored value, so the form can round-trip without knowing it.
 */
export const PublicMcpKeyValue = McpKeyValue.extend({ value: z.string().max(10_000).nullable() });
export type PublicMcpKeyValue = z.infer<typeof PublicMcpKeyValue>;
export const PublicMcpServerDef = McpServerDef.extend({
  env: z.array(PublicMcpKeyValue).default([]),
  headers: z.array(PublicMcpKeyValue).default([]),
});
export type PublicMcpServerDef = z.infer<typeof PublicMcpServerDef>;

/** What the Daemon gets: resolved definitions of the Session's enabled servers, secrets included. */
export const McpServerSpec = McpServerDef.omit({ enabledByDefault: true });
export type McpServerSpec = z.infer<typeof McpServerSpec>;

export const Session = z.object({
  id: z.string(),
  title: z.string(),
  provider: Provider,
  status: SessionStatus,
  workspaceSource: WorkspaceSource,
  dockerMode: DockerMode.default("none"),
  /** Ids of the `Settings.mcpServers` entries enabled for this Session. */
  mcpEnabled: z.array(z.string()).default([]),
  /** The Agent is busy; the last MCP change is applied when the current turn ends. */
  mcpPending: z.boolean().default(false),
  containerId: z.string().nullable(),
  error: z.string().nullable(),
  /** The saved-message queue is being played: the next saved message is sent whenever a turn ends. */
  queueRunning: z.boolean().default(false),
  /** Per-Session override of `Settings.autoSnapshot`; `null` follows the global setting. */
  autoSnapshot: z.boolean().nullable().default(null),
  /** Bytes the Sandbox container's writable layer takes on the host (last measured), `null` if unknown. */
  diskBytes: z.number().int().nonnegative().nullable().default(null),
  /** Bytes taken by this Session's Snapshot images (each Snapshot stores a full copy of the writable layer). */
  snapshotBytes: z.number().int().nonnegative().default(0),
  snapshotCount: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof Session>;

export const CreateSessionRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  provider: Provider.default("claude-code"),
  workspaceSource: WorkspaceSource.default({ type: "empty" }),
  /** Docker daemon inside the Sandbox; defaults to the `dockerInSandbox` setting. */
  docker: z.boolean().optional(),
  /** MCP server ids to enable; defaults to the servers marked `enabledByDefault`. */
  mcpEnabled: z.array(z.string()).optional(),
  prompt: z.string().min(1).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const UpdateSessionRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  /** `null` clears the override (follow `Settings.autoSnapshot`). */
  autoSnapshot: z.boolean().nullable().optional(),
  mcpEnabled: z.array(z.string()).optional(),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

export const PromptRequest = z.object({
  text: z.string().min(1),
});
export type PromptRequest = z.infer<typeof PromptRequest>;

/** One-shot question to the Session's Provider in a fresh, context-free ACP session; not part of the transcript. */
export const AskRequest = z.object({
  text: z.string().min(1).max(20_000),
});
export type AskRequest = z.infer<typeof AskRequest>;

export const AskResult = z.object({ text: z.string() });
export type AskResult = z.infer<typeof AskResult>;

// ---------------------------------------------------------------------------
// Saved messages: prompts kept per Session ("save for later"), ordered; played
// as a queue one turn at a time while `Session.queueRunning`.
// ---------------------------------------------------------------------------

export const SavedMessage = z.object({
  id: z.string(),
  sessionId: z.string(),
  text: z.string(),
  /** 0-based order in the Session's list. */
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type SavedMessage = z.infer<typeof SavedMessage>;

export const SaveMessageRequest = z.object({ text: z.string().min(1) });
export type SaveMessageRequest = z.infer<typeof SaveMessageRequest>;

export const UpdateSavedMessageRequest = z
  .object({ text: z.string().min(1), position: z.number().int().nonnegative() })
  .partial();
export type UpdateSavedMessageRequest = z.infer<typeof UpdateSavedMessageRequest>;

export const QueueRequest = z.object({ running: z.boolean() });
export type QueueRequest = z.infer<typeof QueueRequest>;

// ---------------------------------------------------------------------------
// Snapshots: `docker commit` of a Session's Sandbox, taken after every Agent turn
// (when `Settings.autoSnapshot`) or on demand. A Snapshot is a fork point: a new
// Session can start a fresh Sandbox from its image with the conversation so far.
// ---------------------------------------------------------------------------

export const SNAPSHOT_REASONS = ["turn", "manual"] as const;
export const SnapshotReason = z.enum(SNAPSHOT_REASONS);
export type SnapshotReason = z.infer<typeof SnapshotReason>;

export const Snapshot = z.object({
  id: z.string(),
  sessionId: z.string(),
  /** 1-based, increasing per Session; shown as "snapshot N". */
  ordinal: z.number().int().positive(),
  reason: SnapshotReason,
  /** Docker image reference (`sessionboxer/snapshot:<sessionId>-<ordinal>`). */
  imageTag: z.string(),
  imageId: z.string(),
  /** Last Session event included in the Snapshot; the transcript marker goes right after it. */
  eventSeq: z.number().int().nonnegative(),
  /** Size of the committed layer (the Sandbox's writable layer at that moment). */
  sizeBytes: z.number().int().nonnegative(),
  /** Saved messages that were queued when the Snapshot was taken (candidates for the fork's first prompt). */
  queuedMessages: z.array(z.string()),
  createdAt: z.string(),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const DeleteSnapshotsResult = z.object({
  deleted: z.number().int().nonnegative(),
  /** Snapshots left in place because a fork was started from them. */
  kept: z.number().int().nonnegative(),
});
export type DeleteSnapshotsResult = z.infer<typeof DeleteSnapshotsResult>;

export const ForkSessionRequest = z.object({
  snapshotId: z.string(),
  title: z.string().min(1).max(200).optional(),
  /** Sent to the fork as soon as its Sandbox is ready. */
  prompt: z.string().min(1).optional(),
  /** Texts to put in the fork's saved-message list, in order. */
  savedMessages: z.array(z.string().min(1)).default([]),
});
export type ForkSessionRequest = z.infer<typeof ForkSessionRequest>;

/** One level of the host filesystem, for picking a "copy" Workspace Source in the UI. */
export const HostDirListing = z.object({
  /** Canonical absolute path of the listed directory. */
  path: z.string(),
  /** `null` at the filesystem root. */
  parent: z.string().nullable(),
  /** Subdirectory names, sorted; hidden ones are skipped. */
  dirs: z.array(z.string()),
  /** True when `path` is inside a git work tree. */
  git: z.boolean(),
});
export type HostDirListing = z.infer<typeof HostDirListing>;

// ---------------------------------------------------------------------------
// Settings (stored in ~/.sessionboxer/config.json, 0600)
// ---------------------------------------------------------------------------

export const Settings = z.object({
  gitUserName: z.string().default(""),
  gitUserEmail: z.string().default(""),
  sandboxCpus: z.number().positive().default(2),
  sandboxMemoryGb: z.number().positive().default(4),
  dockerInSandbox: z.boolean().default(false),
  /** `docker commit` the Sandbox after every Agent turn. */
  autoSnapshot: z.boolean().default(true),
  /** Automatic Snapshots kept per Session (oldest pruned first); 0 keeps all. */
  snapshotKeep: z.number().int().nonnegative().default(10),
  mcpServers: z.array(McpServerDef).default([]),
  providerSecrets: z
    .object({
      "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.string().default("") }).default({}),
      devin: z.object({ WINDSURF_API_KEY: z.string().default("") }).default({}),
    })
    .default({}),
});
export type Settings = z.infer<typeof Settings>;

/** Settings as returned to the UI: secrets replaced by a boolean "is set". */
export const PublicSettings = Settings.omit({ providerSecrets: true, mcpServers: true }).extend({
  mcpServers: z.array(PublicMcpServerDef),
  providerSecretsSet: z.object({
    "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.boolean() }),
    devin: z.object({ WINDSURF_API_KEY: z.boolean() }),
  }),
  /** Mode a Docker-enabled Session created now would get, given the host's runtimes. */
  dockerModeAvailable: DockerMode.exclude(["none"]),
});
export type PublicSettings = z.infer<typeof PublicSettings>;

export const UpdateSettingsRequest = Settings.omit({ mcpServers: true }).partial().extend({
  /** Whole registry; `null` secret values keep what is stored for that server/name. */
  mcpServers: z.array(PublicMcpServerDef).optional(),
  providerSecrets: z
    .object({
      "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.string() }).partial(),
      devin: z.object({ WINDSURF_API_KEY: z.string() }).partial(),
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
  | { type: "status"; status: SessionStatus; error?: string }
  /** First event of a forked Session: everything before it was copied from the origin. */
  | { type: "forked"; fromSessionId: string; fromTitle: string; snapshotId: string; snapshotOrdinal: number }
  /** The Daemon restarted the Agent with a new MCP server set (names, `desktop` excluded). */
  | { type: "mcp_changed"; servers: string[] };

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
  | { type: "event"; event: SessionEvent }
  | { type: "fs_changed"; sessionId: string; changes: FsChange[] }
  | { type: "saved_messages"; sessionId: string; messages: SavedMessage[] }
  | { type: "snapshots"; sessionId: string; snapshots: Snapshot[] }
  /** A `docker commit` is in progress (the Sandbox is paused for a few seconds). */
  | { type: "snapshotting"; sessionId: string; active: boolean };

// ---------------------------------------------------------------------------
// Workspace files (UI <-> Control Plane <-> Daemon). Paths are relative to the
// Workspace root, `""` being the root itself; the Daemon rejects escapes.
// ---------------------------------------------------------------------------

export const FS_MAX_FILE_BYTES = 2 * 1024 * 1024;

export const FsEntry = z.object({
  name: z.string(),
  type: z.enum(["file", "dir", "symlink", "other"]),
  size: z.number().int().nonnegative(),
  mtime: z.string(),
});
export type FsEntry = z.infer<typeof FsEntry>;

export const FsPathParams = z.object({ path: z.string() });
export type FsPathParams = z.infer<typeof FsPathParams>;

export const FsListResult = z.object({ path: z.string(), entries: z.array(FsEntry) });
export type FsListResult = z.infer<typeof FsListResult>;

/** `content` is absent for binary files and for files over `FS_MAX_FILE_BYTES`. */
export const FsReadResult = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.string(),
  content: z.string().optional(),
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type FsReadResult = z.infer<typeof FsReadResult>;

export const FsWriteParams = z.object({ path: z.string(), content: z.string() });
export type FsWriteParams = z.infer<typeof FsWriteParams>;

export const FsWriteResult = z.object({ path: z.string(), size: z.number().int().nonnegative(), mtime: z.string() });
export type FsWriteResult = z.infer<typeof FsWriteResult>;

export const FsChange = z.object({
  path: z.string(),
  kind: z.enum(["created", "modified", "deleted"]),
  isDir: z.boolean(),
});
export type FsChange = z.infer<typeof FsChange>;

/** Daemon -> Control Plane notification, debounced; not buffered/replayed. */
export const FsChangedParams = z.object({ changes: z.array(FsChange) });
export type FsChangedParams = z.infer<typeof FsChangedParams>;

// ---------------------------------------------------------------------------
// Terminals (UI <-> Control Plane <-> Daemon). PTYs live in the Daemon, so they
// survive UI reloads and Control Plane restarts; byte payloads are base64.
// ---------------------------------------------------------------------------

export const PTY_SCROLLBACK_BYTES = 256 * 1024;

export const PtyInfo = z.object({
  id: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** Process exit code once the shell has exited; `null` while it runs. */
  exitCode: z.number().int().nullable(),
  createdAt: z.string(),
});
export type PtyInfo = z.infer<typeof PtyInfo>;

export const PtyListResult = z.object({ terminals: z.array(PtyInfo) });
export type PtyListResult = z.infer<typeof PtyListResult>;

export const PtyOpenParams = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
});
export type PtyOpenParams = z.infer<typeof PtyOpenParams>;

export const PtyIdParams = z.object({ id: z.string() });
export type PtyIdParams = z.infer<typeof PtyIdParams>;

/** Attaching returns the retained scrollback (last `PTY_SCROLLBACK_BYTES`), base64. */
export const PtyAttachResult = PtyInfo.extend({ scrollback: z.string() });
export type PtyAttachResult = z.infer<typeof PtyAttachResult>;

export const PtyInputParams = z.object({ id: z.string(), data: z.string() });
export type PtyInputParams = z.infer<typeof PtyInputParams>;

export const PtyResizeParams = PtyOpenParams.extend({ id: z.string() });
export type PtyResizeParams = z.infer<typeof PtyResizeParams>;

/** Daemon -> Control Plane notifications. */
export const PtyOutputParams = z.object({ id: z.string(), data: z.string() });
export type PtyOutputParams = z.infer<typeof PtyOutputParams>;

export const PtyExitParams = z.object({ id: z.string(), exitCode: z.number().int() });
export type PtyExitParams = z.infer<typeof PtyExitParams>;

/**
 * Frames on the UI terminal WebSocket (`/api/sessions/:id/terminals/:ptyId/ws`).
 * Binary frames carry raw bytes (input from the UI, output from the shell);
 * text frames carry these JSON control messages.
 */
export type TerminalClientMessage = { type: "resize"; cols: number; rows: number };
export type TerminalServerMessage =
  | { type: "attached"; terminal: PtyInfo }
  | { type: "exit"; exitCode: number }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Sandbox Daemon RPC (Control Plane <-> Daemon, JSON-RPC 2.0 over WebSocket).
// Method names use ACP's `_<vendor>/` extension convention.
// ---------------------------------------------------------------------------

export const DAEMON_PORT = 7000;
/** websockify in front of x11vnc inside the Sandbox; the Control Plane proxies it to the UI. */
export const NOVNC_PORT = 6080;
export const DESKTOP_WIDTH = 1024;
export const DESKTOP_HEIGHT = 768;

export const DAEMON_METHODS = {
  hello: "_sessionboxer/hello",
  prompt: "_sessionboxer/prompt",
  ask: "_sessionboxer/ask",
  mcpSet: "_sessionboxer/mcp/set",
  cancel: "_sessionboxer/cancel",
  status: "_sessionboxer/status",
  event: "_sessionboxer/event",
  fsList: "_sessionboxer/fs/list",
  fsRead: "_sessionboxer/fs/read",
  fsWrite: "_sessionboxer/fs/write",
  fsChanged: "_sessionboxer/fs/changed",
  ptyList: "_sessionboxer/pty/list",
  ptyOpen: "_sessionboxer/pty/open",
  ptyAttach: "_sessionboxer/pty/attach",
  ptyInput: "_sessionboxer/pty/input",
  ptyResize: "_sessionboxer/pty/resize",
  ptyClose: "_sessionboxer/pty/close",
  ptyOutput: "_sessionboxer/pty/output",
  ptyExit: "_sessionboxer/pty/exit",
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
  /** Names of the user MCP servers the running Agent was started with; `null` until the first `mcp/set`. */
  mcpServers: z.array(z.string()).nullable().default(null),
  /** An `mcp/set` is waiting for the current turn to end. */
  mcpPending: z.boolean().default(false),
});
export type DaemonStatus = z.infer<typeof DaemonStatus>;

/**
 * Replaces the user MCP server set. The Agent (re)starts with it right away when idle,
 * otherwise once the current turn ends; `mcp_changed` is emitted when it has been applied.
 */
export const DaemonMcpSetParams = z.object({ servers: z.array(McpServerSpec) });
export type DaemonMcpSetParams = z.infer<typeof DaemonMcpSetParams>;

export const DaemonMcpSetResult = z.object({
  /** False when the change was deferred to the end of the active turn. */
  applied: z.boolean(),
});
export type DaemonMcpSetResult = z.infer<typeof DaemonMcpSetResult>;

export const DaemonPromptParams = z.object({ text: z.string().min(1) });
export type DaemonPromptParams = z.infer<typeof DaemonPromptParams>;

/** The turn runs asynchronously; its outcome arrives as `turn_ended`/`agent_error` events. */
export const DaemonPromptResult = z.object({ accepted: z.boolean() });
export type DaemonPromptResult = z.infer<typeof DaemonPromptResult>;

/** Synchronous: resolves with the Agent's reply once the throwaway session's turn ends. */
export const DaemonAskParams = AskRequest;
export type DaemonAskParams = AskRequest;
export const DaemonAskResult = AskResult;
export type DaemonAskResult = AskResult;

/** Daemon -> Control Plane notification. `body` never carries `status`. */
export interface DaemonEvent {
  epoch: string;
  seq: number;
  ts: string;
  body: Exclude<SessionEventBody, { type: "status" } | { type: "forked" }>;
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
