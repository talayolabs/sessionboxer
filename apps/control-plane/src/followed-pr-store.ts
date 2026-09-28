import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  PrEventType,
  PrFollowKind,
  PrProvider,
  PrReviewDecision,
  PrState,
  PrSyncError,
  type FollowedPr,
  type PrEvent,
  type PrFollow,
  type PrRef,
} from "@sessionboxer/protocol";
import { PrItemsStore, itemTablesSchema, type PrEtags } from "./pr-store.js";

/**
 * Pull requests the Control Plane follows on its own (ADR-0064). A follow is a scope read with a
 * Connector's login (a repository, "mine", "requested"); the PRs it lists are shared rows linked to
 * every follow that saw them; their comments and checks reuse the item/check tables of attached
 * PRs; events are what a poll derived from the change (one row per PR, type, head and ref, which
 * is also the dedupe key an automation run is matched against).
 */
export const FOLLOWED_SCHEMA = `
CREATE TABLE IF NOT EXISTS pr_follows (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  host TEXT NOT NULL,
  account TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner TEXT,
  repo TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  webhook_id TEXT,
  webhook_seen_at TEXT,
  etags TEXT NOT NULL DEFAULT '{}',
  polled_at TEXT,
  retry_at TEXT,
  sync_error TEXT,
  sync_error_detail TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, host, account, kind, owner, repo)
);
CREATE TABLE IF NOT EXISTS followed_prs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  host TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',
  author TEXT NOT NULL DEFAULT '',
  head_ref TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  head_repo TEXT NOT NULL DEFAULT '',
  base_ref TEXT NOT NULL DEFAULT '',
  is_fork INTEGER NOT NULL DEFAULT 0,
  requested_reviewers TEXT NOT NULL DEFAULT '[]',
  labels TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL DEFAULT '',
  review_decision TEXT,
  remote_created_at TEXT,
  remote_updated_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_event_at TEXT,
  last_activity_at TEXT,
  closed_at TEXT,
  etags TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT,
  sync_error TEXT,
  sync_error_detail TEXT,
  retry_at TEXT,
  needs_detail INTEGER NOT NULL DEFAULT 1,
  pending_opened INTEGER NOT NULL DEFAULT 0,
  UNIQUE (provider, host, owner, repo, number)
);
CREATE TABLE IF NOT EXISTS followed_pr_sources (
  followed_pr_id TEXT NOT NULL REFERENCES followed_prs(id) ON DELETE CASCADE,
  follow_id TEXT NOT NULL REFERENCES pr_follows(id) ON DELETE CASCADE,
  PRIMARY KEY (followed_pr_id, follow_id)
);
CREATE TABLE IF NOT EXISTS pr_events (
  id TEXT PRIMARY KEY,
  followed_pr_id TEXT NOT NULL REFERENCES followed_prs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  actor TEXT,
  ref TEXT,
  detected_at TEXT NOT NULL,
  UNIQUE (followed_pr_id, type, head_sha, ref)
);
CREATE INDEX IF NOT EXISTS pr_events_pr ON pr_events(followed_pr_id, detected_at);
${itemTablesSchema({ prs: "followed_prs", items: "followed_pr_items", checks: "followed_pr_checks" })}
`;

const FOLLOW_SELECT = `
SELECT f.*, (SELECT count(*) FROM followed_pr_sources s JOIN followed_prs p ON p.id = s.followed_pr_id WHERE s.follow_id = f.id AND p.state IN ('open', 'draft')) AS pr_count
FROM pr_follows f`;

