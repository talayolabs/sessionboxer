import type { Element, ElementContent } from "hast";
import { useContext, useMemo } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { AttachmentList, AttachmentSession } from "./Attachments";
import { findAttachments, rawFileUrl, workspacePath } from "./attachment-paths";
import { FileLink, OpenFile } from "./FileLink";
import { parseFileRef, refOf, rehypeFileLinks } from "./file-links";
import { GRAMMARS } from "./highlight";
import { Mermaid } from "./Mermaid";

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const HIGHLIGHT: NonNullable<Options["rehypePlugins"]>[number] = [rehypeHighlight, { languages: GRAMMARS, plainText: ["mermaid"] }];
const REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [HIGHLIGHT];

function textOf(nodes: ElementContent[]): string {
  return nodes.map((n) => (n.type === "text" ? n.value : n.type === "element" ? textOf(n.children) : "")).join("");
}

/** The ```mermaid source when this <pre> holds one, else null. */
function mermaidSource(pre: Element | undefined): string | null {
  const code = pre?.children[0];
  if (!code || code.type !== "element" || code.tagName !== "code") return null;
  const cls = code.properties.className;
  const classes = Array.isArray(cls) ? cls.map(String) : [];
  return classes.includes("language-mermaid") ? textOf(code.children) : null;
}

const Pre: Components["pre"] = ({ node, children, ...rest }) => {
  const source = mermaidSource(node);
  return source !== null ? <Mermaid code={source} /> : <pre {...rest}>{children}</pre>;
};

/** Links to Workspace files point at the Sandbox's copy; anything else is left alone. */
function resolveHref(sessionId: string | null, href: string, base: string): string {
  if (!sessionId) return href;
  const rel = workspacePath(href, base);
  return rel ? rawFileUrl(sessionId, rel) : href;
}

/**
 * Renders Agent/user text as GitHub-flavoured Markdown; plain text reads as before (newlines kept).
 * With `attachments`, Workspace media files the text mentions (`/workspace/demo.mp4`) are embedded
 * below it, and links to Workspace files open the file from the Sandbox. Where a Code pane is
 * around (`OpenFile` context), paths to Workspace source files in prose, inline code or links
 * (`src/App.tsx:42`) open the file there instead. Fenced code is highlighted; ```mermaid blocks
 * are drawn as diagrams. `base` is the Workspace directory relative links resolve against (the
 * folder of a .md file being previewed).
 */
export function Markdown({ text, attachments = false, base = "" }: { text: string; attachments?: boolean; base?: string }) {
  const sessionId = useContext(AttachmentSession);
  const openFile = useContext(OpenFile);
  const found = useMemo(() => (attachments && sessionId ? findAttachments(text) : []), [attachments, sessionId, text]);
  const rehypePlugins = useMemo<NonNullable<Options["rehypePlugins"]>>(
    () => (openFile ? [HIGHLIGHT, [rehypeFileLinks, { base }]] : REHYPE_PLUGINS),
    [openFile, base],
  );
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={{
          pre: Pre,
          code: ({ node, children, ...rest }) => {
            const ref = refOf(node?.properties);
            return ref ? (
              <FileLink fileRef={ref}>
                <code {...rest}>{children}</code>
              </FileLink>
            ) : (
              <code {...rest}>{children}</code>
            );
          },
          a: ({ node, children, href }) => {
            const ref = openFile ? (refOf(node?.properties) ?? (href ? parseFileRef(href, base) : null)) : null;
            if (ref) return <FileLink fileRef={ref}>{children}</FileLink>;
            return (
              <a href={href ? resolveHref(sessionId, href, base) : href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          img: ({ src, alt }) => <img src={typeof src === "string" ? resolveHref(sessionId, src, base) : src} alt={alt ?? ""} loading="lazy" />,
        }}
      >
        {text}
      </ReactMarkdown>
      <AttachmentList attachments={found} />
    </div>
  );
}
