import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { KnownRepoKind, KnownRepoUse, PrProvider, SessionRepo, parseRepoRemote, repoCloneUrl, type KnownRepo } from "@sessionboxer/protocol";

/**
 * Every repository named anywhere in Sessionboxer (ADR-0068): a Session's repositories, a
 * repository follow, an attached PR, an automation's New Session. One row per clone URL (or host
 * folder), case-insensitive, with how often and where it was last named, so the inputs that take
 * a repository can suggest the ones already in use. Nothing reads the repositories from here.
 */
export const REPO_SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  location TEXT NOT NULL COLLATE NOCASE,
  provider TEXT,
  host TEXT,
  owner TEXT,
  repo TEXT,
  uses INTEGER NOT NULL DEFAULT 1,
  last_used_by TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, location)
);
`;

interface Row {
  id: string;
  kind: string;
  location: string;
  provider: string | null;
  host: string | null;
  owner: string | null;
  repo: string | null;
  uses: number;
  last_used_by: string;
  last_used_at: string;
  created_at: string;
}

function rowToRepo(r: Row): KnownRepo {
  return {
    id: r.id,
    kind: KnownRepoKind.parse(r.kind),
    location: r.location,
    provider: r.provider === null ? null : PrProvider.parse(r.provider),
    host: r.host,
    owner: r.owner,
    repo: r.repo,
    uses: r.uses,
    lastUsedBy: KnownRepoUse.parse(r.last_used_by),
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  };
}

/** What to remember: a clone URL (`git`) or a host folder (`copy`), and where it was named. */
export interface RepoUse {
  kind: KnownRepoKind;
  location: string;
  by: KnownRepoUse;
  /** When it was named; now when omitted (the backfill passes the original timestamps). */
  at?: string;
}

export class RepoStore {
  constructor(private readonly db: Database.Database) {
    db.exec(REPO_SCHEMA);
  }

  /** Adds the repository or bumps its use count and last use; a blank location is ignored. */
  remember(use: RepoUse): void {
    const raw = use.location.trim();
    if (raw === "") return;
    const remote = use.kind === "git" ? parseRepoRemote(raw) : null;
    const at = use.at ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO repositories (id, kind, location, provider, host, owner, repo, uses, last_used_by, last_used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (kind, location) DO UPDATE SET
           uses = uses + 1,
           last_used_by = CASE WHEN excluded.last_used_at >= last_used_at THEN excluded.last_used_by ELSE last_used_by END,
           last_used_at = MAX(last_used_at, excluded.last_used_at),
           created_at = MIN(created_at, excluded.created_at)`,
      )
      .run(
        randomBytes(6).toString("hex"),
        use.kind,
        remote?.url ?? raw.replace(/\/+$/, ""),
        remote?.provider ?? null,
        remote?.host ?? null,
        remote?.owner ?? null,
        remote?.repo ?? null,
        use.by,
        at,
        at,
      );
  }

  /** A repository a Connector knows, by coordinates (a follow, an attached PR). */
  rememberRef(ref: Parameters<typeof repoCloneUrl>[0], by: KnownRepoUse, at?: string): void {
    this.remember({ kind: "git", location: repoCloneUrl(ref), by, at });
  }

  /** Most recently named first. */
  list(): KnownRepo[] {
    return (this.db.prepare("SELECT * FROM repositories ORDER BY last_used_at DESC, uses DESC").all() as Row[]).map(rowToRepo);
  }

  forget(id: string): boolean {
    return this.db.prepare("DELETE FROM repositories WHERE id = ?").run(id).changes > 0;
  }

  isEmpty(): boolean {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM repositories").get() as { n: number }).n === 0;
  }

  /**
   * Fills an empty table from what the other tables already name: Sessions' repositories,
   * attached PRs, repository follows and automations' New Session actions, dated as they were.
   */
  backfill(): void {
    const run = this.db.transaction(() => {
      for (const r of this.db.prepare("SELECT repos FROM sessions").all() as Array<{ repos: string }>) {
        const parsed = SessionRepo.array().safeParse(JSON.parse(r.repos));
        if (!parsed.success) continue;
        for (const repo of parsed.data) {
          if (repo.source.type === "git") this.remember({ kind: "git", location: repo.source.url, by: "session", at: repo.createdAt });
          else if (repo.source.type === "copy") this.remember({ kind: "copy", location: repo.source.path, by: "session", at: repo.createdAt });
        }
      }
      const prs = this.db.prepare("SELECT provider, host, owner, repo, attached_at FROM pull_requests").all() as Array<{
        provider: string;
        host: string;
        owner: string;
        repo: string;
        attached_at: string;
      }>;
      for (const p of prs) {
        const provider = PrProvider.safeParse(p.provider);
        if (provider.success) this.rememberRef({ provider: provider.data, host: p.host, owner: p.owner, repo: p.repo }, "pr", p.attached_at);
      }
      const follows = this.db.prepare("SELECT provider, host, owner, repo, created_at FROM pr_follows WHERE kind = 'repo' AND owner IS NOT NULL AND repo IS NOT NULL").all() as Array<{
        provider: string;
        host: string;
        owner: string;
        repo: string;
        created_at: string;
      }>;
      for (const f of follows) {
        const provider = PrProvider.safeParse(f.provider);
        if (provider.success) this.rememberRef({ provider: provider.data, host: f.host, owner: f.owner, repo: f.repo }, "follow", f.created_at);
      }
      for (const a of this.db.prepare("SELECT action, created_at FROM automations").all() as Array<{ action: string; created_at: string }>) {
        const action: unknown = JSON.parse(a.action);
        if (typeof action !== "object" || action === null || !("repos" in action) || !Array.isArray(action.repos)) continue;
        for (const spec of action.repos as unknown[]) {
          const source = typeof spec === "object" && spec !== null && "source" in spec ? spec.source : null;
          if (typeof source !== "object" || source === null || !("type" in source)) continue;
          if (source.type === "git" && "url" in source && typeof source.url === "string") this.remember({ kind: "git", location: source.url, by: "automation", at: a.created_at });
          if (source.type === "copy" && "path" in source && typeof source.path === "string") this.remember({ kind: "copy", location: source.path, by: "automation", at: a.created_at });
        }
      }
    });
    run();
  }
}
