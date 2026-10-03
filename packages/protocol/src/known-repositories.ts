// ---------------------------------------------------------------------------
// Known repositories (ADR-0068): every repository named anywhere in Sessionboxer — a Session's
// repositories, a follow, an attached PR, an automation's New Session — remembered so the inputs
// that take one can suggest it. Nothing is polled or cloned from this list.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { PrProvider, PrState, PrReviewDecision, PrSyncError } from "./pull-requests.js";
import type { PrRef } from "./pull-requests.js";
import { PrEventType, AutomationRun, ReviewVerdict } from "./automations.js";
import { Provider } from "./common.js";
import { SessionSettingsInput } from "./session-settings.js";
import { SCHEDULE_PROMPT_MAX_CHARS } from "./schedules.js";
import { PrFollowKind } from "./followed-prs.js";

export const KnownRepoKind = z.enum(["git", "copy"]);
export type KnownRepoKind = z.infer<typeof KnownRepoKind>;
/** Where the repository was last named. */
export const KnownRepoUse = z.enum(["session", "follow", "pr", "automation"]);
export type KnownRepoUse = z.infer<typeof KnownRepoUse>;

export const KnownRepo = z.object({
  id: z.string(),
  kind: KnownRepoKind,
  /** `git`: the clone URL, canonical when `parseRepoRemote` could read it, as given otherwise; `copy`: the host folder. */
  location: z.string(),
  /** `github` / `bitbucket` when the remote is one Sessionboxer talks to; `null` for other hosts and folders. */
  provider: PrProvider.nullable(),
  host: z.string().nullable(),
  /** Bitbucket: project key and slug. */
  owner: z.string().nullable(),
  repo: z.string().nullable(),
  uses: z.number().int().positive(),
  lastUsedBy: KnownRepoUse,
  lastUsedAt: z.string(),
  createdAt: z.string(),
});
export type KnownRepo = z.infer<typeof KnownRepo>;

/** A git remote read into coordinates: which provider (when known), host, owner / project and repository, and the canonical clone URL. */
export interface RepoRemote {
  provider: PrProvider | null;
  host: string;
  owner: string;
  repo: string;
  url: string;
}

