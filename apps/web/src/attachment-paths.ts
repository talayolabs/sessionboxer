import { MACOS_GUEST_WORKSPACE, MEDIA_EXTENSIONS, mediaKind, type MediaKind } from "@sessionboxer/protocol";
import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

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
/** The Workspace as a macOS Session's Agent names it (`/Users/agent/workspace/...`). */
const MACOS_WORKSPACE = new RegExp(`^${MACOS_GUEST_WORKSPACE}(?:/|$)`);

/** Where a Workspace path may start: `/workspace/`, `/Users/agent/workspace/`, `C:\workspace\`, `./`. */
export const WORKSPACE_PREFIX_RE = String.raw`(?:/workspace/|${MACOS_GUEST_WORKSPACE}/|[A-Za-z]:[\\/]workspace[\\/]|\./)`;
const MARKDOWN = unified().use(remarkParse);

/**
 * Workspace paths of embeddable files (video, image, PDF…) mentioned in a message, as the Agent
 * writes them: `/workspace/recordings/demo.mp4`, `C:\workspace\out\report.pdf` (a Windows Session),
 * `/Users/agent/workspace/out/report.pdf` (a macOS Session), `./out/report.pdf`, `docs/chart.svg`, in prose, backticks or Markdown links. URLs and paths outside
 * the Workspace are ignored.
 */
export function findAttachments(text: string, base = ""): Attachment[] {
  const re = new RegExp(String.raw`(^|[\s\`("'\[<])(${WORKSPACE_PREFIX_RE}?(?:[\w.@+-]+[\\/])*[\w.@+-]+\.(?:${MEDIA_EXTENSIONS}))(?=$|[\s\`)"'\]>,;:!?]|\.\s|\.$)`, "gim");
  const tree = MARKDOWN.parse(text);
  const definitions = new Map<string, string>();
  const seen = new Set<string>();
  const out: Attachment[] = [];
  const add = (href: string): void => {
    const path = workspacePath(href, base);
    if (!path || seen.has(path)) return;
    const kind = mediaKind(path);
    if (!kind) return;
    seen.add(path);
    out.push({ path, name: path.slice(path.lastIndexOf("/") + 1), kind });
  };
  const collect = (node: Root | RootContent): void => {
    if (node.type === "definition" && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node.url);
    if ("children" in node) node.children.forEach(collect);
  };
  const visit = (node: Root | RootContent): void => {
    if (node.type === "link" || node.type === "image") {
      add(node.url);
    } else if (node.type === "linkReference" || node.type === "imageReference") {
      const href = definitions.get(node.identifier.toUpperCase());
      if (href) add(href);
    } else if (node.type === "text" || node.type === "inlineCode" || node.type === "html") {
      if (node.type === "inlineCode" && /^file:/i.test(node.value)) {
        add(node.value);
        return;
      }
      const value = node.value.replace(/<ref_(?:file|snippet)\b[^>]*\sfile\s*=\s*(["'])(.*?)\1[^>]*\/?>/gi, (_match, _quote: string, path: string) => {
        add(path);
        return "";
      });
      for (const m of value.matchAll(re)) add(m[2] ?? "");
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  collect(tree);
  visit(tree);
  return out;
}

/**
 * Workspace-relative form of a path the Agent wrote, or `null` for URLs, anchors and paths outside
 * the Workspace. Relative paths resolve against `base` (the directory of the document they appear in).
 */
export function workspacePath(href: string, base = ""): string | null {
  if (href.startsWith("#") || href.startsWith("//")) return null;
  let path: string;
  try {
    if (/^file:/i.test(href)) {
      const url = new URL(href);
      if (url.hostname !== "" && url.hostname !== "localhost") return null;
      path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:[\\/])/i, "$1");
    } else {
      if (!WINDOWS_DRIVE.test(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
      path = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? "");
    }
  } catch {
    return null;
  }
  if (!path || /[\u0000-\u001f]/.test(path) || path.startsWith("//")) return null;
  if (WINDOWS_DRIVE.test(path)) return WINDOWS_WORKSPACE.test(path) ? normalize(path) || null : null;
  if (path.startsWith("/")) return path.startsWith(WORKSPACE_PREFIX) || MACOS_WORKSPACE.test(path) ? normalize(path) || null : null;
  return normalize(base ? `${base}/${path}` : path) || null;
}

/** Collapses `.`/`..` segments (backslashes count as slashes); `""` when the path climbs out of the Workspace. */
function normalize(p: string): string {
  const rel = p.replace(WINDOWS_WORKSPACE, WORKSPACE_PREFIX).replace(MACOS_WORKSPACE, WORKSPACE_PREFIX).replace(/\\/g, "/").replace(/^\/workspace\//, "");
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

/**
 * Where an HTML Artifact runs: served with the sandboxing CSP (ADR-0078), so the document has an
 * opaque origin in the card's iframe, in the App pane and in a tab of its own. `nonce` changes the
 * URL so a reload fetches the file again.
 */
export function appFileUrl(sessionId: string, path: string, nonce?: number): string {
  return `/api/sessions/${sessionId}/fs/app?path=${encodeURIComponent(path)}${nonce ? `&v=${nonce}` : ""}`;
}
