// ---------------------------------------------------------------------------
// Pulling a copied repository back into its host folder. Both sides describe their files
// the same way (git's view when it is a work tree: tracked + untracked-but-not-ignored,
// `.git` itself excluded); the Control Plane compares the two against the state after the
// copy / last pull and applies the difference. Paths are relative to the repository's
// directory (`/workspace/<name>`, or the Workspace root for the pre-repositories layout).
// ---------------------------------------------------------------------------

import { z } from "zod";

/** Daemon `fs/manifest` params: which Workspace directory to describe (`""` = the root). */
export const FsManifestParams = z.object({ dir: z.string().default("") });
export type FsManifestParams = z.infer<typeof FsManifestParams>;

/**
 * Daemon `fs/watch` params: a Workspace file the UI shows (an HTML Artifact in the App pane); the
 * Daemon reports its changes as `fs/changed` notifications until it is restarted (at most
 * `FS_WATCH_MAX` files, the least recently asked for dropped first).
 */
export const FsWatchParams = z.object({ path: z.string().min(1) });
export type FsWatchParams = z.infer<typeof FsWatchParams>;
export const FS_WATCH_MAX = 32;
/** Daemon → Control Plane `fs/changed` notification: a watched Workspace file was written, replaced or removed. */
export const FsChangedParams = z.object({ path: z.string(), exists: z.boolean() });
export type FsChangedParams = z.infer<typeof FsChangedParams>;

/** One file of a Workspace: regular files carry a content hash, symlinks their target. */
export const SyncFile = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  /** Only the executable bit matters (like git). */
  executable: z.boolean(),
  sha256: z.string().nullable(),
  link: z.string().nullable(),
});
export type SyncFile = z.infer<typeof SyncFile>;

export const SyncManifest = z.object({
  files: z.array(SyncFile),
  /** Listed through git (ignored files left out) rather than by walking everything. */
  git: z.boolean(),
});
export type SyncManifest = z.infer<typeof SyncManifest>;

/** Daemon `POST /fs/tar` body: files under `dir` (relative to it) to stream back as a tar archive. */
export const FS_TAR_PATH = "/fs/tar";
export const FsTarRequest = z.object({ dir: z.string().default(""), paths: z.array(z.string()).max(200_000) });
export type FsTarRequest = z.infer<typeof FsTarRequest>;

export const SYNC_ACTIONS = ["add", "update", "delete"] as const;
export const SyncAction = z.enum(SYNC_ACTIONS);
export type SyncAction = z.infer<typeof SyncAction>;

export const SyncEntry = z.object({
  path: z.string(),
  action: SyncAction,
  /** Size in the box (0 for deletes). */
  size: z.number().int().nonnegative(),
  /**
   * The host file changed too (or was deleted / is only known from the host) since the copy or
   * the last pull, so applying this would discard local work; skipped unless the user asks.
   */
  conflict: z.boolean(),
  /** Why this entry can never be applied (a symlink leaving the folder); null when it can. */
  blocked: z.string().nullable(),
});
export type SyncEntry = z.infer<typeof SyncEntry>;

export const SyncPlan = z.object({
  /** The repository the plan is for. */
  repoId: z.string(),
  /** The host folder. */
  path: z.string(),
  entries: z.array(SyncEntry),
  /** Files identical on both sides. */
  unchanged: z.number().int().nonnegative(),
  /** Files changed (or added / removed) only in the host folder: kept as they are. */
  localOnly: z.number().int().nonnegative(),
  /** A record of the copied state existed, so changes could be attributed to a side. */
  threeWay: z.boolean(),
  computedAt: z.string(),
});
export type SyncPlan = z.infer<typeof SyncPlan>;

export const SyncRequest = z.object({
  /** Which copied repository to pull; omitted takes the Session's only one. */
  repoId: z.string().optional(),
  /** Apply conflicting entries too (host changes lost). */
  overwriteLocal: z.boolean().default(false),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

export const SyncResult = z.object({
  repoId: z.string(),
  path: z.string(),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  /** Conflicting entries left alone. */
  skipped: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type SyncResult = z.infer<typeof SyncResult>;

/** How the chat embeds a Workspace file the Agent mentions; `null` = shown as a plain link. */
export type MediaKind = "video" | "audio" | "image" | "pdf" | "markdown" | "mermaid" | "html";

const MEDIA_TYPES: Record<string, [MediaKind, string]> = {
  mp4: ["video", "video/mp4"],
  m4v: ["video", "video/mp4"],
  webm: ["video", "video/webm"],
  mov: ["video", "video/quicktime"],
  mp3: ["audio", "audio/mpeg"],
  wav: ["audio", "audio/wav"],
  ogg: ["audio", "audio/ogg"],
  m4a: ["audio", "audio/mp4"],
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  svg: ["image", "image/svg+xml"],
  pdf: ["pdf", "application/pdf"],
  md: ["markdown", "text/markdown; charset=utf-8"],
  markdown: ["markdown", "text/markdown; charset=utf-8"],
  mmd: ["mermaid", "text/plain; charset=utf-8"],
  mermaid: ["mermaid", "text/plain; charset=utf-8"],
  html: ["html", "text/html; charset=utf-8"],
  htm: ["html", "text/html; charset=utf-8"],
};

/** Regular expression source matching any embeddable file extension (no anchors, no dot). */
export const MEDIA_EXTENSIONS = Object.keys(MEDIA_TYPES).join("|");

/** Files served with a known type but not embedded on their own (a video's caption sidecar). */
const SIDECAR_TYPES: Record<string, string> = {
  vtt: "text/vtt; charset=utf-8",
};

/** Caption track a video may come with: `<name>.vtt` next to `<name>.mp4`. */
export function captionTrackFor(videoPath: string): string {
  return videoPath.replace(/\.[^./]+$/, ".vtt");
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function mediaKind(path: string): MediaKind | null {
  return MEDIA_TYPES[extensionOf(path)]?.[0] ?? null;
}

export function contentTypeFor(path: string): string {
  const ext = extensionOf(path);
  return MEDIA_TYPES[ext]?.[1] ?? SIDECAR_TYPES[ext] ?? "application/octet-stream";
}
