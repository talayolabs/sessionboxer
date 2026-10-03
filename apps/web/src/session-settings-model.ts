import type {
  AgentToolsPolicy,
  Environment,
  OptionValues,
  PublicSettings,
  SessionSettings,
  SessionSettingsInput,
} from "@sessionboxer/protocol";

/*
 * The per-Session settings as the forms edit them (`SessionSettingsDraft`) and the conversions to and from
 * the wire: no React, so node tests load it as is (`scripts/session-settings.test.mjs`).
 */

/** Every per-Session setting as the form edits it (Docker is a yes/no here; the host picks the mode). */
export interface SessionSettingsDraft {
  model: string | null;
  options: OptionValues;
  inspectLlm: boolean;
  mcpEnabled: string[];
  /** Utilities on for the Session (ADR-0073), by registry id. */
  utilitiesEnabled: string[];
  instructions: string;
  autoSnapshot: boolean | null;
  snapshotKeep: number | null;
  /** Verify each turn end to end (ADR-0044); `null` follows Settings. */
  e2eVerify: boolean | null;
  /** What the `sessionboxer` MCP lets the Agent do (ADR-0062); `null` follows Settings. */
  agentTools: AgentToolsPolicy | null;
  approveCreate: boolean | null;
  /** Where the desktop runs (ADR-0057); fixed once the Session exists, a fork keeps the origin's. */
  environment: Environment;
  /** Start from this Snapshot's image instead of a fresh one (ADR-0069); `environment` is then the Snapshot's. Creation only. */
  snapshotId: string | null;
  docker: boolean;
  cpus: number | null;
  memoryGb: number | null;
  gitName: string;
  gitEmail: string;
}

/** The Utilities a new Session starts with: marked default, in an Environment marked default (the Control Plane applies the same rule). */
export function defaultUtilitiesEnabled(settings: PublicSettings): string[] {
  const envOn = new Set(settings.utilityEnvironments.filter((e) => e.enabledByDefault).map((e) => e.name));
  return settings.utilities.filter((u) => u.enabledByDefault && envOn.has(u.environment)).map((u) => u.id);
}

/** A new Session starts from the global Settings. */
export function draftFromDefaults(settings: PublicSettings): SessionSettingsDraft {
  return {
    model: null,
    options: {},
    inspectLlm: true,
    mcpEnabled: settings.mcpServers.filter((s) => s.enabledByDefault).map((s) => s.id),
    utilitiesEnabled: defaultUtilitiesEnabled(settings),
    instructions: settings.instructions,
    autoSnapshot: null,
    snapshotKeep: null,
    e2eVerify: null,
    agentTools: null,
    approveCreate: null,
    environment: "docker-linux",
    snapshotId: null,
    docker: settings.dockerInSandbox,
    cpus: null,
    memoryGb: null,
    gitName: settings.gitUserName || settings.hostGitIdentity.name,
    gitEmail: settings.gitUserEmail || settings.hostGitIdentity.email,
  };
}

/** A fork (or the live dialog) starts from what the Session has. */
export function draftFromSettings(s: SessionSettings): SessionSettingsDraft {
  return {
    model: s.model,
    options: s.options,
    inspectLlm: s.inspectLlm,
    mcpEnabled: s.mcpEnabled,
    utilitiesEnabled: s.utilitiesEnabled,
    instructions: s.instructions,
    autoSnapshot: s.autoSnapshot,
    snapshotKeep: s.snapshotKeep,
    e2eVerify: s.e2eVerify,
    agentTools: s.agentTools,
    approveCreate: s.approveCreate,
    environment: s.sandbox.environment,
    snapshotId: null,
    docker: s.sandbox.dockerMode !== "none",
    cpus: s.sandbox.cpus,
    memoryGb: s.sandbox.memoryGb,
    gitName: s.sandbox.gitIdentity.name,
    gitEmail: s.sandbox.gitIdentity.email,
  };
}

/** The `settings` of a create/fork request. */
export function draftToInput(d: SessionSettingsDraft): SessionSettingsInput {
  return {
    model: d.model,
    options: d.options,
    inspectLlm: d.inspectLlm,
    mcpEnabled: d.mcpEnabled,
    utilitiesEnabled: d.utilitiesEnabled,
    instructions: d.instructions,
    autoSnapshot: d.autoSnapshot,
    snapshotKeep: d.snapshotKeep,
    e2eVerify: d.e2eVerify,
    agentTools: d.agentTools,
    approveCreate: d.approveCreate,
    sandbox: {
      environment: d.environment,
      docker: d.docker,
      cpus: d.cpus,
      memoryGb: d.memoryGb,
      gitIdentity: { name: d.gitName.trim(), email: d.gitEmail.trim() },
    },
  };
}

/** A stored template's settings back into the form; omitted parts follow the current defaults. */
export function draftFromInput(input: SessionSettingsInput, settings: PublicSettings): SessionSettingsDraft {
  const base = draftFromDefaults(settings);
  return {
    model: input.model ?? base.model,
    options: input.options ?? base.options,
    inspectLlm: input.inspectLlm ?? base.inspectLlm,
    mcpEnabled: input.mcpEnabled ?? base.mcpEnabled,
    utilitiesEnabled: input.utilitiesEnabled ?? base.utilitiesEnabled,
    instructions: input.instructions ?? base.instructions,
    autoSnapshot: input.autoSnapshot === undefined ? base.autoSnapshot : input.autoSnapshot,
    snapshotKeep: input.snapshotKeep === undefined ? base.snapshotKeep : input.snapshotKeep,
    e2eVerify: input.e2eVerify === undefined ? base.e2eVerify : input.e2eVerify,
    agentTools: input.agentTools === undefined ? base.agentTools : input.agentTools,
    approveCreate: input.approveCreate === undefined ? base.approveCreate : input.approveCreate,
    environment: input.sandbox?.environment ?? base.environment,
    snapshotId: base.snapshotId,
    docker: input.sandbox?.docker ?? base.docker,
    cpus: input.sandbox?.cpus === undefined ? base.cpus : input.sandbox.cpus,
    memoryGb: input.sandbox?.memoryGb === undefined ? base.memoryGb : input.sandbox.memoryGb,
    gitName: input.sandbox?.gitIdentity?.name ?? base.gitName,
    gitEmail: input.sandbox?.gitIdentity?.email ?? base.gitEmail,
  };
}
