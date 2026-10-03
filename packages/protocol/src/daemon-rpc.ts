// ---------------------------------------------------------------------------
// Sandbox Daemon RPC (Control Plane <-> Daemon, JSON-RPC 2.0 over WebSocket).
// Method names use ACP's `_<vendor>/` extension convention.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { E2eBridgeRequest } from "./e2e.js";
import { RepoSource, RepoGitState } from "./repositories.js";
import { ModelOption, AgentOption, OptionValues } from "./models.js";
import { UsageWindow } from "./usage-limits.js";
import { ConnectorKind, McpServerSpec } from "./mcp.js";
import { UtilitySpec, UtilityGroup, ProcedureDef } from "./utilities.js";
import { RecordingNarration } from "./settings.js";
import { LlmCall, LlmCallBody } from "./llm-inspector.js";
import { BranchMethod } from "./branches.js";
import { PromptRequest, AskRequest, AskResult } from "./sessions.js";
import { CompactionDetailsRequest, CompactionDetails } from "./context-usage.js";
import type { SessionEventBody } from "./events.js";

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
  codexAuthSet: "_sessionboxer/codex/auth/set",
  codexAuthChanged: "_sessionboxer/codex/auth/changed",
  cursorAuthSet: "_sessionboxer/cursor/auth/set",
  cursorAuthChanged: "_sessionboxer/cursor/auth/changed",
  piAuthSet: "_sessionboxer/pi/auth/set",
  piAuthChanged: "_sessionboxer/pi/auth/changed",
  opencodeAuthSet: "_sessionboxer/opencode/auth/set",
  opencodeAuthChanged: "_sessionboxer/opencode/auth/changed",
  fxAuthSet: "_sessionboxer/fx/auth/set",
  fxAuthChanged: "_sessionboxer/fx/auth/changed",
  kimiAuthSet: "_sessionboxer/kimi/auth/set",
  kimiAuthChanged: "_sessionboxer/kimi/auth/changed",
  copilotAuthSet: "_sessionboxer/copilot/auth/set",
  copilotAuthChanged: "_sessionboxer/copilot/auth/changed",
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
  fsWatch: "_sessionboxer/fs/watch",
  fsChanged: "_sessionboxer/fs/changed",
  ptyList: "_sessionboxer/pty/list",
  ptyOpen: "_sessionboxer/pty/open",
  ptyAttach: "_sessionboxer/pty/attach",
  ptyInput: "_sessionboxer/pty/input",
  ptyResize: "_sessionboxer/pty/resize",
  ptyClose: "_sessionboxer/pty/close",
  ptyRead: "_sessionboxer/pty/read",
  ptyOutput: "_sessionboxer/pty/output",
  ptyExit: "_sessionboxer/pty/exit",
  codeStart: "_sessionboxer/code/start",
  codeStatus: "_sessionboxer/code/status",
  codeStop: "_sessionboxer/code/stop",
  codeOpen: "_sessionboxer/code/open",
  codeTheme: "_sessionboxer/code/theme",
  ghApi: "_sessionboxer/gh/api",
  ghLogins: "_sessionboxer/gh/logins",
  llmInspectSet: "_sessionboxer/llm/inspect/set",
  llmCalls: "_sessionboxer/llm/calls",
  llmCallBody: "_sessionboxer/llm/call",
  reposSet: "_sessionboxer/repos/set",
  reposInspect: "_sessionboxer/repos/inspect",
  reposRemove: "_sessionboxer/repos/remove",
  reposSeed: "_sessionboxer/repos/seed",
  /** Control Plane → Daemon: the `SessionInfo` to write to `SESSION_INFO_PATH` (and to tell the Agent in its briefing). */
  sessionInfoSet: "_sessionboxer/session-info/set",
  /** Control Plane → Daemon: the Session's enabled Utilities (secrets included) and procedure skills (ADR-0073). */
  utilitiesSet: "_sessionboxer/utilities/set",
  /** MCP Apps (ADR-0079): the Daemon's mirror of the Agent's MCP servers, reached through the tee. */
  mcpAppsResource: "_sessionboxer/mcp-apps/resource",
  mcpAppsToolResult: "_sessionboxer/mcp-apps/toolResult",
  mcpAppsCallTool: "_sessionboxer/mcp-apps/callTool",
  mcpAppsReadResource: "_sessionboxer/mcp-apps/readResource",
  mcpAppsTools: "_sessionboxer/mcp-apps/tools/list",
  // Daemon → Control Plane requests (the Agent's `e2e_*` tools); each answers with the `E2eRun`.
  // The `sessionboxer` MCP's tools are `_sessionboxer/agent/<tool>` (see `agentMethod`).
  e2ePlan: "_sessionboxer/e2e/plan",
  e2eCaseStart: "_sessionboxer/e2e/case-start",
  e2eCaseEnd: "_sessionboxer/e2e/case-end",
  e2eFinish: "_sessionboxer/e2e/finish",
} as const;

