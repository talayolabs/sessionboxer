import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings, providerUnavailableIn, instructionsDelivery } from "../packages/protocol/dist/index.js";
import { applySettingsUpdate, providerEnv, providerReady, toPublicSettings } from "../apps/control-plane/dist/config.js";
import { normalizeKimiLogin, describeKimiLogin } from "../apps/control-plane/dist/kimi-login.js";
import { PROVIDER_AUTH, providerOfAuthChanged, providersAuthChangedBy } from "../apps/control-plane/dist/provider-auth.js";
import { RECIPES } from "../apps/control-plane/dist/provider-login.js";
import { KimiAuth } from "../packages/sandbox-daemon/dist/kimi-auth.js";
import { sessionOptions } from "../packages/sandbox-daemon/dist/agent-options.js";
import { AgentManager } from "../packages/sandbox-daemon/dist/agent.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const login = (expires = 1_800_000_000) => JSON.stringify({ access_token: "test-access-not-real", refresh_token: "test-refresh-not-real", expires_at: expires, scope: "kimi" });

test("first-prompt instructions reach the wire once, and the legacy catalog survives a daemon restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "kimi-agent-"));
  const cfg = { stateFile: join(home, "state.json"), sessionId: "fixture", cwd: home, instructions: "standing-marker", instructionsDelivery: "first-prompt", workspaceBriefing: () => "briefing-marker", builtinMcps: () => [], legacyModels: true, log: () => {} };
  const events = { onStateChange: () => {}, onTurnEnded: () => {}, onError: (error) => assert.fail(error) };
  const agent = new AgentManager(cfg, events);
  agent.mcpServers = [];
  agent.ensureStarted = async () => {};
  agent.acpSessionId = "acp-fixture";
  agent.writeState({ acpSessionId: "acp-fixture", freshSessionIds: ["acp-fixture"] });
  agent.captureConfigOptions(sessionOptions({ models: { currentModelId: "mock", availableModels: [{ modelId: "mock", name: "Mock" }] } }));
  const prompts = [];
  agent.conn = { agent: { request: async (_, params) => { prompts.push(params.prompt[0].text); return { stopReason: "end_turn" }; } } };
  await agent.prompt("first");
  await agent.prompt("second");
  assert.match(prompts[0], /standing-marker/);
  assert.match(prompts[0], /briefing-marker/);
  assert.ok(prompts[0].endsWith("first"));
  assert.equal(prompts[1], "second");
  const resumed = new AgentManager(cfg, events);
  assert.deepEqual(resumed.modelOptions, agent.modelOptions);
  assert.equal(resumed.modelConfigId, "model");
  assert.equal(resumed.firstPromptText("third"), "third");
});

test("desktop MCP coordinate schemas use homogeneous items for Kimi's modern JSON Schema validator", async () => {
  const client = new Client({ name: "schema-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["packages/computer-use-mcp/dist/index.js"], stderr: "pipe" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      for (const [field, length] of [["coordinate", 2], ["region", 4]]) {
        let schema = tool.inputSchema.properties?.[field];
        if (!schema) continue;
        if (schema.$ref) schema = schema.$ref.slice(2).split("/").reduce((node, key) => node[key], tool.inputSchema);
        assert.deepEqual(schema.items, { type: "integer" }, tool.name);
        assert.equal(schema.minItems, length, tool.name);
        assert.equal(schema.maxItems, length, tool.name);
      }
    }
    assert.ok(tools.some((tool) => tool.name === "zoom"));
  } finally {
    await client.close();
  }
});

test("Kimi accepts the genuine file shape, rejects API keys, and publishes metadata only", () => {
  assert.throws(() => normalizeKimiLogin("sk-not-a-login"), /API-key-only/);
  for (const bad of ["{}", "null", '{"access_token":"a"}', '{"access_token":"a","refresh_token":""}']) assert.throws(() => normalizeKimiLogin(bad));
  assert.equal(normalizeKimiLogin("  "), "");
  assert.equal(normalizeKimiLogin("  " + login() + " "), login());
  assert.deepEqual(describeKimiLogin(login()), { kind: "oauth", expiresAt: "2027-01-15T08:00:00.000Z" });
  const settings = applySettingsUpdate(Settings.parse({}), { providerSecrets: { kimi: { KIMI_LOGIN: login() } } });
  assert.equal(providerReady("kimi", settings), true);
  assert.deepEqual(providerEnv("kimi", settings), {});
  const published = toPublicSettings(settings);
  assert.equal(published.providerSecretsSet.kimi.KIMI_LOGIN, true);
  assert.deepEqual(published.kimiLogin, describeKimiLogin(login()));
  assert.ok(!JSON.stringify(published).includes("test-access-not-real"));
  assert.ok(!JSON.stringify(published).includes("test-refresh-not-real"));
  const forgotten = applySettingsUpdate(settings, { providerSecrets: { kimi: { KIMI_LOGIN: "" } } });
  assert.equal(providerReady("kimi", forgotten), false);
});

