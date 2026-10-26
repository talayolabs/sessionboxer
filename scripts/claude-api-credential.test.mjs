// The Claude API credential command (ADR-0090): reading this machine's ~/.claude/settings.json, running the
// helper the way Claude Code does, caching its output, and serving it to Claude Code in the Sandbox via apiKeyHelper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionSettings, SessionSettingsPatch, Settings } from "../packages/protocol/dist/index.js";
import { ClaudeApiCredential, claudeHostSettingsUpdate, readClaudeHostSettings, ClaudeApiLoginRun, runClaudeCredentialCommand } from "../apps/control-plane/dist/claude-api-credential.js";
import { providerEnv, providerReady, toPublicSettings } from "../apps/control-plane/dist/config.js";
import { ClaudeSettings } from "../packages/sandbox-daemon/dist/claude-settings.js";

const home = (file) => {
  const dir = mkdtempSync(join(tmpdir(), "sbx-claude-home-"));
  if (file !== undefined) {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), typeof file === "string" ? file : JSON.stringify(file));
  }
  return dir;
};

test("readClaudeHostSettings: the gateway URL and apiKeyHelper of ~/.claude/settings.json, secrets reported as set, nothing relevant as null", () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(readClaudeHostSettings(home()), null, "no file");
  assert.equal(readClaudeHostSettings(home("{not json")), null, "unreadable file");
  assert.equal(readClaudeHostSettings(home({ permissions: { defaultMode: "plan" } })), null, "nothing about the API");
  const h = home({
    env: { ANTHROPIC_BASE_URL: " https://claude-gateway-staging.example.net ", ANTHROPIC_AUTH_TOKEN: "secret" },
    apiKeyHelper: "/home/me/.local/bin/gateway token",
  });
  assert.deepEqual(readClaudeHostSettings(h), {
    baseUrl: "https://claude-gateway-staging.example.net",
    credentialCommand: "/home/me/.local/bin/gateway token",
    authTokenSet: true,
    apiKeySet: false,
  });
  assert.deepEqual(claudeHostSettingsUpdate(h), {
    baseUrl: "https://claude-gateway-staging.example.net",
    credentialCommand: "/home/me/.local/bin/gateway token",
    authToken: "secret",
    apiKey: "",
  });
  assert.throws(() => claudeHostSettingsUpdate(home()), (e) => e.status === 404);
});

test("readClaudeHostSettings honors CLAUDE_CONFIG_DIR", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbx-claude-cfg-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: "vault read token" }));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.deepEqual(readClaudeHostSettings(home()), { baseUrl: null, credentialCommand: "vault read token", authTokenSet: false, apiKeySet: false });
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test("runClaudeCredentialCommand: a shell command, trimmed output; silence and failure are errors that do not echo the output", async () => {
  assert.equal(await runClaudeCredentialCommand("printf '  tok-123\\n'"), "tok-123");
  assert.equal(await runClaudeCredentialCommand("echo a; echo b"), "a\nb");
  await assert.rejects(runClaudeCredentialCommand("true"), /printed nothing/);
  await assert.rejects(runClaudeCredentialCommand("echo nope >&2; exit 3"), (e) => /failed/.test(e.message) && /nope/.test(e.message) && !/tok/.test(e.message));
  await assert.rejects(runClaudeCredentialCommand("sleep 5", 200), /failed/);
});

test("ClaudeApiCredential: '' without a command; one run shared by concurrent callers and cached; re-run when the command changes or the cache is invalidated", async () => {
  let settings = Settings.parse({});
  const runs = [];
  const logs = [];
  let value = "tok-1";
  const cred = new ClaudeApiCredential(() => settings, (m) => logs.push(m), async (cmd) => {
    runs.push(cmd);
    return value;
  });
  assert.equal(cred.configured(), false);
  assert.equal(await cred.current(), "");
  assert.deepEqual(runs, []);
  settings = Settings.parse({ claudeApi: { credentialCommand: "gw token" } });
  assert.equal(cred.configured(), true);
  assert.deepEqual(await Promise.all([cred.current(), cred.current()]), ["tok-1", "tok-1"]);
  assert.equal(await cred.current(), "tok-1");
  assert.deepEqual(runs, ["gw token"], "one run for the three callers");
  value = "tok-2";
  cred.invalidate();
  assert.equal(await cred.current(), "tok-2");
  settings = Settings.parse({ claudeApi: { credentialCommand: "gw2 token" } });
  assert.equal(await cred.current(), "tok-2");
  assert.deepEqual(runs, ["gw token", "gw token", "gw2 token"]);
  assert.deepEqual(logs, ["claude api credential minted", "claude api credential rotated"]);
  assert.ok(logs.every((l) => !l.includes("tok-")), "the credential never reaches the log");
});

