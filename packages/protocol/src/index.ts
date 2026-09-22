import { z } from "zod";
import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk";

export type { SessionUpdate, StopReason, ContentBlock, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";

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
// Repositories. The Workspace (`/workspace`) is the Session's root; every repository the
// Session works on sits in its own directory right below it (`/workspace/<name>`), also when
// there is only one. Repositories can be added and removed while the Session runs; the Agent
// finds the list in `.sessionboxer/repos.json`.
// ---------------------------------------------------------------------------

/** Where a repository comes from: a git clone (GitHub credentials apply) or a copy of a host folder. */
export const RepoSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("git"), url: z.string().min(1), ref: z.string().min(1).optional() }),
  z.object({ type: z.literal("copy"), path: z.string().min(1) }),
]);
export type RepoSource = z.infer<typeof RepoSource>;

export const REPO_NAME_MAX_CHARS = 100;
export const REPO_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** Directory name under `/workspace`: one path segment, no leading dot (keeps `.sessionboxer`, `.` and `..` out of reach). */
export const RepoName = z
  .string()
  .min(1)
  .max(REPO_NAME_MAX_CHARS)
  .regex(REPO_NAME_PATTERN, "Use letters, digits, '.', '_' and '-', not starting with a dot");
export type RepoName = z.infer<typeof RepoName>;

/** A repository to put in a Session (at creation or later). */
export const RepoSpec = z.object({
  /** Directory name under `/workspace`; omitted derives one from the source (last URL segment / folder name). */
  name: RepoName.optional(),
  source: RepoSource,
});
export type RepoSpec = z.infer<typeof RepoSpec>;

export const REPO_STATUSES = ["pending", "ready", "error"] as const;
export const RepoStatus = z.enum(REPO_STATUSES);
export type RepoStatus = z.infer<typeof RepoStatus>;

/** Git state of a repository directory as last seen in the Sandbox. */
export const RepoGitState = z.object({
  /** Checked-out branch; `null` for a detached HEAD or when the directory is not a git work tree. */
  branch: z.string().nullable(),
  /** `git status --porcelain` is not empty (also untracked files). */
  dirty: z.boolean(),
  /** Commits on HEAD that are not on its upstream; `null` when there is no upstream (or not git). */
  ahead: z.number().int().nonnegative().nullable(),
  /** Local branches other than the current one that have commits on no remote-tracking branch. */
  unpushedBranches: z.array(z.string()).default([]),
  git: z.boolean(),
  inspectedAt: z.string(),
});
export type RepoGitState = z.infer<typeof RepoGitState>;

/** Name of the repository record Sessions created before repositories had their own directories carry: their source sits at the Workspace root. */
export const WORKSPACE_ROOT_REPO = ".";

export const SessionRepo = z.object({
  id: z.string(),
  /** Directory under `/workspace` (`WORKSPACE_ROOT_REPO` for the pre-repositories layout). */
  name: z.string().min(1),
  source: RepoSource,
  status: RepoStatus,
  /** Why cloning/copying failed (`status === "error"`). */
  error: z.string().nullable().default(null),
  /** Last git inspection (after cloning, at every turn end, on request); `null` before the first one. */
  git: RepoGitState.nullable().default(null),
  createdAt: z.string(),
});
export type SessionRepo = z.infer<typeof SessionRepo>;

/** Workspace path of a repository's directory (relative, `""` for the root record). */
export function repoDir(repo: Pick<SessionRepo, "name">): string {
  return repo.name === WORKSPACE_ROOT_REPO ? "" : repo.name;
}

/** Human-readable origin of a repository: `owner/repo@ref` for git URLs, the folder path for copies. */
export function repoOriginLabel(source: RepoSource): string {
  if (source.type === "copy") return source.path;
  const trimmed = source.url.replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = trimmed.split(/[/:]/).filter((p) => p !== "");
  const short = parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : trimmed;
  return source.ref ? `${short}@${source.ref}` : short;
}

/** Directory name a source gets when none is given: the URL's last segment (without `.git`) or the folder's name, made to fit `RepoName`. */
export function repoNameFromSource(source: RepoSource): string {
  const raw = source.type === "copy" ? source.path : source.url.replace(/\.git$/, "");
  const last = raw.replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
  const safe = last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, REPO_NAME_MAX_CHARS);
  return safe === "" ? "repo" : safe;
}

export const AddRepoRequest = RepoSpec;
export type AddRepoRequest = z.infer<typeof AddRepoRequest>;

/** `force` removes the directory even when it holds uncommitted or unpushed work. */
export const RemoveRepoRequest = z.object({ force: z.boolean().default(false) });
export type RemoveRepoRequest = z.infer<typeof RemoveRepoRequest>;

/** Body of the 409 a removal gets while the repository holds work that would be lost. */
export const RepoRemovalBlocked = z.object({
  error: z.string(),
  git: RepoGitState,
});
export type RepoRemovalBlocked = z.infer<typeof RepoRemovalBlocked>;

/** Workspace-relative path of the machine-readable repository list the Agent reads. */
export const REPOS_MANIFEST_PATH = ".sessionboxer/repos.json";

export const ReposManifestEntry = z.object({
  name: z.string(),
  /** Absolute path in the Sandbox. */
  path: z.string(),
  source: RepoSource,
});
export type ReposManifestEntry = z.infer<typeof ReposManifestEntry>;

export const ReposManifest = z.object({
  workspace: z.string(),
  repos: z.array(ReposManifestEntry),
});
export type ReposManifest = z.infer<typeof ReposManifest>;

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

// Connectors: presets for well-known code hosts whose login the Control Plane runs
// itself, so the user clicks "Connect" instead of pasting tokens into headers. A GitHub
// entry is that host's remote MCP server plus a Sandbox login; a Bitbucket (Data Center)
// entry is a Sandbox login only (there is no MCP server to add), so its `url` is empty and
// it is left out of the Agent's MCP set. The same preset can be added several times, once
// per account (or per Bitbucket host).
export const CONNECTOR_KINDS = ["github", "bitbucket"] as const;
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
  bitbucket: {
    label: "Bitbucket",
    url: "",
    readonlyUrl: "",
    scopes: [],
    defaultClientId: "",
    tokenHeader: "Authorization",
  },
};

/** Whether an entry of this kind is an MCP server too, or (Bitbucket) only a Sandbox login. */
export function connectorHasMcp(kind: ConnectorKind): boolean {
  return CONNECTORS[kind].url !== "";
}

