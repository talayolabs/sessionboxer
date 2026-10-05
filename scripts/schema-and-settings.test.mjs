// Characterization tests (Feathers): pin what the Control Plane's two riskiest pure-ish modules do
// today — the SQLite schema + migrations of db.ts, and the Settings merge of config.ts — so the
// refactors in docs/TECH-DEBT.md cannot change them unnoticed. Run after `tsc -b`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Settings } from "../packages/protocol/dist/index.js";
import { Db } from "../apps/control-plane/dist/db.js";
import { applySettingsUpdate } from "../apps/control-plane/dist/config.js";
import { HttpError } from "../apps/control-plane/dist/http-error.js";

const tables = (db) =>
  db.connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
const columns = (db, table) => db.connection.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

test("a fresh database has exactly these tables", () => {
  const db = new Db(":memory:");
  assert.deepEqual(tables(db), [
    "automation_mcp_state", "automation_pr_state", "automation_runs", "automations", "branches", "daemon_cursors", "e2e_cases",
    "e2e_runs", "events", "folders", "followed_pr_checks", "followed_pr_items", "followed_pr_sources",
    "followed_prs", "pr_checks", "pr_events", "pr_follows", "pr_items", "provider_models", "provider_options",
    "pull_requests", "repositories", "saved_messages", "sessions", "snapshots",
  ]);
  assert.deepEqual(columns(db, "sessions"), [
    "id", "title", "provider", "status", "workspace_source", "repos", "settings", "container_id", "image", "error",
    "queue_running", "disk_bytes", "mcp_pending", "model_pending", "options_pending", "available_options",
    "inspect_llm_pending", "active_branch_id", "usage", "usb", "created_by", "pinned", "folder_id",
    "created_at", "updated_at",
  ]);
  assert.deepEqual(columns(db, "events"), ["session_id", "seq", "branch_id", "ts", "body"]);
});

test("opening a database twice is a no-op (schema and migrations are idempotent)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessionboxer-db-"));
  try {
    const file = join(dir, "state.db");
    const first = tables(new Db(file));
    assert.deepEqual(tables(new Db(file)), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a v1-era database is migrated: columns added, per-setting columns folded into `settings`, repos indexed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessionboxer-db-"));
  try {
    const file = join(dir, "state.db");
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL,
      workspace_source TEXT NOT NULL, container_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      model TEXT, options TEXT, inspect_llm INTEGER, mcp_enabled TEXT, instructions TEXT, auto_snapshot INTEGER,
      docker_mode TEXT, git_user_name TEXT, git_user_email TEXT)`);
    legacy
      .prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        "s1", "Old one", "claude-code", "stopped", JSON.stringify({ type: "git", url: "https://github.com/acme/widgets" }),
        null, null, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z",
        "claude-sonnet-4", JSON.stringify({ effort: "high" }), 1, JSON.stringify(["desktop"]), "Be brief.", 1,
        "sysbox", "Ada", "ada@example.com",
      );
    legacy.close();

    const db = new Db(file);
    assert.ok(columns(db, "sessions").includes("settings"));
    assert.ok(columns(db, "sessions").includes("folder_id"));
    const s = db.getSession("s1");
    assert.equal(s.settings.model, "claude-sonnet-4");
    assert.deepEqual(s.settings.options, { effort: "high" });
    assert.equal(s.settings.inspectLlm, true);
    assert.deepEqual(s.settings.mcpEnabled, ["desktop"]);
    assert.equal(s.settings.instructions, "Be brief.");
    assert.equal(s.settings.autoSnapshot, true);
    assert.equal(s.settings.sandbox.dockerMode, "sysbox");
    assert.deepEqual(s.settings.sandbox.gitIdentity, { name: "Ada", email: "ada@example.com" });
    assert.deepEqual(s.branches, [], "the root branch is implicit; only forks create rows");
    assert.equal(s.workspaceSource.url, "https://github.com/acme/widgets");
    assert.deepEqual(
      db.connection.prepare("SELECT kind, owner, repo FROM repositories").all(),
      [{ kind: "git", owner: "acme", repo: "widgets" }],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh-install Settings defaults", () => {
  const s = Settings.parse({});
  assert.equal(s.agentTools, "all");
  assert.equal(s.autoSnapshot, false);
  assert.equal(s.e2eVerify, false);
  assert.equal(s.snapshotKeep, 10);
  assert.equal(s.sandboxCpus, 2);
  assert.equal(s.sandboxMemoryGb, 4);
  assert.deepEqual(s.mcpServers, []);
});

test("applySettingsUpdate merges per Agent and never clobbers with undefined", () => {
  const piFile = JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1_800_000_000_000 } });
  const base = applySettingsUpdate(Settings.parse({}), {
    gitUserName: "Ada",
    providerSecrets: { "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: "tok_1" }, pi: { PI_API_KEYS: "ANTHROPIC_API_KEY=sk-ant" } },
  });
  const next = applySettingsUpdate(base, {
    gitUserName: undefined,
    providerSecrets: { pi: { PI_AUTH_JSON: piFile } },
  });
  assert.equal(next.gitUserName, "Ada");
  assert.equal(next.providerSecrets["claude-code"].CLAUDE_CODE_OAUTH_TOKEN, "tok_1", "other Agents' secrets survive");
  assert.equal(next.providerSecrets.pi.PI_API_KEYS, "ANTHROPIC_API_KEY=sk-ant", "the same Agent's other keys survive");
  assert.equal(JSON.parse(next.providerSecrets.pi.PI_AUTH_JSON).anthropic.refresh, "r");
  assert.notEqual(next, base, "the input Settings are not mutated");
  assert.equal(base.providerSecrets.pi.PI_AUTH_JSON, "");
});

test("applySettingsUpdate rejects what the UI must not store, as HTTP 400", () => {
  const base = Settings.parse({});
  for (const bad of [
    { windows: { version: "95" } },
    { macos: { version: "catalina" } },
    { tunnels: { sessionboxer: { server: "ftp://x" } } },
    { tunnels: { ssh: { enabled: true, host: "" } } },
    { claudeApi: { baseUrl: "localhost:8080" } },
  ]) {
    assert.throws(() => applySettingsUpdate(base, bad), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(bad));
  }
  const trimmed = applySettingsUpdate(base, { tunnels: { sessionboxer: { server: " https://tunnel.example.com// ", name: "My-Box" } } });
  assert.equal(trimmed.tunnels.sessionboxer.server, "https://tunnel.example.com");
  assert.equal(trimmed.tunnels.sessionboxer.name, "my-box");
});