test("Settings: credentialCommand is trimmed, public without the secret, makes Claude ready, and keeps the static proxy credentials out of the Sandbox's environment", async () => {
  const s = Settings.parse({ claudeApi: { baseUrl: "https://gw.example.net", credentialCommand: "  gw token ", authToken: "static" } });
  assert.equal(providerReady("claude-code", s), true);
  const env = providerEnv("claude-code", s);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://gw.example.net");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined, "would outrank apiKeyHelper in Claude Code and pin a stale value");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  const pub = toPublicSettings(s, "none", { sessionboxer: null, ssh: null }, [], false);
  assert.equal(pub.claudeApi.credentialCommand, "  gw token ", "trimming happens in applySettingsUpdate, see the schema test");
  assert.ok("host" in pub.claudeApi);
  const without = Settings.parse({ claudeApi: { baseUrl: "https://gw.example.net", authToken: "static" } });
  assert.equal(providerEnv("claude-code", without).ANTHROPIC_AUTH_TOKEN, "static");
});

test("ClaudeSettings.setApiKeyHelperCredential: owner-only credential file on tmpfs, `cat` of it as apiKeyHelper beside the other keys; '' removes both", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbx-claude-sandbox-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ permissions: { defaultMode: "bypassPermissions" }, availableModels: ["opus"] }));
  const logs = [];
  const cs = new ClaudeSettings(file, (m) => logs.push(m));
  const credFile = join(dir, "shm", "claude-api-credential");
  cs.setApiKeyHelperCredential(credFile, "tok-1");
  assert.equal(readFileSync(credFile, "utf8"), "tok-1");
  assert.equal(statSync(credFile).mode & 0o777, 0o600);
  let settings = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(settings.apiKeyHelper, `cat ${credFile}`);
  assert.deepEqual(settings.permissions, { defaultMode: "bypassPermissions" });
  assert.deepEqual(settings.availableModels, ["opus"]);
  const written = statSync(file).mtimeMs;
  cs.setApiKeyHelperCredential(credFile, "tok-2");
  assert.equal(readFileSync(credFile, "utf8"), "tok-2", "a rotation rewrites the file only");
  assert.equal(statSync(file).mtimeMs, written);
  cs.setApiKeyHelperCredential(credFile, "");
  assert.equal(existsSync(credFile), false);
  settings = JSON.parse(readFileSync(file, "utf8"));
  assert.equal("apiKeyHelper" in settings, false);
  assert.deepEqual(settings.availableModels, ["opus"]);
  assert.ok(logs.every((l) => !l.includes("tok-")), "the credential never reaches the log");
});

test("ClaudeApiLoginRun: output is served while the command runs, the exit sets ok, onDone hears it; a failure, a hung command, a cancel", async () => {
  const verdicts = [];
  const run = new ClaudeApiLoginRun({ timeoutMs: 400, onDone: (ok) => verdicts.push(ok) });
  assert.deepEqual(run.current(), { running: false, output: "", ok: null, startedAt: null, finishedAt: null });
  const started = run.start("echo 'Your code: ABCD'; echo open https://sso.example.net/device >&2; sleep 0.2; echo done");
  assert.equal(started.running, true);
  assert.equal(started.ok, null);
  await new Promise((r) => setTimeout(r, 100));
  const mid = run.current();
  assert.equal(mid.running, true);
  assert.match(mid.output, /Your code: ABCD\nopen https:\/\/sso\.example\.net\/device\n/);
  assert.doesNotMatch(mid.output, /done/);
  assert.equal(run.start("echo second").running, true, "one run at a time: a second start returns the running one");
  const end = await run.finished();
  assert.equal(end.running, false);
  assert.equal(end.ok, true);
  assert.match(end.output, /done\n$/);
  assert.doesNotMatch(end.output, /second/);
  assert.ok(end.startedAt && end.finishedAt);
  assert.deepEqual(verdicts, [true]);

  run.start("echo nope >&2; exit 3");
  assert.deepEqual((await run.finished()).ok, false);
  assert.match(run.current().output, /^nope\n/);

  run.start("sleep 5");
  const hung = await run.finished();
  assert.equal(hung.ok, false);
  assert.match(hung.output, /stopped after 0 s/);

  run.start("sleep 5");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(run.cancel().ok, false);
  const cancelled = await run.finished();
  assert.equal(cancelled.running, false);
  assert.match(cancelled.output, /login command cancelled/);
  assert.deepEqual(verdicts, [true, false, false, false]);
});

test("Settings: loginCommand is trimmed and public; SessionSettings.claudeGateway defaults on and patches", () => {
  const settings = Settings.parse({ claudeApi: { credentialCommand: "gw token", loginCommand: "gw login" } });
  assert.equal(settings.claudeApi.loginCommand, "gw login");
  assert.equal(toPublicSettings(settings).claudeApi.loginCommand, "gw login");
  assert.equal(SessionSettings.parse({}).claudeGateway, true);
  assert.deepEqual(SessionSettingsPatch.parse({ claudeGateway: false }), { claudeGateway: false });
});
