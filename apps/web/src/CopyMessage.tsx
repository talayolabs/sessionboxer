import { useEffect, useRef, useState, type ReactNode } from "react";
import { writeClipboard } from "./clipboard";

const INLINE_PROPS = ["color", "background-color", "font-weight", "font-style", "text-decoration-line"] as const;

function inlineStyles(from: Element, to: HTMLElement, props: readonly string[]): void {
  const cs = getComputedStyle(from);
  for (const p of props) to.style.setProperty(p, cs.getPropertyValue(p));
}

/** The rendered message as standalone HTML: page chrome (file links, attachment cards) removed, the
 *  syntax colours of code blocks inlined since they come from CSS classes the target has not got. */
function renderedHtml(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll(".attachment, .msg-copy, .msg-time")) el.remove();
  for (const el of clone.querySelectorAll(".file-link")) {
    el.removeAttribute("role");
    el.removeAttribute("tabindex");
    el.removeAttribute("title");
    el.removeAttribute("class");
  }
  const pres = root.querySelectorAll("pre");
  const clonedPres = clone.querySelectorAll("pre");
  pres.forEach((pre, i) => {
    const target = clonedPres[i];
    if (!target) return;
    inlineStyles(pre, target, INLINE_PROPS);
    target.style.fontFamily = "monospace";
    target.style.padding = "8px 10px";
    target.style.borderRadius = "6px";
    const spans = pre.querySelectorAll("span");
    const clonedSpans = target.querySelectorAll("span");
    spans.forEach((span, j) => {
      const t = clonedSpans[j];
      if (t) inlineStyles(span, t, INLINE_PROPS);
    });
  });
  for (const code of clone.querySelectorAll("code")) code.style.fontFamily = "monospace";
  return clone.innerHTML;
}

type Copied = "raw" | "rich" | null;

/** A chat message box with Copy (the Markdown source) and Copy rich (formatted) in its corner; `footer` sits at its bottom-right (the time). */
export function CopyableMessage({ className, text, footer, children }: { className: string; text: string; footer?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<Copied>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied && !failed) return;
    const t = setTimeout(() => {
      setCopied(null);
      setFailed(false);
    }, 1500);
    return () => clearTimeout(t);
  }, [copied, failed]);

  const copy = async (mode: Exclude<Copied, null>) => {
    try {
      const html = mode === "rich" && ref.current ? renderedHtml(ref.current) : undefined;
      await writeClipboard(text, html);
      setCopied(mode);
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className={`msg ${className}`} ref={ref}>
      <div className="msg-copy" aria-label="Copy message">
        <button type="button" className="small" title="Copy the message as Markdown" onClick={() => void copy("raw")}>
          {failed ? "Failed" : copied === "raw" ? "Copied" : "Copy"}
        </button>
        <button type="button" className="small" title="Copy the message as rich text (formatting kept when pasting into documents or mail)" onClick={() => void copy("rich")}>
          {failed ? "Failed" : copied === "rich" ? "Copied" : "Copy rich"}
        </button>
      </div>
      {children}
      {footer}
    </div>
  );
}
