import type Database from "better-sqlite3";
import {
  PrAddressState,
  PrAttachedBy,
  PrItemKind,
  PrReviewDecision,
  PrState,
  PrSyncError,
  type PrItem,
  type PullRequest,
} from "@sessionboxer/protocol";

export const PR_SCHEMA = `
CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',
  head_ref TEXT NOT NULL DEFAULT '',
  head_repo TEXT NOT NULL DEFAULT '',
  base_ref TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  review_decision TEXT,
  attached_by TEXT NOT NULL,
  attached_at TEXT NOT NULL,
  last_activity_at TEXT,
  via_account TEXT,
  watch INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT,
  sync_error TEXT,
  sync_error_detail TEXT,
  etags TEXT NOT NULL DEFAULT '{}',
  closed_at TEXT,
  retry_at TEXT,
  UNIQUE (session_id, owner, repo, number)
);
CREATE TABLE IF NOT EXISTS pr_items (
  id TEXT PRIMARY KEY,
  pr_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  github_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  thread_id TEXT,
  thread_node_id TEXT,
  in_reply_to INTEGER,
  author TEXT NOT NULL,
  self INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  diff_hunk TEXT,
  html_url TEXT NOT NULL,
  review_state TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  outdated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  address TEXT NOT NULL DEFAULT 'none',
  notified INTEGER NOT NULL DEFAULT 0,
  UNIQUE (pr_id, kind, github_id)
);
CREATE INDEX IF NOT EXISTS pr_items_pr ON pr_items (pr_id);
`;

/** Conditional-request cursors per endpoint. */
export interface PrEtags {
  pr?: string;
  issueComments?: string;
  reviewComments?: string;
  reviews?: string;
}

/** A `pull_requests` row with the polling state the UI does not see. */
export interface StoredPr extends PullRequest {
  etags: PrEtags;
  closedAt: string | null;
  retryAt: string | null;
}

/** What a poll learned about the PR itself. */
export type PrMetaPatch = Partial<
  Pick<PullRequest, "title" | "state" | "headRef" | "headRepo" | "baseRef" | "author" | "reviewDecision" | "viaAccount" | "watch">
> & { closedAt?: string | null };

/** A comment/review as it comes from GitHub, before the Session-side flags. */
export type PrItemInput = Omit<PrItem, "id" | "prId" | "seen" | "address">;

