import { createContext, useContext, useEffect, useState } from "react";
import { formatBytes } from "./format";
import { rawFileUrl, type Attachment } from "./attachment-paths";

/** Session whose Workspace files the chat may embed; `null` outside a Session. */
export const AttachmentSession = createContext<string | null>(null);

type Probe = { state: "loading" } | { state: "ready"; bytes: number | null } | { state: "error"; message: string };

/** Video / image / PDF from the Sandbox's Workspace, inline with a download button. */
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
      {probe.state === "ready" && <Media kind={attachment.kind} src={src} name={attachment.name} />}
    </figure>
  );
}

function Media({ kind, src, name }: { kind: Attachment["kind"]; src: string; name: string }) {
  switch (kind) {
    case "video":
      return <video controls preload="metadata" src={src} />;
    case "audio":
      return <audio controls preload="metadata" src={src} />;
    case "image":
      return <img src={src} alt={name} loading="lazy" />;
    case "pdf":
      return <iframe src={src} title={name} />;
  }
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
