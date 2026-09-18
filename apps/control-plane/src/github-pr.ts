import type { DaemonGhApiParams, DaemonGhApiResult, PrReviewDecision, PrState, PrSyncError } from "@sessionboxer/protocol";
import type { PrItemInput } from "./pr-store.js";

/**
 * Makes GitHub REST/GraphQL requests: through the Sandbox Daemon (`gh api` in the box, the
 * normal path) or straight from the Control Plane with a Connector token (stopped boxes).
 */
export interface GhTransport {
  request(p: DaemonGhApiParams): Promise<DaemonGhApiResult>;
}

/** A transport that calls `api.github.com` itself with a token. */
export function tokenTransport(token: string): GhTransport {
  return {
    async request(p) {
      const res = await fetch(`https://api.github.com/${p.path}`, {
        method: p.method,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${token}`,
          "user-agent": "sessionboxer",
          ...(p.body !== null ? { "content-type": "application/json" } : {}),
          ...p.headers,
        },
        body: p.body ?? undefined,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      return { status: res.status, headers, body: await res.text() };
    },
  };
}

export type GhOutcome<T> =
  | { status: "ok"; value: T; etag: string | null; remaining: number | null }
  | { status: "unchanged"; remaining: number | null }
  | { status: "error"; kind: PrSyncError; detail: string; retryAt: string | null };

export interface PrMeta {
  title: string;
  state: PrState;
  headRef: string;
  headRepo: string;
  baseRef: string;
  author: string;
  closedAt: string | null;
}

interface RestPr {
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  merged_at: string | null;
  closed_at: string | null;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string };
  user: { login: string } | null;
}

interface RestIssueComment {
  id: number;
  node_id: string;
  user: { login: string } | null;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

interface RestReviewComment extends RestIssueComment {
  path: string;
  line: number | null;
  original_line: number | null;
  diff_hunk: string;
  in_reply_to_id?: number;
  pull_request_review_id: number | null;
}

interface RestReview {
  id: number;
  node_id: string;
  user: { login: string } | null;
  body: string | null;
  state: string;
  html_url: string;
  submitted_at?: string;
}

export interface ThreadInfo {
  reviewDecision: PrReviewDecision | null;
  threads: Array<{ nodeId: string; commentIds: number[]; resolved: boolean; outdated: boolean }>;
}

export async function fetchPrMeta(t: GhTransport, ref: PrRef, etag: string | undefined, account: string | null): Promise<GhOutcome<PrMeta>> {
  const r = await conditional(t, `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, etag, account);
  if (r.status !== "ok") return r;
  const pr = JSON.parse(r.value) as RestPr;
  return {
    ...r,
    value: {
      title: pr.title,
      state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open",
      headRef: pr.head.ref,
      headRepo: pr.head.repo?.full_name ?? `${ref.owner}/${ref.repo}`,
      baseRef: pr.base.ref,
      author: pr.user?.login ?? "ghost",
      closedAt: pr.closed_at,
    },
  };
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** Conversation-tab comments (`issues/:n/comments`). */
export async function fetchIssueComments(t: GhTransport, ref: PrRef, etag: string | undefined, account: string | null, self: string | null): Promise<GhOutcome<PrItemInput[]>> {
  const r = await conditionalList(t, `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`, etag, account);
  if (r.status !== "ok") return r;
  const items = (r.value as RestIssueComment[]).map<PrItemInput>((c) => ({
    kind: "issue_comment",
    githubId: c.id,
    nodeId: c.node_id,
    threadId: null,
    threadNodeId: null,
    inReplyTo: null,
    author: c.user?.login ?? "ghost",
    self: isSelf(c.user?.login, self),
    body: c.body ?? "",
    path: null,
    line: null,
    diffHunk: null,
    htmlUrl: c.html_url,
    reviewState: null,
    resolved: false,
    outdated: false,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  }));
  return { ...r, value: items };
}

/** Inline review comments (`pulls/:n/comments`); `threadId` from `in_reply_to_id` until GraphQL refines it. */
export async function fetchReviewComments(t: GhTransport, ref: PrRef, etag: string | undefined, account: string | null, self: string | null, itemId: (kind: "review_comment", id: number) => string): Promise<GhOutcome<PrItemInput[]>> {
  const r = await conditionalList(t, `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments?per_page=100`, etag, account);
  if (r.status !== "ok") return r;
  const items = (r.value as RestReviewComment[]).map<PrItemInput>((c) => ({
    kind: "review_comment",
    githubId: c.id,
    nodeId: c.node_id,
    threadId: itemId("review_comment", c.in_reply_to_id ?? c.id),
    threadNodeId: null,
    inReplyTo: c.in_reply_to_id ?? null,
    author: c.user?.login ?? "ghost",
    self: isSelf(c.user?.login, self),
    body: c.body ?? "",
    path: c.path,
    line: c.line ?? null,
    diffHunk: c.diff_hunk,
    htmlUrl: c.html_url,
    reviewState: null,
    resolved: false,
    outdated: c.line === null && c.original_line !== null,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  }));
  return { ...r, value: items };
}

/** Submitted reviews; `COMMENTED` ones without a body are only containers for inline comments and are skipped. */
export async function fetchReviews(t: GhTransport, ref: PrRef, etag: string | undefined, account: string | null, self: string | null): Promise<GhOutcome<PrItemInput[]>> {
  const r = await conditionalList(t, `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`, etag, account);
  if (r.status !== "ok") return r;
  const items = (r.value as RestReview[])
    .filter((rv) => rv.state !== "PENDING" && !(rv.state === "COMMENTED" && !rv.body?.trim()))
    .map<PrItemInput>((rv) => ({
      kind: "review",
      githubId: rv.id,
      nodeId: rv.node_id,
      threadId: null,
      threadNodeId: null,
      inReplyTo: null,
      author: rv.user?.login ?? "ghost",
      self: isSelf(rv.user?.login, self),
      body: rv.body ?? "",
      path: null,
      line: null,
      diffHunk: null,
      htmlUrl: rv.html_url,
      reviewState: rv.state,
      resolved: false,
      outdated: false,
      createdAt: rv.submitted_at ?? new Date(0).toISOString(),
      updatedAt: rv.submitted_at ?? new Date(0).toISOString(),
    }));
  return { ...r, value: items };
}

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewDecision
    reviewThreads(first: 100) { nodes { id isResolved isOutdated comments(first: 100) { nodes { databaseId } } } }
  } } }`;

interface ThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewDecision: string | null;
        reviewThreads: { nodes: Array<{ id: string; isResolved: boolean; isOutdated: boolean; comments: { nodes: Array<{ databaseId: number | null }> } }> };
      } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

/** Review-thread resolution and the review decision, which REST does not expose. */
export async function fetchThreads(t: GhTransport, ref: PrRef, account: string | null): Promise<GhOutcome<ThreadInfo>> {
  let res: DaemonGhApiResult;
  try {
    res = await t.request({
      method: "POST",
      path: "graphql",
      headers: {},
      body: JSON.stringify({ query: THREADS_QUERY, variables: ref }),
      account,
    });
  } catch (e) {
    return { status: "error", kind: "error", detail: e instanceof Error ? e.message : String(e), retryAt: null };
  }
  const remaining = rateRemaining(res.headers);
  if (res.status !== 200) return classify(res);
  const parsed = JSON.parse(res.body) as ThreadsResponse;
  const pr = parsed.data?.repository?.pullRequest;
  if (!pr) {
    const msg = parsed.errors?.map((e) => e.message).join("; ") ?? "no pull request in the reply";
    const kind: PrSyncError = /not resolve|could not be found|NOT_FOUND/i.test(msg) ? "not_found" : "error";
    return { status: "error", kind, detail: msg, retryAt: null };
  }
  const decision = pr.reviewDecision === "APPROVED" ? "approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested" : pr.reviewDecision === "REVIEW_REQUIRED" ? "review_required" : null;
  return {
    status: "ok",
    etag: null,
    remaining,
    value: {
      reviewDecision: decision,
      threads: pr.reviewThreads.nodes.map((n) => ({
        nodeId: n.id,
        commentIds: n.comments.nodes.map((c) => c.databaseId).filter((id): id is number => id !== null),
        resolved: n.isResolved,
        outdated: n.isOutdated,
      })),
    },
  };
}

type Conditional = GhOutcome<string> & { link?: string | null };

async function conditional(t: GhTransport, path: string, etag: string | undefined, account: string | null): Promise<Conditional> {
  let res: DaemonGhApiResult;
  try {
    res = await t.request({ method: "GET", path, headers: etag ? { "If-None-Match": etag } : {}, body: null, account });
  } catch (e) {
    return { status: "error", kind: "error", detail: e instanceof Error ? e.message : String(e), retryAt: null };
  }
  const remaining = rateRemaining(res.headers);
  if (res.status === 304) return { status: "unchanged", remaining };
  if (res.status !== 200) return classify(res);
  return { status: "ok", value: res.body, etag: res.headers.etag ?? null, remaining, link: res.headers.link ?? null };
}

/** Like `conditional` for list endpoints: follows `Link: rel="next"` pages when the first one changed. */
async function conditionalList(t: GhTransport, path: string, etag: string | undefined, account: string | null): Promise<GhOutcome<unknown[]>> {
  const first = await conditional(t, path, etag, account);
  if (first.status !== "ok") return first;
  const all: unknown[] = JSON.parse(first.value) as unknown[];
  let next = linkNext(first.link ?? undefined);
  let pages = 1;
  while (next && pages < 10) {
    let res: DaemonGhApiResult;
    try {
      res = await t.request({ method: "GET", path: next, headers: {}, body: null, account });
    } catch (e) {
      return { status: "error", kind: "error", detail: e instanceof Error ? e.message : String(e), retryAt: null };
    }
    if (res.status !== 200) return classify(res);
    all.push(...(JSON.parse(res.body) as unknown[]));
    next = linkNext(res.headers.link);
    pages++;
  }
  return { status: "ok", value: all, etag: first.etag, remaining: first.remaining };
}

function linkNext(link: string | undefined): string | null {
  if (!link) return null;
  const m = /<([^>]+)>;\s*rel="next"/.exec(link);
  if (!m) return null;
  const u = new URL(m[1]!);
  return `${u.pathname.slice(1)}${u.search}`;
}

function classify(res: DaemonGhApiResult): GhOutcome<never> {
  const detail = message(res.body) ?? `HTTP ${res.status}`;
  if (res.status === 404 || res.status === 410) return { status: "error", kind: "not_found", detail, retryAt: null };
  if (res.status === 401) return { status: "error", kind: "unauthorized", detail, retryAt: null };
  if (res.status === 403 || res.status === 429) {
    const retryAfter = res.headers["retry-after"];
    const reset = res.headers["x-ratelimit-reset"];
    const remaining = rateRemaining(res.headers);
    if (retryAfter || remaining === 0 || /rate limit/i.test(detail)) {
      const at = retryAfter ? new Date(Date.now() + Number(retryAfter) * 1000) : reset ? new Date(Number(reset) * 1000) : new Date(Date.now() + 60_000);
      return { status: "error", kind: "rate_limited", detail, retryAt: at.toISOString() };
    }
    return { status: "error", kind: "unauthorized", detail, retryAt: null };
  }
  const retryAt = res.status >= 500 ? new Date(Date.now() + 5 * 60_000).toISOString() : null;
  return { status: "error", kind: "error", detail, retryAt };
}

function message(body: string): string | null {
  try {
    const v = JSON.parse(body) as { message?: unknown };
    return typeof v.message === "string" ? v.message : null;
  } catch {
    return null;
  }
}

function rateRemaining(headers: Record<string, string>): number | null {
  const v = headers["x-ratelimit-remaining"];
  return v === undefined ? null : Number(v);
}

function isSelf(login: string | undefined, self: string | null): boolean {
  return !!login && !!self && login.toLowerCase() === self.toLowerCase();
}
