import type { Element, ElementContent } from "hast";
import { useContext, useMemo } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { AttachmentList, AttachmentSession } from "./Attachments";
import { findAttachments, rawFileUrl, workspacePath } from "./attachment-paths";
import { GRAMMARS } from "./highlight";
import { Mermaid } from "./Mermaid";

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [[rehypeHighlight, { languages: GRAMMARS, plainText: ["mermaid"] }]];

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
 * below it, and links to Workspace files open the file from the Sandbox. Fenced code is highlighted;
 * ```mermaid blocks are drawn as diagrams. `base` is the Workspace directory relative links resolve
 * against (the folder of a .md file being previewed).
 */
export function Markdown({ text, attachments = false, base = "" }: { text: string; attachments?: boolean; base?: string }) {
  const sessionId = useContext(AttachmentSession);
  const found = useMemo(() => (attachments && sessionId ? findAttachments(text) : []), [attachments, sessionId, text]);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{
          pre: Pre,
          a: ({ children, href }) => (
            <a href={href ? resolveHref(sessionId, href, base) : href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          img: ({ src, alt }) => <img src={typeof src === "string" ? resolveHref(sessionId, src, base) : src} alt={alt ?? ""} loading="lazy" />,
        }}
      >
        {text}
      </ReactMarkdown>
      <AttachmentList attachments={found} />
    </div>
  );
}
