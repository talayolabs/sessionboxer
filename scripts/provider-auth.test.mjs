import test from "node:test";
import assert from "node:assert/strict";
import { Settings, DAEMON_METHODS } from "../packages/protocol/dist/index.js";
import { applySettingsUpdate } from "../apps/control-plane/dist/config.js";
import { PROVIDER_AUTH, SYNCED_AUTH_PROVIDERS, isSyncedAuthProvider, providerOfAuthChanged, providersAuthChangedBy } from "../apps/control-plane/dist/provider-auth.js";

// Characterization tests: these pin what each Agent's login looked like on the wire before the
// per-provider methods were folded into PROVIDER_AUTH (Codex ADR-0046, Cursor ADR-0054, pi ADR-0075,
// OpenCode ADR-0076, fx ADR-0077, GitHub Copilot ADR-0082, Mistral Vibe ADR-0085). Values are the observed ones, not recomputed from the code.

for (const key of ["CURSOR_API_KEY", "AI_GATEWAY_API_KEY", "COPILOT_GITHUB_TOKEN"]) delete process.env[key];

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const codexFile = (lastRefresh) => JSON.stringify({ tokens: { id_token: jwt({ email: "a@b.c" }), access_token: "a", refresh_token: "r" }, last_refresh: lastRefresh });
const cursorFile = (exp) => JSON.stringify({ accessToken: jwt({ exp }), refreshToken: "r" });
const piFile = (expires) => JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires } });
const opencodeFile = (expires) => JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires } });
const fxFile = (expiresAtMs) => JSON.stringify({ version: 1, access_token: "a", refresh_token: "r", expires_at_ms: expiresAtMs, account_id: "acc" });
const copilotFile = (token) => JSON.stringify({ authTokens: { "github.com:octocat": { token } }, lastLoggedInUser: { host: "github.com", login: "octocat" } });

const base = Settings.parse({});
const settings = applySettingsUpdate(base, {
  providerSecrets: {
    codex: { CODEX_AUTH_JSON: codexFile("2026-01-01T00:00:00Z") },
    cursor: { CURSOR_LOGIN: cursorFile(1_800_000_000) },
    pi: { PI_AUTH_JSON: piFile(1_800_000_000_000), PI_API_KEYS: "ANTHROPIC_API_KEY=sk-ant\nOPENAI_API_KEY=sk-oai" },
    opencode: { OPENCODE_AUTH_JSON: opencodeFile(1_800_000_000_000) },
    fx: { FX_LOGIN: fxFile(1_800_000_000_000) },
    copilot: { COPILOT_LOGIN: copilotFile("ghu_a") },
    vibe: { VIBE_LOGIN: "MISTRAL_API_KEY='key_vibe_1'" },
  },
});

test("the synced Agents are Codex, Cursor, pi, OpenCode, fx, Kimi, GitHub Copilot and Mistral Vibe; Claude Code and Devin are not", () => {
  assert.deepEqual([...SYNCED_AUTH_PROVIDERS], ["codex", "cursor", "pi", "opencode", "fx", "kimi", "copilot", "vibe"]);
  assert.equal(isSyncedAuthProvider("claude-code"), false);
  assert.equal(isSyncedAuthProvider("devin"), false);
  assert.equal(isSyncedAuthProvider("pi"), true);
});

