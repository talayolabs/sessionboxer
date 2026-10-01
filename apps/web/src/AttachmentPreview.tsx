import { useEffect, useState } from "react";
import { mediaKind } from "@sessionboxer/protocol";
import type { PendingAttachment } from "./attachments-pending";
import { formatBytes } from "./format";
import { Markdown } from "./Markdown";
import { Mermaid } from "./Mermaid";
import { Modal } from "./ui";

/** How a file picked for the next prompt can be shown before it is sent; `null` = name and size only. */
export type PreviewKind = "image" | "video" | "audio" | "pdf" | "markdown" | "mermaid" | "html" | "text";

const TEXT_EXTENSIONS = new Set([
  "txt", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "css", "scss",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash",
  "zsh", "ps1", "bat", "sql", "diff", "patch", "gitignore", "dockerfile", "makefile", "tex", "rst", "adoc", "vtt", "srt",
]);
const TEXT_MIMES = new Set(["application/json", "application/xml", "application/x-yaml", "application/yaml", "application/javascript", "application/x-sh", "application/sql"]);

/** Above this many characters a text preview is cut, so a huge log does not freeze the dialog. */
const TEXT_CAP = 200_000;

export function previewKind(name: string, mimeType: string): PreviewKind | null {
  const known = mediaKind(name);
  if (known) return known;
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (type === "text/markdown") return "markdown";
  if (type === "text/html") return "html";
  if (type.startsWith("text/") || TEXT_MIMES.has(type)) return "text";
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
  return TEXT_EXTENSIONS.has(ext) ? "text" : null;
}

const BADGES: Record<Exclude<PreviewKind, "image" | "video">, string> = { audio: "\u266b", pdf: "PDF", markdown: "MD", mermaid: "MMD", html: "HTML", text: "TXT" };

/** The small square at the start of a chip: the picture or the video's first frame, else a badge for the type. */
export function AttachmentThumb({ kind, url, name }: { kind: PreviewKind | null; url: string; name: string }) {
  if (kind === "image") return <img className="attach-thumb" src={url} alt="" />;
  if (kind === "video") return <video className="attach-thumb" src={url} muted preload="metadata" playsInline aria-hidden="true" />;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase().slice(0, 4) : "";
  return (
    <span className={`attach-thumb badge${kind ? ` ${kind}` : ""}`} aria-hidden="true">
      {kind === "text" && ext ? ext : kind ? BADGES[kind] : ext || "FILE"}
    </span>
  );
}

type Loaded = { state: "loading" } | { state: "ok"; text: string; cut: boolean } | { state: "error"; message: string };

function useText(url: string, wanted: boolean): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    setLoaded({ state: "loading" });
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`cannot read the file (${res.status})`);
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setLoaded({ state: "ok", text: text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text, cut: text.length > TEXT_CAP });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoaded({ state: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [url, wanted]);
  return loaded;
}

/** The file large enough to tell what it is: the picture, the player, the PDF in the browser's viewer, the Markdown rendered, the text as is. */
export function AttachmentPreviewDialog<A>({ item, kind, onClose }: { item: PendingAttachment<A>; kind: PreviewKind; onClose: () => void }) {
  const textual = kind === "markdown" || kind === "mermaid" || kind === "text";
  const loaded = useText(item.url, textual);
  return (
    <Modal
      className={`preview-dialog preview-${kind}`}
      title={
        <>
          <span className="preview-title" title={item.name}>
            {item.name}
          </span>
          <span className="muted small-text">{formatBytes(item.size)}</span>
          <a className="link" href={item.url} download={item.name}>
            Download
          </a>
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        </>
      }
      onClose={onClose}
    >
      <div className="preview-body">
        {kind === "image" && <img src={item.url} alt={item.name} />}
        {kind === "video" && <video src={item.url} controls autoPlay playsInline />}
        {kind === "audio" && <audio src={item.url} controls autoPlay />}
        {kind === "pdf" && <iframe src={item.url} title={item.name} />}
        {kind === "html" && <iframe src={item.url} title={item.name} sandbox="" referrerPolicy="no-referrer" />}
        {textual && loaded.state === "loading" && <div className="muted">Loading\u2026</div>}
        {textual && loaded.state === "error" && <div className="attachment-error">{loaded.message}</div>}
        {textual && loaded.state === "ok" && (
          <>
            {kind === "markdown" && <Markdown text={loaded.text} />}
            {kind === "mermaid" && <Mermaid code={loaded.text} />}
            {kind === "text" && <pre className="preview-text">{loaded.text}</pre>}
            {loaded.cut && <div className="muted small-text">Showing the first {formatBytes(TEXT_CAP)} of the file.</div>}
          </>
        )}
      </div>
    </Modal>
  );
}