export class PrStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(PR_SCHEMA);
  }

  list(sessionId: string): StoredPr[] {
    const rows = this.db
      .prepare(`${PR_SELECT} WHERE p.session_id = ? ORDER BY p.attached_at ASC`)
      .all(sessionId) as PrRow[];
    return rows.map(rowToPr);
  }

  listWatched(): StoredPr[] {
    const rows = this.db.prepare(`${PR_SELECT} WHERE p.watch = 1 ORDER BY p.synced_at ASC`).all() as PrRow[];
    return rows.map(rowToPr);
  }

  get(id: string): StoredPr | null {
    const row = this.db.prepare(`${PR_SELECT} WHERE p.id = ?`).get(id) as PrRow | undefined;
    return row ? rowToPr(row) : null;
  }

  find(sessionId: string, owner: string, repo: string, number: number): StoredPr | null {
    const row = this.db
      .prepare(`${PR_SELECT} WHERE p.session_id = ? AND lower(p.owner) = lower(?) AND lower(p.repo) = lower(?) AND p.number = ?`)
      .get(sessionId, owner, repo, number) as PrRow | undefined;
    return row ? rowToPr(row) : null;
  }

  insert(pr: { id: string; sessionId: string; owner: string; repo: string; number: number; url: string; attachedBy: PullRequest["attachedBy"] }): StoredPr {
    this.db
      .prepare(
        `INSERT INTO pull_requests (id, session_id, owner, repo, number, url, attached_by, attached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(pr.id, pr.sessionId, pr.owner, pr.repo, pr.number, pr.url, pr.attachedBy, new Date().toISOString());
    return this.get(pr.id)!;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM pull_requests WHERE id = ?").run(id).changes > 0;
  }

  updateMeta(id: string, patch: PrMetaPatch): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    const set = (col: string, value: string | number | null): void => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if (patch.title !== undefined) set("title", patch.title);
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.headRef !== undefined) set("head_ref", patch.headRef);
    if (patch.headRepo !== undefined) set("head_repo", patch.headRepo);
    if (patch.baseRef !== undefined) set("base_ref", patch.baseRef);
    if (patch.author !== undefined) set("author", patch.author);
    if (patch.reviewDecision !== undefined) set("review_decision", patch.reviewDecision);
    if (patch.viaAccount !== undefined) set("via_account", patch.viaAccount);
    if (patch.watch !== undefined) set("watch", patch.watch ? 1 : 0);
    if (patch.closedAt !== undefined) set("closed_at", patch.closedAt);
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE pull_requests SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  /** Records the outcome of a poll: cursors, time, error (or none). */
  setSync(id: string, s: { etags: PrEtags; error: PullRequest["syncError"]; detail: string | null; retryAt?: string | null }): void {
    this.db
      .prepare("UPDATE pull_requests SET etags = ?, synced_at = ?, sync_error = ?, sync_error_detail = ?, retry_at = ? WHERE id = ?")
      .run(JSON.stringify(s.etags), new Date().toISOString(), s.error, s.detail, s.retryAt ?? null, id);
  }

  items(prId: string): PrItem[] {
    const rows = this.db.prepare("SELECT * FROM pr_items WHERE pr_id = ? ORDER BY created_at ASC").all(prId) as ItemRow[];
    return rows.map(rowToItem);
  }

  getItems(ids: string[]): PrItem[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM pr_items WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as ItemRow[];
    const byId = new Map(rows.map((r) => [r.id, rowToItem(r)]));
    return ids.map((id) => byId.get(id)).filter((i): i is PrItem => i !== undefined);
  }

  /**
   * Replaces the PR's items with what GitHub returned for `kinds`, keeping the Session-side
   * flags of rows that already existed. Returns the new rows (not by the watching account).
   */
  upsertItems(prId: string, kinds: PrItem["kind"][], items: PrItemInput[]): PrItem[] {
    const tx = this.db.transaction((): PrItem[] => {
      const existing = new Map(this.items(prId).map((i) => [i.id, i]));
      const fresh: PrItem[] = [];
      const keep = new Set<string>();
      const stmt = this.db.prepare(
        `INSERT INTO pr_items (id, pr_id, kind, github_id, node_id, thread_id, thread_node_id, in_reply_to, author, self, body, path, line, diff_hunk,
           html_url, review_state, resolved, outdated, created_at, updated_at, seen, address, notified)
         VALUES (@id, @pr_id, @kind, @github_id, @node_id, @thread_id, @thread_node_id, @in_reply_to, @author, @self, @body, @path, @line, @diff_hunk,
           @html_url, @review_state, @resolved, @outdated, @created_at, @updated_at, @seen, @address, @notified)
         ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, thread_id = excluded.thread_id,
           thread_node_id = coalesce(excluded.thread_node_id, pr_items.thread_node_id), in_reply_to = excluded.in_reply_to,
           author = excluded.author, self = excluded.self, body = excluded.body, path = excluded.path, line = excluded.line,
           diff_hunk = excluded.diff_hunk, html_url = excluded.html_url, review_state = excluded.review_state,
           resolved = excluded.resolved, outdated = excluded.outdated, updated_at = excluded.updated_at`,
      );
      for (const it of items) {
        const id = itemId(prId, it.kind, it.githubId);
        keep.add(id);
        const old = existing.get(id);
        const seen = old ? old.seen : it.self;
        stmt.run({
          id,
          pr_id: prId,
          kind: it.kind,
          github_id: it.githubId,
          node_id: it.nodeId,
          thread_id: it.threadId,
          thread_node_id: it.threadNodeId,
          in_reply_to: it.inReplyTo,
          author: it.author,
          self: it.self ? 1 : 0,
          body: it.body,
          path: it.path,
          line: it.line,
          diff_hunk: it.diffHunk,
          html_url: it.htmlUrl,
          review_state: it.reviewState,
          resolved: it.resolved ? 1 : 0,
          outdated: it.outdated ? 1 : 0,
          created_at: it.createdAt,
          updated_at: it.updatedAt,
          seen: seen ? 1 : 0,
          address: old?.address ?? "none",
          notified: old ? 1 : it.self ? 1 : 0,
        });
        if (!old && !it.self) fresh.push({ ...it, id, prId, seen: false, address: "none" });
      }
      // Deleted on GitHub: drop rows of the refreshed kinds that came back missing.
      const del = this.db.prepare("DELETE FROM pr_items WHERE id = ?");
      for (const old of existing.values()) if (kinds.includes(old.kind) && !keep.has(old.id)) del.run(old.id);
      const newest = items.reduce<string | null>((m, i) => (m === null || i.updatedAt > m ? i.updatedAt : m), null);
      if (newest) {
        this.db
          .prepare("UPDATE pull_requests SET last_activity_at = max(coalesce(last_activity_at, ''), ?) WHERE id = ?")
          .run(newest, prId);
      }
      return fresh;
    });
    return tx();
  }

  /** Sets thread ids and `resolved`/`outdated` of review comments from the GraphQL thread list. */
  setThreads(prId: string, threads: Array<{ nodeId: string; commentIds: number[]; resolved: boolean; outdated: boolean }>): void {
    const stmt = this.db.prepare(
      "UPDATE pr_items SET thread_id = ?, thread_node_id = ?, resolved = ?, outdated = ? WHERE pr_id = ? AND kind = 'review_comment' AND github_id = ?",
    );
    const tx = this.db.transaction(() => {
      for (const t of threads) {
        const root = t.commentIds[0];
        if (root === undefined) continue;
        const threadId = itemId(prId, "review_comment", root);
        for (const cid of t.commentIds) stmt.run(threadId, t.nodeId, t.resolved ? 1 : 0, t.outdated ? 1 : 0, prId, cid);
      }
    });
    tx();
  }

  /**
   * Items being addressed count as addressed once the watching login answered them: a reply in
   * the same thread, the thread resolved, or (conversation comments/reviews) a later comment.
   */
  settleAddressed(prId: string): number {
    return this.db
      .prepare(
        `UPDATE pr_items SET address = 'addressed' WHERE pr_id = ? AND address = 'addressing' AND (
           resolved = 1
           OR EXISTS (SELECT 1 FROM pr_items r WHERE r.pr_id = pr_items.pr_id AND r.self = 1 AND r.created_at > pr_items.created_at
                      AND ((pr_items.thread_id IS NOT NULL AND r.thread_id = pr_items.thread_id)
                           OR (pr_items.thread_id IS NULL AND r.kind = 'issue_comment'))))`,
      )
      .run(prId).changes;
  }

  markSeen(prId: string): number {
    return this.db.prepare("UPDATE pr_items SET seen = 1 WHERE pr_id = ? AND seen = 0").run(prId).changes;
  }

  setAddress(ids: string[], state: PrAddressState): void {
    if (ids.length === 0) return;
    this.db
      .prepare(`UPDATE pr_items SET address = ?, seen = 1 WHERE id IN (${ids.map(() => "?").join(",")})`)
      .run(state, ...ids);
  }

  /** Items nobody has been told about yet (by other people), across the Session's PRs. */
  unnotified(sessionId: string): PrItem[] {
    const rows = this.db
      .prepare(
        `SELECT i.* FROM pr_items i JOIN pull_requests p ON p.id = i.pr_id
         WHERE p.session_id = ? AND i.notified = 0 AND i.self = 0 ORDER BY i.created_at ASC`,
      )
      .all(sessionId) as ItemRow[];
    return rows.map(rowToItem);
  }

  markNotified(ids: string[]): void {
    if (ids.length === 0) return;
    this.db.prepare(`UPDATE pr_items SET notified = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  }
}

