// ---------------------------------------------------------------------------
// Per-Session settings: everything a Session is configured with, as one object
// (`Session.settings`), next to the runtime state the Control Plane and the
// Daemon own (status, pending flags, sizes, branches). Live fields (model,
// options, MCP, Inspect LLM, snapshots) change through `PATCH /api/sessions/:id`;
// the Sandbox block is fixed at creation and only changes by forking.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { Environment, DockerMode, SessionStatus } from "./common.js";
import { GitIdentity } from "./branches.js";
import { OptionValues, INSTRUCTIONS_MAX_CHARS } from "./models.js";

/** How the Sandbox was built; fixed for the Session's life (a fork can differ). */
export const SandboxSettings = z.object({
  environment: Environment.default("docker-linux"),
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
   * exact request/response bodies (Claude Code only; see `LlmCall`). On by default for new Sessions.
   */
  inspectLlm: z.boolean().default(false),
  /** Ids of the `Settings.mcpServers` entries enabled for this Session. */
  mcpEnabled: z.array(z.string()).default([]),
  /** Ids of the `Settings.utilities` entries enabled for this Session (ADR-0073). */
  utilitiesEnabled: z.array(z.string()).default([]),
  /** Standing instructions the Agent got with this Session (see `instructionsDelivery`); fixed at creation. */
  instructions: z.string().max(INSTRUCTIONS_MAX_CHARS).default(""),
  /** Override of `Settings.autoSnapshot`; `null` follows the global setting. */
  autoSnapshot: z.boolean().nullable().default(null),
  /** Override of `Settings.snapshotKeep`; `null` follows the global setting. */
  snapshotKeep: z.number().int().nonnegative().nullable().default(null),
  /** Override of `Settings.e2eVerify` (verify each turn end to end, see `E2eRun`); `null` follows the global setting. */
  e2eVerify: z.boolean().nullable().default(null),
  /** Override of `Settings.agentTools` (what the `sessionboxer` MCP lets the Agent do, ADR-0062); `null` follows the global setting. */
  agentTools: z.enum(["off", "session", "all"]).nullable().default(null),
  /** Override of `Settings.approveCreate` (the user allows each Session the Agent creates); `null` follows the global setting. */
  approveCreate: z.boolean().nullable().default(null),
  sandbox: SandboxSettings.default({}),
});
export type SessionSettings = z.infer<typeof SessionSettings>;

/** Global values the `null` settings fall back to. */
export interface SessionSettingsDefaults {
  autoSnapshot: boolean;
  snapshotKeep: number;
  e2eVerify: boolean;
  agentTools: "off" | "session" | "all";
  approveCreate: boolean;
  sandboxCpus: number;
  sandboxMemoryGb: number;
}

/** The values in force: each `null` replaced by the global default. */
export function resolveSessionSettings(
  settings: SessionSettings,
  defaults: SessionSettingsDefaults,
): { autoSnapshot: boolean; snapshotKeep: number; e2eVerify: boolean; agentTools: "off" | "session" | "all"; approveCreate: boolean; cpus: number; memoryGb: number } {
  return {
    autoSnapshot: settings.autoSnapshot ?? defaults.autoSnapshot,
    snapshotKeep: settings.snapshotKeep ?? defaults.snapshotKeep,
    e2eVerify: settings.e2eVerify ?? defaults.e2eVerify,
    agentTools: settings.agentTools ?? defaults.agentTools,
    approveCreate: settings.approveCreate ?? defaults.approveCreate,
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
    utilitiesEnabled: z.array(z.string()).optional(),
    /** `null` clears the override (follow `Settings.autoSnapshot`). */
    autoSnapshot: z.boolean().nullable().optional(),
    /** `null` clears the override (follow `Settings.snapshotKeep`). */
    snapshotKeep: z.number().int().nonnegative().nullable().optional(),
    /** `null` clears the override (follow `Settings.e2eVerify`). */
    e2eVerify: z.boolean().nullable().optional(),
    /** `null` clears the override (follow `Settings.agentTools`). */
    agentTools: z.enum(["off", "session", "all"]).nullable().optional(),
    /** `null` clears the override (follow `Settings.approveCreate`). */
    approveCreate: z.boolean().nullable().optional(),
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
  utilitiesEnabled: z.array(z.string()).optional(),
  instructions: z.string().max(INSTRUCTIONS_MAX_CHARS).optional(),
  autoSnapshot: z.boolean().nullable().optional(),
  snapshotKeep: z.number().int().nonnegative().nullable().optional(),
  e2eVerify: z.boolean().nullable().optional(),
  agentTools: z.enum(["off", "session", "all"]).nullable().optional(),
  approveCreate: z.boolean().nullable().optional(),
  sandbox: z
    .object({
      /** Omitted means `docker-linux`; a fork keeps the origin's. */
      environment: Environment.optional(),
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

/**
 * A file for a Session that does not exist yet: `PUT /api/uploads?name=` stores it on the Control
 * Plane, `CreateSessionRequest.attachments` names it by id, and it lands in the new Sandbox as a
 * `PromptAttachment` of the first prompt. Files nobody claims are swept after a day.
 */
export const StagedUpload = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
});
export type StagedUpload = z.infer<typeof StagedUpload>;