/** `E2eBridgeRequest.method` → the JSON-RPC method the Daemon sends the Control Plane. */
export const E2E_BRIDGE_METHODS: Record<E2eBridgeRequest["method"], string> = {
  plan: DAEMON_METHODS.e2ePlan,
  case_start: DAEMON_METHODS.e2eCaseStart,
  case_end: DAEMON_METHODS.e2eCaseEnd,
  finish: DAEMON_METHODS.e2eFinish,
};

/** Control Plane → Daemon: the Workspace's repositories; the Daemon writes `REPOS_MANIFEST_PATH` from them for the Agent. */
export const DaemonReposSetParams = z.object({
  repos: z.array(z.object({ name: z.string().min(1), source: RepoSource, account: z.string().nullable().default(null) })),
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
  /** The Provider's usage meters as last seen by the Daemon; `null` when it reported none yet. */
  usage: z.object({ windows: z.array(UsageWindow), updatedAt: z.string() }).nullable().default(null),
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
  /** Whether the built-in `sessionboxer` MCP goes to the Agent (`AgentToolsPolicy` other than `off`, ADR-0062). */
  sessionboxerTools: z.boolean().default(true),
});
export type DaemonMcpSetParams = z.infer<typeof DaemonMcpSetParams>;

/**
 * Puts repositories in place where the Agent runs when that is not the Sandbox itself (a Windows
 * VM, ADR-0057): a git source is cloned there with the Session's connected accounts (as `account`
 * when set); a copied folder was already unpacked into the Sandbox's `/workspace/<dir>` by the
 * Control Plane and is pushed on from there. Answers once the machine is reachable, per repository.
 */
export const DaemonReposSeedParams = z.object({
  repos: z.array(z.object({ dir: z.string().min(1), source: RepoSource, account: z.string().nullable().default(null) })),
  /** The Session's connected accounts, so the clones can answer for private repositories (as in `mcp/set`). */
  credentials: z.array(BoxCredential).default([]),
});
export type DaemonReposSeedParams = z.infer<typeof DaemonReposSeedParams>;

export const DaemonReposSeedResult = z.object({
  results: z.array(z.object({ dir: z.string(), ok: z.boolean(), error: z.string().nullable() })),
});
export type DaemonReposSeedResult = z.infer<typeof DaemonReposSeedResult>;

export const DaemonMcpSetResult = z.object({
  /** False when the change was deferred to the end of the active turn. */
  applied: z.boolean(),
});
export type DaemonMcpSetResult = z.infer<typeof DaemonMcpSetResult>;

/**
 * Replaces the Session's Utilities (ADR-0073): the Daemon writes each one's credentials to tmpfs
 * (`UTILITY_CREDENTIALS_DIR/<name>.json`, for `sb-util` and the `${util:…}` placeholders), the
 * secret-free manifest to `UTILITIES_MANIFEST_PATH`, and the procedures as skills. Their MCP facets
 * travel in `mcp/set` (they are ordinary servers of the Agent's set).
 */
export const DaemonUtilitiesSetParams = z.object({
  environments: z.array(z.object({ name: z.string(), production: z.boolean() })),
  utilities: z.array(UtilitySpec),
  available: z.array(z.object({ name: z.string(), label: z.string(), group: UtilityGroup, environment: z.string() })),
  procedures: z.array(ProcedureDef.pick({ name: true, description: true, body: true })),
});
export type DaemonUtilitiesSetParams = z.infer<typeof DaemonUtilitiesSetParams>;
export const DaemonUtilitiesSetResult = z.object({ ok: z.boolean() });
export type DaemonUtilitiesSetResult = z.infer<typeof DaemonUtilitiesSetResult>;

/**
 * Codex's `auth.json` for the Sandbox (ADR-0046): the Daemon keeps it on tmpfs behind
 * `~/.codex/auth.json`, where Codex reads its tokens from. Sent before the MCP set (the
 * Agent starts after that one) and again whenever the stored file changes. The same shape
 * comes back as the `codexAuthChanged` notification when Codex rewrites the file with
 * refreshed tokens.
 */
export const DaemonCodexAuthParams = z.object({
  authJson: z.string(),
});
export type DaemonCodexAuthParams = z.infer<typeof DaemonCodexAuthParams>;

