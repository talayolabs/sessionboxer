import { useContext, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { AttachmentList, AttachmentSession } from "./Attachments";
import { findAttachments, rawFileUrl, workspacePath } from "./attachment-paths";

const PLUGINS = [remarkGfm, remarkBreaks];

/** Links to Workspace files point at the Sandbox's copy; anything else is left alone. */
function resolveHref(sessionId: string | null, href: string): string {
  if (!sessionId) return href;
  const rel = workspacePath(href);
  return rel ? rawFileUrl(sessionId, rel) : href;
}

/**
 * Renders Agent/user text as GitHub-flavoured Markdown; plain text reads as before (newlines kept).
 * With `attachments`, Workspace media files the text mentions (`/workspace/demo.mp4`) are embedded
 * below it, and links to Workspace files open the file from the Sandbox.
 */
export function Markdown({ text, attachments = false }: { text: string; attachments?: boolean }) {
  const sessionId = useContext(AttachmentSession);
  const found = useMemo(() => (attachments && sessionId ? findAttachments(text) : []), [attachments, sessionId, text]);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={PLUGINS}
        components={{
          a: ({ children, href }) => (
            <a href={href ? resolveHref(sessionId, href) : href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          img: ({ src, alt }) => <img src={typeof src === "string" ? resolveHref(sessionId, src) : src} alt={alt ?? ""} loading="lazy" />,
        }}
      >
        {text}
      </ReactMarkdown>
      <AttachmentList attachments={found} />
    </div>
  );
}
