// Node strips the model's TypeScript, as in feed.test.mjs. Expected values are written by hand, not computed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultUtilitiesEnabled, draftFromDefaults, draftFromSettings, draftToInput, draftFromInput,
} from "../apps/web/src/session-settings-model.ts";

const settings = {
  instructions: "Be brief.", dockerInSandbox: true, gitUserName: "", gitUserEmail: "me@example.com",
  hostGitIdentity: { name: "Host User", email: "host@example.com" },
  mcpServers: [{ id: "github", enabledByDefault: true }, { id: "slack", enabledByDefault: false }],
  utilityEnvironments: [{ name: "node", enabledByDefault: true }, { name: "python", enabledByDefault: false }],
  utilities: [
    { id: "eslint", environment: "node", enabledByDefault: true },
    { id: "prettier", environment: "node", enabledByDefault: false },
    { id: "ruff", environment: "python", enabledByDefault: true },
  ],
};
const defaults = {
  model: null, options: {}, inspectLlm: true, mcpEnabled: ["github"], utilitiesEnabled: ["eslint"],
  instructions: "Be brief.", autoSnapshot: null, snapshotKeep: null, e2eVerify: null, agentTools: null, approveCreate: null,
  environment: "docker-linux", snapshotId: null, docker: true, cpus: null, memoryGb: null,
  gitName: "Host User", gitEmail: "me@example.com",
};
const sessionSettings = {
  model: "claude-3", options: { effort: "high" }, inspectLlm: false, mcpEnabled: ["slack"], utilitiesEnabled: [],
  instructions: "", autoSnapshot: true, snapshotKeep: 3, e2eVerify: false, agentTools: "all", approveCreate: true,
  sandbox: { environment: "qemu-windows", dockerMode: "none", cpus: 2, memoryGb: 4, gitIdentity: { name: "Dev", email: "dev@example.com" } },
};
const sessionDraft = {
  model: "claude-3", options: { effort: "high" }, inspectLlm: false, mcpEnabled: ["slack"], utilitiesEnabled: [],
  instructions: "", autoSnapshot: true, snapshotKeep: 3, e2eVerify: false, agentTools: "all", approveCreate: true,
  environment: "qemu-windows", snapshotId: null, docker: false, cpus: 2, memoryGb: 4, gitName: "Dev", gitEmail: "dev@example.com",
};

test("defaultUtilitiesEnabled: a default Utility counts only in an Environment that is on by default", () => {
  assert.deepEqual(defaultUtilitiesEnabled(settings), ["eslint"]);
  assert.deepEqual(defaultUtilitiesEnabled({ ...settings, utilityEnvironments: [] }), []);
});

test("draftFromDefaults: default MCP servers and Utilities, host git identity when Settings has none", () => {
  assert.deepEqual(draftFromDefaults(settings), defaults);
  assert.deepEqual(draftFromDefaults({ ...settings, gitUserName: "Me", dockerInSandbox: false }), { ...defaults, gitName: "Me", docker: false });
});

test("draftFromSettings: Docker is a yes/no (any mode but none), snapshotId is never carried", () => {
  assert.deepEqual(draftFromSettings(sessionSettings), sessionDraft);
  assert.equal(draftFromSettings({ ...sessionSettings, sandbox: { ...sessionSettings.sandbox, dockerMode: "sysbox" } }).docker, true);
});

test("draftToInput: trims the git identity and leaves snapshotId out of the request", () => {
  const input = draftToInput({ ...sessionDraft, snapshotId: "snap", gitName: " Dev ", gitEmail: "dev@example.com " });
  assert.deepEqual(input, {
    model: "claude-3", options: { effort: "high" }, inspectLlm: false, mcpEnabled: ["slack"], utilitiesEnabled: [],
    instructions: "", autoSnapshot: true, snapshotKeep: 3, e2eVerify: false, agentTools: "all", approveCreate: true,
    sandbox: { environment: "qemu-windows", docker: false, cpus: 2, memoryGb: 4, gitIdentity: { name: "Dev", email: "dev@example.com" } },
  });
  assert.equal("snapshotId" in input, false);
});

test("draftFromInput: omitted fields follow the defaults; explicit null, false, 0 and empty strings are kept", () => {
  const input = {
    model: null, inspectLlm: false, mcpEnabled: [], instructions: "",
    autoSnapshot: null, snapshotKeep: 0, e2eVerify: false, agentTools: null, approveCreate: false,
    sandbox: { docker: false, cpus: null, memoryGb: 8, gitIdentity: { name: "", email: "other@example.com" } },
  };
  const saved = structuredClone(input);
  assert.deepEqual(draftFromInput(input, settings), {
    model: null, options: {}, inspectLlm: false, mcpEnabled: [], utilitiesEnabled: ["eslint"],
    instructions: "", autoSnapshot: null, snapshotKeep: 0, e2eVerify: false, agentTools: null, approveCreate: false,
    environment: "docker-linux", snapshotId: null, docker: false, cpus: null, memoryGb: 8, gitName: "", gitEmail: "other@example.com",
  });
  assert.deepEqual(input, saved);
});

test("draftFromInput: an empty template is the defaults", () => {
  assert.deepEqual(draftFromInput({}, settings), defaults);
});
