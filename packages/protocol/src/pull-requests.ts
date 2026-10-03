// ---------------------------------------------------------------------------
// Pull Requests attached to a Session. The Control Plane stores them and polls the provider for
// comments/reviews/checks: GitHub through the Sandbox (`gh api`, Daemon `gh/api`) so the box's own
// login decides what can be seen (a Connector token while it is stopped); Bitbucket Data Center
// directly from the Control Plane with the Bitbucket Connector's token (ADR-0051).
// ---------------------------------------------------------------------------

import { z } from "zod";

/** Where a Pull Request lives: github.com, or a Bitbucket Data Center (self-hosted). */
export const PrProvider = z.enum(["github", "bitbucket"]);
export type PrProvider = z.infer<typeof PrProvider>;
export const PR_PROVIDER_LABEL: Record<PrProvider, string> = { github: "GitHub", bitbucket: "Bitbucket" };

export const PrState = z.enum(["open", "draft", "closed", "merged"]);
export type PrState = z.infer<typeof PrState>;

export const PrReviewDecision = z.enum(["approved", "changes_requested", "review_required"]);
export type PrReviewDecision = z.infer<typeof PrReviewDecision>;

/** How a Pull Request got attached to the Session. */
export const PrAttachedBy = z.enum(["prompt", "agent", "manual"]);
export type PrAttachedBy = z.infer<typeof PrAttachedBy>;

/** Why the last poll of a Pull Request did not succeed. */
export const PrSyncError = z.enum(["unauthorized", "not_found", "rate_limited", "box_stopped", "error"]);
export type PrSyncError = z.infer<typeof PrSyncError>;

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export const MergeMethod = z.enum(MERGE_METHODS);
export type MergeMethod = z.infer<typeof MergeMethod>;

/** GitHub's `mergeStateStatus`, lower-cased. */
export const PrMergeStatus = z.enum(["clean", "unstable", "blocked", "behind", "dirty", "draft", "has_hooks", "unknown"]);
export type PrMergeStatus = z.infer<typeof PrMergeStatus>;

/** One commit status or check run on the PR's head. */
export const PrCheck = z.object({
  name: z.string(),
  /** `pending` until it finishes; a check that is skipped or neutral counts as `passed`. */
  state: z.enum(["pending", "passed", "failed"]),
  /** Branch protection requires it before merging. */
  required: z.boolean(),
  url: z.string().nullable(),
});
export type PrCheck = z.infer<typeof PrCheck>;

/**
 * What the auto-merge watcher last saw (every 10 s while it is on and the PR is open). `merged`
 * is set once *it* merged the PR; `error` when GitHub refused the merge or could not be asked.
 */
export const PrMergeState = z.object({
  checkedAt: z.string(),
  status: PrMergeStatus,
  /** GitHub's own conflict verdict (`null` while it is still computing). */
  mergeable: z.boolean().nullable(),
  headSha: z.string(),
  checks: z.array(PrCheck),
  error: z.string().nullable(),
  merged: z.boolean(),
});
export type PrMergeState = z.infer<typeof PrMergeState>;

/** One line of a `pr_merged` notification. */
export const PrMergedNotice = z.object({
  prId: z.string(),
  url: z.string(),
  title: z.string(),
  number: z.number().int(),
  method: MergeMethod,
});
export type PrMergedNotice = z.infer<typeof PrMergedNotice>;

