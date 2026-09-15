import Database from "better-sqlite3";
import {
  DockerMode,
  Session,
  WorkspaceSource,
  type SessionEvent,
  type SessionEventBody,
  type SessionStatus,
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
  created_at: string;
  updated_at: string;
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
];

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
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as SessionRow[];
    return rows.map(rowToSession);
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  insertSession(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, provider, status, workspace_source, docker_mode, container_id, error, created_at, updated_at)
         VALUES (@id, @title, @provider, @status, @workspace_source, @docker_mode, @container_id, @error, @created_at, @updated_at)`,
      )
      .run(sessionToRow(session));
  }

  updateSession(
    id: string,
    patch: Partial<Pick<Session, "title" | "status" | "containerId" | "error">>,
  ): Session | null {
    const current = this.getSession(id);
    if (!current) return null;
    const next: Session = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE sessions SET title=@title, status=@status, container_id=@container_id, error=@error, updated_at=@updated_at
         WHERE id=@id`,
      )
      .run(sessionToRow(next));
    return next;
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
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

function rowToSession(row: SessionRow): Session {
  return Session.parse({
    id: row.id,
    title: row.title,
    provider: row.provider,
    status: row.status as SessionStatus,
    workspaceSource: WorkspaceSource.parse(JSON.parse(row.workspace_source)),
    dockerMode: DockerMode.parse(row.docker_mode),
    containerId: row.container_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
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
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}