/** Login state of a registry entry made from a Connector; the token itself lives in `headers`. */
export const McpConnector = z.object({
  kind: ConnectorKind,
  /** Account the stored token belongs to (`login`), `null` until connected. */
  account: z.string().nullable().default(null),
  connectedAt: z.string().nullable().default(null),
  /** Set when the OAuth App issues expiring tokens; Sessionboxer does not refresh them. */
  expiresAt: z.string().nullable().default(null),
  /** Bitbucket: the Data Center host the token is for (`bitbucket.example.com`); `null` for GitHub. */
  host: z.string().nullable().default(null),
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

/** Shipped default for `Settings.instructions`. */
export const DEFAULT_INSTRUCTIONS = [
  "- Never author git commits as an agent: commits carry the user's git identity only, with no `Co-Authored-By` trailer, no \"generated with\" line and no mention of Claude, Devin or any other agent in commit messages or PR text.",
  "- After changing code, when the change can be exercised, run the application and use the desktop (mouse, keyboard, screenshots) to test it end to end, watching the change work. Record a video of the core part of the change with the desktop's start_recording/stop_recording tools and hand the user the file path so it plays in the chat.",
].join("\n");

export const INSTRUCTIONS_MAX_CHARS = 20_000;

/**
 * How a Session's `instructions` reach the Agent. `system-prompt`: appended to the Agent's system
 * prompt (claude-agent-acp accepts `_meta.systemPrompt.append` on session/new and session/load).
 * `first-prompt`: the Agent has no such hook (Devin CLI), so they are prepended to the first prompt
 * of every fresh ACP session the Daemon creates.
 */
export const InstructionsDelivery = z.enum(["system-prompt", "first-prompt"]);
export type InstructionsDelivery = z.infer<typeof InstructionsDelivery>;

export function instructionsDelivery(provider: Provider): InstructionsDelivery {
  return provider === "claude-code" ? "system-prompt" : "first-prompt";
}

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

/** Author/committer identity git in the Sandbox commits with; either part may be empty (git's own fallback then). */
export const GitIdentity = z.object({
  name: z.string().max(200).default(""),
  email: z.string().max(200).default(""),
});
export type GitIdentity = z.infer<typeof GitIdentity>;

// ---------------------------------------------------------------------------
// Per-Session settings: everything a Session is configured with, as one object
// (`Session.settings`), next to the runtime state the Control Plane and the
// Daemon own (status, pending flags, sizes, branches). Live fields (model,
// options, MCP, Inspect LLM, snapshots) change through `PATCH /api/sessions/:id`;
// the Sandbox block is fixed at creation and only changes by forking.
// ---------------------------------------------------------------------------

/** How the Sandbox was built; fixed for the Session's life (a fork can differ). */
export const SandboxSettings = z.object({
  dockerMode: DockerMode.default("none"),
  /** CPU limit; `null` follows `Settings.sandboxCpus` (read when a Sandbox is created or rebuilt). */
  cpus: z.number().positive().nullable().default(null),
  /** Memory limit; `null` follows `Settings.sandboxMemoryGb`. */
  memoryGb: z.number().positive().nullable().default(null),
  /** Identity the Sandbox's git uses (`user.name` / `user.email`). */
  gitIdentity: GitIdentity.default({ name: "", email: "" }),
});
export type SandboxSettings = z.infer<typeof SandboxSettings>;

export const SessionSettings = z.object({
  /** Model the Agent runs (a `ModelOption.value`); `null` until the Agent has reported its default. */
  model: z.string().nullable().default(null),
  /** Values asked for (or reported by the Agent) of its other options, by option id. */
  options: OptionValues.default({}),
  /**
   * Route the Agent's model API calls through the Sandbox's loopback inspector, which keeps the
   * exact request/response bodies (Claude Code only; see `LlmCall`). Off by default.
   */
  inspectLlm: z.boolean().default(false),
  /** Ids of the `Settings.mcpServers` entries enabled for this Session. */
  mcpEnabled: z.array(z.string()).default([]),
  /** Standing instructions the Agent got with this Session (see `instructionsDelivery`); fixed at creation. */
  instructions: z.string().max(INSTRUCTIONS_MAX_CHARS).default(""),
  /** Override of `Settings.autoSnapshot`; `null` follows the global setting. */
  autoSnapshot: z.boolean().nullable().default(null),
  /** Override of `Settings.snapshotKeep`; `null` follows the global setting. */
  snapshotKeep: z.number().int().nonnegative().nullable().default(null),
  sandbox: SandboxSettings.default({}),
});
export type SessionSettings = z.infer<typeof SessionSettings>;

/** Global values the `null` settings fall back to. */
export interface SessionSettingsDefaults {
  autoSnapshot: boolean;
  snapshotKeep: number;
  sandboxCpus: number;
  sandboxMemoryGb: number;
}

/** The values in force: each `null` replaced by the global default. */
export function resolveSessionSettings(
  settings: SessionSettings,
  defaults: SessionSettingsDefaults,
): { autoSnapshot: boolean; snapshotKeep: number; cpus: number; memoryGb: number } {
  return {
    autoSnapshot: settings.autoSnapshot ?? defaults.autoSnapshot,
    snapshotKeep: settings.snapshotKeep ?? defaults.snapshotKeep,
    cpus: settings.sandbox.cpus ?? defaults.sandboxCpus,
    memoryGb: settings.sandbox.memoryGb ?? defaults.sandboxMemoryGb,
  };
}

/** Live settings `PATCH /api/sessions/:id` accepts; unknown keys are rejected. */
export const SessionSettingsPatch = z
  .object({
    model: z.string().min(1).optional(),
    /** Merged into the Session's option values. */
    options: OptionValues.optional(),
    inspectLlm: z.boolean().optional(),
    mcpEnabled: z.array(z.string()).optional(),
    /** `null` clears the override (follow `Settings.autoSnapshot`). */
    autoSnapshot: z.boolean().nullable().optional(),
    /** `null` clears the override (follow `Settings.snapshotKeep`). */
    snapshotKeep: z.number().int().nonnegative().nullable().optional(),
    /** Resource limits; read when the next Sandbox is built (Rebuild, fork). */
    sandbox: z
      .object({
        cpus: z.number().positive().nullable().optional(),
        memoryGb: z.number().positive().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SessionSettingsPatch = z.infer<typeof SessionSettingsPatch>;

/** Settings a new Session (or a fork) asks for; whatever is omitted takes the global default (or the origin's, for a fork). */
export const SessionSettingsInput = z.object({
  model: z.string().min(1).nullable().optional(),
  options: OptionValues.optional(),
  inspectLlm: z.boolean().optional(),
  mcpEnabled: z.array(z.string()).optional(),
  instructions: z.string().max(INSTRUCTIONS_MAX_CHARS).optional(),
  autoSnapshot: z.boolean().nullable().optional(),
  snapshotKeep: z.number().int().nonnegative().nullable().optional(),
  sandbox: z
    .object({
      /** Docker daemon inside the Sandbox; the mode is whatever the host offers. */
      docker: z.boolean().optional(),
      cpus: z.number().positive().nullable().optional(),
      memoryGb: z.number().positive().nullable().optional(),
      /** An omitted part takes `Settings.gitUserName` / `gitUserEmail`, else the host's git config; `""` sends none. */
      gitIdentity: GitIdentity.partial().optional(),
    })
    .optional(),
});
export type SessionSettingsInput = z.infer<typeof SessionSettingsInput>;

/** Where a live setting change lands, in one sentence for the UI (same wording everywhere). */
export function applyNote(status: SessionStatus, how: "immediate" | "restart" | "next-sandbox"): string {
  if (how === "next-sandbox") return "Applies to the next Sandbox built for this Session (Rebuild Sandbox, or a fork).";
  if (status === "running") return "Applies when the current turn ends.";
  if (status === "idle") return how === "restart" ? "Restarts the Agent in place; the conversation is kept." : "Applies immediately.";
  return "Applies when the Session resumes.";
}

export const Session = z.object({
  id: z.string(),
  title: z.string(),
  provider: Provider,
  status: SessionStatus,
  /**
   * How the Sandbox itself started: `fork` (another Session's Snapshot) or `empty`. Sessions
   * created before repositories had their own directories still carry their `git`/`copy` source
   * here too; `repos` is authoritative for what is in the Workspace.
   */
  workspaceSource: WorkspaceSource,
  /** Repositories in the Workspace, one directory each, in the order they were added. */
  repos: z.array(SessionRepo).default([]),
  settings: SessionSettings.default({}),
  /** The Agent is busy; the last MCP change is applied when the current turn ends. */
  mcpPending: z.boolean().default(false),
  /** The Agent is busy; the model change is applied when the current turn ends. */
  modelPending: z.boolean().default(false),
  /** The Agent is busy; the option change is applied when the current turn ends. */
  optionsPending: z.boolean().default(false),
  /** Options the Session's Agent currently advertises (depends on the model). */
  availableOptions: z.array(AgentOption).default([]),
  /** The Agent is busy; the last `inspectLlm` change is applied when the current turn ends. */
  inspectLlmPending: z.boolean().default(false),
  containerId: z.string().nullable(),
  error: z.string().nullable(),
  /** The saved-message queue is being played: the next saved message is sent whenever a turn ends. */
  queueRunning: z.boolean().default(false),
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
  /** Repositories to clone/copy into `/workspace/<name>`; none gives an empty Workspace. */
  repos: z.array(RepoSpec).max(50).optional(),
  /** Older clients: a single `git`/`copy` source, taken as one repository when `repos` is omitted. */
  workspaceSource: WorkspaceSource.default({ type: "empty" }),
  settings: SessionSettingsInput.default({}),
  // Flat forms of `settings.*`, kept for the CLI flags and older clients; `settings` wins where both are given.
  /** Docker daemon inside the Sandbox; defaults to the `dockerInSandbox` setting. */
  docker: z.boolean().optional(),
  /** MCP server ids to enable; defaults to the servers marked `enabledByDefault`. */
  mcpEnabled: z.array(z.string()).optional(),
  /** Model to switch to once the Agent is up; omitted keeps the Provider's default. */
  model: z.string().min(1).optional(),
  /** Other option values (effort, fast mode, …) to set once the Agent is up. */
  options: OptionValues.optional(),
  /** Standing instructions for the Agent; omitted takes `Settings.instructions`, `""` sends none. */
  instructions: z.string().max(INSTRUCTIONS_MAX_CHARS).optional(),
  /** Git identity for the Sandbox; an omitted part takes `Settings.gitUserName` / `gitUserEmail`, else the host's git config; `""` sends none. */
  gitIdentity: GitIdentity.partial().optional(),
  inspectLlm: z.boolean().optional(),
  prompt: z.string().min(1).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;
/** What a client sends (defaults not yet filled in). */
export type CreateSessionRequestInput = z.input<typeof CreateSessionRequest>;

/** The `settings` a create request asks for, with its flat legacy fields folded in. */
export function createRequestSettings(req: CreateSessionRequest): SessionSettingsInput {
  const flat: SessionSettingsInput = {
    ...(req.model !== undefined ? { model: req.model } : {}),
    ...(req.options !== undefined ? { options: req.options } : {}),
    ...(req.inspectLlm !== undefined ? { inspectLlm: req.inspectLlm } : {}),
    ...(req.mcpEnabled !== undefined ? { mcpEnabled: req.mcpEnabled } : {}),
    ...(req.instructions !== undefined ? { instructions: req.instructions } : {}),
  };
  const sandbox = {
    ...(req.docker !== undefined ? { docker: req.docker } : {}),
    ...(req.gitIdentity !== undefined ? { gitIdentity: req.gitIdentity } : {}),
    ...req.settings.sandbox,
  };
  return { ...flat, ...req.settings, ...(Object.keys(sandbox).length > 0 ? { sandbox } : {}) };
}

export const UpdateSessionRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  settings: SessionSettingsPatch.optional(),
  // Flat forms of `settings.*`, kept for older clients; `settings` wins where both are given.
  mcpEnabled: z.array(z.string()).optional(),
  model: z.string().min(1).optional(),
  options: OptionValues.optional(),
  inspectLlm: z.boolean().optional(),
  autoSnapshot: z.boolean().nullable().optional(),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

/** The `settings` patch an update request asks for, with its flat legacy fields folded in. */
export function updateRequestSettings(req: UpdateSessionRequest): SessionSettingsPatch {
  return {
    ...(req.mcpEnabled !== undefined ? { mcpEnabled: req.mcpEnabled } : {}),
    ...(req.model !== undefined ? { model: req.model } : {}),
    ...(req.options !== undefined ? { options: req.options } : {}),
    ...(req.inspectLlm !== undefined ? { inspectLlm: req.inspectLlm } : {}),
    ...(req.autoSnapshot !== undefined ? { autoSnapshot: req.autoSnapshot } : {}),
    ...req.settings,
  };
}

/** Where files attached to prompts land in the Workspace (`<UPLOADS_DIR>/<random>/<name>`). */
export const UPLOADS_DIR = ".sessionboxer/uploads";

/** A file the user attached to a prompt, uploaded into the Sandbox's Workspace. */
export const PromptAttachment = z.object({
  /** Workspace-relative path (`.sessionboxer/uploads/ab12cd34/photo.png`). */
  path: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
});
export type PromptAttachment = z.infer<typeof PromptAttachment>;

export const MAX_PROMPT_ATTACHMENTS = 20;

/** Text, attached files, or both; the Daemon adds the files' paths to the text it sends the Agent. */
export const PromptRequest = z
  .object({
    text: z.string(),
    attachments: z.array(PromptAttachment).max(MAX_PROMPT_ATTACHMENTS).optional(),
  })
  .refine((r) => r.text.trim().length > 0 || (r.attachments?.length ?? 0) > 0, { message: "a prompt needs text or an attachment" });
export type PromptRequest = z.infer<typeof PromptRequest>;

/** One-shot question to the Session's Provider in a fresh, context-free ACP session; not part of the transcript. */
export const AskRequest = z.object({
  text: z.string().min(1).max(20_000),
});
export type AskRequest = z.infer<typeof AskRequest>;

export const AskResult = z.object({ text: z.string() });
export type AskResult = z.infer<typeof AskResult>;

// ---------------------------------------------------------------------------
// Context usage (ADR-0030). Occupancy and per-turn spend come from the ACP
// `usage_update` notifications and the prompt response's `usage`, both kept in the
// event stream; the category breakdown is the Agent's own `/context` report, parsed.
// ---------------------------------------------------------------------------

/** What one turn spent, as the Agent reports it on the prompt response (ACP `usage`). */
export const TurnUsage = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  thoughtTokens: z.number().nullable().optional(),
  cachedReadTokens: z.number().nullable().optional(),
  cachedWriteTokens: z.number().nullable().optional(),
});
export type TurnUsage = z.infer<typeof TurnUsage>;

export const CONTEXT_CATEGORY_KINDS = ["used", "free", "buffer", "deferred"] as const;
export const ContextCategoryKind = z.enum(CONTEXT_CATEGORY_KINDS);
export type ContextCategoryKind = z.infer<typeof ContextCategoryKind>;

/** One row of the Agent's `/context` table (system prompt, tools, messages, free space, …). */
export const ContextCategory = z.object({
  name: z.string(),
  tokens: z.number(),
  /** Of the context window, as the Agent printed it. */
  percent: z.number().nullable(),
  kind: ContextCategoryKind,
});
export type ContextCategory = z.infer<typeof ContextCategory>;

/** One named contributor to a category: an MCP tool (source = server), a memory file (source = type), a skill (source = plugin). */
export const ContextContributor = z.object({
  name: z.string(),
  source: z.string(),
  tokens: z.number(),
});
export type ContextContributor = z.infer<typeof ContextContributor>;

/**
 * The Agent's own account of what fills its context window right now, parsed from its
 * `/context` report. Categories are the Provider's (Claude Code and Devin name them
 * differently); `text` is the report as printed, kept for what the parser does not know.
 */
export const ContextBreakdown = z.object({
  provider: Provider,
  model: z.string().nullable(),
  totalTokens: z.number().nullable(),
  maxTokens: z.number().nullable(),
  percent: z.number().nullable(),
  categories: z.array(ContextCategory),
  mcpTools: z.array(ContextContributor),
  memoryFiles: z.array(ContextContributor),
  skills: z.array(ContextContributor),
  /** A caveat the Agent printed ("Token counts are estimates…"). */
  note: z.string().nullable(),
  text: z.string(),
});
export type ContextBreakdown = z.infer<typeof ContextBreakdown>;

/** One message of the conversation as the Provider's own store keeps it (plain text rendering). */
export const CompactionMessage = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  text: z.string(),
  /** Cut at the Daemon's per-message limit; the store has the rest. */
  truncated: z.boolean(),
  /** Still in the window verbatim after the compaction (Claude keeps the last exchanges). */
  kept: z.boolean(),
});
export type CompactionMessage = z.infer<typeof CompactionMessage>;

/**
 * What one context compaction did, read from the Provider's own records in the Sandbox
 * (Claude Code: the session transcript JSONL; Devin: sessions.db and the history file it
 * writes): the messages it worked on and the summary that replaced them.
 */
export const CompactionDetails = z.object({
  provider: Provider,
  /** Position among the Provider's recorded compactions of this Agent session (0-based). */
  index: z.number(),
  /** How many the Provider has recorded, so the UI can tell a stale match. */
  total: z.number(),
  trigger: z.enum(["automatic", "manual"]).nullable(),
  preTokens: z.number().nullable(),
  postTokens: z.number().nullable(),
  /** The conversation the compaction started from, oldest first. */
  before: z.array(CompactionMessage),
  /** The text now standing in for it, as the model sees it; null when the store has none. */
  summary: z.string().nullable(),
  /** Where it was read from, for the curious. */
  source: z.string(),
  note: z.string().nullable(),
});
export type CompactionDetails = z.infer<typeof CompactionDetails>;

/** Which compaction the caller means: its position among the Session's completed ones, plus what the marker knows, for a safer match. */
export const CompactionDetailsRequest = z.object({
  index: z.number().int().min(0),
  preTokens: z.number().nullable().optional(),
  postTokens: z.number().nullable().optional(),
  trigger: z.enum(["automatic", "manual"]).nullable().optional(),
});
export type CompactionDetailsRequest = z.infer<typeof CompactionDetailsRequest>;

// ---------------------------------------------------------------------------
// Model API calls seen by the Sandbox's loopback inspector (`Session.inspectLlm`).
// Claude Code sends every request to `ANTHROPIC_BASE_URL`; with inspection on, that is
// the Daemon, which forwards to the real upstream (the company proxy or Anthropic)
// and keeps the bodies. Headers are never recorded.
// ---------------------------------------------------------------------------

/** Loopback port the Daemon's inspector listens on inside the Sandbox. */
export const LLM_INSPECTOR_PORT = 7200;
/** Anthropic's API, the upstream when no `ANTHROPIC_BASE_URL` is configured anywhere. */
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * - `turn`: a conversation request (has tools): what the transcript's agent messages and tool
 *   calls come from.
 * - `side`: a `/v1/messages` request without tools: Claude's own helpers (session naming,
 *   compaction summaries, prompt suggestions), no bubble of their own.
 * - `count_tokens`: `/v1/messages/count_tokens`.
 * - `other`: anything else sent to the base URL.
 */
export const LlmCallKind = z.enum(["turn", "side", "count_tokens", "other"]);
export type LlmCallKind = z.infer<typeof LlmCallKind>;

export const LlmCallUsage = z.object({
  inputTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
export type LlmCallUsage = z.infer<typeof LlmCallUsage>;

/** Shape of a `/v1/messages` request body, counted (not copied) for the list and the labels. */
export const LlmRequestShape = z.object({
  systemBlocks: z.number().int().nonnegative(),
  systemChars: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  toolsChars: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  messagesChars: z.number().int().nonnegative(),
  maxTokens: z.number().nullable(),
  stream: z.boolean(),
});
export type LlmRequestShape = z.infer<typeof LlmRequestShape>;

/** Summary of one call; the bodies themselves stay in the Sandbox (`DaemonLlmCallBodyResult`). */
export const LlmCall = z.object({
  /** Unique per Daemon process. */
  id: z.string(),
  /** 1-based position among the Session's recorded calls, the `n` of the `LLM #n` label; set by the Control Plane (0 from the Daemon). */
  ordinal: z.number().int().nonnegative(),
  kind: LlmCallKind,
  method: z.string(),
  /** Path and query as Claude sent them, e.g. `/v1/messages?beta=true`. */
  path: z.string(),
  model: z.string().nullable(),
  /** HTTP status from upstream; `null` when the request never got a response. */
  status: z.number().int().nullable(),
  /** Why there is no (complete) response: upstream unreachable, client went away, … */
  error: z.string().nullable(),
  startedAt: z.string(),
  /** Request start to last response byte. */
  durationMs: z.number().nullable(),
  /** Decoded body sizes; `Truncated` when the inspector's per-body cap cut the copy. */
  requestBytes: z.number().int().nonnegative(),
  requestTruncated: z.boolean(),
  responseBytes: z.number().int().nonnegative(),
  responseTruncated: z.boolean(),
  /** The response was a `text/event-stream` (passed through as it arrived). */
  streamed: z.boolean(),
  /** `message.id` from the response, when it was a Messages API reply. */
  messageId: z.string().nullable(),
  stopReason: z.string().nullable(),
  usage: LlmCallUsage.nullable(),
  shape: LlmRequestShape.nullable(),
});
export type LlmCall = z.infer<typeof LlmCall>;

/** The exact bodies of one call, decoded (content-encoding removed) and as UTF-8 text. */
export const LlmCallBody = z.object({
  call: LlmCall.nullable(),
  /** `null` when evicted (the Sandbox keeps a bounded number of bodies, on tmpfs: gone after Stop → Resume too). */
  request: z.string().nullable(),
  response: z.string().nullable(),
});
export type LlmCallBody = z.infer<typeof LlmCallBody>;

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

/** `rebuild`: a full image of the Sandbox's filesystem the Sandbox was moved onto (see `POST /sessions/:id/rebuild`). */
export const SNAPSHOT_REASONS = ["turn", "manual", "rebuild"] as const;
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
  /** Settings the fork differs in from the origin (the rest is copied). */
  settings: SessionSettingsInput.default({}),
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

/**
 * When a finished desktop recording gets its captions spoken into an audio track (local TTS in
 * the Sandbox): `always`, `never`, or `ask` — by itself when the estimated extra processing is at
 * most `askAboveSeconds`, otherwise the Agent asks the user first.
 */
export const NarrationMode = z.enum(["ask", "always", "never"]);
export type NarrationMode = z.infer<typeof NarrationMode>;

export const RecordingNarration = z.object({
  mode: NarrationMode.default("ask"),
  askAboveSeconds: z.number().nonnegative().default(5),
});
export type RecordingNarration = z.infer<typeof RecordingNarration>;

// ---------------------------------------------------------------------------
// Access: who may talk to the Control Plane (`/api/auth/...`)
// ---------------------------------------------------------------------------

/**
 * A browser that logged in: it holds a long-lived HttpOnly cookie whose secret is stored hashed.
 * `id` is what the Devices list shows and what revocation names.
 */
export const AuthDevice = z.object({
  id: z.string(),
  /** Label given at login, else derived from the user agent ("Chrome on Android"). */
  name: z.string(),
  userAgent: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  /** Client address of the last request, as the Control Plane saw it (proxy-forwarded when `X-Forwarded-For` is trusted). */
  lastIp: z.string(),
  /** Whether this is the device making the request. */
  current: z.boolean(),
  /** Whether this browser registered for Web Push notifications (see `PushStatus`). */
  push: z.boolean(),
});
export type AuthDevice = z.infer<typeof AuthDevice>;

export const AUTH_DEVICE_NAME_MAX = 80;

/** Exchanges the access token for a device cookie. */
export const AuthLoginRequest = z.object({
  token: z.string().min(1),
  name: z.string().max(AUTH_DEVICE_NAME_MAX).default(""),
});
export type AuthLoginRequest = z.infer<typeof AuthLoginRequest>;

/** Exchanges a one-time pairing code (from a QR / link made by a logged-in device) for a device cookie. */
export const AuthPairRedeemRequest = z.object({
  code: z.string().min(1),
  name: z.string().max(AUTH_DEVICE_NAME_MAX).default(""),
});
export type AuthPairRedeemRequest = z.infer<typeof AuthPairRedeemRequest>;

/** A pairing code: single use, valid until `expiresAt`; the UI puts it in `<origin>/#pair=<code>`. */
export const AuthPairing = z.object({
  code: z.string(),
  expiresAt: z.string(),
});
export type AuthPairing = z.infer<typeof AuthPairing>;

export const PAIRING_TTL_MS = 5 * 60_000;
/** Hash fragment carrying a pairing code, optionally followed by `&next=<route>` to land on. */
export const PAIR_FRAGMENT_KEY = "pair";

/** Who the current request is: a logged-in browser (`device`) or a bearer of the access token (`token`, CLI/scripts). */
export const AuthPrincipal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), device: AuthDevice }),
  z.object({ kind: z.literal("token") }),
]);
export type AuthPrincipal = z.infer<typeof AuthPrincipal>;

