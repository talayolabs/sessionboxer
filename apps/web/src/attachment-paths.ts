import { MEDIA_EXTENSIONS, mediaKind, type MediaKind } from "@sessionboxer/protocol";

export interface Attachment {
  /** Workspace-relative path. */
  path: string;
  name: string;
  kind: MediaKind;
}

const WORKSPACE_PREFIX = "/workspace/";

/**
 * Workspace paths of embeddable files (video, image, PDF…) mentioned in a message, as the Agent
 * writes them: `/workspace/recordings/demo.mp4`, `./out/report.pdf`, `docs/chart.svg`, in prose,
 * backticks or Markdown links. URLs and paths outside the Workspace are ignored.
 */
export function findAttachments(text: string): Attachment[] {
  const re = new RegExp(String.raw`(^|[\s\`("'\[<])(?:/workspace/|\./)?((?:[\w.@+-]+/)*[\w.@+-]+\.(?:${MEDIA_EXTENSIONS}))(?=$|[\s\`)"'\]>,;:!?]|\.\s|\.$)`, "gim");
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

/** Workspace-relative form of a path the Agent wrote, or `null` for URLs and paths outside it. */
export function workspacePath(href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  if (href.startsWith("/")) return href.startsWith(WORKSPACE_PREFIX) ? normalize(href) : null;
  return normalize(href);
}

function normalize(p: string): string {
  let rel = p.startsWith(WORKSPACE_PREFIX) ? p.slice(WORKSPACE_PREFIX.length) : p;
  while (rel.startsWith("./")) rel = rel.slice(2);
  if (rel.split("/").includes("..")) return "";
  return rel;
}

export function rawFileUrl(sessionId: string, path: string, download = false): string {
  return `/api/sessions/${sessionId}/fs/raw?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}
