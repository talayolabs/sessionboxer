import { createContext, useContext, useEffect, useRef, useState } from "react";
import { captionTrackFor, mediaKind, type PromptAttachment } from "@sessionboxer/protocol";
import { formatBytes } from "./format";
import { rawFileUrl, type Attachment } from "./attachment-paths";
import { DocumentView } from "./Document";

/** Session whose Workspace files the chat may embed; `null` outside a Session. */
export const AttachmentSession = createContext<string | null>(null);

type Probe = { state: "loading" } | { state: "ready"; bytes: number | null } | { state: "error"; message: string };

/** Video / image / PDF / Markdown document from the Sandbox's Workspace, inline with a download button. */
export function AttachmentCard({ sessionId, attachment }: { sessionId: string; attachment: Attachment }) {
  const src = rawFileUrl(sessionId, attachment.path);
  const [probe, setProbe] = useState<Probe>({ state: "loading" });

  // A HEAD first: it tells missing file from stopped Sandbox apart (a <video> error would not), and gives the size.
  useEffect(() => {
    let cancelled = false;
    setProbe({ state: "loading" });
    fetch(src, { method: "HEAD" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          const len = res.headers.get("content-length");
          setProbe({ state: "ready", bytes: len ? Number(len) : null });
        } else {
          setProbe({
            state: "error",
            message:
              res.status === 404
                ? "not found in the Workspace"
                : res.status === 409
                  ? "Sandbox stopped; Resume the Session to view it"
                  : `cannot load (${res.status})`,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setProbe({ state: "error", message: "cannot load" });
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <figure className={`attachment attachment-${attachment.kind}`}>
      <figcaption className="attachment-head">
        <span className="attachment-name" title={attachment.path}>
          {attachment.name}
        </span>
        {probe.state === "ready" && probe.bytes !== null && <span className="attachment-size">{formatBytes(probe.bytes)}</span>}
        {probe.state === "error" && <span className="attachment-error">{probe.message}</span>}
        <span className="attachment-actions">
          <a href={src} target="_blank" rel="noreferrer noopener" title="Open in a new tab">
            Open
          </a>
          <a href={rawFileUrl(sessionId, attachment.path, true)} download={attachment.name} title="Download">
            Download
          </a>
        </span>
      </figcaption>
      {probe.state === "ready" && <Media sessionId={sessionId} kind={attachment.kind} src={src} path={attachment.path} name={attachment.name} />}
    </figure>
  );
}

function Media({ sessionId, kind, src, path, name }: { sessionId: string; kind: Attachment["kind"]; src: string; path: string; name: string }) {
  switch (kind) {
    case "video":
      return <Video src={src} track={rawFileUrl(sessionId, captionTrackFor(path))} />;
    case "audio":
      return <audio controls preload="metadata" src={src} />;
    case "image":
      return <img src={src} alt={name} loading="lazy" />;
    case "pdf":
      return <iframe src={src} title={name} />;
    case "markdown":
    case "mermaid":
      return <DocumentView src={src} path={path} kind={kind} />;
  }
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

/**
 * Player with the recording's captions, when a `.vtt` sits next to it: offered as a subtitle track
 * (off by default, since recordings carry them burned in) and listed as clickable steps that
 * follow playback.
 */
function Video({ src, track }: { src: string; track: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [time, setTime] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCues([]);
    fetch(track)
      .then(async (res) => (res.ok ? parseVtt(await res.text()) : []))
      .catch(() => [])
      .then((c) => {
        if (!cancelled) setCues(c);
      });
    return () => {
      cancelled = true;
    };
  }, [track]);

  const seek = (t: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = t;
    if (v.paused) void v.play().catch(() => undefined);
  };

  return (
    <>
      <video ref={ref} controls preload="metadata" src={src} onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}>
        {cues.length > 0 && <track kind="captions" src={track} srcLang="en" label="Agent captions" />}
      </video>
      {cues.length > 0 && (
        <ol className="video-steps">
          {cues.map((c, i) => (
            <li key={i} className={time >= c.start && time < c.end ? "current" : undefined}>
              <button type="button" onClick={() => seek(c.start)} title="Jump to this moment">
                <span className="video-step-time">{formatTime(c.start)}</span>
                <span>{c.text}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** WebVTT cues (timing line + text); the header, notes and styling blocks are skipped. */
function parseVtt(text: string): Cue[] {
  if (!text.startsWith("WEBVTT")) return [];
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = (lines[i] ?? "").split("-->").map((s) => vttSeconds(s.trim().split(/\s+/)[0] ?? ""));
    const body = lines.slice(i + 1).join("\n").trim();
    if (typeof a !== "number" || typeof b !== "number" || body === "") continue;
    cues.push({ start: a, end: b, text: body });
  }
  return cues;
}

function vttSeconds(stamp: string): number | null {
  const m = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(stamp);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Files the user attached to a prompt: media inline, anything else as a chip with its Sandbox path. */
export function UploadedAttachments({ attachments }: { attachments: PromptAttachment[] }) {
  const sessionId = useContext(AttachmentSession);
  if (!sessionId || attachments.length === 0) return null;
  return (
    <div className="attachments uploaded">
      {attachments.map((a) => {
        const kind = mediaKind(a.path);
        return kind ? (
          <AttachmentCard key={a.path} sessionId={sessionId} attachment={{ path: a.path, name: a.name, kind }} />
        ) : (
          <span key={a.path} className="attach-chip ready" title={`/workspace/${a.path} \u00b7 ${a.mimeType}`}>
            <span className="attach-name">{a.name}</span>
            <span className="attach-meta">{formatBytes(a.size)}</span>
            <a className="attach-meta" href={rawFileUrl(sessionId, a.path, true)} download={a.name} title="Download">
              Download
            </a>
          </span>
        );
      })}
    </div>
  );
}

/** Embeds for every Workspace media file a message mentions (no-op outside a Session). */
export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const sessionId = useContext(AttachmentSession);
  if (!sessionId || attachments.length === 0) return null;
  return (
    <div className="attachments">
      {attachments.map((a) => (
        <AttachmentCard key={a.path} sessionId={sessionId} attachment={a} />
      ))}
    </div>
  );
}
