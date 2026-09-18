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

// Connectors: presets for well-known remote MCP servers whose login the Control
// Plane runs itself (OAuth), so the user clicks "Connect" instead of pasting a
// token. The same preset can be added several times, once per account.
export const CONNECTOR_KINDS = ["github"] as const;
export const ConnectorKind = z.enum(CONNECTOR_KINDS);
export type ConnectorKind = z.infer<typeof ConnectorKind>;

export const CONNECTORS: Record<
  ConnectorKind,
  { label: string; url: string; readonlyUrl: string; scopes: string[]; defaultClientId: string; tokenHeader: string }
> = {
  github: {
    label: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    readonlyUrl: "https://api.githubcopilot.com/mcp/readonly",
    scopes: ["repo", "workflow", "read:org", "read:user", "user:email", "gist", "notifications", "project"],
    /** The "Sessionboxer" OAuth App on github.com (Device Flow enabled); Settings can point at another. */
    defaultClientId: "Ov23liy480AEYdv2nOiD",
    tokenHeader: "Authorization",
  },
};

/** Login state of a registry entry made from a Connector; the token itself lives in `headers`. */
export const McpConnector = z.object({
  kind: ConnectorKind,
  /** Account the stored token belongs to (`login`), `null` until connected. */
  account: z.string().nullable().default(null),
  connectedAt: z.string().nullable().default(null),
  /** Set when the OAuth App issues expiring tokens; Sessionboxer does not refresh them. */
  expiresAt: z.string().nullable().default(null),
});
export type McpConnector = z.infer<typeof McpConnector>;

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
  connector: McpConnector.nullable().default(null),
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
export const McpServerSpec = McpServerDef.omit({ enabledByDefault: true, connector: true });
export type McpServerSpec = z.infer<typeof McpServerSpec>;

// ---------------------------------------------------------------------------
// Models: each Provider's ACP adapter advertises the models it can run as the
// `model` session config option (ACP `configOptions`), and switches with
// `session/set_config_option`. The Control Plane remembers the last list seen
// per Provider so New Session can offer it before a Sandbox exists.
// ---------------------------------------------------------------------------

export const ModelOption = z.object({
  /** Value understood by the Agent (`sonnet`, `opus[1m]`, `claude-sonnet-5-low`, …). */
  value: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  /** Group label when the Agent organises its list (ACP select groups). */
  group: z.string().nullable().default(null),
});
export type ModelOption = z.infer<typeof ModelOption>;

/** Last model list seen from each Provider's Agent; empty until a Session of that Provider has started. */
export type ProviderModels = Record<Provider, ModelOption[]>;

// ---------------------------------------------------------------------------
// Agent options: the other `select` config options an Agent advertises besides
// the model and the permission mode (claude-agent-acp: `effort`, `fast`). They
// are set the same way (`session/set_config_option`) and the set on offer can
// change with the model, so a Session carries both the values it asked for and
// what its Agent currently advertises.
// ---------------------------------------------------------------------------

export const OptionChoice = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
});
export type OptionChoice = z.infer<typeof OptionChoice>;

export const AgentOption = z.object({
  /** ACP config option id (`effort`, `fast`, …). */
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  category: z.string().nullable().default(null),
  choices: z.array(OptionChoice),
});
export type AgentOption = z.infer<typeof AgentOption>;

/** Option values by option id. */
export const OptionValues = z.record(z.string().min(1), z.string().min(1));
export type OptionValues = z.infer<typeof OptionValues>;

/** Every option each Provider's Agent has ever advertised (merged by id), so New Session can offer them. */
export type ProviderOptions = Record<Provider, AgentOption[]>;

/** Claude aliases Sessionboxer allows by default (Claude's own list plus Fable, which the SDK hides otherwise). */
export const DEFAULT_CLAUDE_MODELS = ["opus", "sonnet", "haiku", "fable"];

// ---------------------------------------------------------------------------
// Branches: "revert to here" at a turn boundary keeps the conversation that
// followed as a branch and continues from that point on a new one. Branches
// share the Session's Sandbox; only the active branch talks to the Agent.
// ---------------------------------------------------------------------------

/** Id of the Session's original conversation. */
export const ROOT_BRANCH_ID = "root";

export const BRANCH_METHODS = ["fork", "replay"] as const;
/** How the Agent's memory was rewound: an ACP `session/fork` at the message, or a new session fed the transcript. */
export const BranchMethod = z.enum(BRANCH_METHODS);
export type BranchMethod = z.infer<typeof BranchMethod>;

