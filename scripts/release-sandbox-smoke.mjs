// In-container smoke test of a Sandbox image variant (ADR-0088 step 2), run by `release-sandbox.mjs verify` as
// `docker run --rm -v <this file>:/tmp/smoke.mjs:ro <image>@<digest> node /tmp/smoke.mjs <expected Provider ids, comma-separated; "-" for base>`
// with the image's own node and `agent` user. Checks that /opt/sessionboxer/providers/ holds exactly the expected
// payloads (each with a well-formed manifest.json), that every expected Provider's command answers `--version`, and
// that its ACP adapter answers `initialize` (fx has no credential-free initialize: its gateway error is accepted).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const PAYLOADS = "/opt/sessionboxer/providers";
const { ACP_COMMANDS } = await import("/opt/sessionboxer/sandbox-daemon/dist/provider-commands.js");

/** `--version` command per Provider when it is not the ACP adapter itself (pi-acp prints nothing). */
const VERSION_COMMANDS = { pi: ["pi"], copilot: ["copilot", "--no-auto-update"] };
/** What the Daemon puts in each Agent's environment (its `*_AGENT_ENV` constants) so they start non-interactively and without updating. */
const AGENT_ENV = {
  codex: { CODEX_HOME: "/home/agent/.codex", INITIAL_AGENT_MODE: "agent-full-access" },
  pi: { PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  opencode: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
  fx: { FX_PERMISSION_MODE: "full-access", FX_AUTO_UPGRADE: "0", FX_NO_OPEN_BROWSER: "1" },
  kimi: { KIMI_CLI_NO_AUTO_UPDATE: "1", KIMI_SHARE_DIR: "" },
  copilot: { COPILOT_ALLOW_ALL: "true", COPILOT_AUTO_UPDATE: "false" },
  vibe: { VIBE_ENABLE_AUTO_UPDATE: "false", VIBE_TEST_DISABLE_KEYRING: "1" },
  grok: { GROK_DISABLE_AUTOUPDATER: "1" },
  gemini: { GEMINI_CLI_TRUST_WORKSPACE: "true", NO_BROWSER: "true", GEMINI_TELEMETRY_ENABLED: "false" },
};
/** Providers whose `initialize` cannot succeed without credentials, with the error they report instead. */
const CREDENTIAL_ERRORS = { fx: /AI_GATEWAY_API_KEY|fx login/ };

const expected = process.argv[2] === "-" || process.argv[2] === undefined ? [] : process.argv[2].split(",");
const failures = [];
const fail = (msg) => { failures.push(msg); console.error(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok   ${msg}`);

const present = existsSync(PAYLOADS) ? readdirSync(PAYLOADS).sort() : [];
if (present.join(",") !== [...expected].sort().join(",")) fail(`${PAYLOADS} holds [${present}], expected [${[...expected].sort()}]`);
else ok(`${PAYLOADS} holds exactly [${present.join(",") || "nothing"}]`);
for (const id of present) {
  try {
    const m = JSON.parse(readFileSync(`${PAYLOADS}/${id}/manifest.json`, "utf8"));
    if (m.provider !== id || m.payloadFormat !== 1 || typeof m.version !== "string" || !Array.isArray(m.files)) throw new Error(JSON.stringify(m).slice(0, 200));
    ok(`${id} manifest.json: version ${m.version}, ${m.files.length} files`);
  } catch (err) {
    fail(`${id} manifest.json: ${err.message}`);
  }
}

for (const id of expected) {
  if (ACP_COMMANDS[id] === undefined) { fail(`${id}: not in the Daemon's ACP_COMMANDS`); continue; }
  const env = { ...process.env, ...(AGENT_ENV[id] ?? {}) };
  const [cmd, ...args] = VERSION_COMMANDS[id] ?? [ACP_COMMANDS[id][0]];
  const v = spawnSync(cmd, [...args, "--version"], { encoding: "utf8", env, timeout: 60_000 });
  const line = `${v.stdout ?? ""}${v.stderr ?? ""}`.trim().split("\n")[0] ?? "";
  if (v.status !== 0 || line === "") fail(`${id}: ${cmd} --version exited ${v.status}: ${line}`);
  else ok(`${id}: ${cmd} --version → ${line}`);
  const r = await initialize(id, env);
  if (r.ok) ok(`${id}: ACP initialize → ${r.detail}`);
  else if (CREDENTIAL_ERRORS[id]?.test(r.detail)) ok(`${id}: ACP initialize needs credentials (accepted): ${r.detail.split("\n")[0]}`);
  else fail(`${id}: ACP initialize: ${r.detail}`);
}

if (failures.length > 0) { console.error(`${failures.length} smoke failure(s)`); process.exit(1); }
console.log(`smoke ok: ${expected.length} Provider(s)`);

/** Spawns the Provider's ACP adapter and sends `initialize`; resolves with the result or the error/exit text. */
function initialize(id, env) {
  const [cmd, ...args] = ACP_COMMANDS[id];
  if (env.CODEX_HOME !== undefined) spawnSync("mkdir", ["-p", env.CODEX_HOME]);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env, cwd: "/workspace" });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const done = (result) => { clearTimeout(timer); child.removeAllListeners("exit"); child.kill("SIGKILL"); resolve(result); };
    const timer = setTimeout(() => done({ ok: false, detail: `no initialize response in 120s\n${stderr.slice(-1500)}` }), 120_000);
    child.on("error", (err) => done({ ok: false, detail: `${cmd}: ${err.message}` }));
    child.on("exit", (code) => done({ ok: false, detail: `${cmd} exited ${code} before answering\n${stderr.slice(-1500)}` }));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== 1) return;
      if (msg.error) return done({ ok: false, detail: `error ${JSON.stringify(msg.error)}` });
      const r = msg.result ?? {};
      done({ ok: true, detail: `protocolVersion ${r.protocolVersion}, agent ${r.agentInfo?.name ?? "?"}@${r.agentInfo?.version ?? "?"}` });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "sessionboxer-release-smoke", version: "0" } } }) + "\n");
  });
}
