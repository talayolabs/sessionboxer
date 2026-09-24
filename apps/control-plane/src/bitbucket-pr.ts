import type { PrReviewDecision, PrRef, PrState, PrSyncError } from "@sessionboxer/protocol";
import { prUrl } from "@sessionboxer/protocol";
import type { GhOutcome, PrMeta } from "./github-pr.js";
import type { PrCheckInput, PrItemInput } from "./pr-store.js";

/**
 * Reads a Pull Request on a Bitbucket Data Center: the PR itself, its activities (comments,
 * approvals, needs-work) and the build statuses on its head commit, shaped like the GitHub side
 * so the store, the notifications and the PR pane do not know the difference. Data Center has no
 * conditional requests worth speaking of, so every poll reads everything (a handful of calls).
 * Bitbucket Cloud (bitbucket.org) is a different API and not supported.
 */
export interface BbTransport {
  /** `path` is relative to `https://host/`, e.g. `rest/api/latest/projects/K/repos/s/pull-requests/12`. */
  request(path: string, query?: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** A transport that calls the Data Center itself with an HTTP access token (the Connector's). */
export function bitbucketTokenTransport(host: string, token: string, fetchImpl: typeof fetch = fetch): BbTransport {
  return {
    async request(path, query) {
      const url = new URL(`https://${host}/${path}`);
      for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
      const res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "sessionboxer" },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      return { status: res.status, headers, body: await res.text() };
    },
  };
}

interface BbUser {
  name: string;
  slug?: string;
  displayName?: string;
}

interface BbRef {
  id: string;
  displayId: string;
  latestCommit?: string;
  repository: { slug: string; project: { key: string } };
}

interface BbParticipant {
  user: BbUser;
  approved: boolean;
  status: "UNAPPROVED" | "NEEDS_WORK" | "APPROVED";
}

interface BbPr {
  id: number;
  version: number;
  title: string;
  state: "OPEN" | "MERGED" | "DECLINED";
  draft?: boolean;
  closedDate?: number;
  updatedDate: number;
  fromRef: BbRef;
  toRef: BbRef;
  author: BbParticipant;
  reviewers: BbParticipant[];
}

interface BbAnchor {
  path?: string;
  line?: number;
  orphaned?: boolean;
}

interface BbComment {
  id: number;
  text: string;
  author: BbUser;
  createdDate: number;
  updatedDate?: number;
  severity?: "NORMAL" | "BLOCKER";
  state?: "OPEN" | "RESOLVED" | "PENDING";
  threadResolved?: boolean;
  anchor?: BbAnchor;
  comments?: BbComment[];
}

interface BbActivity {
  id: number;
  createdDate: number;
  user: BbUser;
  action: string;
  commentAction?: "ADDED" | "REPLIED" | "UPDATED" | "DELETED";
  comment?: BbComment;
  commentAnchor?: BbAnchor;
}

interface BbBuildStatus {
  key: string;
  name?: string;
  state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "CANCELLED" | "UNKNOWN";
  url?: string;
  description?: string;
  dateAdded?: number;
  duration?: number;
  buildNumber?: string;
  parent?: string;
  testResults?: { failed?: number; successful?: number; skipped?: number };
}

interface BbRefMatcher {
  id: string;
  type: { id: string };
}

interface BbRequiredBuild {
  buildParentKeys: string[];
  refMatcher: BbRefMatcher;
  exemptRefMatcher?: BbRefMatcher | null;
}

interface BbPage<T> {
  values: T[];
  isLastPage: boolean;
  nextPageStart?: number;
}

/** What one poll of the PR itself learns, beyond the shared metadata. */
export interface BbPrInfo {
  meta: PrMeta;
  reviewDecision: PrReviewDecision | null;
  headSha: string | null;
  /** `refs/heads/main`: what the required-builds merge checks match against. */
  targetRefId: string;
}

function prPath(ref: PrRef): string {
  return `rest/api/latest/projects/${encodeURIComponent(ref.owner)}/repos/${encodeURIComponent(ref.repo)}/pull-requests/${ref.number}`;
}

function repoPath(ref: PrRef): string {
  return `projects/${encodeURIComponent(ref.owner)}/repos/${encodeURIComponent(ref.repo)}`;
}

export async function fetchBbPr(t: BbTransport, ref: PrRef): Promise<GhOutcome<BbPrInfo>> {
  const r = await getJson<BbPr>(t, prPath(ref));
  if (r.status !== "ok") return r;
  const pr = r.value;
  const decision: PrReviewDecision | null = pr.reviewers.some((p) => p.status === "NEEDS_WORK")
    ? "changes_requested"
    : pr.reviewers.some((p) => p.approved)
      ? "approved"
      : pr.reviewers.length > 0
        ? "review_required"
        : null;
  return {
    status: "ok",
    etag: null,
    remaining: null,
    value: {
      meta: {
        title: pr.title,
        state: pr.state === "MERGED" ? "merged" : pr.state === "DECLINED" ? "closed" : pr.draft ? "draft" : "open",
        headRef: pr.fromRef.displayId,
        headRepo: `${pr.fromRef.repository.project.key}/${pr.fromRef.repository.slug}`,
        baseRef: pr.toRef.displayId,
        author: pr.author.user.name,
        closedAt: pr.closedDate ? iso(pr.closedDate) : null,
      },
      reviewDecision: decision,
      headSha: pr.fromRef.latestCommit ?? null,
      targetRefId: pr.toRef.id,
    },
  };
}

/**
 * The PR's activities as items: each comment thread flattened (root and replies share the root's
 * id as `threadId`; anchored ones are `review_comment`s, the others `issue_comment`s), each
 * approval / needs-work a `review`. Activities come newest first and a comment shows up in
 * several of them (its own ADDED, nested under its root, again on UPDATED / REPLIED), so they
 * are read oldest first and a comment counts once, where its thread is known.
 */
export async function fetchBbActivities(t: BbTransport, ref: PrRef, self: string | null, itemId: (kind: PrItemInput["kind"], id: number) => string): Promise<GhOutcome<PrItemInput[]>> {
  const r = await getAll<BbActivity>(t, `${prPath(ref)}/activities`);
  if (r.status !== "ok") return r;
  const page = prUrl(ref);
  const out: PrItemInput[] = [];
  const seen = new Set<number>();
  for (const a of r.value) if (a.action === "COMMENTED" && a.commentAction === "DELETED" && a.comment) seen.add(a.comment.id);
  for (const a of [...r.value].reverse()) {
    if (a.action === "COMMENTED" && a.comment) {
      if (a.commentAction === "DELETED") continue;
      const root = a.comment;
      const anchor = root.anchor ?? a.commentAnchor;
      const kind: PrItemInput["kind"] = anchor?.path ? "review_comment" : "issue_comment";
      const threadId = itemId(kind, root.id);
      const resolved = root.threadResolved === true || root.state === "RESOLVED";
      const walk = (c: BbComment, parent: BbComment | null): void => {
        if (seen.has(c.id)) {
          for (const reply of c.comments ?? []) walk(reply, c);
          return;
        }
        seen.add(c.id);
        out.push({
          kind,
          githubId: c.id,
          nodeId: String(c.id),
          threadId,
          threadNodeId: null,
          inReplyTo: parent ? parent.id : null,
          author: c.author.name,
          self: isSelf(c.author, self),
          body: (c.severity === "BLOCKER" && !parent ? "**Task** — " : "") + c.text,
          path: anchor?.path ?? null,
          line: anchor?.line ?? null,
          diffHunk: null,
          htmlUrl: `${page}/overview?commentId=${c.id}`,
          reviewState: null,
          resolved,
          outdated: anchor?.orphaned === true,
          createdAt: iso(c.createdDate),
          updatedAt: iso(c.updatedDate ?? c.createdDate),
        });
        for (const reply of c.comments ?? []) walk(reply, c);
      };
      walk(root, null);
      continue;
    }
    const reviewState = a.action === "APPROVED" ? "APPROVED" : a.action === "REVIEWED" ? "CHANGES_REQUESTED" : null;
    if (reviewState === null) continue;
    out.push({
      kind: "review",
      githubId: a.id,
      nodeId: `activity:${a.id}`,
      threadId: null,
      threadNodeId: null,
      inReplyTo: null,
      author: a.user.name,
      self: isSelf(a.user, self),
      body: "",
      path: null,
      line: null,
      diffHunk: null,
      htmlUrl: `${page}/overview`,
      reviewState,
      resolved: false,
      outdated: false,
      createdAt: iso(a.createdDate),
      updatedAt: iso(a.createdDate),
    });
  }
  return { status: "ok", etag: null, remaining: null, value: out };
}

const SUMMARY_MAX = 4000;

/**
 * The build statuses on `headSha` as checks (`kind: "build"`), the newest per key. A build is
 * `required` when a required-builds merge check on the target branch names its parent key.
 */
export async function fetchBbBuilds(t: BbTransport, ref: PrRef, headSha: string, targetRefId: string): Promise<GhOutcome<PrCheckInput[]>> {
  // Build statuses hang off the commit, not the repository (`…/repos/…/commits/{sha}/builds` only
  // reads one status by key), so this is the list; a commit no server knows is an empty page.
  const r = await getAll<BbBuildStatus>(t, `rest/build-status/latest/commits/${headSha}`);
  if (r.status !== "ok") return r;
  const newest = new Map<string, BbBuildStatus>();
  for (const b of r.value) {
    const prev = newest.get(b.key);
    if (!prev || (b.dateAdded ?? 0) > (prev.dateAdded ?? 0)) newest.set(b.key, b);
  }
  const required = newest.size > 0 ? await requiredParentKeys(t, ref, targetRefId) : new Set<string>();
  return { status: "ok", etag: null, remaining: null, value: [...newest.values()].map((b) => buildToCheck(b, required)) };
}

function buildToCheck(b: BbBuildStatus, required: Set<string>): PrCheckInput {
  const state = b.state === "SUCCESSFUL" ? "passed" : b.state === "FAILED" || b.state === "CANCELLED" ? "failed" : "pending";
  const final = state !== "pending";
  const name = b.name && b.name.trim() !== "" ? b.name : b.key;
  const parts: string[] = [];
  if (b.description && b.description.trim() !== "") parts.push(b.description.trim());
  if (b.testResults) {
    const { failed = 0, successful = 0, skipped = 0 } = b.testResults;
    parts.push(`tests: ${failed} failed, ${successful} passed, ${skipped} skipped`);
  }
  const summary = parts.join("\n\n");
  const started = b.dateAdded ? iso(b.dateAdded) : null;
  const parent = b.parent ?? b.key;
  return {
    name,
    kind: "build",
    source: parent === name ? null : parent,
    state,
    conclusion: final ? b.state.toLowerCase() : null,
    required: required.has(parent) || required.has(b.key),
    url: b.url && b.url.trim() !== "" ? b.url : null,
    githubId: null,
    summary: summary === "" ? null : summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX)}…` : summary,
    startedAt: started,
    completedAt: final ? (b.dateAdded ? iso(b.dateAdded + (b.duration ?? 0)) : null) : null,
  };
}

/** Parent keys the required-builds merge checks demand green on `targetRefId`; empty when the feature is off or unreadable. */
async function requiredParentKeys(t: BbTransport, ref: PrRef, targetRefId: string): Promise<Set<string>> {
  const r = await getAll<BbRequiredBuild>(t, `rest/required-builds/latest/${repoPath(ref)}/conditions`);
  const keys = new Set<string>();
  if (r.status !== "ok") return keys;
  for (const c of r.value) {
    if (!refMatches(c.refMatcher, targetRefId)) continue;
    if (c.exemptRefMatcher && refMatches(c.exemptRefMatcher, targetRefId)) continue;
    for (const k of c.buildParentKeys) keys.add(k);
  }
  return keys;
}

function refMatches(m: BbRefMatcher, refId: string): boolean {
  switch (m.type.id) {
    case "ANY_REF":
      return true;
    case "BRANCH":
      return m.id === refId || m.id === refId.replace(/^refs\/heads\//, "");
    case "PATTERN": {
      const pattern = m.id.startsWith("refs/") ? m.id : `refs/heads/${m.id}`;
      const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".")}$`);
      return re.test(refId);
    }
    default:
      // Branching-model matchers need the model; better to under-report than to flag every build required.
      return false;
  }
}