export const PullRequest = z.object({
  id: z.string(),
  sessionId: z.string(),
  provider: PrProvider.default("github"),
  /** `github.com`, or the Bitbucket Data Center host. */
  host: z.string().default("github.com"),
  /** GitHub: owner and repository; Bitbucket: project key and repository slug. */
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  state: PrState,
  headRef: z.string(),
  /** `owner/repo` of the head branch (differs from `owner/repo` for forks). */
  headRepo: z.string(),
  baseRef: z.string(),
  author: z.string(),
  reviewDecision: PrReviewDecision.nullable(),
  attachedBy: PrAttachedBy,
  attachedAt: z.string(),
  /** Newest comment/review seen on GitHub. */
  lastActivityAt: z.string().nullable(),
  /** Items the user has not looked at yet (cleared when the PR's pane is shown). */
  unread: z.number().int().nonnegative(),
  /** Review threads still unresolved. */
  openThreads: z.number().int().nonnegative(),
  /** Checks on the current head: failed / still running / passed. */
  checksFailed: z.number().int().nonnegative(),
  checksPending: z.number().int().nonnegative(),
  checksPassed: z.number().int().nonnegative(),
  /** The login the PR is read with (the Sandbox's `gh` login, or a Connector's account); `null` until one worked. Never a token. */
  viaAccount: z.string().nullable(),
  /** Still being polled (closed/merged PRs stop after a while; the user can pause too). */
  watch: z.boolean(),
  syncedAt: z.string().nullable(),
  syncError: PrSyncError.nullable(),
  syncErrorDetail: z.string().nullable(),
  /** The PR's repo is the Workspace's origin, so it can be addressed locally. */
  local: z.boolean(),
  /** Merge it as soon as GitHub says it can be (checks green, reviews in, no conflicts). GitHub only. */
  autoMerge: z.boolean(),
  mergeMethod: MergeMethod,
  mergeState: PrMergeState.nullable(),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const PrItemKind = z.enum(["issue_comment", "review_comment", "review"]);
export type PrItemKind = z.infer<typeof PrItemKind>;

/** What has been done about an item from this Session. */
export const PrAddressState = z.enum(["none", "in_prompt", "addressing", "addressed"]);
export type PrAddressState = z.infer<typeof PrAddressState>;

/**
 * One comment or review of a Pull Request. Inline review comments of one thread share `threadId`
 * (the root comment's id); the root has `inReplyTo: null`. Bitbucket: a general comment is an
 * `issue_comment`, one anchored to a file a `review_comment`, an approval / needs-work a `review`.
 */
export const PrItem = z.object({
  id: z.string(),
  prId: z.string(),
  kind: PrItemKind,
  /** The provider's numeric id of the comment / review (Bitbucket: comment or activity id). */
  githubId: z.number().int(),
  /** GitHub's node id; Bitbucket: the numeric id as a string. */
  nodeId: z.string(),
  threadId: z.string().nullable(),
  /** GraphQL id of the review thread (`PRRT_…`), what `resolveReviewThread` takes. */
  threadNodeId: z.string().nullable(),
  inReplyTo: z.number().int().nullable(),
  author: z.string(),
  /** Written by the login the PR is watched with (i.e. by this Sandbox / the user). */
  self: z.boolean(),
  body: z.string(),
  /** Inline review comments: file and line (`line` is `null` for outdated positions). */
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  diffHunk: z.string().nullable(),
  htmlUrl: z.string(),
  /** Reviews: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`. */
  reviewState: z.string().nullable(),
  /** Review-comment threads: resolved on GitHub / left behind by a later push. */
  resolved: z.boolean(),
  outdated: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  seen: z.boolean(),
  address: PrAddressState,
});
export type PrItem = z.infer<typeof PrItem>;

export const PrCheckState = z.enum(["pending", "passed", "failed"]);
export type PrCheckState = z.infer<typeof PrCheckState>;

/**
 * One check run (GitHub Actions job, an app's check), commit status, or Bitbucket build status on
 * the PR's head, followed across pushes by name: a new head replaces the row's state rather than
 * adding a row.
 */
export const PrCheckItem = z.object({
  id: z.string(),
  prId: z.string(),
  name: z.string(),
  kind: z.enum(["check_run", "status", "build"]),
  /** The workflow (GitHub Actions) or app that runs it, when GitHub says; Bitbucket: the build key / plan. */
  source: z.string().nullable(),
  state: PrCheckState,
  /** Check runs: GitHub's conclusion (`failure`, `timed_out`, `cancelled`, `action_required`, …); statuses: `error` / `failure`; builds: `failed` / `cancelled`. */
  conclusion: z.string().nullable(),
  /** Branch protection (GitHub) / a required-builds merge check (Bitbucket) requires it before merging. */
  required: z.boolean(),
  /** Where the log / details are (an Actions job page, the CI's own page). */
  url: z.string().nullable(),
  /** Check runs: GitHub's id (`gh api repos/{o}/{r}/check-runs/{id}`). */
  githubId: z.number().int().nullable(),
  headSha: z.string(),
  /** Check runs: title and summary the check reported (cut short); statuses: the description. */
  summary: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  seen: z.boolean(),
  address: PrAddressState,
});
export type PrCheckItem = z.infer<typeof PrCheckItem>;

/** One line of a `pr_activity` notification. */
export const PrActivity = z.object({
  prId: z.string(),
  url: z.string(),
  title: z.string(),
  number: z.number().int(),
  /** Items new since the last notification. */
  count: z.number().int().nonnegative(),
  /** Authors of those items. */
  authors: z.array(z.string()),
  /** Set when one of them is a `CHANGES_REQUESTED` review. */
  changesRequested: z.boolean(),
  /** Names of checks that failed since the last notification. */
  failedChecks: z.array(z.string()).default([]),
});
export type PrActivity = z.infer<typeof PrActivity>;

/** `POST /api/sessions/:id/prs`: a github.com / Bitbucket Data Center PR URL, `owner/repo#12`, or `#12` / `12` for the Workspace's repo. */
export const AttachPrRequest = z.object({ ref: z.string().min(1) });
export type AttachPrRequest = z.infer<typeof AttachPrRequest>;

export const UpdatePrRequest = z.object({
  watch: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
  mergeMethod: MergeMethod.optional(),
});
export type UpdatePrRequest = z.infer<typeof UpdatePrRequest>;

/**
 * What to do with comments/reviews, one or many (possibly from several PRs of the Session):
 * - `prompt`: build the prompt text and hand it back for the composer (nothing is sent).
 * - `address`: send it to the Agent (queued when a turn is running): change the code, no GitHub replies.
 * - `address_reply`: same, plus reply on GitHub per thread and resolve the threads it addressed.
 */
export const PrAction = z.enum(["prompt", "address", "address_reply"]);
export type PrAction = z.infer<typeof PrAction>;

export const PrActionRequest = z
  .object({
    action: PrAction,
    /** Comments / reviews. */
    itemIds: z.array(z.string()).default([]),
    /** Failed checks: the Agent reads their logs and fixes the cause. */
    checkIds: z.array(z.string()).default([]),
  })
  .refine((r) => r.itemIds.length + r.checkIds.length > 0, { message: "Pick at least one comment or check." });
export type PrActionRequest = z.infer<typeof PrActionRequest>;

export const PrActionResult = z.object({
  /** The prompt built from the items. */
  text: z.string(),
  /** `address*`: `sent` now, or `queued` behind the running turn. `prompt`: `none`. */
  delivery: z.enum(["none", "sent", "queued"]),
});
export type PrActionResult = z.infer<typeof PrActionResult>;

/** Which Pull Request: provider, host, repository coordinates and number. */
export interface PrRef {
  provider: PrProvider;
  host: string;
  owner: string;
  repo: string;
  number: number;
}

const GITHUB_PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#]|$)/;
/** Data Center: `https://host[/context]/projects/KEY/repos/slug/pull-requests/12[/overview…]`. */
const BITBUCKET_PR_URL = /^https?:\/\/([^/\s:@]+(?::\d+)?)(?:\/[^\s?#]*?)?\/projects\/([^/\s?#]+)\/repos\/([^/\s?#]+)\/pull-requests\/(\d+)(?:[/?#]|$)/;

/** Parses a github.com or Bitbucket Data Center Pull Request URL (bitbucket.org is Bitbucket Cloud: not supported). */
export function parsePrUrl(url: string): PrRef | null {
  const s = url.trim();
  const gh = GITHUB_PR_URL.exec(s);
  if (gh) return { provider: "github", host: "github.com", owner: gh[1]!, repo: gh[2]!.replace(/\.git$/, ""), number: Number(gh[3]) };
  const bb = BITBUCKET_PR_URL.exec(s);
  if (bb) {
    // The host as the Bitbucket Connector spells it: with a non-default port, never a context path.
    const host = bb[1]!.toLowerCase().replace(/:443$/, "");
    if (host === "bitbucket.org" || host.endsWith(".bitbucket.org")) return null;
    return { provider: "bitbucket", host, owner: bb[2]!, repo: bb[3]!, number: Number(bb[4]) };
  }
  return null;
}

/** The page of a Pull Request. */
export function prUrl(ref: PrRef): string {
  return ref.provider === "github"
    ? `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`
    : `https://${ref.host}/projects/${encodeURIComponent(ref.owner)}/repos/${encodeURIComponent(ref.repo)}/pull-requests/${ref.number}`;
}

/** `owner/repo#12` (Bitbucket: `KEY/slug#12`). */
export function prLabel(ref: Pick<PrRef, "owner" | "repo" | "number">): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** All Pull Request URLs in a text (prompts, Agent output), deduplicated in order. */
export function findPrUrls(text: string): (PrRef & { url: string })[] {
  const out: (PrRef & { url: string })[] = [];
  const seen = new Set<string>();
  const found = [
    ...text.matchAll(/https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g),
    ...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+\/projects\/[^\s/]+\/repos\/[^\s/]+\/pull-requests\/\d+/g),
  ].sort((a, b) => a.index - b.index);
  for (const m of found) {
    const parsed = parsePrUrl(m[0]);
    if (!parsed) continue;
    const key = `${parsed.host}/${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}#${parsed.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...parsed, url: prUrl(parsed) });
  }
  return out;
}