/**
 * The ways the Control Plane can make itself reachable from outside the local network, each a
 * child process it supervises while the transport is enabled in `Settings.tunnels`:
 * - `cloudflare`: `cloudflared tunnel --url` (no account), a random `https://….trycloudflare.com`, new at every start;
 * - `sessionboxer`: `frpc` dialling a Sessionboxer tunnel server (frps), a stable `https://<name>.<server domain>`;
 * - `ssh`: `ssh -R` to a server of yours, reached at the URL you give (your reverse proxy) or `http://<host>:<port>`.
 */
export const TunnelKind = z.enum(["cloudflare", "sessionboxer", "ssh"]);
export type TunnelKind = z.infer<typeof TunnelKind>;
export const TUNNEL_KINDS = TunnelKind.options;

/** Runtime state of one transport. `error` is the last failure while `starting`/`error`. */
export const TunnelStatus = z.object({
  state: z.enum(["off", "starting", "up", "error"]),
  url: z.string().nullable(),
  error: z.string().nullable(),
  /** Version of the program in use (`cloudflared`, `frpc`, `ssh`), once found or downloaded. */
  version: z.string().nullable(),
});
export type TunnelStatus = z.infer<typeof TunnelStatus>;

export const TunnelStatuses = z.object({ cloudflare: TunnelStatus, sessionboxer: TunnelStatus, ssh: TunnelStatus });
export type TunnelStatuses = z.infer<typeof TunnelStatuses>;

