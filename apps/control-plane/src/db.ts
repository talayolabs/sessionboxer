import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  DockerMode,
  Session,
  SnapshotReason,
  WorkspaceSource,
  type SavedMessage,
  type SessionEvent,
  type SessionEventBody,
  type SessionStatus,
  type Snapshot,
} from "@sessionboxer/protocol";

interface SessionRow {
  id: string;
  title: string;
  provider: string;
  status: string;
  workspace_source: string;
  docker_mode: string;
  container_id: string | null;
  error: string | null;
  queue_running: number;
  auto_snapshot: number | null;
  disk_bytes: number | null;
  /** JSON array of MCP server ids. */
  mcp_enabled: string;
  mcp_pending: number;
  created_at: string;
  updated_at: string;
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
  size_bytes: number;
  queued_messages: string;
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
  ts: string;
  body: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  workspace_source TEXT NOT NULL,
  docker_mode TEXT NOT NULL DEFAULT 'none',
  container_id TEXT,
  error TEXT,
  queue_running INTEGER NOT NULL DEFAULT 0,
  auto_snapshot INTEGER,
  disk_bytes INTEGER,
  mcp_enabled TEXT NOT NULL DEFAULT '[]',
  mcp_pending INTEGER NOT NULL DEFAULT 0,
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
  size_bytes INTEGER NOT NULL,
  queued_messages TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, ordinal)
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
  ts TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS daemon_cursors (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  last_seq INTEGER NOT NULL
);
`;

/** Columns added after the first release, applied to databases created before them. */
const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "sessions", column: "docker_mode", ddl: "ALTER TABLE sessions ADD COLUMN docker_mode TEXT NOT NULL DEFAULT 'none'" },
  { table: "sessions", column: "queue_running", ddl: "ALTER TABLE sessions ADD COLUMN queue_running INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "disk_bytes", ddl: "ALTER TABLE sessions ADD COLUMN disk_bytes INTEGER" },
  { table: "sessions", column: "auto_snapshot", ddl: "ALTER TABLE sessions ADD COLUMN auto_snapshot INTEGER" },
  { table: "sessions", column: "mcp_enabled", ddl: "ALTER TABLE sessions ADD COLUMN mcp_enabled TEXT NOT NULL DEFAULT '[]'" },
  { table: "sessions", column: "mcp_pending", ddl: "ALTER TABLE sessions ADD COLUMN mcp_pending INTEGER NOT NULL DEFAULT 0" },
];

const SESSION_SELECT = `
  SELECT s.*,
    (SELECT COALESCE(SUM(size_bytes), 0) FROM snapshots WHERE session_id = s.id) AS snapshot_bytes,
    (SELECT COUNT(*) FROM snapshots WHERE session_id = s.id) AS snapshot_count
  FROM sessions s`;

export class Db {
  private readonly db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    for (const m of MIGRATIONS) {
      const columns = this.db.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === m.column)) this.db.exec(m.ddl);
    }
  }

  listSessions(): Session[] {
    const rows = this.db.prepare(`${SESSION_SELECT} ORDER BY s.created_at DESC`).all() as SessionQueryRow[];
    return rows.map(rowToSession);
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionQueryRow | undefined;
    return row ? rowToSession(row) : null;
  }

  insertSession(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, provider, status, workspace_source, docker_mode, container_id, error, queue_running, auto_snapshot, disk_bytes, mcp_enabled, mcp_pending, created_at, updated_at)
         VALUES (@id, @title, @provider, @status, @workspace_source, @docker_mode, @container_id, @error, @queue_running, @auto_snapshot, @disk_bytes, @mcp_enabled, @mcp_pending, @created_at, @updated_at)`,
      )
      .run(sessionToRow(session));
  }

  updateSession(id: string, patch: SessionPatch): Session | null {
    const current = this.getSession(id);
    if (!current) return null;
    const next: Session = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE sessions SET title=@title, status=@status, container_id=@container_id, error=@error,
           queue_running=@queue_running, auto_snapshot=@auto_snapshot, disk_bytes=@disk_bytes,
           mcp_enabled=@mcp_enabled, mcp_pending=@mcp_pending, updated_at=@updated_at
         WHERE id=@id`,
      )
      .run(sessionToRow(next));
    return next;
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
        `INSERT INTO snapshots (id, session_id, ordinal, reason, image_tag, image_id, event_seq, size_bytes, queued_messages, created_at)
         VALUES (@id, @session_id, @ordinal, @reason, @image_tag, @image_id, @event_seq, @size_bytes, @queued_messages, @created_at)`,
      )
      .run({
        id: snapshot.id,
        session_id: snapshot.sessionId,
        ordinal: snapshot.ordinal,
        reason: snapshot.reason,
        image_tag: snapshot.imageTag,
        image_id: snapshot.imageId,
        event_seq: snapshot.eventSeq,
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

  appendEvent(sessionId: string, body: SessionEventBody, ts = new Date().toISOString()): SessionEvent {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max FROM events WHERE session_id = ?")
      .get(sessionId) as { max: number };
    const seq = row.max + 1;
    this.db
      .prepare("INSERT INTO events (session_id, seq, ts, body) VALUES (?, ?, ?, ?)")
      .run(sessionId, seq, ts, JSON.stringify(body));
    return { seq, sessionId, ts, body };
  }

  /**
   * Copies the conversation up to `uptoSeq` into a new Session, keeping sequence
   * numbers (so later appends continue after them). Lifecycle `status` markers are
   * the origin's, not the fork's, and are left out.
   */
  copyEvents(fromSessionId: string, toSessionId: string, uptoSeq: number): void {
    this.db
      .prepare(
        `INSERT INTO events (session_id, seq, ts, body)
         SELECT ?, seq, ts, body FROM events
         WHERE session_id = ? AND seq <= ? AND json_extract(body, '$.type') <> 'status'
         ORDER BY seq ASC`,
      )
      .run(toSessionId, fromSessionId, uptoSeq);
  }

  lastEventSeq(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max FROM events WHERE session_id = ?")
      .get(sessionId) as { max: number };
    return row.max;
  }

  listEvents(sessionId: string, afterSeq = 0, limit = 5000): SessionEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(sessionId, afterSeq, limit) as EventRow[];
    return rows.map((r) => ({
      seq: r.seq,
      sessionId: r.session_id,
      ts: r.ts,
      body: JSON.parse(r.body) as SessionEventBody,
    }));
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

  close(): void {
    this.db.close();
  }
}

export type SessionPatch = Partial<
  Pick<Session, "title" | "status" | "containerId" | "error" | "queueRunning" | "autoSnapshot" | "diskBytes" | "mcpEnabled" | "mcpPending">
>;

function rowToSession(row: SessionQueryRow): Session {
  return Session.parse({
    id: row.id,
    title: row.title,
    provider: row.provider,
    status: row.status as SessionStatus,
    workspaceSource: WorkspaceSource.parse(JSON.parse(row.workspace_source)),
    dockerMode: DockerMode.parse(row.docker_mode),
    containerId: row.container_id,
    error: row.error,
    queueRunning: row.queue_running === 1,
    autoSnapshot: row.auto_snapshot === null ? null : row.auto_snapshot === 1,
    diskBytes: row.disk_bytes,
    mcpEnabled: JSON.parse(row.mcp_enabled) as string[],
    mcpPending: row.mcp_pending === 1,
    snapshotBytes: row.snapshot_bytes,
    snapshotCount: row.snapshot_count,
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
    docker_mode: s.dockerMode,
    container_id: s.containerId,
    error: s.error,
    queue_running: s.queueRunning ? 1 : 0,
    auto_snapshot: s.autoSnapshot === null ? null : s.autoSnapshot ? 1 : 0,
    disk_bytes: s.diskBytes,
    mcp_enabled: JSON.stringify(s.mcpEnabled),
    mcp_pending: s.mcpPending ? 1 : 0,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}