// --- HTTP ----------------------------------------------------------------------------------

async function getJson<T>(t: BbTransport, path: string, query?: Record<string, string>): Promise<GhOutcome<T>> {
  let res: { status: number; headers: Record<string, string>; body: string };
  try {
    res = await t.request(path, query);
  } catch (e) {
    return { status: "error", kind: "error", detail: describeNetworkError(e), retryAt: null };
  }
  if (res.status !== 200) return classify(res);
  try {
    return { status: "ok", value: JSON.parse(res.body) as T, etag: null, remaining: null };
  } catch {
    return { status: "error", kind: "error", detail: "the server did not answer with JSON; is this a Bitbucket Data Center?", retryAt: null };
  }
}

/** Follows Data Center's `start`/`nextPageStart` paging (capped, like GitHub's Link pages). */
async function getAll<T>(t: BbTransport, path: string): Promise<GhOutcome<T[]>> {
  const all: T[] = [];
  let start = 0;
  for (let pages = 0; pages < 10; pages++) {
    const r = await getJson<BbPage<T>>(t, path, { limit: "100", start: String(start) });
    if (r.status !== "ok") return r;
    all.push(...(r.value.values ?? []));
    if (r.value.isLastPage !== false || r.value.nextPageStart === undefined) break;
    start = r.value.nextPageStart;
  }
  return { status: "ok", value: all, etag: null, remaining: null };
}