const REMOTE_GITHUB = /^(?:(?:https?:\/\/|ssh:\/\/|git:\/\/)(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?\/|(?:[^@/\s]+@)?github\.com:|github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i;
/** Data Center: `https://host[/context]/scm/KEY/slug.git`, `https://host[/context]/projects/KEY/repos/slug[/browse]`, `ssh://git@host[:port]/KEY/slug.git`. */
const REMOTE_BITBUCKET_HTTPS =
  /^https?:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?(?:\/[^\s]*?)?\/(?:scm\/([^/\s]+)\/([^/\s]+?)(?:\.git)?|projects\/([^/\s]+)\/repos\/([^/\s]+?)(?:\/[^\s]*)?)\/?$/i;
const REMOTE_GENERIC_URL = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(?:.*\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const REMOTE_GENERIC_SCP = /^(?:[^@/\s]+@)?([^/:\s]+):(?:.*\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/**
 * Reads a clone URL (https, ssh, scp-style) into coordinates: github.com as `github`, a
 * `/scm/KEY/slug` or `/projects/KEY/repos/slug` path as `bitbucket`, anything else with at least
 * `owner/repo` at the end as an unknown provider (a Data Center `ssh://` remote included: nothing
 * tells it from another host's); `null` for a path or a URL with no such tail.
 */
export function parseRepoRemote(text: string): RepoRemote | null {
  const s = text.trim();
  const gh = REMOTE_GITHUB.exec(s);
  if (gh) return { provider: "github", host: "github.com", owner: gh[1]!, repo: gh[2]!, url: `https://github.com/${gh[1]}/${gh[2]}` };
  const bb = REMOTE_BITBUCKET_HTTPS.exec(s);
  if (bb) {
    const host = bb[1]!.toLowerCase();
    if (host !== "bitbucket.org" && !host.endsWith(".bitbucket.org")) {
      const owner = (bb[2] ?? bb[4])!;
      const repo = (bb[3] ?? bb[5])!;
      return { provider: "bitbucket", host, owner, repo, url: `https://${host}/scm/${owner}/${repo}.git` };
    }
  }
  const m = s.includes("://") ? REMOTE_GENERIC_URL.exec(s) : REMOTE_GENERIC_SCP.exec(s);
  if (!m) return null;
  return { provider: null, host: m[1]!.toLowerCase(), owner: m[2]!, repo: m[3]!, url: s.replace(/\/+$/, "") };
}

/** The HTTPS clone URL of a repository a Connector knows: `https://github.com/o/r`, `https://host/scm/KEY/slug.git`. */
export function repoCloneUrl(ref: Pick<PrRef, "provider" | "host" | "owner" | "repo">): string {
  return ref.provider === "github" ? `https://github.com/${ref.owner}/${ref.repo}` : `https://${ref.host}/scm/${ref.owner}/${ref.repo}.git`;
}

/** Something that happened to a followed PR, as polling saw it. One row per (PR, type, head, ref). */
export const PrEvent = z.object({
  id: z.string(),
  followedPrId: z.string(),
  type: PrEventType,
  headSha: z.string(),
  /** Who caused it (the author of the comment, the reviewer), when known. */
  actor: z.string().nullable(),
  /** What it is about: the item id of a comment / review, the check name, the reviewer login. */
  ref: z.string().nullable(),
  detectedAt: z.string(),
});
export type PrEvent = z.infer<typeof PrEvent>;

/** A followed pull request: what the list and the detail view need; comments and checks come separately. */
export const FollowedPr = z.object({
  id: z.string(),
  provider: PrProvider,
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  state: PrState,
  author: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  /** `owner/repo` of the head branch (differs from `owner/repo` for forks). */
  headRepo: z.string(),
  baseRef: z.string(),
  isFork: z.boolean(),
  /** Logins asked to review, and GitHub teams as `org/slug`. */
  requestedReviewers: z.array(z.string()),
  labels: z.array(z.string()),
  reviewDecision: PrReviewDecision.nullable(),
  /** Checks on the current head: failed / still running / passed. */
  checksFailed: z.number().int().nonnegative(),
  checksPending: z.number().int().nonnegative(),
  checksPassed: z.number().int().nonnegative(),
  /** Comments and failed checks not looked at yet (cleared when the PR's page is shown). */
  unread: z.number().int().nonnegative(),
  remoteCreatedAt: z.string().nullable(),
  remoteUpdatedAt: z.string().nullable(),
  firstSeenAt: z.string(),
  lastEventAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  syncedAt: z.string().nullable(),
  syncError: PrSyncError.nullable(),
  syncErrorDetail: z.string().nullable(),
  /** The follows this PR came in through. */
  follows: z.array(z.string()),
  /** Sessions the same PR is attached to (the Session-level PR pane). */
  attached: z.array(z.object({ sessionId: z.string(), prId: z.string() })),
  /** The newest automation run per automation on this PR (badges); the full history is `/api/prs/:id/runs`. */
  runs: z.array(AutomationRun),
});
export type FollowedPr = z.infer<typeof FollowedPr>;

/** `POST /api/prs/:id/attach`: attach the followed PR to an existing Session. */
export const AttachFollowedPrRequest = z.object({ sessionId: z.string().min(1) });
export type AttachFollowedPrRequest = z.infer<typeof AttachFollowedPrRequest>;

/** `POST /api/prs/:id/session`: a new Session on the PR head (the PR is attached to it). */
export const StartPrSessionRequest = z.object({
  provider: Provider.default("claude-code"),
  settings: SessionSettingsInput.default({}),
  /** Omitted sends a short brief of the PR. */
  prompt: z.string().max(SCHEDULE_PROMPT_MAX_CHARS).optional(),
});
export type StartPrSessionRequest = z.infer<typeof StartPrSessionRequest>;

/** `POST /api/prs/:id/run`: run a PR-event automation on this PR by hand (filters and caps still apply, dedupe does not). */
export const RunPrAutomationRequest = z.object({ automationId: z.string().min(1) });
export type RunPrAutomationRequest = z.infer<typeof RunPrAutomationRequest>;

export const PRS_ROUTE = "#/prs";
export function followedPrRoute(id: string): string {
  return `${PRS_ROUTE}/${id}`;
}

/** `pr_follow` (the `sessionboxer` MCP). */
export const AgentPrFollowArgs = z.object({
  kind: PrFollowKind.default("repo"),
  /** `repo` follows: `owner/repo` or a repository / PR URL (GitHub or Bitbucket Data Center). */
  repo: z.string().max(500).optional(),
  /** A connected login; omitted takes the Session's active one, then the first Connector. */
  account: z.string().min(1).optional(),
  provider: PrProvider.optional(),
  host: z.string().optional(),
});
export type AgentPrFollowArgs = z.infer<typeof AgentPrFollowArgs>;

/** `pr_followed_list`. */
export const AgentFollowedPrListArgs = z.object({
  /** `owner/repo` to narrow down to. */
  repo: z.string().max(500).optional(),
  state: z.enum(["open", "all"]).default("open"),
});
export type AgentFollowedPrListArgs = z.infer<typeof AgentFollowedPrListArgs>;

export const REVIEW_SUMMARY_MAX_CHARS = 4000;
export const REVIEW_FINDINGS_MAX = 50;
export const ReviewFindingSeverity = z.enum(["high", "medium", "low"]);
export type ReviewFindingSeverity = z.infer<typeof ReviewFindingSeverity>;
/** One inline finding of an automatic review; `line` is in the head (`RIGHT`) or base (`LEFT`) side of the diff. */
export const ReviewFinding = z.object({
  path: z.string().min(1).max(500),
  line: z.number().int().positive(),
  side: z.enum(["RIGHT", "LEFT"]).default("RIGHT"),
  severity: ReviewFindingSeverity.default("medium"),
  body: z.string().min(1).max(2000),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;
/** `pr_review_submit`: the review an Auto review Session hands to the Control Plane, which posts it. */
export const AgentPrReviewSubmitArgs = z.object({
  verdict: ReviewVerdict,
  summary: z.string().min(1).max(REVIEW_SUMMARY_MAX_CHARS),
  findings: z.array(ReviewFinding).max(REVIEW_FINDINGS_MAX).default([]),
});
export type AgentPrReviewSubmitArgs = z.infer<typeof AgentPrReviewSubmitArgs>;