test("Kimi auth RPC pins and refresh ordering", () => {
  const row = PROVIDER_AUTH.kimi;
  assert.equal(row.setMethod, "_sessionboxer/kimi/auth/set");
  assert.equal(row.changedMethod, "_sessionboxer/kimi/auth/changed");
  const settings = applySettingsUpdate(Settings.parse({}), { providerSecrets: { kimi: { KIMI_LOGIN: login() } } });
  assert.deepEqual(row.params(settings), { login: login() });
  assert.deepEqual(row.storeUpdate(login()), { providerSecrets: { kimi: { KIMI_LOGIN: login() } } });
  assert.deepEqual(providersAuthChangedBy(row.storeUpdate(login())), ["kimi"]);
  assert.equal(providerOfAuthChanged(row.changedMethod), "kimi");
  assert.equal(row.newer(login(), login()), false);
  assert.equal(row.newer(login(1_900_000_000), login()), true);
  assert.equal(row.newer(login(1_700_000_000), login()), false);
  assert.equal(row.newer("invalid", login()), false);
  assert.equal(row.newer(login(), ""), true);
});

test("Kimi device login is limited to the verified URL, captures the code and OAuth file", () => {
  const recipe = RECIPES.kimi;
  const url = "https://www.kimi.com/code/authorize_device?user_code=ABCD-EFGH";
  assert.equal(recipe.isLoginUrl(new URL(url)), true);
  assert.equal(recipe.isLoginUrl(new URL("https://www.kimi.com.evil.example/code/authorize_device")), false);
  assert.equal(recipe.userCode("Verification URL: " + url), "ABCD-EFGH");
  assert.deepEqual(recipe.args, ["login"]);
  assert.deepEqual(recipe.files, [".kimi/credentials/kimi-code.json"]);
  assert.deepEqual(recipe.result("", login()), { login: login(), account: null });
  assert.equal(recipe.result("", "invalid"), null);
});

test("Kimi is unavailable on the x86_64 Mac guest and uses first-prompt standing instructions", () => {
  assert.match(providerUnavailableIn("kimi", "qemu-macos"), /x86_64/);
  assert.equal(providerUnavailableIn("kimi", "docker-linux"), null);
  assert.equal(providerUnavailableIn("kimi", "qemu-windows"), null);
  assert.equal(instructionsDelivery("kimi"), "first-prompt");
});

test("Kimi's legacy model list is converted without changing configOptions", () => {
  assert.deepEqual(sessionOptions({ models: { currentModelId: "a", availableModels: [{ modelId: "a", name: "A" }] } }), [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "A", description: undefined }] },
  ]);
  const options = [{ id: "test" }];
  assert.equal(sessionOptions({ configOptions: options }), options);
});

test("atomic credential replacement remains behind the directory symlink and reports refresh without logging tokens", async () => {
  const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
  const tmpfs = mkdtempSync(join(tmpdir(), "kimi-tmpfs-"));
  const logs = [];
  let resolveRefresh;
  const refreshed = new Promise((resolve) => { resolveRefresh = resolve; });
  const auth = new KimiAuth(home, tmpfs, (message) => logs.push(message), resolveRefresh);
  const env = auth.set(login());
  assert.deepEqual(auth.set(login()), env);
  const file = join(home, ".kimi/credentials/kimi-code.json");
  assert.ok(realpathSync(file).startsWith(tmpfs));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const replacement = join(home, ".kimi/credentials/replacement.json");
  writeFileSync(replacement, login(1_900_000_000), { mode: 0o600 });
  renameSync(replacement, file);
  assert.equal(await Promise.race([refreshed, new Promise((_, reject) => setTimeout(() => reject(Error("refresh not observed")), 2000).unref())]), login(1_900_000_000));
  assert.ok(realpathSync(file).startsWith(tmpfs));
  assert.equal(readFileSync(file, "utf8"), login(1_900_000_000));
  assert.ok(!logs.join("\n").includes("test-access-not-real"));
  auth.set("");
  assert.equal(existsSync(file), false);
  auth.close();
});
