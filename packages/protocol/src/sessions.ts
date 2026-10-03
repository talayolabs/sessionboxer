// ---------------------------------------------------------------------------
// Sessions (Control Plane <-> web UI)
// ---------------------------------------------------------------------------

import { z } from "zod";
import { Provider, SessionStatus, WorkspaceSource } from "./common.js";
import { SessionRepo, RepoSpec } from "./repositories.js";
import { SessionSettings, SessionSettingsInput, MAX_PROMPT_ATTACHMENTS, SessionSettingsPatch, PromptAttachment } from "./session-settings.js";
import { AgentOption, OptionValues, INSTRUCTIONS_MAX_CHARS } from "./models.js";
import { Branch, ROOT_BRANCH_ID, GitIdentity } from "./branches.js";
import { SessionUsage } from "./usage-limits.js";
import { SessionUsb } from "./usb.js";

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
  /** The queue is playing: the next queued message is sent whenever the Agent is idle. Off = paused by the user (or after a cancelled/failed turn). */
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
  /** The Provider's usage meters and, when it refused to work for lack of credit, the standing limit. */
  usage: SessionUsage.default({}),
  /** USB device of the host connected to this Sandbox (one Session per device). */
  usb: SessionUsb.nullable().default(null),
  /** The Session whose Agent created this one (`session_create` / `session_fork`, ADR-0062); `null` when the user did. */
  createdBy: z.object({ sessionId: z.string() }).nullable().default(null),
  /** Listed before the others, whatever its age (ADR-0071). */
  pinned: z.boolean().default(false),
  /** Folder the sidebar files the Session under (ADR-0074); `null` = the unfiled list. */
  folderId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof Session>;

/** A named group Sessions are filed under in the sidebar (ADR-0074). */
export const SessionFolder = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type SessionFolder = z.infer<typeof SessionFolder>;

export const CreateFolderRequest = z.object({
  name: z.string().min(1).max(80),
});
export type CreateFolderRequest = z.infer<typeof CreateFolderRequest>;

export const UpdateFolderRequest = z.object({
  name: z.string().min(1).max(80).optional(),
});
export type UpdateFolderRequest = z.infer<typeof UpdateFolderRequest>;

export const CreateSessionRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  provider: Provider.default("claude-code"),
  /** Repositories to clone/copy into `/workspace/<name>`; none gives an empty Workspace. */
  repos: z.array(RepoSpec).max(50).optional(),
  /** Older clients: a single `git`/`copy` source, taken as one repository when `repos` is omitted. */
  workspaceSource: WorkspaceSource.default({ type: "empty" }),
  /**
   * Start the Sandbox from this Snapshot's image instead of a fresh one (ADR-0069): its files,
   * tools and repositories come along, the conversation starts empty, the Environment is the
   * Snapshot's (`settings.sandbox.environment` is ignored). `repos` must then be empty.
   */
  snapshotId: z.string().min(1).optional(),
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
  /** Ids of `StagedUpload`s to attach to the first prompt (a prompt of files alone is fine). */
  attachments: z.array(z.string().min(1)).max(MAX_PROMPT_ATTACHMENTS).optional(),
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
  /** Keep the Session at the top of the list (`true`) or let it back in date order. */
  pinned: z.boolean().optional(),
  /** Folder to file the Session under (ADR-0074); `null` moves it back to the unfiled list. */
  folderId: z.string().nullable().optional(),
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
