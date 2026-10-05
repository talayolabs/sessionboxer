// ---------------------------------------------------------------------------
// Snapshots: `docker commit` of a Session's Sandbox, taken after every Agent turn
// (when `Settings.autoSnapshot`) or on demand. A Snapshot is a fork point: a new
// Session can start a fresh Sandbox from its image with the conversation so far.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { ROOT_BRANCH_ID } from "./branches.js";
import { Provider, Environment } from "./common.js";
import { ProviderPayload } from "./sandbox-image.js";
import { SessionSettingsInput } from "./session-settings.js";

/** `rebuild`: a full image of the Sandbox's filesystem the Sandbox was moved onto (see `POST /sessions/:id/rebuild`). */
export const SNAPSHOT_REASONS = ["turn", "manual", "rebuild", "agent"] as const;
export const SnapshotReason = z.enum(SNAPSHOT_REASONS);
export type SnapshotReason = z.infer<typeof SnapshotReason>;

export const Snapshot = z.object({
  id: z.string(),
  sessionId: z.string(),
  /** 1-based, increasing per Session; shown as "snapshot N". */
  ordinal: z.number().int().positive(),
  reason: SnapshotReason,
  /** Docker image reference (`sessionboxer/snapshot:<sessionId>-<ordinal>`). */
  imageTag: z.string(),
  imageId: z.string(),
  /** The Agents the Snapshot image carries, as its Session's image did (ADR-0088); `null` = a legacy image, or unknown. */
  providers: z.array(Provider).nullable().default(null),
  /** Agent payloads staged into the Sandbox since its image (a cross-Provider fork's target Agent), with their digests. */
  payloads: z.array(ProviderPayload).default([]),
  /** Last Session event included in the Snapshot; the transcript marker goes right after it. */
  eventSeq: z.number().int().nonnegative(),
  /** Branch that was active when the Snapshot was taken. */
  branchId: z.string().default(ROOT_BRANCH_ID),
  /** Size of the committed layer (the Sandbox's writable layer at that moment). */
  sizeBytes: z.number().int().nonnegative(),
  /** Saved messages that were queued when the Snapshot was taken (candidates for the fork's first prompt). */
  queuedMessages: z.array(z.string()),
  createdAt: z.string(),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const DeleteSnapshotsResult = z.object({
  deleted: z.number().int().nonnegative(),
  /** Snapshots left in place because a fork was started from them. */
  kept: z.number().int().nonnegative(),
});
export type DeleteSnapshotsResult = z.infer<typeof DeleteSnapshotsResult>;

/** A Snapshot with what a picker shows about its Session (`GET /api/snapshots/recent`, ADR-0069). */
export const RecentSnapshot = Snapshot.extend({ sessionTitle: z.string(), provider: Provider, environment: Environment });
export type RecentSnapshot = z.infer<typeof RecentSnapshot>;

/**
 * What the fork does with the origin's conversation: `continue` copies the transcript up to the
 * Snapshot and the Agent resumes its own session from the image (it remembers everything);
 * `new` keeps only the Snapshot's files and tools — empty transcript, the Agent starts a session;
 * `handoff` is `new` plus a handoff document the origin's Agent writes now (a hidden turn in the
 * origin, from its whole memory) and the fork's Agent gets as its first message.
 */
export const ForkConversation = z.enum(["continue", "new", "handoff"]);
export type ForkConversation = z.infer<typeof ForkConversation>;
/** Longest handoff document a fork request carries. */
export const HANDOFF_DOCUMENT_MAX_CHARS = 200_000;

export const ForkSessionRequest = z.object({
  /** The fork point; omitted, the Control Plane takes a manual Snapshot of the running Sandbox now and forks from it. */
  snapshotId: z.string().optional(),
  conversation: ForkConversation.default("continue"),
  /** The fork's Agent; the origin's when omitted. Another one needs `new` or `handoff` (an Agent's memory cannot be loaded into another). */
  provider: Provider.optional(),
  title: z.string().min(1).max(200).optional(),
  /** Settings the fork differs in from the origin (the rest is copied). */
  settings: SessionSettingsInput.default({}),
  /** Sent to the fork as soon as its Sandbox is ready. */
  prompt: z.string().min(1).optional(),
  /** Texts to put in the fork's saved-message list, in order. */
  savedMessages: z.array(z.string().min(1)).default([]),
  /**
   * With `conversation: "handoff"`: the handoff document, already written (the origin's Agent hands
   * off through `session_fork`); the hidden handoff turn is skipped.
   */
  document: z.string().min(1).max(HANDOFF_DOCUMENT_MAX_CHARS).optional(),
});
export type ForkSessionRequest = z.infer<typeof ForkSessionRequest>;

/** One level of the host filesystem, for picking a "copy" Workspace Source in the UI. */
export const HostDirListing = z.object({
  /** Canonical absolute path of the listed directory. */
  path: z.string(),
  /** `null` at the filesystem root. */
  parent: z.string().nullable(),
  /** Subdirectory names, sorted; hidden ones are skipped. */
  dirs: z.array(z.string()),
  /** True when `path` is inside a git work tree. */
  git: z.boolean(),
});
export type HostDirListing = z.infer<typeof HostDirListing>;