const PR_SELECT = `
SELECT p.*,
  (SELECT count(*) FROM followed_pr_items i WHERE i.pr_id = p.id AND i.seen = 0)
    + (SELECT count(*) FROM followed_pr_checks c WHERE c.pr_id = p.id AND c.seen = 0 AND c.state = 'failed') AS unread,
  (SELECT count(*) FROM followed_pr_checks c WHERE c.pr_id = p.id AND c.state = 'failed') AS checks_failed,
  (SELECT count(*) FROM followed_pr_checks c WHERE c.pr_id = p.id AND c.state = 'pending') AS checks_pending,
  (SELECT count(*) FROM followed_pr_checks c WHERE c.pr_id = p.id AND c.state = 'passed') AS checks_passed,
  (SELECT group_concat(s.follow_id, ' ') FROM followed_pr_sources s WHERE s.followed_pr_id = p.id) AS follow_ids
FROM followed_prs p`;

interface FollowRow {
  id: string;
  provider: string;
  host: string;
  account: string;
  kind: string;
  owner: string | null;
  repo: string | null;
  enabled: number;
  webhook_id: string | null;
  webhook_seen_at: string | null;
  etags: string;
  polled_at: string | null;
  retry_at: string | null;
  sync_error: string | null;
  sync_error_detail: string | null;
  created_at: string;
  pr_count: number;
}

interface PrRow {
  id: string;
  provider: string;
  host: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  state: string;
  author: string;
  head_ref: string;
  head_sha: string;
  head_repo: string;
  base_ref: string;
  is_fork: number;
  requested_reviewers: string;
  labels: string;
  body: string;
  review_decision: string | null;
  remote_created_at: string | null;
  remote_updated_at: string | null;
  first_seen_at: string;
  last_event_at: string | null;
  last_activity_at: string | null;
  closed_at: string | null;
  etags: string;
  synced_at: string | null;
  sync_error: string | null;
  sync_error_detail: string | null;
  retry_at: string | null;
  needs_detail: number;
  pending_opened: number;
  unread: number;
  checks_failed: number;
  checks_pending: number;
  checks_passed: number;
  follow_ids: string | null;
}

interface EventRow {
  id: string;
  followed_pr_id: string;
  type: string;
  head_sha: string;
  actor: string | null;
  ref: string | null;
  detected_at: string;
}

/** A `pr_follows` row with its polling cursors. */
export interface StoredFollow extends PrFollow {
  etags: PrEtags & { list?: string };
}

