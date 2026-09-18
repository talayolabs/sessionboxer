import type { Element, ElementContent, Root, Text } from "hast";
import { mediaKind } from "@sessionboxer/protocol";
import { workspacePath } from "./attachment-paths";

/** A place in a Workspace file the chat points at; opened in the Code pane on click. */
export interface FileRef {
  /** Workspace-relative. */
  path: string;
  /** 1-based. */
  line?: number;
  /** 1-based; only with `line`. */
  column?: number;
}

// A file name: `name.ext` (extension starts with a letter, so `v1.2.3` is not one) or one of the
// usual extensionless files.
const NAME = String.raw`(?:[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}|Dockerfile|Makefile|LICENSE|README|CHANGELOG|\.env(?:\.[\w-]+)?|\.\w+rc|\.\w+ignore|\.editorconfig)`;
const PATH = String.raw`(?:/workspace/|\./)?(?:[\w.@+-]+/)*${NAME}`;
// `:12`, `:12:5`, `#L12`, `#L12C5`.
const LOC = String.raw`(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)?`;
// Where a path may start and what may follow it (prose punctuation, quotes, brackets).
const BEFORE = String.raw`(^|[\s\`("'\[<])`;
const AFTER = String.raw`(?=$|[\s\`)"'\]>,;:!?]|\.\s|\.$)`;

const WHOLE = new RegExp(`^(${PATH})${LOC}$`);
const IN_TEXT = new RegExp(`${BEFORE}(${PATH})${LOC}${AFTER}`, "gm");
/** Domains, not files: `example.com`, `socket.io`. */
const NOT_EXTENSIONS = new Set(["com", "org", "net", "io", "dev", "ai", "co", "uk", "edu", "gov", "info", "me", "app"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** `example.com`, `example.com/foo.js`: a host, not a file. */
function looksLikeDomain(raw: string): boolean {
  const segments = raw.split("/").filter((s) => s !== "");
  const first = segments[0] ?? "";
  const last = segments[segments.length - 1] ?? "";
  return NOT_EXTENSIONS.has(extensionOf(last)) || (!raw.startsWith("/") && !raw.startsWith("./") && NOT_EXTENSIONS.has(extensionOf(first)));
}

/** Binary media has its own card in the chat; text media (Markdown, Mermaid) is also code. */
function isBinaryMedia(path: string): boolean {
  const kind = mediaKind(path);
  return kind !== null && kind !== "markdown" && kind !== "mermaid";
}

function toRef(raw: string, loc: Array<string | undefined>, base: string): FileRef | null {
  if (looksLikeDomain(raw) || isBinaryMedia(raw)) return null;
  const path = workspacePath(raw, base);
  if (!path) return null;
  const line = Number(loc[0] ?? loc[2] ?? NaN);
  const column = Number(loc[1] ?? loc[3] ?? NaN);
  const ref: FileRef = { path };
  if (line > 0) {
    ref.line = line;
    if (column > 0) ref.column = column;
  }
  return ref;
}

/**
 * The file a whole string names (`src/App.tsx:42:7`, `/workspace/README.md`, `./a.ts#L3`), or
 * null. Video/image/PDF files are left to the attachment cards, paths outside the Workspace to nobody.
 */
export function parseFileRef(text: string, base = ""): FileRef | null {
  const m = WHOLE.exec(text.trim());
  return m ? toRef(m[1] ?? "", m.slice(2, 6), base) : null;
}

/** A path known to be a file (a tool call's), whatever it is named; null outside the Workspace. */
export function knownFileRef(path: string, line?: number | null): FileRef | null {
  if (isBinaryMedia(path)) return null;
  const rel = workspacePath(path);
  if (!rel) return null;
  return typeof line === "number" && line > 0 ? { path: rel, line } : { path: rel };
}

export type TextPart = string | { text: string; ref: FileRef };

/**
 * Splits prose into plain runs and file references. In prose a bare `index.ts` is left alone
 * (too many false hits); a path needs a directory (`src/index.ts`), a `./` or `/workspace/`
 * prefix, or a `:line` to count.
 */
export function splitFileRefs(text: string, base = ""): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(IN_TEXT)) {
    const lead = m[1] ?? "";
    const raw = m[2] ?? "";
    const hasLoc = m[3] !== undefined || m[5] !== undefined;
    if (!raw.includes("/") && !hasLoc) continue;
    const ref = toRef(raw, m.slice(3, 7), base);
    if (!ref) continue;
    const start = m.index + lead.length;
    const end = m.index + m[0].length;
    if (start > last) parts.push(text.slice(last, start));
    parts.push({ text: text.slice(start, end), ref });
    last = end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** First file a tool call touched, from its title (`Wrote ./a.ts`, `Read src/b.ts`). */
export function firstFileRef(text: string): FileRef | null {
  for (const part of splitFileRefs(text)) if (typeof part !== "string") return part.ref;
  return null;
}

/** hast properties carrying a FileRef; the Markdown components turn them into a FileLink. */
export function refProperties(ref: FileRef): Element["properties"] {
  const props: Element["properties"] = { dataFile: ref.path };
  if (ref.line !== undefined) props.dataLine = ref.line;
  if (ref.column !== undefined) props.dataColumn = ref.column;
  return props;
}

export function refOf(properties: Element["properties"] | undefined): FileRef | null {
  if (!properties || typeof properties.dataFile !== "string") return null;
  const ref: FileRef = { path: properties.dataFile };
  if (typeof properties.dataLine === "number") ref.line = properties.dataLine;
  if (typeof properties.dataColumn === "number") ref.column = properties.dataColumn;
  return ref;
}

function textOf(nodes: ElementContent[]): string {
  return nodes.map((n) => (n.type === "text" ? n.value : n.type === "element" ? textOf(n.children) : "")).join("");
}

/**
 * rehype plugin: marks inline `code` that names a Workspace file and wraps file references in
 * prose in `<a data-file>` so they render as links into the Code pane. Fenced code, existing
 * links and their contents are left alone.
 */
export function rehypeFileLinks(options: { base?: string } = {}) {
  const base = options.base ?? "";
  const visit = (node: Root | Element): void => {
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child) continue;
      if (child.type === "element") {
        if (child.tagName === "a" || child.tagName === "pre") continue;
        if (child.tagName === "code") {
          const ref = parseFileRef(textOf(child.children), base);
          if (ref) Object.assign(child.properties, refProperties(ref));
          continue;
        }
        visit(child);
      } else if (child.type === "text") {
        const parts = splitFileRefs(child.value, base);
        if (parts.length === 1 && typeof parts[0] === "string") continue;
        const nodes: ElementContent[] = parts.map((p) =>
          typeof p === "string"
            ? ({ type: "text", value: p } satisfies Text)
            : ({ type: "element", tagName: "a", properties: refProperties(p.ref), children: [{ type: "text", value: p.text }] } satisfies Element),
        );
        children.splice(i, 1, ...nodes);
        i += nodes.length - 1;
      }
    }
  };
  return (tree: Root) => visit(tree);
}