export const Branch = z.object({
  id: z.string(),
  sessionId: z.string(),
  name: z.string(),
  /** `null` for the root branch. */
  parentId: z.string().nullable(),
  /** `turn_ended` event of the parent this branch continues from; `null` for the root branch. */
  forkedAtSeq: z.number().int().nullable(),
  method: BranchMethod.nullable(),
  createdAt: z.string(),
});
export type Branch = z.infer<typeof Branch>;

/** A branch's view of the transcript: its own events plus each ancestor's up to the fork point. */
export type BranchScope = Array<{ branchId: string; uptoSeq: number }>;

export function branchScope(branches: Branch[], activeBranchId: string): BranchScope {
  const scope: BranchScope = [];
  let id: string | null = activeBranchId;
  let upto = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    scope.push({ branchId: id, uptoSeq: upto });
    const branch = branches.find((b) => b.id === id);
    if (!branch || branch.parentId === null || branch.forkedAtSeq === null) break;
    upto = branch.forkedAtSeq;
    id = branch.parentId;
  }
  return scope;
}

export function inBranchScope(scope: BranchScope, branchId: string, seq: number): boolean {
  return scope.some((s) => s.branchId === branchId && seq <= s.uptoSeq);
}

export const RevertRequest = z.object({
  /** `seq` of the `turn_ended` event to continue from (the divider in the transcript). */
  seq: z.number().int().positive(),
});
export type RevertRequest = z.infer<typeof RevertRequest>;

export const SwitchBranchRequest = z.object({ branchId: z.string().min(1) });
export type SwitchBranchRequest = z.infer<typeof SwitchBranchRequest>;

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
  /** Model the Agent runs (a `ModelOption.value`); `null` until the Agent has reported its default. */
  model: z.string().nullable().default(null),
  /** The Agent is busy; the model change is applied when the current turn ends. */
  modelPending: z.boolean().default(false),
  /** Values asked for (or reported by the Agent) of its other options, by option id. */
  options: OptionValues.default({}),
  /** The Agent is busy; the option change is applied when the current turn ends. */
  optionsPending: z.boolean().default(false),
  /** Options the Session's Agent currently advertises (depends on the model). */
  availableOptions: z.array(AgentOption).default([]),
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
  /** Conversation branches; empty until the first "revert", then the root and every branch. */
  branches: z.array(Branch).default([]),
  /** Branch the transcript shows and prompts go to. */
  activeBranchId: z.string().default(ROOT_BRANCH_ID),
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
  /** Model to switch to once the Agent is up; omitted keeps the Provider's default. */
  model: z.string().min(1).optional(),
  /** Other option values (effort, fast mode, …) to set once the Agent is up. */
  options: OptionValues.optional(),
  prompt: z.string().min(1).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const UpdateSessionRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  /** `null` clears the override (follow `Settings.autoSnapshot`). */
  autoSnapshot: z.boolean().nullable().optional(),
  mcpEnabled: z.array(z.string()).optional(),
  model: z.string().min(1).optional(),
  /** Merged into the Session's option values. */
  options: OptionValues.optional(),
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
  /** Branch that was active when the Snapshot was taken. */
  branchId: z.string().default(ROOT_BRANCH_ID),
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
  /**
   * Model aliases Claude Code may offer (its `availableModels` setting, written to the Sandbox's
   * `~/.claude/settings.json`); `default` is always kept. Empty leaves Claude's built-in list.
   */
  claudeModels: z.array(z.string().min(1)).default(DEFAULT_CLAUDE_MODELS),
  /**
   * Copy the CA certificates this machine trusts beyond the public ones (corporate proxies,
   * Cloudflare WARP, mitmproxy…) into every Sandbox's trust store, so TLS works there too.
   */
  trustHostCaCerts: z.boolean().default(true),
  /** Additional CA certificates for Sandboxes, PEM (`-----BEGIN CERTIFICATE-----` blocks). */
  extraCaCerts: z.string().default(""),
  providerSecrets: z
    .object({
      "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.string().default("") }).default({}),
      devin: z.object({ WINDSURF_API_KEY: z.string().default("") }).default({}),
    })
    .default({}),
  /** OAuth App used by each Connector's login; empty `clientId` means the built-in one. */
  connectors: z
    .object({
      github: z.object({ clientId: z.string().default(""), clientSecret: z.string().default("") }).default({}),
    })
    .default({}),
});
export type Settings = z.infer<typeof Settings>;

