import { MEDIA_EXTENSIONS, mediaKind, type MediaKind } from "@sessionboxer/protocol";

export interface Attachment {
  /** Workspace-relative path. */
  path: string;
  name: string;
  kind: MediaKind;
}

const WORKSPACE_PREFIX = "/workspace/";
/** The Workspace as a Windows Session's Agent names it (`C:\workspace\...`), either slash. */
const WINDOWS_WORKSPACE = /^[a-z]:[\\/]workspace(?:[\\/]|$)/i;
/** A Windows drive path (`C:\...`, `C:/...`), which is not a URL scheme. */
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

/** Where a Workspace path may start: `/workspace/`, `C:\workspace\`, `./`. */
export const WORKSPACE_PREFIX_RE = String.raw`(?:/workspace/|[A-Za-z]:[\\/]workspace[\\/]|\./)`;

/**
 * Workspace paths of embeddable files (video, image, PDF…) mentioned in a message, as the Agent
 * writes them: `/workspace/recordings/demo.mp4`, `C:\workspace\out\report.pdf` (a Windows Session),
 * `./out/report.pdf`, `docs/chart.svg`, in prose, backticks or Markdown links. URLs and paths outside
 * the Workspace are ignored.
 */
export function findAttachments(text: string): Attachment[] {
  const re = new RegExp(String.raw`(^|[\s\`("'\[<])(${WORKSPACE_PREFIX_RE}?(?:[\w.@+-]+[\\/])*[\w.@+-]+\.(?:${MEDIA_EXTENSIONS}))(?=$|[\s\`)"'\]>,;:!?]|\.\s|\.$)`, "gim");
  const seen = new Set<string>();
  const out: Attachment[] = [];
  for (const m of text.matchAll(re)) {
    const path = normalize(m[2] ?? "");
    if (!path || seen.has(path)) continue;
    const kind = mediaKind(path);
    if (!kind) continue;
    seen.add(path);
    out.push({ path, name: path.slice(path.lastIndexOf("/") + 1), kind });
  }
  return out;
}

/**
 * Workspace-relative form of a path the Agent wrote, or `null` for URLs, anchors and paths outside
 * the Workspace. Relative paths resolve against `base` (the directory of the document they appear in).
 */
export function workspacePath(href: string, base = ""): string | null {
  if (WINDOWS_DRIVE.test(href)) return WINDOWS_WORKSPACE.test(href) ? normalize(href) : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return null;
  if (href.startsWith("/")) return href.startsWith(WORKSPACE_PREFIX) ? normalize(href) : null;
  return normalize(base ? `${base}/${href}` : href);
}

/** Collapses `.`/`..` segments (backslashes count as slashes); `""` when the path climbs out of the Workspace. */
function normalize(p: string): string {
  const rel = p.replace(WINDOWS_WORKSPACE, WORKSPACE_PREFIX).replace(/\\/g, "/").replace(/^\/workspace\//, "");
  const out: string[] = [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.pop()) return "";
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** Directory part of a Workspace-relative path (`""` at the root). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function rawFileUrl(sessionId: string, path: string, download = false): string {
  return `/api/sessions/${sessionId}/fs/raw?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}
