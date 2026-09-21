import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  AgentOption,
  BranchMethod,
  ModelOption,
  PROVIDERS,
  Provider,
  ROOT_BRANCH_ID,
  Session,
  SessionSettings,
  SnapshotReason,
  WorkspaceSource,
  branchScope,
  type Branch,
  type BranchScope,
  type ProviderModels,
  type ProviderOptions,
  type SavedMessage,
  type SessionEvent,
  type SessionEventBody,
  type SessionStatus,
  type Snapshot,
} from "@sessionboxer/protocol";
import { PrStore } from "./pr-store.js";

const BRANCH_TITLE_MAX = 40;

/** A branch is titled after the prompt that started it: its first words, on one line. */
export function branchTitle(prompt: string): string {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (text.length <= BRANCH_TITLE_MAX) return text || "(empty prompt)";
  const cut = text.slice(0, BRANCH_TITLE_MAX);
  const atWord = cut.lastIndexOf(" ");
  return `${atWord > BRANCH_TITLE_MAX / 2 ? cut.slice(0, atWord) : cut}\u2026`;
}

interface SessionRow {
  id: string;
  title: string;
  provider: string;
  status: string;
  workspace_source: string;
  /** JSON `SessionSettings`. */
  settings: string;
  container_id: string | null;
  error: string | null;
  queue_running: number;
  disk_bytes: number | null;
  mcp_pending: number;
  model_pending: number;
  options_pending: number;
  /** JSON array of `AgentOption`. */
  available_options: string;
  inspect_llm_pending: number;
  active_branch_id: string;
  created_at: string;
  updated_at: string;
}

/** The columns `settings` replaced; an old database has the ones that existed when it was last opened. */
interface LegacySettingsRow {
  id: string;
  docker_mode?: string;
  auto_snapshot?: number | null;
  mcp_enabled?: string;
  model?: string | null;
  options?: string;
  instructions?: string;
  inspect_llm?: number;
  git_user_name?: string;
  git_user_email?: string;
}

/** `sessions` joined with its Snapshot aggregates. */
interface SessionQueryRow extends SessionRow {
  snapshot_bytes: number;
  snapshot_count: number;
}

interface SnapshotRow {
  id: string;
  session_id: string;
  ordinal: number;
  reason: string;
  image_tag: string;
  image_id: string;
  event_seq: number;
  branch_id: string;
  size_bytes: number;
  queued_messages: string;
  created_at: string;
}

interface BranchRow {
  session_id: string;
  id: string;
  name: string;
  parent_id: string | null;
  forked_at_seq: number | null;
  method: string | null;
  acp_session_id: string | null;
  created_at: string;
}

interface SavedMessageRow {
  id: string;
  session_id: string;
  position: number;
  text: string;
  created_at: string;
}

interface EventRow {
  seq: number;
  session_id: string;
  branch_id: string;
  ts: string;
  body: string;
}