/** Settings as returned to the UI: secrets replaced by a boolean "is set". */
export const PublicSettings = Settings.omit({ providerSecrets: true, mcpServers: true, connectors: true }).extend({
  mcpServers: z.array(PublicMcpServerDef),
  providerSecretsSet: z.object({
    "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.boolean() }),
    devin: z.object({ WINDSURF_API_KEY: z.boolean() }),
  }),
  connectors: z.object({
    github: z.object({ clientId: z.string(), clientSecretSet: z.boolean() }),
  }),
  /** Mode a Docker-enabled Session created now would get, given the host's runtimes. */
  dockerModeAvailable: DockerMode.exclude(["none"]),
  /** Subjects of the non-public CA certificates found in this machine's trust store. */
  hostCaCerts: z.array(z.string()),
});
export type PublicSettings = z.infer<typeof PublicSettings>;

export const UpdateSettingsRequest = Settings.omit({ mcpServers: true, connectors: true }).partial().extend({
  /** Whole registry; `null` secret values keep what is stored for that server/name. */
  mcpServers: z.array(PublicMcpServerDef).optional(),
  providerSecrets: z
    .object({
      "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.string() }).partial(),
      devin: z.object({ WINDSURF_API_KEY: z.string() }).partial(),
    })
    .partial()
    .optional(),
  /** `clientSecret: ""` forgets the stored secret (device-code login is used then). */
  connectors: z
    .object({
      github: z.object({ clientId: z.string(), clientSecret: z.string() }).partial(),
    })
    .partial()
    .optional(),
});
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequest>;

// ---------------------------------------------------------------------------
// Connector login flows (Control Plane `/api/connectors/...`)
// ---------------------------------------------------------------------------

/**
 * How a Connector login mints its token:
 * - `gh`: GitHub CLI's own device login (GitHub's first-party app, so organization OAuth-App
 *   restrictions don't apply); `gh` is downloaded if the machine lacks it.
 * - `gh-existing`: reuse a login `gh` already has on this machine (`account` picks which).
 * - `app`: the Sessionboxer OAuth App (or the one from Settings); organizations may block it.
 */
export const ConnectorVia = z.enum(["gh", "gh-existing", "app"]);
export type ConnectorVia = z.infer<typeof ConnectorVia>;

/** Starts a login for a registry entry; a missing/unknown `serverId` creates the entry from the preset. */
export const ConnectorStartRequest = z.object({
  serverId: z.string().nullable().default(null),
  name: z.string().regex(MCP_NAME_PATTERN, "letters, digits, `_` and `-` only"),
  via: ConnectorVia.default("gh"),
  /** `gh-existing`: the `gh` account whose token to reuse. */
  account: z.string().nullable().default(null),
});
export type ConnectorStartRequest = z.infer<typeof ConnectorStartRequest>;

/** What the GitHub CLI on this machine offers to Connector logins. */
export const GhCliStatus = z.object({
  /** `gh` found on PATH or already downloaded by Sessionboxer. */
  available: z.boolean(),
  version: z.string().nullable(),
  /** Accounts `gh` is logged in to on this machine (reusable with `via: "gh-existing"`). */
  logins: z.array(z.string()),
});
export type GhCliStatus = z.infer<typeof GhCliStatus>;

export const ConnectorFlow = z.object({
  id: z.string(),
  kind: ConnectorKind,
  serverId: z.string(),
  via: ConnectorVia,
  /** `redirect`: open `url` and come back; `device`: enter `userCode` at `verificationUri`. */
  mode: z.enum(["redirect", "device"]),
  url: z.string().nullable(),
  userCode: z.string().nullable(),
  verificationUri: z.string().nullable(),
  expiresAt: z.string(),
  status: z.enum(["pending", "done", "error"]),
  error: z.string().nullable(),
  /** The registry entry being connected, as stored (token hidden like any secret header). */
  server: PublicMcpServerDef,
});
export type ConnectorFlow = z.infer<typeof ConnectorFlow>;

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
  | { type: "mcp_changed"; servers: string[] }
  /** The Agent switched model (`name` is the human label, `model` the value). */
  | { type: "model_changed"; model: string; name: string }
  /** One of the Agent's other options changed (`name`/`valueName` are the human labels). */
  | { type: "option_changed"; id: string; name: string; value: string; valueName: string };

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
  | { type: "event"; event: SessionEvent }
  | { type: "fs_changed"; sessionId: string; changes: FsChange[] }
  | { type: "saved_messages"; sessionId: string; messages: SavedMessage[] }
  | { type: "snapshots"; sessionId: string; snapshots: Snapshot[] }
  /** A `docker commit` is in progress (the Sandbox is paused for a few seconds). */
  | { type: "snapshotting"; sessionId: string; active: boolean }
  /** A Provider's Agent reported its model list (differs from what was remembered). */
  | { type: "models"; provider: Provider; models: ModelOption[] }
  /** A Provider's Agent advertised options not remembered before (or changed ones). */
  | { type: "options"; provider: Provider; options: AgentOption[] };

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