test("each Agent's login goes to the Daemon method and params it always did", () => {
  const stored = settings.providerSecrets;
  assert.equal(PROVIDER_AUTH.codex.setMethod, "_sessionboxer/codex/auth/set");
  assert.deepEqual(PROVIDER_AUTH.codex.params(settings), { authJson: stored.codex.CODEX_AUTH_JSON });
  assert.equal(PROVIDER_AUTH.cursor.setMethod, "_sessionboxer/cursor/auth/set");
  assert.deepEqual(PROVIDER_AUTH.cursor.params(settings), { login: stored.cursor.CURSOR_LOGIN });
  assert.equal(PROVIDER_AUTH.pi.setMethod, "_sessionboxer/pi/auth/set");
  assert.deepEqual(PROVIDER_AUTH.pi.params(settings), {
    authJson: stored.pi.PI_AUTH_JSON,
    apiKeys: { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" },
  });
  assert.equal(PROVIDER_AUTH.opencode.setMethod, "_sessionboxer/opencode/auth/set");
  assert.deepEqual(PROVIDER_AUTH.opencode.params(settings), { authJson: stored.opencode.OPENCODE_AUTH_JSON });
  assert.equal(PROVIDER_AUTH.fx.setMethod, "_sessionboxer/fx/auth/set");
  assert.deepEqual(PROVIDER_AUTH.fx.params(settings), { login: stored.fx.FX_LOGIN });
  assert.equal(PROVIDER_AUTH.copilot.setMethod, "_sessionboxer/copilot/auth/set");
  assert.deepEqual(PROVIDER_AUTH.copilot.params(settings), { login: stored.copilot.COPILOT_LOGIN });
  assert.equal(stored.copilot.COPILOT_LOGIN, copilotFile("ghu_a"));
  assert.equal(PROVIDER_AUTH.vibe.setMethod, "_sessionboxer/vibe/auth/set");
  assert.deepEqual(PROVIDER_AUTH.vibe.params(settings), { login: stored.vibe.VIBE_LOGIN });
});

test("only Codex tolerates a Daemon that predates its auth method", () => {
  assert.deepEqual(
    SYNCED_AUTH_PROVIDERS.filter((p) => PROVIDER_AUTH[p].tolerateMissingMethod),
    ["codex"],
  );
});

test("an environment API key overrides the stored Cursor, fx, GitHub Copilot and Mistral Vibe logins, as before", () => {
  process.env.CURSOR_API_KEY = " key_cursor ";
  process.env.AI_GATEWAY_API_KEY = "key_fx";
  process.env.COPILOT_GITHUB_TOKEN = " github_pat_x ";
  process.env.MISTRAL_API_KEY = "key_vibe_env";
  try {
    assert.deepEqual(PROVIDER_AUTH.cursor.params(settings), { login: "key_cursor" });
    assert.deepEqual(PROVIDER_AUTH.fx.params(settings), { login: "key_fx" });
    assert.deepEqual(PROVIDER_AUTH.copilot.params(settings), { login: "github_pat_x" });
    assert.deepEqual(PROVIDER_AUTH.vibe.params(settings), { login: "key_vibe_env" });
    assert.deepEqual(PROVIDER_AUTH.codex.params(settings), { authJson: settings.providerSecrets.codex.CODEX_AUTH_JSON });
  } finally {
    delete process.env.CURSOR_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.COPILOT_GITHUB_TOKEN;
  }
});

test("a Settings update pushes exactly the logins it touches", () => {
  assert.deepEqual(providersAuthChangedBy({}), []);
  assert.deepEqual(providersAuthChangedBy({ providerSecrets: { codex: { CODEX_AUTH_JSON: "" } } }), ["codex"]);
  assert.deepEqual(providersAuthChangedBy({ providerSecrets: { cursor: { CURSOR_LOGIN: "k" } } }), ["cursor"]);
  assert.deepEqual(providersAuthChangedBy({ providerSecrets: { pi: { PI_API_KEYS: "A=b" } } }), ["pi"]);
  assert.deepEqual(providersAuthChangedBy({ providerSecrets: { pi: { PI_AUTH_JSON: "{}" } } }), ["pi"]);
  assert.deepEqual(providersAuthChangedBy({ providerSecrets: { opencode: { OPENCODE_AUTH_JSON: "{}" } } }), ["opencode"]);
  assert.deepEqual(providersAuthChangedBy({ providerSecrets: { fx: { FX_LOGIN: "k" } } }), ["fx"]);
  assert.deepEqual(providersAuthChangedBy({ providerSecrets: { vibe: { VIBE_LOGIN: "k" } } }), ["vibe"]);
  assert.deepEqual(providersAuthChangedBy({ providerSecrets: { codex: { CODEX_AUTH_JSON: "" }, fx: { FX_LOGIN: "" } } }), ["codex", "fx"]);
  assert.deepEqual(providersAuthChangedBy({ providerSecrets: { copilot: { COPILOT_LOGIN: "github_pat_x" } } }), ["copilot"]);
  assert.deepEqual(providersAuthChangedBy({ providerSecrets: { "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: "t" } } }), []);
  assert.deepEqual(providersAuthChangedBy({ mcpServers: [] }), []);
});

test("each *AuthChanged notification maps back to its Agent", () => {
  assert.equal(providerOfAuthChanged(DAEMON_METHODS.codexAuthChanged), "codex");
  assert.equal(providerOfAuthChanged("_sessionboxer/cursor/auth/changed"), "cursor");
  assert.equal(providerOfAuthChanged("_sessionboxer/pi/auth/changed"), "pi");
  assert.equal(providerOfAuthChanged("_sessionboxer/opencode/auth/changed"), "opencode");
  assert.equal(providerOfAuthChanged("_sessionboxer/fx/auth/changed"), "fx");
  assert.equal(providerOfAuthChanged("_sessionboxer/copilot/auth/changed"), "copilot");
  assert.equal(providerOfAuthChanged("_sessionboxer/vibe/auth/changed"), "vibe");
  assert.equal(providerOfAuthChanged(DAEMON_METHODS.codexAuthSet), null);
  assert.equal(providerOfAuthChanged("event"), null);
});

test("a refreshed file is stored under the Agent's own secret key", () => {
  assert.deepEqual(PROVIDER_AUTH.codex.storeUpdate("{}"), { providerSecrets: { codex: { CODEX_AUTH_JSON: "{}" } } });
  assert.deepEqual(PROVIDER_AUTH.cursor.storeUpdate("{}"), { providerSecrets: { cursor: { CURSOR_LOGIN: "{}" } } });
  assert.deepEqual(PROVIDER_AUTH.pi.storeUpdate("{}"), { providerSecrets: { pi: { PI_AUTH_JSON: "{}" } } });
  assert.deepEqual(PROVIDER_AUTH.opencode.storeUpdate("{}"), { providerSecrets: { opencode: { OPENCODE_AUTH_JSON: "{}" } } });
  assert.deepEqual(PROVIDER_AUTH.fx.storeUpdate("{}"), { providerSecrets: { fx: { FX_LOGIN: "{}" } } });
  assert.deepEqual(PROVIDER_AUTH.copilot.storeUpdate("{}"), { providerSecrets: { copilot: { COPILOT_LOGIN: "{}" } } });
  assert.deepEqual(PROVIDER_AUTH.vibe.storeUpdate("MISTRAL_API_KEY=k"), { providerSecrets: { vibe: { VIBE_LOGIN: "MISTRAL_API_KEY=k" } } });
});

test("a refreshed file replaces the stored one only when it is newer, per Agent", () => {
  // Codex: by last_refresh; an identical file never replaces.
  assert.equal(PROVIDER_AUTH.codex.newer(codexFile("2026-02-01T00:00:00Z"), codexFile("2026-01-01T00:00:00Z")), true);
  assert.equal(PROVIDER_AUTH.codex.newer(codexFile("2025-12-01T00:00:00Z"), codexFile("2026-01-01T00:00:00Z")), false);
  assert.equal(PROVIDER_AUTH.codex.newer(codexFile("2026-01-01T00:00:00Z"), codexFile("2026-01-01T00:00:00Z")), false);
  assert.equal(PROVIDER_AUTH.codex.newer("not json", codexFile("2026-01-01T00:00:00Z")), false);
  // Cursor: by the access token's exp; a stored API key is never replaced.
  assert.equal(PROVIDER_AUTH.cursor.newer(cursorFile(1_900_000_000), cursorFile(1_800_000_000)), true);
  assert.equal(PROVIDER_AUTH.cursor.newer(cursorFile(1_700_000_000), cursorFile(1_800_000_000)), false);
  assert.equal(PROVIDER_AUTH.cursor.newer(cursorFile(1_900_000_000), "key_cursor"), false);
  // pi: by the latest OAuth expires; a file without OAuth entries never replaces; an empty store accepts.
  assert.equal(PROVIDER_AUTH.pi.newer(piFile(1_900_000_000_000), piFile(1_800_000_000_000)), true);
  assert.equal(PROVIDER_AUTH.pi.newer(piFile(1_700_000_000_000), piFile(1_800_000_000_000)), false);
  assert.equal(PROVIDER_AUTH.pi.newer(JSON.stringify({ openai: { type: "api_key", key: "k" } }), piFile(1_800_000_000_000)), false);
  assert.equal(PROVIDER_AUTH.pi.newer(piFile(1_900_000_000_000), ""), true);
  // OpenCode: by the latest OAuth expiry; an empty store accepts.
  assert.equal(PROVIDER_AUTH.opencode.newer(opencodeFile(1_900_000_000_000), opencodeFile(1_800_000_000_000)), true);
  assert.equal(PROVIDER_AUTH.opencode.newer(opencodeFile(1_700_000_000_000), opencodeFile(1_800_000_000_000)), false);
  assert.equal(PROVIDER_AUTH.opencode.newer(opencodeFile(1_900_000_000_000), ""), true);
  // fx: by expires_at_ms; a stored API key is never replaced.
  assert.equal(PROVIDER_AUTH.fx.newer(fxFile(1_900_000_000_000), fxFile(1_800_000_000_000)), true);
  assert.equal(PROVIDER_AUTH.fx.newer(fxFile(1_700_000_000_000), fxFile(1_800_000_000_000)), false);
  assert.equal(PROVIDER_AUTH.fx.newer(fxFile(1_900_000_000_000), "key_fx"), false);
  // GitHub Copilot: its tokens carry no expiry, so any readable config.json that differs replaces a stored file; a stored bare token is never replaced; an empty store accepts.
  assert.equal(PROVIDER_AUTH.copilot.newer(copilotFile("ghu_b"), copilotFile("ghu_a")), true);
  assert.equal(PROVIDER_AUTH.copilot.newer(copilotFile("ghu_a"), copilotFile("ghu_a")), false);
  assert.equal(PROVIDER_AUTH.copilot.newer(copilotFile("ghu_b"), "github_pat_x"), false);
  assert.equal(PROVIDER_AUTH.copilot.newer("github_pat_y", copilotFile("ghu_a")), false);
  assert.equal(PROVIDER_AUTH.copilot.newer(JSON.stringify({ lastLoggedInUser: { login: "octocat" } }), copilotFile("ghu_a")), false);
  assert.equal(PROVIDER_AUTH.copilot.newer(copilotFile("ghu_b"), ""), true);
  // Mistral Vibe: a rewritten .env replaces the stored login when it holds another key (quotes do not count); one without a key never does.
  assert.equal(PROVIDER_AUTH.vibe.newer("MISTRAL_API_KEY='key_vibe_2'", "MISTRAL_API_KEY='key_vibe_1'"), true);
  assert.equal(PROVIDER_AUTH.vibe.newer("MISTRAL_API_KEY=key_vibe_1", "MISTRAL_API_KEY='key_vibe_1'"), false);
  assert.equal(PROVIDER_AUTH.vibe.newer("MISTRAL_API_KEY='key_vibe_2'", "key_vibe_2"), false);
  assert.equal(PROVIDER_AUTH.vibe.newer("MISTRAL_API_KEY='key_vibe_2'", "key_vibe_1"), true);
  assert.equal(PROVIDER_AUTH.vibe.newer("OTHER=x", "key_vibe_1"), false);
  assert.equal(PROVIDER_AUTH.vibe.newer("", "key_vibe_1"), false);
});