/** Stands in for "no upper bound" in SQL (a `BranchScope` uses Infinity). */
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  workspace_source TEXT NOT NULL,
  settings TEXT,
  container_id TEXT,
  error TEXT,
  queue_running INTEGER NOT NULL DEFAULT 0,
  disk_bytes INTEGER,
  mcp_pending INTEGER NOT NULL DEFAULT 0,
  model_pending INTEGER NOT NULL DEFAULT 0,
  options_pending INTEGER NOT NULL DEFAULT 0,
  available_options TEXT NOT NULL DEFAULT '[]',
  inspect_llm_pending INTEGER NOT NULL DEFAULT 0,
  active_branch_id TEXT NOT NULL DEFAULT 'root',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  reason TEXT NOT NULL,
  image_tag TEXT NOT NULL,
  image_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  branch_id TEXT NOT NULL DEFAULT 'root',
  size_bytes INTEGER NOT NULL,
  queued_messages TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, ordinal)
);
CREATE TABLE IF NOT EXISTS branches (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT,
  forked_at_seq INTEGER,
  method TEXT,
  acp_session_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE IF NOT EXISTS saved_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  branch_id TEXT NOT NULL DEFAULT 'root',
  ts TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS daemon_cursors (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  last_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_models (
  provider TEXT PRIMARY KEY,
  models TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_options (
  provider TEXT PRIMARY KEY,
  options TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Columns added after the first release, applied to databases created before them. The per-setting
 * columns of old databases (docker_mode, auto_snapshot, mcp_enabled, model, options, instructions,
 * inspect_llm, git_user_name, git_user_email) are left in place and folded into `settings` once.
 */
const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "sessions", column: "queue_running", ddl: "ALTER TABLE sessions ADD COLUMN queue_running INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "disk_bytes", ddl: "ALTER TABLE sessions ADD COLUMN disk_bytes INTEGER" },
  { table: "sessions", column: "mcp_pending", ddl: "ALTER TABLE sessions ADD COLUMN mcp_pending INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "model_pending", ddl: "ALTER TABLE sessions ADD COLUMN model_pending INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "options_pending", ddl: "ALTER TABLE sessions ADD COLUMN options_pending INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "available_options", ddl: "ALTER TABLE sessions ADD COLUMN available_options TEXT NOT NULL DEFAULT '[]'" },
  { table: "sessions", column: "active_branch_id", ddl: "ALTER TABLE sessions ADD COLUMN active_branch_id TEXT NOT NULL DEFAULT 'root'" },
  { table: "sessions", column: "inspect_llm_pending", ddl: "ALTER TABLE sessions ADD COLUMN inspect_llm_pending INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "settings", ddl: "ALTER TABLE sessions ADD COLUMN settings TEXT" },
  { table: "snapshots", column: "branch_id", ddl: "ALTER TABLE snapshots ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'root'" },
  { table: "events", column: "branch_id", ddl: "ALTER TABLE events ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'root'" },
];

const SESSION_SELECT = `
  SELECT s.*,
    (SELECT COALESCE(SUM(size_bytes), 0) FROM snapshots WHERE session_id = s.id) AS snapshot_bytes,
    (SELECT COUNT(*) FROM snapshots WHERE session_id = s.id) AS snapshot_count
  FROM sessions s`;

export class Db {
  private readonly db: Database.Database;
  /** Pull Requests attached to Sessions and their comments. */
  readonly prs: PrStore;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
    this.titleBranches();
    this.prs = new PrStore(this.db);
  }

  /** The connection, for stores that live in their own module (devices). */
  get connection(): Database.Database {
    return this.db;
  }

  /** Branches created before prompt-derived titles still carry "branch N"; title them from their first prompt. */
  private titleBranches(): void {
    const rows = this.db
      .prepare(
        `SELECT b.session_id, b.id, json_extract(e.body, '$.text') AS text, MIN(e.seq) AS first_seq FROM branches b
         JOIN events e ON e.session_id = b.session_id AND e.branch_id = b.id AND json_extract(e.body, '$.type') = 'user_prompt'
         WHERE b.name GLOB 'branch [0-9]*' GROUP BY b.session_id, b.id`,
      )
      .all() as Array<{ session_id: string; id: string; text: string }>;
    for (const r of rows) this.renameBranch(r.session_id, r.id, branchTitle(r.text));
  }

  private migrate(): void {
    for (const m of MIGRATIONS) {
      const columns = this.db.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === m.column)) this.db.exec(m.ddl);
    }
    this.backfillSettings();
  }

  /** Sessions from before the `settings` column: assemble the JSON from the per-setting columns. */
  private backfillSettings(): void {
    const rows = this.db.prepare("SELECT * FROM sessions WHERE settings IS NULL").all() as LegacySettingsRow[];
    const write = this.db.prepare("UPDATE sessions SET settings = ? WHERE id = ?");
    for (const r of rows) {
      const settings = SessionSettings.parse({
        model: r.model ?? null,
        options: JSON.parse(r.options ?? "{}"),
        inspectLlm: r.inspect_llm === 1,
        mcpEnabled: JSON.parse(r.mcp_enabled ?? "[]"),
        instructions: r.instructions ?? "",
        autoSnapshot: r.auto_snapshot === null || r.auto_snapshot === undefined ? null : r.auto_snapshot === 1,
        sandbox: { dockerMode: r.docker_mode ?? "none", gitIdentity: { name: r.git_user_name ?? "", email: r.git_user_email ?? "" } },
      });
      write.run(JSON.stringify(settings), r.id);
    }
  }

  listSessions(): Session[] {
    const rows = this.db.prepare(`${SESSION_SELECT} ORDER BY s.created_at DESC`).all() as SessionQueryRow[];
    const branches = new Map<string, Branch[]>();
    for (const row of this.db.prepare("SELECT * FROM branches ORDER BY created_at ASC").all() as BranchRow[]) {
      const list = branches.get(row.session_id) ?? [];
      list.push(rowToBranch(row));
      branches.set(row.session_id, list);
    }
    return rows.map((r) => rowToSession(r, branches.get(r.id) ?? []));
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionQueryRow | undefined;
    return row ? rowToSession(row, this.listBranches(id)) : null;
  }

  insertSession(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, provider, status, workspace_source, settings, container_id, error, queue_running, disk_bytes, mcp_pending, model_pending, options_pending, available_options, inspect_llm_pending, active_branch_id, created_at, updated_at)
         VALUES (@id, @title, @provider, @status, @workspace_source, @settings, @container_id, @error, @queue_running, @disk_bytes, @mcp_pending, @model_pending, @options_pending, @available_options, @inspect_llm_pending, @active_branch_id, @created_at, @updated_at)`,
      )
      .run(sessionToRow(session));
  }

  updateSession(id: string, patch: SessionPatch): Session | null {
    const current = this.getSession(id);
    if (!current) return null;
    const next: Session = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE sessions SET title=@title, status=@status, settings=@settings, container_id=@container_id, error=@error,
           queue_running=@queue_running, disk_bytes=@disk_bytes, mcp_pending=@mcp_pending, model_pending=@model_pending,
           options_pending=@options_pending, available_options=@available_options, inspect_llm_pending=@inspect_llm_pending,
           active_branch_id=@active_branch_id, updated_at=@updated_at
         WHERE id=@id`,
      )
      .run(sessionToRow(next));
    return next;
  }

  listBranches(sessionId: string): Branch[] {
    const rows = this.db.prepare("SELECT * FROM branches WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as BranchRow[];
    return rows.map(rowToBranch);
  }

  insertBranch(branch: Branch, acpSessionId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO branches (session_id, id, name, parent_id, forked_at_seq, method, acp_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(branch.sessionId, branch.id, branch.name, branch.parentId, branch.forkedAtSeq, branch.method, acpSessionId, branch.createdAt);
  }

  /** ACP session the Agent runs for this branch; `null` when never recorded. */
  branchAcpSessionId(sessionId: string, branchId: string): string | null {
    const row = this.db.prepare("SELECT acp_session_id FROM branches WHERE session_id = ? AND id = ?").get(sessionId, branchId) as
      | { acp_session_id: string | null }
      | undefined;
    return row?.acp_session_id ?? null;
  }

  setBranchAcpSessionId(sessionId: string, branchId: string, acpSessionId: string): void {
    this.db.prepare("UPDATE branches SET acp_session_id = ? WHERE session_id = ? AND id = ?").run(acpSessionId, sessionId, branchId);
  }

  renameBranch(sessionId: string, branchId: string, name: string): void {
    this.db.prepare("UPDATE branches SET name = ? WHERE session_id = ? AND id = ?").run(name, sessionId, branchId);
  }

  /** Model API calls recorded for the Session so far (every branch), to number the next one. */
  countLlmCalls(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND json_extract(body, '$.type') = 'llm_call'")
      .get(sessionId) as { n: number };
    return row.n;
  }

  /** Prompts recorded on this branch itself (not inherited from its parent). */
  countBranchPrompts(sessionId: string, branchId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND branch_id = ? AND json_extract(body, '$.type') = 'user_prompt'")
      .get(sessionId, branchId) as { n: number };
    return row.n;
  }

  /** The active branch's view of the transcript (every event when the Session has no branches). */
  activeScope(sessionId: string): BranchScope {
    const row = this.db.prepare("SELECT active_branch_id FROM sessions WHERE id = ?").get(sessionId) as { active_branch_id: string } | undefined;
    return branchScope(this.listBranches(sessionId), row?.active_branch_id ?? ROOT_BRANCH_ID);
  }

  /** Sessions whose Sandbox was started from this Snapshot's image (its image must stay). */
  countForksOf(snapshotId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(workspace_source, '$.snapshotId') = ?")
      .get(snapshotId) as { n: number };
    return row.n;
  }

  listSnapshots(sessionId: string): Snapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM snapshots WHERE session_id = ? ORDER BY ordinal ASC")
      .all(sessionId) as SnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  /** Every Snapshot image reference the database knows about (for garbage collection). */
  listAllSnapshotImageIds(): Set<string> {
    const rows = this.db.prepare("SELECT image_id FROM snapshots").all() as Array<{ image_id: string }>;
    return new Set(rows.map((r) => r.image_id));
  }

  getSnapshot(sessionId: string, id: string): Snapshot | null {
    const row = this.db.prepare("SELECT * FROM snapshots WHERE session_id = ? AND id = ?").get(sessionId, id) as
      | SnapshotRow
      | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  nextSnapshotOrdinal(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(ordinal), 0) AS max FROM snapshots WHERE session_id = ?")
      .get(sessionId) as { max: number };
    return row.max + 1;
  }

  insertSnapshot(snapshot: Snapshot): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (id, session_id, ordinal, reason, image_tag, image_id, event_seq, branch_id, size_bytes, queued_messages, created_at)
         VALUES (@id, @session_id, @ordinal, @reason, @image_tag, @image_id, @event_seq, @branch_id, @size_bytes, @queued_messages, @created_at)`,
      )
      .run({
        id: snapshot.id,
        session_id: snapshot.sessionId,
        ordinal: snapshot.ordinal,
        reason: snapshot.reason,
        image_tag: snapshot.imageTag,
        image_id: snapshot.imageId,
        event_seq: snapshot.eventSeq,
        branch_id: snapshot.branchId,
        size_bytes: snapshot.sizeBytes,
        queued_messages: JSON.stringify(snapshot.queuedMessages),
        created_at: snapshot.createdAt,
      });
  }

  deleteSnapshot(sessionId: string, id: string): boolean {
    return this.db.prepare("DELETE FROM snapshots WHERE session_id = ? AND id = ?").run(sessionId, id).changes > 0;
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  listSavedMessages(sessionId: string): SavedMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM saved_messages WHERE session_id = ? ORDER BY position ASC")
      .all(sessionId) as SavedMessageRow[];
    return rows.map(rowToSavedMessage);
  }

  getSavedMessage(sessionId: string, id: string): SavedMessage | null {
    const row = this.db.prepare("SELECT * FROM saved_messages WHERE session_id = ? AND id = ?").get(sessionId, id) as
      | SavedMessageRow
      | undefined;
    return row ? rowToSavedMessage(row) : null;
  }

  /** Appends at the end of the Session's list (or at `position`, shifting the rest down). */
  insertSavedMessage(sessionId: string, text: string, position?: number): SavedMessage {
    const id = randomBytes(6).toString("hex");
    const createdAt = new Date().toISOString();
    const tx = this.db.transaction((): SavedMessage => {
      const ids = this.listSavedMessages(sessionId).map((m) => m.id);
      const at = position === undefined ? ids.length : Math.min(position, ids.length);
      ids.splice(at, 0, id);
      this.db
        .prepare("INSERT INTO saved_messages (id, session_id, position, text, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, sessionId, at, text, createdAt);
      this.renumberSavedMessages(ids);
      return { id, sessionId, text, position: at, createdAt };
    });
    return tx();
  }

  updateSavedMessage(sessionId: string, id: string, patch: { text?: string; position?: number }): SavedMessage | null {
    const tx = this.db.transaction((): SavedMessage | null => {
      if (!this.getSavedMessage(sessionId, id)) return null;
      if (patch.text !== undefined) this.db.prepare("UPDATE saved_messages SET text = ? WHERE id = ?").run(patch.text, id);
      if (patch.position !== undefined) {
        const ids = this.listSavedMessages(sessionId).map((m) => m.id).filter((x) => x !== id);
        ids.splice(Math.min(patch.position, ids.length), 0, id);
        this.renumberSavedMessages(ids);
      }
      return this.getSavedMessage(sessionId, id);
    });
    return tx();
  }

  deleteSavedMessage(sessionId: string, id: string): boolean {
    const tx = this.db.transaction((): boolean => {
      const info = this.db.prepare("DELETE FROM saved_messages WHERE session_id = ? AND id = ?").run(sessionId, id);
      if (info.changes === 0) return false;
      this.renumberSavedMessages(this.listSavedMessages(sessionId).map((m) => m.id));
      return true;
    });
    return tx();
  }

  private renumberSavedMessages(idsInOrder: string[]): void {
    const stmt = this.db.prepare("UPDATE saved_messages SET position = ? WHERE id = ?");
    idsInOrder.forEach((id, i) => stmt.run(i, id));
  }

  /** Appends to the Session's active branch. */
  appendEvent(sessionId: string, body: SessionEventBody, ts = new Date().toISOString()): SessionEvent {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max, (SELECT active_branch_id FROM sessions WHERE id = ?) AS branch FROM events WHERE session_id = ?")
      .get(sessionId, sessionId) as { max: number; branch: string | null };
    const seq = row.max + 1;
    const branchId = row.branch ?? ROOT_BRANCH_ID;
    this.db
      .prepare("INSERT INTO events (session_id, seq, branch_id, ts, body) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, seq, branchId, ts, JSON.stringify(body));
    return { seq, sessionId, branchId, ts, body };
  }

  getEvent(sessionId: string, seq: number): SessionEvent | null {
    const row = this.db.prepare("SELECT * FROM events WHERE session_id = ? AND seq = ?").get(sessionId, seq) as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  /**
   * Copies the conversation seen from `scope` up to `uptoSeq` into a new Session's root
   * branch, keeping sequence numbers (so later appends continue after them). Lifecycle
   * `status` markers are the origin's, not the fork's, and are left out.
   */
  copyEvents(fromSessionId: string, toSessionId: string, uptoSeq: number, scope: BranchScope): void {
    const where = scopeClause(scope);
    this.db
      .prepare(
        `INSERT INTO events (session_id, seq, branch_id, ts, body)
         SELECT ?, seq, '${ROOT_BRANCH_ID}', ts, body FROM events
         WHERE session_id = ? AND seq <= ? AND json_extract(body, '$.type') <> 'status' AND ${where.sql}
         ORDER BY seq ASC`,
      )
      .run(toSessionId, fromSessionId, uptoSeq, ...where.params);
  }

  lastEventSeq(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max FROM events WHERE session_id = ?")
      .get(sessionId) as { max: number };
    return row.max;
  }

  /** Events of one branch's view of the transcript (the active branch's by default). */
  listEvents(sessionId: string, afterSeq = 0, limit = 5000, scope = this.activeScope(sessionId)): SessionEvent[] {
    const where = scopeClause(scope);
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? AND seq > ? AND ${where.sql} ORDER BY seq ASC LIMIT ?`)
      .all(sessionId, afterSeq, ...where.params, limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  getDaemonCursor(sessionId: string): { epoch: string; lastSeq: number } | null {
    const row = this.db.prepare("SELECT epoch, last_seq FROM daemon_cursors WHERE session_id = ?").get(sessionId) as
      | { epoch: string; last_seq: number }
      | undefined;
    return row ? { epoch: row.epoch, lastSeq: row.last_seq } : null;
  }

  setDaemonCursor(sessionId: string, epoch: string, lastSeq: number): void {
    this.db
      .prepare(
        `INSERT INTO daemon_cursors (session_id, epoch, last_seq) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, last_seq = excluded.last_seq`,
      )
      .run(sessionId, epoch, lastSeq);
  }

  /** Last model list each Provider's Agent reported; Providers never seen map to `[]`. */
  providerModels(): ProviderModels {
    const rows = this.db.prepare("SELECT provider, models FROM provider_models").all() as Array<{ provider: string; models: string }>;
    const result = Object.fromEntries(PROVIDERS.map((p): [Provider, ModelOption[]] => [p, []])) as ProviderModels;
    for (const row of rows) {
      const provider = Provider.safeParse(row.provider);
      if (provider.success) result[provider.data] = ModelOption.array().parse(JSON.parse(row.models));
    }
    return result;
  }

  /** Returns whether the stored list changed. */
  setProviderModels(provider: Provider, models: ModelOption[]): boolean {
    const row = this.db.prepare("SELECT models FROM provider_models WHERE provider = ?").get(provider) as { models: string } | undefined;
    const json = JSON.stringify(models);
    if (row?.models === json) return false;
    this.db
      .prepare(
        `INSERT INTO provider_models (provider, models, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET models = excluded.models, updated_at = excluded.updated_at`,
      )
      .run(provider, json, new Date().toISOString());
    return true;
  }

  /** Every option each Provider's Agent has advertised so far, merged by id; Providers never seen map to `[]`. */
  providerOptions(): ProviderOptions {
    const rows = this.db.prepare("SELECT provider, options FROM provider_options").all() as Array<{ provider: string; options: string }>;
    const result = Object.fromEntries(PROVIDERS.map((p): [Provider, AgentOption[]] => [p, []])) as ProviderOptions;
    for (const row of rows) {
      const provider = Provider.safeParse(row.provider);
      if (provider.success) result[provider.data] = AgentOption.array().parse(JSON.parse(row.options));
    }
    return result;
  }

  /** Merges freshly advertised options into the Provider's catalog (by id); returns the catalog when it changed, else `null`. */
  mergeProviderOptions(provider: Provider, options: AgentOption[]): AgentOption[] | null {
    const current = this.providerOptions()[provider];
    const merged = [...current.filter((o) => !options.some((n) => n.id === o.id)), ...options];
    const json = JSON.stringify(merged);
    if (json === JSON.stringify(current)) return null;
    this.db
      .prepare(
        `INSERT INTO provider_options (provider, options, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET options = excluded.options, updated_at = excluded.updated_at`,
      )
      .run(provider, json, new Date().toISOString());
    return merged;
  }

  close(): void {
    this.db.close();
  }
}

export type SessionPatch = Partial<
  Pick<
    Session,
    | "title"
    | "status"
    | "containerId"
    | "error"
    | "queueRunning"
    | "settings"
    | "diskBytes"
    | "mcpPending"
    | "modelPending"
    | "optionsPending"
    | "availableOptions"
    | "inspectLlmPending"
    | "activeBranchId"
  >
>;

function scopeClause(scope: BranchScope): { sql: string; params: Array<string | number> } {
  if (scope.length === 0) return { sql: "1", params: [] };
  return {
    sql: `(${scope.map(() => "(branch_id = ? AND seq <= ?)").join(" OR ")})`,
    params: scope.flatMap((s) => [s.branchId, Number.isFinite(s.uptoSeq) ? s.uptoSeq : MAX_SEQ]),
  };
}

function rowToEvent(r: EventRow): SessionEvent {
  return { seq: r.seq, sessionId: r.session_id, branchId: r.branch_id, ts: r.ts, body: JSON.parse(r.body) as SessionEventBody };
}

function rowToBranch(row: BranchRow): Branch {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    parentId: row.parent_id,
    forkedAtSeq: row.forked_at_seq,
    method: row.method === null ? null : BranchMethod.parse(row.method),
    createdAt: row.created_at,
  };
}

function rowToSession(row: SessionQueryRow, branches: Branch[]): Session {
  return Session.parse({
    id: row.id,
    title: row.title,
    provider: row.provider,
    status: row.status as SessionStatus,
    workspaceSource: WorkspaceSource.parse(JSON.parse(row.workspace_source)),
    settings: SessionSettings.parse(JSON.parse(row.settings)),
    containerId: row.container_id,
    error: row.error,
    queueRunning: row.queue_running === 1,
    diskBytes: row.disk_bytes,
    mcpPending: row.mcp_pending === 1,
    modelPending: row.model_pending === 1,
    optionsPending: row.options_pending === 1,
    availableOptions: AgentOption.array().parse(JSON.parse(row.available_options)),
    inspectLlmPending: row.inspect_llm_pending === 1,
    snapshotBytes: row.snapshot_bytes,
    snapshotCount: row.snapshot_count,
    branches,
    activeBranchId: row.active_branch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    reason: SnapshotReason.parse(row.reason),
    imageTag: row.image_tag,
    imageId: row.image_id,
    eventSeq: row.event_seq,
    branchId: row.branch_id,
    sizeBytes: row.size_bytes,
    queuedMessages: JSON.parse(row.queued_messages) as string[],
    createdAt: row.created_at,
  };
}

function rowToSavedMessage(row: SavedMessageRow): SavedMessage {
  return { id: row.id, sessionId: row.session_id, text: row.text, position: row.position, createdAt: row.created_at };
}

function sessionToRow(s: Session): SessionRow {
  return {
    id: s.id,
    title: s.title,
    provider: s.provider,
    status: s.status,
    workspace_source: JSON.stringify(s.workspaceSource),
    settings: JSON.stringify(s.settings),
    container_id: s.containerId,
    error: s.error,
    queue_running: s.queueRunning ? 1 : 0,
    disk_bytes: s.diskBytes,
    mcp_pending: s.mcpPending ? 1 : 0,
    model_pending: s.modelPending ? 1 : 0,
    options_pending: s.optionsPending ? 1 : 0,
    available_options: JSON.stringify(s.availableOptions),
    inspect_llm_pending: s.inspectLlmPending ? 1 : 0,
    active_branch_id: s.activeBranchId,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}