// Raw (binary) Workspace files are served over HTTP rather than JSON-RPC, so the browser can
// stream a video with Range requests: Daemon `GET /fs/raw?path=…`, proxied by the Control Plane
// as `GET /api/sessions/:id/fs/raw?path=…[&download=1]`.
export const FS_RAW_PATH = "/fs/raw";

/** How the chat embeds a Workspace file the Agent mentions; `null` = shown as a plain link. */
export type MediaKind = "video" | "audio" | "image" | "pdf" | "markdown" | "mermaid";

const MEDIA_TYPES: Record<string, [MediaKind, string]> = {
  mp4: ["video", "video/mp4"],
  m4v: ["video", "video/mp4"],
  webm: ["video", "video/webm"],
  mov: ["video", "video/quicktime"],
  mp3: ["audio", "audio/mpeg"],
  wav: ["audio", "audio/wav"],
  ogg: ["audio", "audio/ogg"],
  m4a: ["audio", "audio/mp4"],
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  svg: ["image", "image/svg+xml"],
  pdf: ["pdf", "application/pdf"],
  md: ["markdown", "text/markdown; charset=utf-8"],
  markdown: ["markdown", "text/markdown; charset=utf-8"],
  mmd: ["mermaid", "text/plain; charset=utf-8"],
  mermaid: ["mermaid", "text/plain; charset=utf-8"],
};

/** Regular expression source matching any embeddable file extension (no anchors, no dot). */
export const MEDIA_EXTENSIONS = Object.keys(MEDIA_TYPES).join("|");

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function mediaKind(path: string): MediaKind | null {
  return MEDIA_TYPES[extensionOf(path)]?.[0] ?? null;
}

export function contentTypeFor(path: string): string {
  return MEDIA_TYPES[extensionOf(path)]?.[1] ?? "application/octet-stream";
}

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
// Code pane (UI <-> Control Plane <-> Daemon). VS Code runs inside the Sandbox as
// `openvscode-server` on the loopback interface, started on demand by the Daemon; its
// HTTP and WebSocket traffic is reverse-proxied under `CODE_PATH` on the Daemon port and
// again by the Control Plane under `/api/sessions/:id/code`, which is what the iframe loads.
// ---------------------------------------------------------------------------

export const CODE_PATH = "/code";

export const CodeServerStatus = z.object({
  state: z.enum(["stopped", "starting", "running", "failed"]),
  /** Server version (`openvscode-server --version` first line) once known. */
  version: z.string().nullable(),
  /** Why the last start failed, for the UI. */
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
});
export type CodeServerStatus = z.infer<typeof CodeServerStatus>;

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
  modelSet: "_sessionboxer/model/set",
  optionSet: "_sessionboxer/option/set",
  claudeModelsSet: "_sessionboxer/claude-models/set",
  sessionFork: "_sessionboxer/session/fork",
  sessionSwitch: "_sessionboxer/session/switch",
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
  codeStart: "_sessionboxer/code/start",
  codeStatus: "_sessionboxer/code/status",
  codeStop: "_sessionboxer/code/stop",
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
  /** Models the Agent advertises; `null` when it has not reported any (yet). */
  models: z.array(ModelOption).nullable().default(null),
  /** Model requested via `model/set` (even if still pending), else the one the Agent reports; `null` if unknown. */
  model: z.string().nullable().default(null),
  modelPending: z.boolean().default(false),
  /** Other options the Agent currently advertises; `null` until the Agent has reported its config. */
  options: z.array(AgentOption).nullable().default(null),
  /** Requested values (even if still pending), else what the Agent reports, by option id. */
  optionValues: OptionValues.default({}),
  optionsPending: z.boolean().default(false),
});
export type DaemonStatus = z.infer<typeof DaemonStatus>;