export function itemId(prId: string, kind: PrItem["kind"], githubId: number): string {
  return `${prId}:${kind}:${githubId}`;
}

const PR_SELECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM pr_items i WHERE i.pr_id = p.id AND i.seen = 0 AND i.self = 0) AS unread,
    (SELECT COUNT(*) FROM pr_items i WHERE i.pr_id = p.id AND i.kind = 'review_comment' AND i.in_reply_to IS NULL AND i.resolved = 0) AS open_threads
  FROM pull_requests p`;

interface PrRow {
  id: string;
  session_id: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: string;
  head_ref: string;
  head_repo: string;
  base_ref: string;
  author: string;
  review_decision: string | null;
  attached_by: string;
  attached_at: string;
  last_activity_at: string | null;
  via_account: string | null;
  watch: number;
  synced_at: string | null;
  sync_error: string | null;
  sync_error_detail: string | null;
  etags: string;
  closed_at: string | null;
  retry_at: string | null;
  unread: number;
  open_threads: number;
}

interface ItemRow {
  id: string;
  pr_id: string;
  kind: string;
  github_id: number;
  node_id: string;
  thread_id: string | null;
  thread_node_id: string | null;
  in_reply_to: number | null;
  author: string;
  self: number;
  body: string;
  path: string | null;
  line: number | null;
  diff_hunk: string | null;
  html_url: string;
  review_state: string | null;
  resolved: number;
  outdated: number;
  created_at: string;
  updated_at: string;
  seen: number;
  address: string;
  notified: number;
}

function rowToPr(r: PrRow): StoredPr {
  return {
    id: r.id,
    sessionId: r.session_id,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    url: r.url,
    title: r.title,
    state: PrState.catch("open").parse(r.state),
    headRef: r.head_ref,
    headRepo: r.head_repo,
    baseRef: r.base_ref,
    author: r.author,
    reviewDecision: r.review_decision === null ? null : PrReviewDecision.catch("review_required").parse(r.review_decision),
    attachedBy: PrAttachedBy.catch("manual").parse(r.attached_by),
    attachedAt: r.attached_at,
    lastActivityAt: r.last_activity_at,
    unread: r.unread,
    openThreads: r.open_threads,
    viaAccount: r.via_account,
    watch: r.watch === 1,
    syncedAt: r.synced_at,
    syncError: r.sync_error === null ? null : PrSyncError.catch("error").parse(r.sync_error),
    syncErrorDetail: r.sync_error_detail,
    // Filled in by the manager (depends on the Session's Workspace).
    local: true,
    etags: JSON.parse(r.etags) as PrEtags,
    closedAt: r.closed_at,
    retryAt: r.retry_at,
  };
}

function rowToItem(r: ItemRow): PrItem {
  return {
    id: r.id,
    prId: r.pr_id,
    kind: PrItemKind.parse(r.kind),
    githubId: r.github_id,
    nodeId: r.node_id,
    threadId: r.thread_id,
    threadNodeId: r.thread_node_id,
    inReplyTo: r.in_reply_to,
    author: r.author,
    self: r.self === 1,
    body: r.body,
    path: r.path,
    line: r.line,
    diffHunk: r.diff_hunk,
    htmlUrl: r.html_url,
    reviewState: r.review_state,
    resolved: r.resolved === 1,
    outdated: r.outdated === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    seen: r.seen === 1,
    address: PrAddressState.catch("none").parse(r.address),
  };
}