/**
 * How the Control Plane is reached remotely. `publicUrl` is what links and OAuth callbacks use
 * (`SESSIONBOXER_PUBLIC_URL`, else derived from the bind address); `tls` whether it serves HTTPS itself.
 * A pairing link carries the URL of the transport chosen for it (`pairingOrigin`).
 */
export const RemoteAccess = z.object({
  publicUrl: z.string(),
  tls: z.boolean(),
  /** Where the access token comes from; `env` cannot be rotated from the UI. */
  accessTokenSource: z.enum(["settings", "env"]),
  /** `X-Forwarded-*` from a reverse proxy are believed (`SESSIONBOXER_TRUST_PROXY=1`). */
  trustProxy: z.boolean(),
  tunnels: TunnelStatuses,
});
export type RemoteAccess = z.infer<typeof RemoteAccess>;

/** What a pairing link can point at: the configured public URL, or one of the transports. */
export const PairingTransport = z.enum(["local", ...TUNNEL_KINDS]);
export type PairingTransport = z.infer<typeof PairingTransport>;

/** The origin a pairing link over `transport` carries; `null` while that transport is not up. */
export function pairingOrigin(remote: RemoteAccess, transport: PairingTransport): string | null {
  if (transport === "local") return remote.publicUrl;
  const t = remote.tunnels[transport];
  return t.state === "up" && t.url ? t.url : null;
}

/** The Sessionboxer tunnel server a laptop dials by default (talayolabs' frps + registry). */
export const DEFAULT_TUNNEL_SERVER = "https://tunnel-sessionboxer.talayolabs.com";
/** What a tunnel name may look like (the server enforces the same rule and a list of reserved names). */
export const TUNNEL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