/**
 * A login the Sandbox itself gets while the matching Connector entry is enabled: `gh` and
 * `git push` to github.com work as `account`, in the Agent's shell and in the Terminal pane.
 * Kept on tmpfs in the Sandbox, so it is gone from Snapshots and after the entry is switched off.
 */
export const BoxCredential = z.object({
  kind: ConnectorKind,
  account: z.string(),
  token: z.string(),
});
export type BoxCredential = z.infer<typeof BoxCredential>;

/**
 * Replaces the user MCP server set. The Agent (re)starts with it right away when idle,
 * otherwise once the current turn ends; `mcp_changed` is emitted when it has been applied.
 * Sandbox credentials are applied immediately either way (nothing needs a restart to see them).
 */
export const DaemonMcpSetParams = z.object({
  servers: z.array(McpServerSpec),
  /** First entry is the active one when several accounts of a kind are enabled. */
  credentials: z.array(BoxCredential).default([]),
});
export type DaemonMcpSetParams = z.infer<typeof DaemonMcpSetParams>;

export const DaemonMcpSetResult = z.object({
  /** False when the change was deferred to the end of the active turn. */
  applied: z.boolean(),
});
export type DaemonMcpSetResult = z.infer<typeof DaemonMcpSetResult>;

/**
 * Switches the Agent's model (ACP `session/set_config_option` on the `model` option). Applied right
 * away when idle, otherwise once the current turn ends; `model_changed` is emitted when it took effect.
 */
export const DaemonModelSetParams = z.object({ model: z.string().min(1) });
export type DaemonModelSetParams = z.infer<typeof DaemonModelSetParams>;

export const DaemonModelSetResult = z.object({ applied: z.boolean() });
export type DaemonModelSetResult = z.infer<typeof DaemonModelSetResult>;

/**
 * Sets other config options of the Agent (`session/set_config_option` per id), merged into
 * the current values. Same timing as `model/set`; `option_changed` is emitted per option applied.
 */
export const DaemonOptionSetParams = z.object({
  options: OptionValues,
  /** Skip (instead of failing on) options or values the Agent does not offer with its current model. */
  lenient: z.boolean().default(false),
});
export type DaemonOptionSetParams = z.infer<typeof DaemonOptionSetParams>;

export const DaemonOptionSetResult = z.object({ applied: z.boolean() });
export type DaemonOptionSetResult = z.infer<typeof DaemonOptionSetResult>;

/**
 * Sets Claude Code's `availableModels` allowlist in the Sandbox. Takes effect on the next Agent
 * start: right away (restart in place, like `mcp/set`) when the Agent runs with another list and
 * is idle, once the current turn ends otherwise. Ignored by Daemons of other Providers.
 */
export const DaemonClaudeModelsSetParams = z.object({ models: z.array(z.string().min(1)) });
export type DaemonClaudeModelsSetParams = z.infer<typeof DaemonClaudeModelsSetParams>;

export const DaemonClaudeModelsSetResult = z.object({ applied: z.boolean() });
export type DaemonClaudeModelsSetResult = z.infer<typeof DaemonClaudeModelsSetResult>;

/**
 * Rewinds the Agent to an earlier point and continues on a new ACP session: `session/fork` at
 * `messageId` (the last assistant message to keep; `null` forks the whole history) when the Agent
 * supports forking, otherwise a fresh session primed with `replay` (the transcript so far).
 * Fails while a turn is active. The Daemon switches to the new session.
 */
export const DaemonSessionForkParams = z.object({
  messageId: z.string().nullable(),
  replay: z.string().nullable(),
});
export type DaemonSessionForkParams = z.infer<typeof DaemonSessionForkParams>;

export const DaemonSessionForkResult = z.object({ acpSessionId: z.string(), method: BranchMethod });
export type DaemonSessionForkResult = z.infer<typeof DaemonSessionForkResult>;

/** Makes `acpSessionId` the Agent's session (restarting it with `session/load`); fails while a turn is active. */
export const DaemonSessionSwitchParams = z.object({ acpSessionId: z.string().min(1) });
export type DaemonSessionSwitchParams = z.infer<typeof DaemonSessionSwitchParams>;

export const DaemonSessionSwitchResult = z.object({ acpSessionId: z.string() });
export type DaemonSessionSwitchResult = z.infer<typeof DaemonSessionSwitchResult>;

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