function classify(res: { status: number; headers: Record<string, string>; body: string }): { status: "error"; kind: PrSyncError; detail: string; retryAt: string | null } {
  const detail = message(res.body) ?? `HTTP ${res.status}`;
  if (res.status === 404) return { status: "error", kind: "not_found", detail, retryAt: null };
  if (res.status === 401 || res.status === 403) return { status: "error", kind: "unauthorized", detail, retryAt: null };
  if (res.status === 429) {
    const retryAfter = Number(res.headers["retry-after"]);
    const at = new Date(Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000));
    return { status: "error", kind: "rate_limited", detail, retryAt: at.toISOString() };
  }
  const retryAt = res.status >= 500 ? new Date(Date.now() + 5 * 60_000).toISOString() : null;
  return { status: "error", kind: "error", detail, retryAt };
}

/** Data Center errors come as `{ errors: [{ message }] }`. */
function message(body: string): string | null {
  try {
    const v = JSON.parse(body) as { errors?: Array<{ message?: unknown }> };
    const msgs = (v.errors ?? []).map((e) => e.message).filter((m): m is string => typeof m === "string");
    return msgs.length > 0 ? msgs.join("; ") : null;
  } catch {
    return null;
  }
}

function describeNetworkError(e: unknown): string {
  if (e instanceof Error && e.name === "TimeoutError") return `no answer within ${REQUEST_TIMEOUT_MS / 1000} s (VPN off?)`;
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    const code = (cur as Error & { code?: unknown }).code;
    if (typeof code === "string") {
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return `TLS certificate not trusted (${code}); add the CA under Settings → TLS certificates`;
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host name not found";
      return code;
    }
    cur = cur.cause;
  }
  return e instanceof Error ? e.message : String(e);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isSelf(user: BbUser, self: string | null): boolean {
  if (!self) return false;
  const s = self.toLowerCase();
  return user.name.toLowerCase() === s || (user.slug ?? "").toLowerCase() === s;
}