/**
 * The Cursor login for the Sandbox (ADR-0054): an `auth.json` goes on tmpfs behind
 * `~/.config/cursor/auth.json`, an API key becomes the Agent's `CURSOR_API_KEY`. Sent before
 * the MCP set and again whenever the stored login changes. When the CLI refreshes the tokens
 * of an `auth.json`, the rewritten file comes back as the `cursorAuthChanged` notification.
 */
export const DaemonCursorAuthParams = z.object({
  login: z.string(),
});
export type DaemonCursorAuthParams = z.infer<typeof DaemonCursorAuthParams>;

export const DaemonCursorAuthChangedParams = z.object({
  authJson: z.string(),
});
export type DaemonCursorAuthChangedParams = z.infer<typeof DaemonCursorAuthChangedParams>;

/**
 * The pi login for the Sandbox (ADR-0075): the `auth.json` goes on tmpfs behind
 * `~/.pi/agent/auth.json`, the API keys become the Agent process's environment (`ANTHROPIC_API_KEY`,
 * ...), never the container's. Sent before the MCP set and again whenever the stored login changes;
 * empty values forget. When pi refreshes an OAuth token in `auth.json`, the rewritten file comes back
 * as the `piAuthChanged` notification.
 */
export const DaemonPiAuthParams = z.object({
  authJson: z.string(),
  apiKeys: z.record(z.string(), z.string()),
});
export type DaemonPiAuthParams = z.infer<typeof DaemonPiAuthParams>;

export const DaemonPiAuthChangedParams = z.object({
  authJson: z.string(),
});
export type DaemonPiAuthChangedParams = z.infer<typeof DaemonPiAuthChangedParams>;

/**
 * `opencodeAuthSet`: the OpenCode `auth.json` (ADR-0076) for the Sandbox's tmpfs, where OpenCode
 * reads it (`~/.local/share/opencode/auth.json`); `""` removes it. OpenCode refreshes the OAuth
 * tokens in the file; the rewritten file comes back as the `opencodeAuthChanged` notification.
 */
export const DaemonOpenCodeAuthParams = z.object({
  authJson: z.string(),
});
export type DaemonOpenCodeAuthParams = z.infer<typeof DaemonOpenCodeAuthParams>;

export const DaemonOpenCodeAuthChangedParams = z.object({
  authJson: z.string(),
});
export type DaemonOpenCodeAuthChangedParams = z.infer<typeof DaemonOpenCodeAuthChangedParams>;

/**
 * The fx login for the Sandbox (ADR-0077): a login file goes on tmpfs behind the path fx reads it
 * from (`~/.fx/auth.json`, `chatgpt-auth.json` or `grok-auth.json`, by its shape), an AI Gateway
 * API key becomes the Agent's `AI_GATEWAY_API_KEY`. Sent before the MCP set and again whenever the
 * stored login changes. When fx refreshes the tokens of a login file, the rewritten file comes back
 * as the `fxAuthChanged` notification.
 */
export const DaemonFxAuthParams = z.object({
  login: z.string(),
});
export type DaemonFxAuthParams = z.infer<typeof DaemonFxAuthParams>;

export const DaemonFxAuthChangedParams = z.object({
  authJson: z.string(),
});
export type DaemonFxAuthChangedParams = z.infer<typeof DaemonFxAuthChangedParams>;

export const DaemonKimiAuthParams = z.object({ login: z.string() });
export type DaemonKimiAuthParams = z.infer<typeof DaemonKimiAuthParams>;
export const DaemonKimiAuthChangedParams = z.object({ authJson: z.string() });
export type DaemonKimiAuthChangedParams = z.infer<typeof DaemonKimiAuthChangedParams>;

/** `copilotAuthSet`: the stored GitHub Copilot login (ADR-0082): a GitHub token, or the JSON of `~/.copilot/config.json`; `""` removes it. */
export const DaemonCopilotAuthParams = z.object({
  login: z.string(),
});
export type DaemonCopilotAuthParams = z.infer<typeof DaemonCopilotAuthParams>;

/** `copilotAuthChanged`: Copilot rewrote `~/.copilot/config.json` in the Sandbox; the file's content. */
export const DaemonCopilotAuthChangedParams = z.object({
  authJson: z.string(),
});
export type DaemonCopilotAuthChangedParams = z.infer<typeof DaemonCopilotAuthChangedParams>;

/** Every `*AuthChanged` notification carries the rewritten login file the same way. */
export const DaemonAuthChangedParams = z.object({
  authJson: z.string(),
});
export type DaemonAuthChangedParams = z.infer<typeof DaemonAuthChangedParams>;

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
export const DaemonPromptParams = PromptRequest.innerType().extend({
  note: z.string().optional(),
});
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
  body: Exclude<SessionEventBody, { type: "status" } | { type: "forked" } | { type: "e2e_run" }>;
}
