// ---------------------------------------------------------------------------
// Followed pull requests (ADR-0064): PRs the Control Plane watches on their own, without a Session.
// A follow names a scope; the PRs it finds are shared rows; events are derived from polling.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { PrProvider, PrSyncError } from "./pull-requests.js";

export const PrFollowKind = z.enum(["repo", "mine", "requested"]);
export type PrFollowKind = z.infer<typeof PrFollowKind>;
export const PR_FOLLOW_KIND_LABELS: Record<PrFollowKind, string> = {
  repo: "every open PR of a repository",
  mine: "PRs I opened",
  requested: "PRs where my review is requested",
};

/** One scope the Control Plane polls with a Connector's login. */
export const PrFollowWebhook = z.enum(["none", "registered", "healthy"]);
export type PrFollowWebhook = z.infer<typeof PrFollowWebhook>;

export const PrFollow = z.object({
  id: z.string(),
  provider: PrProvider,
  /** `github.com`, or the Bitbucket Data Center host. */
  host: z.string(),
  /** The Connector login the scope is read with (`mine` / `requested` are about this login). */
  account: z.string(),
  kind: PrFollowKind,
  /** `repo` follows: owner and repository (Bitbucket: project key and slug); `null` for the others. */
  owner: z.string().nullable(),
  repo: z.string().nullable(),
  enabled: z.boolean(),
  polledAt: z.string().nullable(),
  /** Not polled before this when the last poll hit a rate limit or a 5xx. */
  retryAt: z.string().nullable(),
  syncError: PrSyncError.nullable(),
  syncErrorDetail: z.string().nullable(),
  /** Open PRs this follow currently lists. */
  prCount: z.number().int().nonnegative(),
  /** `registered`: a webhook secret exists (registered on GitHub, or configured by hand); `healthy`: a delivery came in the last hour, so the list is polled every 5 min instead of every minute. */
  webhook: PrFollowWebhook,
  webhookSeenAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PrFollow = z.infer<typeof PrFollow>;

/** `POST /api/prs/follows/:id/hook` — the public base URL the platform should call (a tunnel); the Control Plane's own URL when omitted. */
export const PrFollowHookRequest = z.object({ url: z.string().url().optional() });
export type PrFollowHookRequest = z.infer<typeof PrFollowHookRequest>;

/** The webhook of a follow: where the platform posts, and the secret to paste when Sessionboxer could not register it itself. */
export const PrFollowHook = z.object({
  webhook: PrFollowWebhook,
  /** `POST /api/hooks/{provider}/{followId}` at the public base URL; `null` when off. */
  url: z.string().nullable(),
  /** Only when the hook must be configured by hand (Bitbucket Data Center, `mine` / `requested` follows). */
  secret: z.string().nullable(),
  /** The platform's id when Sessionboxer registered the hook (GitHub `repo` follows). */
  registeredId: z.string().nullable(),
  seenAt: z.string().nullable(),
});
export type PrFollowHook = z.infer<typeof PrFollowHook>;

export const CreatePrFollowRequest = z.object({
  provider: PrProvider.default("github"),
  /** Bitbucket: the Data Center host; GitHub: ignored. */
  host: z.string().optional(),
  /** A connected login; omitted takes the first Connector of that provider (and host). */
  account: z.string().min(1).optional(),
  kind: PrFollowKind.default("repo"),
  /** `repo` follows: `owner/repo`, or a repository / PR URL. */
  repo: z.string().max(500).optional(),
});
export type CreatePrFollowRequest = z.infer<typeof CreatePrFollowRequest>;

export const UpdatePrFollowRequest = z.object({ enabled: z.boolean() });
export type UpdatePrFollowRequest = z.infer<typeof UpdatePrFollowRequest>;
