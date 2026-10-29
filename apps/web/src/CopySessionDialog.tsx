import { useEffect, useMemo, useState } from "react";
import type { Session } from "@sessionboxer/protocol";
import { downloadText, writeClipboard } from "./clipboard";
import { formatBytes } from "./format";
import {
  DEFAULT_EXPORT_OPTIONS, EXPORT_EXTENSIONS, exportMessages, formatExport, type ExportFormat, type ExportOptions,
} from "./session-export";
import type { TranscriptItem } from "./transcript-model";
import { Modal } from "./ui";

const FORMATS: Array<{ id: ExportFormat; label: string; hint: string }> = [
  { id: "markdown", label: "Markdown", hint: "to read or paste into a doc or another chat" },
  { id: "json", label: "JSON", hint: "one object: the Session and its messages" },
  { id: "jsonl", label: "JSONL", hint: "one message per line" },
];
const PREVIEW_CHARS = 4000;
const MIME: Record<ExportFormat, string> = { markdown: "text/markdown", json: "application/json", jsonl: "application/jsonl" };

function fileName(title: string, format: ExportFormat): string {
  const base = title.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
  return `${base}.${EXPORT_EXTENSIONS[format]}`;
}

/** "Copy session…" in the header's "…" menu: pick which messages and a format, then copy or download the transcript. */
export function CopySessionDialog({ session, items, onClose }: { session: Session; items: TranscriptItem[]; onClose: () => void }) {
  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const set = (patch: Partial<ExportOptions>) => setOpts((o) => ({ ...o, ...patch }));

  const messages = useMemo(() => exportMessages(items, opts), [items, opts]);
  const text = useMemo(() => formatExport({ id: session.id, title: session.title, provider: session.provider }, messages, opts.format), [session, messages, opts.format]);
  const bytes = useMemo(() => new TextEncoder().encode(text).length, [text]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await writeClipboard(text);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  };

  const check = (key: "user" | "assistant" | "thinking" | "toolCalls" | "toolOutput" | "timestamps", label: string, hint?: string, disabled = false) => (
    <label className="check">
      <input type="checkbox" checked={opts[key]} disabled={disabled} onChange={(e) => set({ [key]: e.target.checked })} />
      <span className={`choice-text${disabled ? " muted" : ""}`}>
        {label}
        {hint && <span className="muted"> — {hint}</span>}
      </span>
    </label>
  );

  return (
    <Modal className="copy-session-dialog" title={`Copy "${session.title}"`} onClose={onClose}>
      <fieldset className="choice">
        <legend>Messages</legend>
        {check("user", "User")}
        {check("assistant", "Assistant")}
        <div className="copy-session-sub" role="radiogroup" aria-label="Assistant messages">
          <label className="check">
            <input type="radio" name="assistant-scope" checked={opts.assistantScope === "all"} disabled={!opts.assistant} onChange={() => set({ assistantScope: "all" })} />
            <span className={`choice-text${opts.assistant ? "" : " muted"}`}>All</span>
          </label>
          <label className="check">
            <input type="radio" name="assistant-scope" checked={opts.assistantScope === "last"} disabled={!opts.assistant} onChange={() => set({ assistantScope: "last" })} />
            <span className={`choice-text${opts.assistant ? "" : " muted"}`}>
              Only the last message of each turn <span className="muted">— the summary</span>
            </span>
          </label>
        </div>
        {check("thinking", "Thinking", "the Agent's reasoning, where it shows it")}
        {check("toolCalls", "Tool calls", "name, status and input of each")}
        <div className="copy-session-sub">{check("toolOutput", "Tool output", "what each tool returned (can be long)", !opts.toolCalls)}</div>
        {check("timestamps", "Timestamps")}
      </fieldset>
      <fieldset className="choice">
        <legend>Format</legend>
        {FORMATS.map((f) => (
          <label className="check" key={f.id}>
            <input type="radio" name="format" checked={opts.format === f.id} onChange={() => set({ format: f.id })} />
            <span className="choice-text">
              {f.label} <span className="muted">— {f.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <pre className="copy-session-preview" aria-label="Preview">
        {messages.length === 0 ? "Nothing to copy with these options." : text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n\u2026` : text}
      </pre>
      <div className="actions">
        <span className="muted small-text">
          {messages.length} message{messages.length === 1 ? "" : "s"}, {formatBytes(bytes)}
        </span>
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button type="button" disabled={messages.length === 0} onClick={() => downloadText(fileName(session.title, opts.format), text, MIME[opts.format])}>
          Download
        </button>
        <button type="button" className="primary" disabled={messages.length === 0} onClick={() => void copy()}>
          {copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
        </button>
      </div>
    </Modal>
  );
}
