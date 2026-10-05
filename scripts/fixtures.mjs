// Shared row fixtures for the control-plane characterization tests. Run after `tsc -b`.
import { ROOT_BRANCH_ID, Settings } from "../packages/protocol/dist/index.js";

/** The Session row as `SessionManager.createClaimed` inserts it once its Sandbox runs: idle, Claude Code, Linux Sandbox. */
export function sessionRow(id, overrides = {}) {
  const now = "2026-01-01T00:00:00.000Z";
  const { settings: settingsOverride, sandbox, usage, ...rest } = overrides;
  return {
    id,
    title: `Session ${id}`,
    provider: "claude-code",
    status: "idle",
    workspaceSource: { type: "empty" },
    repos: [],
    settings: {
      ...Settings.parse({}),
      ...{ model: null, options: {}, inspectLlm: false, mcpEnabled: [], utilitiesEnabled: [], instructions: "" },
      autoSnapshot: null,
      snapshotKeep: null,
      e2eVerify: null,
      agentTools: null,
      approveCreate: null,
      ...settingsOverride,
      sandbox: { environment: "docker-linux", dockerMode: "none", cpus: null, memoryGb: null, gitIdentity: { name: "", email: "" }, ...sandbox },
    },
    containerId: `ctr-${id}`,
    image: null,
    error: null,
    queueRunning: false,
    diskBytes: null,
    mcpPending: false,
    modelPending: false,
    optionsPending: false,
    availableOptions: [],
    inspectLlmPending: false,
    snapshotBytes: 0,
    snapshotCount: 0,
    branches: [],
    activeBranchId: ROOT_BRANCH_ID,
    usage: { windows: [], updatedAt: null, limit: null, autoContinue: false, ...usage },
    usb: null,
    createdBy: null,
    pinned: false,
    folderId: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

/** A cloned repository row as `SessionManager` records it once the Sandbox has it: a git source, ready, no login bound. */
export function gitRepo(url, overrides = {}) {
  const name = url.replace(/\/+$/, "").split("/").pop().replace(/\.git$/, "");
  return {
    id: `repo-${name}`,
    name,
    source: { type: "git", url },
    status: "ready",
    error: null,
    git: null,
    account: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