/** `GET <server>/api/v1/info`: how to reach a Sessionboxer tunnel server's frps and what URLs it hands out. */
export const TunnelServerInfo = z.object({
  service: z.literal("sessionboxer-tunnel"),
  domain: z.string().min(1),
  frps: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535), tls: z.boolean(), token: z.string().nullable() }),
  nameRule: z.string(),
  frpVersion: z.string(),
  grafana: z.string().nullable().optional(),
});
export type TunnelServerInfo = z.infer<typeof TunnelServerInfo>;

/** `GET <server>/api/v1/names/<name>` (proxied by the Control Plane as `GET /api/tunnels/sessionboxer/names/:name`). */
export const TunnelNameCheck = z.object({ name: z.string(), available: z.boolean(), reserved: z.boolean() });
export type TunnelNameCheck = z.infer<typeof TunnelNameCheck>;

/** Per-transport configuration (`Settings.tunnels`); `enabled` keeps the transport running across restarts. */
export const TunnelSettings = z.object({
  cloudflare: z.object({ enabled: z.boolean().default(false) }).default({}),
  sessionboxer: z
    .object({
      enabled: z.boolean().default(false),
      server: z.string().default(DEFAULT_TUNNEL_SERVER),
      /** The subdomain this laptop takes on the server; empty means a name derived from the hostname. */
      name: z.string().default(""),
      /** Generated once; the server binds the name to it at first login. Never shown. */
      secret: z.string().default(""),
    })
    .default({}),
  ssh: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default(""),
      port: z.number().int().min(1).max(65535).default(22),
      user: z.string().default(""),
      /** Private key file; empty uses the default keys and the agent. */
      identityFile: z.string().default(""),
      /** Port sshd listens on for the reverse forward (`-R`). */
      remotePort: z.number().int().min(1).max(65535).default(4000),
      /** `all` binds every interface on the server (needs `GatewayPorts yes`); `localhost` for a reverse proxy running there. */
      remoteBind: z.enum(["all", "localhost"]).default("all"),
      /** What the phone opens; empty means `http://<host>:<remotePort>`. */
      publicUrl: z.string().default(""),
    })
    .default({}),
});
export type TunnelSettings = z.infer<typeof TunnelSettings>;

/** `TunnelSettings` as the UI sees it: the frp secret replaced by whether it exists. */
export const PublicTunnelSettings = TunnelSettings.extend({
  sessionboxer: TunnelSettings.shape.sessionboxer.removeDefault().omit({ secret: true }).extend({ secretSet: z.boolean() }),
});
export type PublicTunnelSettings = z.infer<typeof PublicTunnelSettings>;

/** Partial update of `TunnelSettings`; omitted fields keep what is stored. */
export const TunnelSettingsUpdate = z.object({
  cloudflare: TunnelSettings.shape.cloudflare.removeDefault().partial().optional(),
  sessionboxer: TunnelSettings.shape.sessionboxer.removeDefault().omit({ secret: true }).partial().optional(),
  ssh: TunnelSettings.shape.ssh.removeDefault().partial().optional(),
});
export type TunnelSettingsUpdate = z.infer<typeof TunnelSettingsUpdate>;

// --- Web Push -------------------------------------------------------------------------------------
// A phone that is asleep has no WebSocket; the browser's push service (RFC 8030) wakes its service
// worker instead. The Control Plane signs each push with its VAPID key (RFC 8292) and encrypts the
// payload to the subscription's keys (RFC 8291), so nothing readable passes the push service.

/** What `PushManager.subscribe()` gave the browser; the keys are stored for encryption and never returned. */
export const PushSubscribeRequest = z.object({
  endpoint: z.string().url().max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequest>;

/** Push state for the requesting device. `publicKey` is the VAPID public key, base64url, for `applicationServerKey`. */
export const PushStatus = z.object({
  publicKey: z.string(),
  subscribed: z.boolean(),
});
export type PushStatus = z.infer<typeof PushStatus>;

/** The (encrypted) body of a push: what the service worker shows and where a tap lands (a hash route). */
export const PushMessage = z.object({
  title: z.string(),
  body: z.string(),
  /** Notifications with the same tag replace each other. */
  tag: z.string(),
  /** Hash route to open, e.g. `#/sessions/<id>/pr/<prId>`. */
  url: z.string(),
});
export type PushMessage = z.infer<typeof PushMessage>;

/**
 * What the UI tells the Control Plane over its WebSocket. `visibility` says whether the page is on
 * screen: a device with a visible page gets no push (it sees the change live), every other device does.
 */
export const UiClientMessage = z.discriminatedUnion("type", [z.object({ type: z.literal("visibility"), visible: z.boolean() })]);
export type UiClientMessage = z.infer<typeof UiClientMessage>;

/** Where a notification about a Session (or one of its PRs) should land. */
export function sessionRoute(sessionId: string, pane?: "prs" | `pr:${string}`): string {
  const base = `#/sessions/${sessionId}`;
  if (!pane) return base;
  return pane === "prs" ? `${base}/prs` : `${base}/pr/${pane.slice(3)}`;
}

/** One line about new activity on a PR ("3 new items from @a, @b (changes requested)"). */
export function prActivityLine(p: PrActivity): string {
  const who = p.authors.length <= 2 ? p.authors.map((a) => `@${a}`).join(", ") : `@${p.authors[0]} and ${p.authors.length - 1} others`;
  return `${p.count} new ${p.count === 1 ? "item" : "items"} from ${who}${p.changesRequested ? " (changes requested)" : ""}`;
}

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
   * Standing instructions every new Session's Agent gets (editable per Session at creation), on top
   * of the Sandbox briefing: delivered as system prompt or first-prompt prefix, see `instructionsDelivery`.
   */
  instructions: z.string().max(INSTRUCTIONS_MAX_CHARS).default(DEFAULT_INSTRUCTIONS),
  recordingNarration: RecordingNarration.default({}),
  /**
   * Copy the CA certificates this machine trusts beyond the public ones (corporate proxies,
   * Cloudflare WARP, mitmproxy…) into every Sandbox's trust store, so TLS works there too.
   */
  trustHostCaCerts: z.boolean().default(true),
  /** Additional CA certificates for Sandboxes, PEM (`-----BEGIN CERTIFICATE-----` blocks). */
  extraCaCerts: z.string().default(""),
  /**
   * Where Claude Code sends its API requests (`ANTHROPIC_BASE_URL`), e.g. a company Claude proxy.
   * Empty follows the Control Plane's own `ANTHROPIC_BASE_URL`, else Anthropic. `authToken` /
   * `apiKey` become `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` in the Sandbox, for proxies with
   * their own credential; empty sends neither (Claude uses the OAuth token).
   */
  claudeApi: z
    .object({
      baseUrl: z.string().default(""),
      authToken: z.string().default(""),
      apiKey: z.string().default(""),
    })
    .default({}),
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
  /**
   * The access token every browser and CLI must present once (`SESSIONBOXER_ACCESS_TOKEN` overrides it);
   * generated at first start. Never leaves the Control Plane except through `rotate`.
   */
  accessToken: z.string().default(""),
  /** The transports that make this Control Plane reachable from outside (see `TunnelKind`). */
  tunnels: TunnelSettings.default({}),
  /** VAPID key pair (P-256, base64url) signing this Control Plane's Web Pushes; generated at first start. */
  vapid: z.object({ publicKey: z.string(), privateKey: z.string() }).nullable().default(null),
});
export type Settings = z.infer<typeof Settings>;

/** Settings as returned to the UI: secrets replaced by a boolean "is set". */
export const PublicSettings = Settings.omit({ providerSecrets: true, mcpServers: true, connectors: true, claudeApi: true, accessToken: true, vapid: true, tunnels: true }).extend({
  mcpServers: z.array(PublicMcpServerDef),
  tunnels: PublicTunnelSettings,
  claudeApi: z.object({
    baseUrl: z.string(),
    authTokenSet: z.boolean(),
    apiKeySet: z.boolean(),
    /** What a Sandbox created now gets as `ANTHROPIC_BASE_URL`, and where it comes from. */
    effectiveBaseUrl: z.string(),
    effectiveBaseUrlSource: z.enum(["settings", "env", "default"]),
  }),
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
  /** `user.name` / `user.email` of the host's own git config, the fallback when the Settings identity is blank. */
  hostGitIdentity: GitIdentity,
  /** How this Control Plane is reached from elsewhere (see `RemoteAccess`). */
  remote: RemoteAccess,
});
export type PublicSettings = z.infer<typeof PublicSettings>;