/** A `followed_prs` row with the polling state the UI does not see; `attached` and `runs` are filled in by the service. */
export interface StoredFollowedPr extends Omit<FollowedPr, "attached" | "runs"> {
  /** The PR's description as the platform gives it (the review prompt fences it). */
  body: string;
  etags: PrEtags;
  retryAt: string | null;
  /** The list saw it change (or never read its detail): read comments, reviews and checks next. */
  needsDetail: boolean;
  /** Seen for the first time as a new PR: the `opened` event waits for the first detail read (its head). */
  pendingOpened: boolean;
  lastActivityAt: string | null;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function rowToFollow(r: FollowRow): StoredFollow {
  return {
    id: r.id,
    provider: PrProvider.parse(r.provider),
    host: r.host,
    account: r.account,
    kind: PrFollowKind.parse(r.kind),
    owner: r.owner,
    repo: r.repo,
    enabled: r.enabled === 1,
    polledAt: r.polled_at,
    retryAt: r.retry_at,
    syncError: r.sync_error === null ? null : PrSyncError.parse(r.sync_error),
    syncErrorDetail: r.sync_error_detail,
    prCount: r.pr_count,
    createdAt: r.created_at,
    etags: parseJson(r.etags, {}),
  };
}

function rowToPr(r: PrRow): StoredFollowedPr {
  return {
    id: r.id,
    provider: PrProvider.parse(r.provider),
    host: r.host,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    url: r.url,
    title: r.title,
    state: PrState.parse(r.state),
    author: r.author,
    headRef: r.head_ref,
    headSha: r.head_sha,
    headRepo: r.head_repo,
    baseRef: r.base_ref,
    isFork: r.is_fork === 1,
    requestedReviewers: parseJson<string[]>(r.requested_reviewers, []),
    labels: parseJson<string[]>(r.labels, []),
    body: r.body,
    reviewDecision: r.review_decision === null ? null : PrReviewDecision.parse(r.review_decision),
    checksFailed: r.checks_failed,
    checksPending: r.checks_pending,
    checksPassed: r.checks_passed,
    unread: r.unread,
    remoteCreatedAt: r.remote_created_at,
    remoteUpdatedAt: r.remote_updated_at,
    firstSeenAt: r.first_seen_at,
    lastEventAt: r.last_event_at,
    closedAt: r.closed_at,
    syncedAt: r.synced_at,
    syncError: r.sync_error === null ? null : PrSyncError.parse(r.sync_error),
    syncErrorDetail: r.sync_error_detail,
    follows: r.follow_ids ? r.follow_ids.split(" ").filter((s) => s !== "") : [],
    etags: parseJson(r.etags, {}),
    retryAt: r.retry_at,
    needsDetail: r.needs_detail === 1,
    pendingOpened: r.pending_opened === 1,
    lastActivityAt: r.last_activity_at,
  };
}

function rowToEvent(r: EventRow): PrEvent {
  return { id: r.id, followedPrId: r.followed_pr_id, type: PrEventType.parse(r.type), headSha: r.head_sha, actor: r.actor, ref: r.ref, detectedAt: r.detected_at };
}

/** What a list or a detail read learned about a followed PR. */
export type FollowedPrPatch = Partial<
  Pick<
    StoredFollowedPr,
    "title" | "body" | "state" | "author" | "headRef" | "headSha" | "headRepo" | "baseRef" | "isFork" | "requestedReviewers" | "labels" | "reviewDecision" | "remoteCreatedAt" | "remoteUpdatedAt" | "closedAt" | "needsDetail"
  >
>;

export type FollowKey = Pick<PrFollow, "provider" | "host" | "account" | "kind" | "owner" | "repo">;

/** Events kept per PR (the UI shows the newest first). */
const EVENTS_MAX = 200;

export class FollowedPrStore extends PrItemsStore {
  constructor(db: Database.Database) {
    super(db, { prs: "followed_prs", items: "followed_pr_items", checks: "followed_pr_checks" });
    this.db.exec(FOLLOWED_SCHEMA);
    const cols = (this.db.prepare("PRAGMA table_info(followed_prs)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("body")) this.db.exec("ALTER TABLE followed_prs ADD COLUMN body TEXT NOT NULL DEFAULT ''");
  }

  // --- follows -------------------------------------------------------------------------------

  listFollows(): StoredFollow[] {
    return (this.db.prepare(`${FOLLOW_SELECT} ORDER BY f.created_at ASC`).all() as FollowRow[]).map(rowToFollow);
  }

  getFollow(id: string): StoredFollow | null {
    const row = this.db.prepare(`${FOLLOW_SELECT} WHERE f.id = ?`).get(id) as FollowRow | undefined;
    return row ? rowToFollow(row) : null;
  }

  findFollow(key: FollowKey): StoredFollow | null {
    const row = this.db
      .prepare(
        `${FOLLOW_SELECT} WHERE f.provider = ? AND lower(f.host) = lower(?) AND lower(f.account) = lower(?) AND f.kind = ? AND lower(coalesce(f.owner, '')) = lower(?) AND lower(coalesce(f.repo, '')) = lower(?)`,
      )
      .get(key.provider, key.host, key.account, key.kind, key.owner ?? "", key.repo ?? "") as FollowRow | undefined;
    return row ? rowToFollow(row) : null;
  }

  insertFollow(key: FollowKey): StoredFollow {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO pr_follows (id, provider, host, account, kind, owner, repo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, key.provider, key.host, key.account, key.kind, key.owner, key.repo, new Date().toISOString());
    return this.getFollow(id)!;
  }

  setFollowEnabled(id: string, enabled: boolean): StoredFollow | null {
    this.db.prepare("UPDATE pr_follows SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return this.getFollow(id);
  }

  /** Records the outcome of a list poll. */
  setFollowSync(id: string, s: { etags?: StoredFollow["etags"]; error: PrFollow["syncError"]; detail: string | null; retryAt?: string | null; polled?: boolean }): void {
    const sets = ["sync_error = ?", "sync_error_detail = ?", "retry_at = ?"];
    const params: Array<string | null> = [s.error, s.detail, s.retryAt ?? null];
    if (s.etags !== undefined) {
      sets.push("etags = ?");
      params.push(JSON.stringify(s.etags));
    }
    if (s.polled !== false) {
      sets.push("polled_at = ?");
      params.push(new Date().toISOString());
    }
    params.push(id);
    this.db.prepare(`UPDATE pr_follows SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  /** Makes the follow due now (a webhook, "Poll now"). */
  touchFollow(id: string): void {
    this.db.prepare("UPDATE pr_follows SET polled_at = NULL, retry_at = NULL WHERE id = ?").run(id);
  }

  deleteFollow(id: string): boolean {
    return this.db.prepare("DELETE FROM pr_follows WHERE id = ?").run(id).changes > 0;
  }

  // --- followed PRs --------------------------------------------------------------------------

  listPrs(filter: { state?: "open" | "all"; repo?: string } = {}): StoredFollowedPr[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.state !== "all") where.push("p.state IN ('open', 'draft')");
    if (filter.repo) {
      where.push("lower(p.owner || '/' || p.repo) = lower(?)");
      params.push(filter.repo);
    }
    const sql = `${PR_SELECT}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY coalesce(p.remote_updated_at, p.first_seen_at) DESC`;
    return (this.db.prepare(sql).all(...params) as PrRow[]).map(rowToPr);
  }

  /** Open PRs a follow lists (its current members). */
  prsOfFollow(followId: string): StoredFollowedPr[] {
    return (this.db.prepare(`${PR_SELECT} WHERE p.id IN (SELECT followed_pr_id FROM followed_pr_sources WHERE follow_id = ?)`).all(followId) as PrRow[]).map(rowToPr);
  }

  getPr(id: string): StoredFollowedPr | null {
    const row = this.db.prepare(`${PR_SELECT} WHERE p.id = ?`).get(id) as PrRow | undefined;
    return row ? rowToPr(row) : null;
  }

  findPr(ref: PrRef): StoredFollowedPr | null {
    const row = this.db
      .prepare(`${PR_SELECT} WHERE p.provider = ? AND lower(p.host) = lower(?) AND lower(p.owner) = lower(?) AND lower(p.repo) = lower(?) AND p.number = ?`)
      .get(ref.provider, ref.host, ref.owner, ref.repo, ref.number) as PrRow | undefined;
    return row ? rowToPr(row) : null;
  }

  insertPr(ref: PrRef & { url: string }, patch: FollowedPrPatch): StoredFollowedPr {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO followed_prs (id, provider, host, owner, repo, number, url, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, ref.provider, ref.host, ref.owner, ref.repo, ref.number, ref.url, new Date().toISOString());
    this.updatePr(id, patch);
    return this.getPr(id)!;
  }

  updatePr(id: string, patch: FollowedPrPatch): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    const set = (col: string, value: string | number | null): void => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if (patch.title !== undefined) set("title", patch.title);
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.author !== undefined) set("author", patch.author);
    if (patch.headRef !== undefined) set("head_ref", patch.headRef);
    if (patch.headSha !== undefined) set("head_sha", patch.headSha);
    if (patch.headRepo !== undefined) set("head_repo", patch.headRepo);
    if (patch.baseRef !== undefined) set("base_ref", patch.baseRef);
    if (patch.isFork !== undefined) set("is_fork", patch.isFork ? 1 : 0);
    if (patch.requestedReviewers !== undefined) set("requested_reviewers", JSON.stringify(patch.requestedReviewers));
    if (patch.labels !== undefined) set("labels", JSON.stringify(patch.labels));
    if (patch.body !== undefined) set("body", patch.body);
    if (patch.reviewDecision !== undefined) set("review_decision", patch.reviewDecision);
    if (patch.remoteCreatedAt !== undefined) set("remote_created_at", patch.remoteCreatedAt);
    if (patch.remoteUpdatedAt !== undefined) set("remote_updated_at", patch.remoteUpdatedAt);
    if (patch.closedAt !== undefined) set("closed_at", patch.closedAt);
    if (patch.needsDetail !== undefined) set("needs_detail", patch.needsDetail ? 1 : 0);
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE followed_prs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  /** Records the outcome of a detail poll. */
  setPrSync(id: string, s: { etags: PrEtags; error: PrFollow["syncError"]; detail: string | null; retryAt?: string | null }): void {
    this.db
      .prepare("UPDATE followed_prs SET etags = ?, synced_at = ?, sync_error = ?, sync_error_detail = ?, retry_at = ?, needs_detail = ? WHERE id = ?")
      .run(JSON.stringify(s.etags), new Date().toISOString(), s.error, s.detail, s.retryAt ?? null, s.error === null ? 0 : 1, id);
  }

  setPendingOpened(id: string, pending: boolean): void {
    this.db.prepare("UPDATE followed_prs SET pending_opened = ? WHERE id = ?").run(pending ? 1 : 0, id);
  }

  link(prId: string, followId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO followed_pr_sources (followed_pr_id, follow_id) VALUES (?, ?)").run(prId, followId);
  }

  unlink(prId: string, followId: string): void {
    this.db.prepare("DELETE FROM followed_pr_sources WHERE followed_pr_id = ? AND follow_id = ?").run(prId, followId);
  }

  deletePr(id: string): boolean {
    return this.db.prepare("DELETE FROM followed_prs WHERE id = ?").run(id).changes > 0;
  }

  /** Rows no follow lists any more (unlinked, or their follow was deleted) and open: nothing keeps them. */
  orphans(): StoredFollowedPr[] {
    return (this.db.prepare(`${PR_SELECT} WHERE NOT EXISTS (SELECT 1 FROM followed_pr_sources s WHERE s.followed_pr_id = p.id)`).all() as PrRow[]).map(rowToPr);
  }

  /** Merged and closed PRs older than `before` (the page shows them for a while, then they go). */
  purgeClosed(before: string): number {
    return this.db.prepare("DELETE FROM followed_prs WHERE state IN ('merged', 'closed') AND coalesce(closed_at, synced_at, first_seen_at) < ?").run(before).changes;
  }

  // --- events --------------------------------------------------------------------------------

  /** Records an event; `null` when the same (type, head, ref) was already seen on this PR. */
  insertEvent(prId: string, e: { type: PrEvent["type"]; headSha: string; actor: string | null; ref: string | null }): PrEvent | null {
    const id = randomUUID();
    const now = new Date().toISOString();
    const res = this.db
      .prepare("INSERT OR IGNORE INTO pr_events (id, followed_pr_id, type, head_sha, actor, ref, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, prId, e.type, e.headSha, e.actor, e.ref ?? "", now);
    if (res.changes === 0) return null;
    this.db.prepare("UPDATE followed_prs SET last_event_at = ? WHERE id = ?").run(now, prId);
    this.db
      .prepare(`DELETE FROM pr_events WHERE followed_pr_id = ? AND id NOT IN (SELECT id FROM pr_events WHERE followed_pr_id = ? ORDER BY detected_at DESC LIMIT ${EVENTS_MAX})`)
      .run(prId, prId);
    return { id, followedPrId: prId, type: e.type, headSha: e.headSha, actor: e.actor, ref: e.ref, detectedAt: now };
  }

  listEvents(prId: string): PrEvent[] {
    return (this.db.prepare("SELECT * FROM pr_events WHERE followed_pr_id = ? ORDER BY detected_at DESC, rowid DESC").all(prId) as EventRow[]).map(rowToEvent);
  }

  getEvent(id: string): PrEvent | null {
    const row = this.db.prepare("SELECT * FROM pr_events WHERE id = ?").get(id) as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }
}