export const UpdateSettingsRequest = Settings.omit({ mcpServers: true, connectors: true, claudeApi: true, accessToken: true, vapid: true, tunnels: true }).partial().extend({
  /** Whole registry; `null` secret values keep what is stored for that server/name. */
  mcpServers: z.array(PublicMcpServerDef).optional(),
  tunnels: TunnelSettingsUpdate.optional(),
  /** Omitted secret fields keep what is stored; `""` forgets it. */
  claudeApi: z.object({ baseUrl: z.string(), authToken: z.string(), apiKey: z.string() }).partial().optional(),
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
 * - `token`: Bitbucket Data Center: an HTTP access token the user created on `host` and pasted;
 *   verified against the host's REST API, which also tells whose it is.
 */
export const ConnectorVia = z.enum(["gh", "gh-existing", "app", "token"]);
export type ConnectorVia = z.infer<typeof ConnectorVia>;

/** Starts a login for a registry entry; a missing/unknown `serverId` creates the entry from the preset. */
export const ConnectorStartRequest = z.object({
  serverId: z.string().nullable().default(null),
  name: z.string().regex(MCP_NAME_PATTERN, "letters, digits, `_` and `-` only"),
  via: ConnectorVia.default("gh"),
  /** `gh-existing`: the `gh` account whose token to reuse. */
  account: z.string().nullable().default(null),
  /** `token`: the Bitbucket host (`bitbucket.example.com` or its URL) and the pasted HTTP access token. */
  host: z.string().max(500).nullable().default(null),
  token: z.string().max(4000).nullable().default(null),
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
  | { type: "user_prompt"; text: string; attachments?: PromptAttachment[] }
  | { type: "update"; update: SessionUpdate }
  | { type: "turn_ended"; stopReason: StopReason; usage?: TurnUsage }
  | { type: "agent_error"; message: string }
  | { type: "status"; status: SessionStatus; error?: string }
  /** First event of a forked Session: everything before it was copied from the origin. */
  | { type: "forked"; fromSessionId: string; fromTitle: string; snapshotId: string; snapshotOrdinal: number }
  /** The Daemon restarted the Agent with a new MCP server set (names, `desktop` excluded). */
  | { type: "mcp_changed"; servers: string[] }
  /** The Agent switched model (`name` is the human label, `model` the value). */
  | { type: "model_changed"; model: string; name: string }
  /** One of the Agent's other options changed (`name`/`valueName` are the human labels). */
  | { type: "option_changed"; id: string; name: string; value: string; valueName: string }
  /** The Agent was asked `/context` outside the conversation; this is what it reported. */
  | { type: "context_breakdown"; breakdown: ContextBreakdown }
  /** A repository was added to (cloned/copied into) or removed from the Workspace while the Session ran. */
  | { type: "repo_changed"; action: "added" | "removed"; name: string; source: RepoSource }
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
  /**
   * New feedback arrived on attached Pull Requests and the Session is idle (or stopped): the UI
   * notifies. While the Agent is busy the Control Plane holds this until `turn_ended`.
   */
  | { type: "pr_activity"; sessionId: string; sessionTitle: string; prs: PrActivity[] }
  /** Auto-merge merged an attached Pull Request. */
  | { type: "pr_merged"; sessionId: string; sessionTitle: string; pr: PrMergedNotice }
  /** A transport came up, went down or failed (`PublicSettings.remote` changed). */
  | { type: "remote"; remote: RemoteAccess };

// ---------------------------------------------------------------------------
// Workspace files. Paths are relative to the Workspace root; the Daemon rejects escapes.
// ---------------------------------------------------------------------------

// Raw (binary) Workspace files are served over HTTP rather than JSON-RPC, so the browser can
// stream a video with Range requests: Daemon `GET /fs/raw?path=…`, proxied by the Control Plane
// as `GET /api/sessions/:id/fs/raw?path=…[&download=1]`.
export const FS_RAW_PATH = "/fs/raw";
/**
 * `PUT /fs/upload?name=<file name>` with the bytes as the body (and their `Content-Type`) stores a
 * prompt attachment under `UPLOADS_DIR` and answers with the `PromptAttachment`.
 */
export const FS_UPLOAD_PATH = "/fs/upload";
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pulling a copied repository back into its host folder. Both sides describe their files
// the same way (git's view when it is a work tree: tracked + untracked-but-not-ignored,
// `.git` itself excluded); the Control Plane compares the two against the state after the
// copy / last pull and applies the difference. Paths are relative to the repository's
// directory (`/workspace/<name>`, or the Workspace root for the pre-repositories layout).
// ---------------------------------------------------------------------------

/** Daemon `fs/manifest` params: which Workspace directory to describe (`""` = the root). */
export const FsManifestParams = z.object({ dir: z.string().default("") });
export type FsManifestParams = z.infer<typeof FsManifestParams>;

/** One file of a Workspace: regular files carry a content hash, symlinks their target. */
export const SyncFile = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  /** Only the executable bit matters (like git). */
  executable: z.boolean(),
  sha256: z.string().nullable(),
  link: z.string().nullable(),
});
export type SyncFile = z.infer<typeof SyncFile>;

export const SyncManifest = z.object({
  files: z.array(SyncFile),
  /** Listed through git (ignored files left out) rather than by walking everything. */
  git: z.boolean(),
});
export type SyncManifest = z.infer<typeof SyncManifest>;

/** Daemon `POST /fs/tar` body: files under `dir` (relative to it) to stream back as a tar archive. */
export const FS_TAR_PATH = "/fs/tar";
export const FsTarRequest = z.object({ dir: z.string().default(""), paths: z.array(z.string()).max(200_000) });
export type FsTarRequest = z.infer<typeof FsTarRequest>;

export const SYNC_ACTIONS = ["add", "update", "delete"] as const;
export const SyncAction = z.enum(SYNC_ACTIONS);
export type SyncAction = z.infer<typeof SyncAction>;

export const SyncEntry = z.object({
  path: z.string(),
  action: SyncAction,
  /** Size in the box (0 for deletes). */
  size: z.number().int().nonnegative(),
  /**
   * The host file changed too (or was deleted / is only known from the host) since the copy or
   * the last pull, so applying this would discard local work; skipped unless the user asks.
   */
  conflict: z.boolean(),
  /** Why this entry can never be applied (a symlink leaving the folder); null when it can. */
  blocked: z.string().nullable(),
});
export type SyncEntry = z.infer<typeof SyncEntry>;

export const SyncPlan = z.object({
  /** The repository the plan is for. */
  repoId: z.string(),
  /** The host folder. */
  path: z.string(),
  entries: z.array(SyncEntry),
  /** Files identical on both sides. */
  unchanged: z.number().int().nonnegative(),
  /** Files changed (or added / removed) only in the host folder: kept as they are. */
  localOnly: z.number().int().nonnegative(),
  /** A record of the copied state existed, so changes could be attributed to a side. */
  threeWay: z.boolean(),
  computedAt: z.string(),
});
export type SyncPlan = z.infer<typeof SyncPlan>;

export const SyncRequest = z.object({
  /** Which copied repository to pull; omitted takes the Session's only one. */
  repoId: z.string().optional(),
  /** Apply conflicting entries too (host changes lost). */
  overwriteLocal: z.boolean().default(false),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

export const SyncResult = z.object({
  repoId: z.string(),
  path: z.string(),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  /** Conflicting entries left alone. */
  skipped: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type SyncResult = z.infer<typeof SyncResult>;

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

/** Files served with a known type but not embedded on their own (a video's caption sidecar). */
const SIDECAR_TYPES: Record<string, string> = {
  vtt: "text/vtt; charset=utf-8",
};

/** Caption track a video may come with: `<name>.vtt` next to `<name>.mp4`. */
export function captionTrackFor(videoPath: string): string {
  return videoPath.replace(/\.[^./]+$/, ".vtt");
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function mediaKind(path: string): MediaKind | null {
  return MEDIA_TYPES[extensionOf(path)]?.[0] ?? null;
}

export function contentTypeFor(path: string): string {
  const ext = extensionOf(path);
  return MEDIA_TYPES[ext]?.[1] ?? SIDECAR_TYPES[ext] ?? "application/octet-stream";
}

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

/** A place in a Workspace file to show in the Code pane: a path in the chat the user clicked. */
export const CodeOpenParams = z.object({
  /** Workspace-relative (`src/a.ts`) or absolute under `/workspace`. */
  path: z.string().min(1),
  /** 1-based. */
  line: z.number().int().positive().optional(),
  /** 1-based; only with `line`. */
  column: z.number().int().positive().optional(),
});
export type CodeOpenParams = z.infer<typeof CodeOpenParams>;

// ---------------------------------------------------------------------------
// Pull Requests attached to a Session. The Control Plane stores them and polls GitHub for
// comments/reviews; the HTTP requests run inside the Sandbox (`gh api`, Daemon `gh/api`) so the
// box's own GitHub login decides what can be seen. github.com only.
// ---------------------------------------------------------------------------

export const PrState = z.enum(["open", "draft", "closed", "merged"]);
export type PrState = z.infer<typeof PrState>;

export const PrReviewDecision = z.enum(["approved", "changes_requested", "review_required"]);
export type PrReviewDecision = z.infer<typeof PrReviewDecision>;

/** How a Pull Request got attached to the Session. */
export const PrAttachedBy = z.enum(["prompt", "agent", "manual"]);
export type PrAttachedBy = z.infer<typeof PrAttachedBy>;

/** Why the last poll of a Pull Request did not succeed. */
export const PrSyncError = z.enum(["unauthorized", "not_found", "rate_limited", "box_stopped", "error"]);
export type PrSyncError = z.infer<typeof PrSyncError>;

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export const MergeMethod = z.enum(MERGE_METHODS);
export type MergeMethod = z.infer<typeof MergeMethod>;

/** GitHub's `mergeStateStatus`, lower-cased. */
export const PrMergeStatus = z.enum(["clean", "unstable", "blocked", "behind", "dirty", "draft", "has_hooks", "unknown"]);
export type PrMergeStatus = z.infer<typeof PrMergeStatus>;

/** One commit status or check run on the PR's head. */
export const PrCheck = z.object({
  name: z.string(),
  /** `pending` until it finishes; a check that is skipped or neutral counts as `passed`. */
  state: z.enum(["pending", "passed", "failed"]),
  /** Branch protection requires it before merging. */
  required: z.boolean(),
  url: z.string().nullable(),
});
export type PrCheck = z.infer<typeof PrCheck>;

/**
 * What the auto-merge watcher last saw (every 10 s while it is on and the PR is open). `merged`
 * is set once *it* merged the PR; `error` when GitHub refused the merge or could not be asked.
 */
export const PrMergeState = z.object({
  checkedAt: z.string(),
  status: PrMergeStatus,
  /** GitHub's own conflict verdict (`null` while it is still computing). */
  mergeable: z.boolean().nullable(),
  headSha: z.string(),
  checks: z.array(PrCheck),
  error: z.string().nullable(),
  merged: z.boolean(),
});
export type PrMergeState = z.infer<typeof PrMergeState>;

/** One line of a `pr_merged` notification. */
export const PrMergedNotice = z.object({
  prId: z.string(),
  url: z.string(),
  title: z.string(),
  number: z.number().int(),
  method: MergeMethod,
});
export type PrMergedNotice = z.infer<typeof PrMergedNotice>;

export const PullRequest = z.object({
  id: z.string(),
  sessionId: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  state: PrState,
  headRef: z.string(),
  /** `owner/repo` of the head branch (differs from `owner/repo` for forks). */
  headRepo: z.string(),
  baseRef: z.string(),
  author: z.string(),
  reviewDecision: PrReviewDecision.nullable(),
  attachedBy: PrAttachedBy,
  attachedAt: z.string(),
  /** Newest comment/review seen on GitHub. */
  lastActivityAt: z.string().nullable(),
  /** Items the user has not looked at yet (cleared when the PR's pane is shown). */
  unread: z.number().int().nonnegative(),
  /** Review threads still unresolved. */
  openThreads: z.number().int().nonnegative(),
  /** The Sandbox's GitHub login the PR is read with (`null` until one worked). Never a token. */
  viaAccount: z.string().nullable(),
  /** Still being polled (closed/merged PRs stop after a while; the user can pause too). */
  watch: z.boolean(),
  syncedAt: z.string().nullable(),
  syncError: PrSyncError.nullable(),
  syncErrorDetail: z.string().nullable(),
  /** The PR's repo is the Workspace's origin, so it can be addressed locally. */
  local: z.boolean(),
  /** Merge it as soon as GitHub says it can be (checks green, reviews in, no conflicts). */
  autoMerge: z.boolean(),
  mergeMethod: MergeMethod,
  mergeState: PrMergeState.nullable(),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const PrItemKind = z.enum(["issue_comment", "review_comment", "review"]);
export type PrItemKind = z.infer<typeof PrItemKind>;

/** What has been done about an item from this Session. */
export const PrAddressState = z.enum(["none", "in_prompt", "addressing", "addressed"]);
export type PrAddressState = z.infer<typeof PrAddressState>;

/**
 * One comment or review of a Pull Request. Inline review comments of one thread share `threadId`
 * (the root comment's id); the root has `inReplyTo: null`.
 */
export const PrItem = z.object({
  id: z.string(),
  prId: z.string(),
  kind: PrItemKind,
  githubId: z.number().int(),
  nodeId: z.string(),
  threadId: z.string().nullable(),
  /** GraphQL id of the review thread (`PRRT_…`), what `resolveReviewThread` takes. */
  threadNodeId: z.string().nullable(),
  inReplyTo: z.number().int().nullable(),
  author: z.string(),
  /** Written by the login the PR is watched with (i.e. by this Sandbox / the user). */
  self: z.boolean(),
  body: z.string(),
  /** Inline review comments: file and line (`line` is `null` for outdated positions). */
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  diffHunk: z.string().nullable(),
  htmlUrl: z.string(),
  /** Reviews: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`. */
  reviewState: z.string().nullable(),
  /** Review-comment threads: resolved on GitHub / left behind by a later push. */
  resolved: z.boolean(),
  outdated: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  seen: z.boolean(),
  address: PrAddressState,
});
export type PrItem = z.infer<typeof PrItem>;

/** One line of a `pr_activity` notification. */
export const PrActivity = z.object({
  prId: z.string(),
  url: z.string(),
  title: z.string(),
  number: z.number().int(),
  /** Items new since the last notification. */
  count: z.number().int().positive(),
  /** Authors of those items. */
  authors: z.array(z.string()),
  /** Set when one of them is a `CHANGES_REQUESTED` review. */
  changesRequested: z.boolean(),
});
export type PrActivity = z.infer<typeof PrActivity>;

/** `POST /api/sessions/:id/prs`: a github.com PR URL, `owner/repo#12`, or `#12` / `12` for the Workspace's repo. */
export const AttachPrRequest = z.object({ ref: z.string().min(1) });
export type AttachPrRequest = z.infer<typeof AttachPrRequest>;

export const UpdatePrRequest = z.object({
  watch: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
  mergeMethod: MergeMethod.optional(),
});
export type UpdatePrRequest = z.infer<typeof UpdatePrRequest>;

/**
 * What to do with comments/reviews, one or many (possibly from several PRs of the Session):
 * - `prompt`: build the prompt text and hand it back for the composer (nothing is sent).
 * - `address`: send it to the Agent (queued when a turn is running): change the code, no GitHub replies.
 * - `address_reply`: same, plus reply on GitHub per thread and resolve the threads it addressed.
 */
export const PrAction = z.enum(["prompt", "address", "address_reply"]);
export type PrAction = z.infer<typeof PrAction>;

export const PrActionRequest = z.object({
  action: PrAction,
  itemIds: z.array(z.string()).min(1),
});
export type PrActionRequest = z.infer<typeof PrActionRequest>;

export const PrActionResult = z.object({
  /** The prompt built from the items. */
  text: z.string(),
  /** `address*`: `sent` now, or `queued` behind the running turn. `prompt`: `none`. */
  delivery: z.enum(["none", "sent", "queued"]),
});
export type PrActionResult = z.infer<typeof PrActionResult>;

/** Parses a github.com Pull Request URL. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(url.trim());
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, ""), number: Number(m[3]) };
}

/** All github.com Pull Request URLs in a text (prompts, Agent output), deduplicated in order. */
export function findPrUrls(text: string): { owner: string; repo: string; number: number; url: string }[] {
  const out: { owner: string; repo: string; number: number; url: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g)) {
    const parsed = parsePrUrl(m[0]);
    if (!parsed) continue;
    const key = `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}#${parsed.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...parsed, url: `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}` });
  }
  return out;
}

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
  contextReport: "_sessionboxer/context/report",
  compactionDetails: "_sessionboxer/context/compaction",
  mcpSet: "_sessionboxer/mcp/set",
  modelSet: "_sessionboxer/model/set",
  optionSet: "_sessionboxer/option/set",
  claudeModelsSet: "_sessionboxer/claude-models/set",
  recordingPrefsSet: "_sessionboxer/recording-prefs/set",
  sessionFork: "_sessionboxer/session/fork",
  sessionSwitch: "_sessionboxer/session/switch",
  cancel: "_sessionboxer/cancel",
  status: "_sessionboxer/status",
  event: "_sessionboxer/event",
  fsManifest: "_sessionboxer/fs/manifest",
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
  codeOpen: "_sessionboxer/code/open",
  ghApi: "_sessionboxer/gh/api",
  ghLogins: "_sessionboxer/gh/logins",
  llmInspectSet: "_sessionboxer/llm/inspect/set",
  llmCalls: "_sessionboxer/llm/calls",
  llmCallBody: "_sessionboxer/llm/call",
  reposSet: "_sessionboxer/repos/set",
  reposInspect: "_sessionboxer/repos/inspect",
  reposRemove: "_sessionboxer/repos/remove",
} as const;

/** Control Plane → Daemon: the Workspace's repositories; the Daemon writes `REPOS_MANIFEST_PATH` from them for the Agent. */
export const DaemonReposSetParams = z.object({
  repos: z.array(z.object({ name: z.string().min(1), source: RepoSource })),
});
export type DaemonReposSetParams = z.infer<typeof DaemonReposSetParams>;

/** Git state of the given repository directories (Workspace-relative); `state` is `null` for a missing directory. */
export const DaemonReposInspectParams = z.object({ dirs: z.array(z.string()).max(100) });
export type DaemonReposInspectParams = z.infer<typeof DaemonReposInspectParams>;

export const DaemonReposInspectResult = z.object({
  states: z.array(z.object({ dir: z.string(), state: RepoGitState.nullable() })),
});
export type DaemonReposInspectResult = z.infer<typeof DaemonReposInspectResult>;

/** Deletes a repository directory; refused (`removed: false`, with the state) while it holds work that is not pushed, unless `force`. */
export const DaemonReposRemoveParams = z.object({ dir: z.string().min(1), force: z.boolean().default(false) });
export type DaemonReposRemoveParams = z.infer<typeof DaemonReposRemoveParams>;

export const DaemonReposRemoveResult = z.discriminatedUnion("removed", [
  z.object({ removed: z.literal(true) }),
  z.object({ removed: z.literal(false), git: RepoGitState }),
]);
export type DaemonReposRemoveResult = z.infer<typeof DaemonReposRemoveResult>;

/** Work that a removal would throw away, as a sentence for the user (or `null` when there is none). */
export function repoWorkAtRisk(git: RepoGitState | null): string | null {
  if (!git?.git) return null;
  const parts: string[] = [];
  if (git.dirty) parts.push("uncommitted changes");
  if (git.ahead === null) parts.push(git.branch ? `branch ${git.branch} has no upstream` : "a detached HEAD");
  else if (git.ahead > 0) parts.push(`${git.ahead} unpushed commit${git.ahead === 1 ? "" : "s"} on ${git.branch ?? "HEAD"}`);
  if (git.unpushedBranches.length > 0) parts.push(`unpushed branch${git.unpushedBranches.length === 1 ? "" : "es"} ${git.unpushedBranches.join(", ")}`);
  return parts.length === 0 ? null : parts.join(", ");
}

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
  /** The running Agent sends its model API calls through the inspector. */
  llmInspect: z.boolean().default(false),
  /** An `llm/inspect/set` is waiting for the current turn to end. */
  llmInspectPending: z.boolean().default(false),
});
export type DaemonStatus = z.infer<typeof DaemonStatus>;

/**
 * A login the Sandbox itself gets while the matching Connector entry is enabled: `gh` and
 * `git push` to github.com (or `bb` and `git push` to a Bitbucket host) work as `account`, in
 * the Agent's shell and in the Terminal pane. Kept on tmpfs in the Sandbox, so it is gone from
 * Snapshots and after the entry is switched off.
 */
export const BoxCredential = z.object({
  kind: ConnectorKind,
  /** `github.com`, or the Bitbucket Data Center host. */
  host: z.string().default("github.com"),
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
 * Hands the Sandbox the recording preferences from `Settings`; the Daemon writes them to tmpfs
 * where the computer-use MCP reads them at `stop_recording`. Sent on every connect and change.
 */
export const DaemonRecordingPrefsSetParams = z.object({ narration: RecordingNarration });
export type DaemonRecordingPrefsSetParams = z.infer<typeof DaemonRecordingPrefsSetParams>;

export const DaemonRecordingPrefsSetResult = z.object({ ok: z.literal(true) });
export type DaemonRecordingPrefsSetResult = z.infer<typeof DaemonRecordingPrefsSetResult>;

/**
 * Turns the loopback inspector on or off for the Agent: with it on, the Agent process gets the
 * inspector as `ANTHROPIC_BASE_URL` and the inspector forwards to the Sandbox's configured one.
 * Takes effect on the next Agent start (restart in place when idle, after the turn otherwise).
 * Ignored by Daemons of Providers without a redirectable API endpoint.
 */
export const DaemonLlmInspectSetParams = z.object({ enabled: z.boolean() });
export type DaemonLlmInspectSetParams = z.infer<typeof DaemonLlmInspectSetParams>;

export const DaemonLlmInspectSetResult = z.object({ applied: z.boolean(), supported: z.boolean() });
export type DaemonLlmInspectSetResult = z.infer<typeof DaemonLlmInspectSetResult>;

/** Calls this Daemon process has seen (summaries, `ordinal` 0 until the Control Plane numbers them), oldest first. */
export const DaemonLlmCallsResult = z.object({
  calls: z.array(LlmCall),
  /** Ids whose bodies are still on tmpfs. */
  withBodies: z.array(z.string()),
});
export type DaemonLlmCallsResult = z.infer<typeof DaemonLlmCallsResult>;

export const DaemonLlmCallBodyParams = z.object({ id: z.string() });
export type DaemonLlmCallBodyParams = z.infer<typeof DaemonLlmCallBodyParams>;

export const DaemonLlmCallBodyResult = LlmCallBody;
export type DaemonLlmCallBodyResult = z.infer<typeof DaemonLlmCallBodyResult>;

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

/**
 * `note` is put in front of the text the Agent gets but not in the transcript's `user_prompt`:
 * the Control Plane uses it to tell the Agent what changed in the Workspace since the last turn
 * (repositories added or removed).
 */
export const DaemonPromptParams = PromptRequest.innerType().extend({ note: z.string().optional() });
export type DaemonPromptParams = z.infer<typeof DaemonPromptParams>;

/** The turn runs asynchronously; its outcome arrives as `turn_ended`/`agent_error` events. */
export const DaemonPromptResult = z.object({ accepted: z.boolean() });
export type DaemonPromptResult = z.infer<typeof DaemonPromptResult>;

/** Synchronous: resolves with the Agent's reply once the throwaway session's turn ends. */
export const DaemonAskParams = AskRequest;
export type DaemonAskParams = AskRequest;
export const DaemonAskResult = AskResult;
export type DaemonAskResult = AskResult;

/**
 * Synchronous: `/context` sent on the Agent's own session (both Providers answer it locally,
 * without a model call) with its reply captured instead of streamed as events, so the
 * conversation shows nothing of it. Refused while a turn is active.
 */
export const DaemonContextReportResult = z.object({ text: z.string() });
export type DaemonContextReportResult = z.infer<typeof DaemonContextReportResult>;

/** Synchronous: reads the Provider's own record of one compaction (no Agent involvement). */
export const DaemonCompactionDetailsParams = CompactionDetailsRequest;
export type DaemonCompactionDetailsParams = CompactionDetailsRequest;
export const DaemonCompactionDetailsResult = CompactionDetails;
export type DaemonCompactionDetailsResult = CompactionDetails;

/**
 * One GitHub API request made from inside the Sandbox with `gh api`, so it is authenticated with
 * whatever the box is logged in as (Connector entry, a `gh auth login` done in the Terminal,
 * `GH_TOKEN`). `path` is relative to `https://api.github.com/` (`repos/o/r/pulls/1`, `graphql`);
 * nothing else can be reached through this. The response is passed back untouched.
 */
export const DaemonGhApiParams = z.object({
  method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).default("GET"),
  path: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_.~%/=&?+-]+$/, "relative API path")
    .refine((p) => !p.startsWith("/") && !p.includes("..") && !/^[a-z]+:/i.test(p), "relative API path"),
  headers: z.record(z.string()).default({}),
  /** Request body (JSON text) for `POST`/`PATCH`/`PUT`. */
  body: z.string().nullable().default(null),
  /** Use this `gh` login instead of the active one (`gh auth token --user`). */
  account: z.string().nullable().default(null),
});
export type DaemonGhApiParams = z.infer<typeof DaemonGhApiParams>;

export const DaemonGhApiResult = z.object({
  status: z.number().int(),
  /** Lower-cased header names. */
  headers: z.record(z.string()),
  body: z.string(),
});
export type DaemonGhApiResult = z.infer<typeof DaemonGhApiResult>;

/** The github.com logins the Sandbox has (`gh auth status`), never their tokens. */
export const DaemonGhLoginsResult = z.object({
  /** `gh`'s active account, or the login `GH_TOKEN` in the environment belongs to. */
  active: z.string().nullable(),
  logins: z.array(z.string()),
});
export type DaemonGhLoginsResult = z.infer<typeof DaemonGhLoginsResult>;

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
