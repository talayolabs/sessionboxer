import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";

export type ComposerMode = "raw" | "rich";

// Markdown is the source of truth in both modes: the rich editor parses it on entry and
// serializes back on every change, so switching modes never loses content.
export type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Keep the text for later instead of sending it (Ctrl+S). */
  onSave: () => void;
  disabled: boolean;
  placeholder: string;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  zen: boolean;
  onZenChange: (zen: boolean) => void;
  /** Explicit height as a fraction of the chat column; null means "fit to content". */
  heightFrac: number | null;
  onHeightFracChange: (frac: number | null) => void;
  chatRef: RefObject<HTMLDivElement | null>;
  /** Rendered above the toolbar (the saved-messages list). */
  above?: ReactNode;
  /** Enables the "Translate to English" tooltip on selected text; resolves with the replacement. */
  onTranslate?: (text: string) => Promise<string>;
};

/** A non-empty selection in the active editor and where its first line sits on screen. */
type Selection = { start: number; end: number; text: string; x: number; y: number };

const SELECTION_TIP_GAP = 8;

/**
 * Screen position of a textarea selection's first line, via a hidden mirror of
 * the textarea's text and metrics (textareas expose no Range API).
 */
function textareaSelectionAnchor(ta: HTMLTextAreaElement, start: number, end: number): { x: number; y: number } | null {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  for (const prop of [
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "lineHeight",
    "tabSize",
    "textTransform",
    "textIndent",
    "wordSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
  ] as const) {
    mirror.style[prop] = cs[prop];
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.boxSizing = "border-box";
  // clientWidth excludes a vertical scrollbar, so lines wrap where the textarea wraps them.
  mirror.style.width = `${ta.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)}px`;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  const text = ta.value;
  mirror.append(document.createTextNode(text.slice(0, start)));
  const from = document.createElement("span");
  from.textContent = text.slice(start, end);
  mirror.append(from);
  const to = document.createElement("span");
  to.textContent = "\u200b";
  mirror.append(to);
  document.body.append(mirror);
  try {
    const rect = ta.getBoundingClientRect();
    const originX = rect.left + parseFloat(cs.borderLeftWidth) - ta.scrollLeft;
    const top = rect.top + parseFloat(cs.borderTopWidth) + from.offsetTop - ta.scrollTop;
    const sameLine = Math.abs(to.offsetTop - from.offsetTop) < 1;
    const left = originX + from.offsetLeft;
    const right = sameLine ? originX + to.offsetLeft : rect.right - parseFloat(cs.paddingRight);
    if (top < rect.top || top > rect.bottom) return null;
    return { x: (left + right) / 2, y: top };
  } finally {
    mirror.remove();
  }
}

export const COMPOSER_MIN_FRAC = 0.1;
export const COMPOSER_MAX_FRAC = 0.95;

type ToolAction =
  | "heading"
  | "bold"
  | "italic"
  | "strike"
  | "quote"
  | "code"
  | "codeBlock"
  | "link"
  | "bulletList"
  | "orderedList"
  | "taskList";

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  quote: "M3 4h10M3 8h6M3 12h10",
  link: "M6.5 9.5l3-3M5 11l-1 1a2.1 2.1 0 0 1-3-3l2.5-2.5a2.1 2.1 0 0 1 3 0M11 5l1-1a2.1 2.1 0 0 1 3 3l-2.5 2.5a2.1 2.1 0 0 1-3 0",
  bulletList: "M6 4h8M6 8h8M6 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01",
  taskList: "M2 3.5l1.5 1.5L6 2.5M9 4h5M2 9.5l1.5 1.5L6 8.5M9 10h5",
  zen: "M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4",
  exitZen: "M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4",
};

const TOOLS: Array<{ id: ToolAction; label: ReactNode; title: string; className?: string }> = [
  { id: "heading", label: "H", title: "Heading", className: "tb-bold" },
  { id: "bold", label: "B", title: "Bold (Ctrl+B)", className: "tb-bold" },
  { id: "italic", label: "I", title: "Italic (Ctrl+I)", className: "tb-italic" },
  { id: "strike", label: "S", title: "Strikethrough", className: "tb-strike" },
  { id: "quote", label: <Icon d={ICONS.quote} />, title: "Quote" },
  { id: "code", label: "<>", title: "Code", className: "tb-mono" },
  { id: "codeBlock", label: "```", title: "Code block", className: "tb-mono" },
  { id: "link", label: <Icon d={ICONS.link} />, title: "Link" },
  { id: "bulletList", label: <Icon d={ICONS.bulletList} />, title: "Bulleted list" },
  { id: "orderedList", label: "1.", title: "Numbered list" },
  { id: "taskList", label: <Icon d={ICONS.taskList} />, title: "Task list" },
];

function isSendKey(e: KeyboardEvent | globalThis.KeyboardEvent): boolean {
  return e.key === "Enter" && (e.ctrlKey || e.metaKey);
}

export function Composer(props: ComposerProps) {
  const { value, onChange, onSend, onSave, disabled, placeholder, mode, onModeChange, zen, onZenChange, heightFrac, onHeightFracChange, chatRef, above, onTranslate } =
    props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  // The tooltip stays put while a translation is pending, and an error stays
  // readable until the next real selection (typing collapses the selection).
  const pinned = useRef({ translating: false, error: false });
  pinned.current = { translating, error: translateError !== null };

  const collapse = useCallback(() => {
    if (pinned.current.translating || pinned.current.error) return;
    setSelection(null);
  }, []);
  const dismiss = useCallback(() => {
    if (pinned.current.translating) return;
    setSelection(null);
    setTranslateError(null);
  }, []);

  const trackRawSelection = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta || ta.selectionStart === ta.selectionEnd) {
      collapse();
      return;
    }
    if (pinned.current.translating) return;
    setTranslateError(null);
    const { selectionStart: start, selectionEnd: end } = ta;
    const anchor = textareaSelectionAnchor(ta, start, end);
    setSelection(anchor ? { start, end, text: ta.value.slice(start, end), ...anchor } : null);
  }, [collapse]);

  useEffect(() => {
    if (!editor) return;
    const track = () => {
      const { from, to, empty } = editor.state.selection;
      const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
      if (empty || !range || !editor.isFocused) {
        collapse();
        return;
      }
      if (pinned.current.translating) return;
      setTranslateError(null);
      const rects = range.getClientRects();
      const box = range.getBoundingClientRect();
      const first = rects[0] ?? box;
      const x = rects.length > 1 ? (box.left + box.right) / 2 : (first.left + first.right) / 2;
      setSelection({ start: from, end: to, text: editor.state.doc.textBetween(from, to, "\n"), x, y: first.top });
    };
    editor.on("selectionUpdate", track);
    editor.on("blur", dismiss);
    return () => {
      editor.off("selectionUpdate", track);
      editor.off("blur", dismiss);
    };
  }, [editor, collapse, dismiss]);

  useEffect(() => {
    setSelection(null);
    setTranslateError(null);
  }, [mode]);

  const translate = async () => {
    if (!selection || !onTranslate || translating) return;
    const { start, end, text } = selection;
    const inRaw = mode === "raw";
    setTranslating(true);
    setTranslateError(null);
    try {
      const out = await onTranslate(text);
      if (inRaw) {
        const cur = valueRef.current;
        if (cur.slice(start, end) !== text) throw new Error("The selected text changed meanwhile");
        onChange(cur.slice(0, start) + out + cur.slice(end));
        const ta = textareaRef.current;
        requestAnimationFrame(() => {
          ta?.focus();
          ta?.setSelectionRange(start + out.length, start + out.length);
        });
      } else {
        if (!editor) throw new Error("Editor is gone");
        if (editor.state.doc.textBetween(start, end, "\n") !== text) throw new Error("The selected text changed meanwhile");
        editor.view.dispatch(editor.state.tr.insertText(out, start, end));
        editor.commands.focus();
      }
      setSelection(null);
    } catch (e) {
      setTranslateError(e instanceof Error ? e.message : String(e));
    } finally {
      setTranslating(false);
    }
  };

  useEffect(() => {
    if (!zen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onZenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zen, onZenChange]);

  const applyRaw = useCallback(
    (action: ToolAction) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const next = applyMarkdownAction(action, value, ta.selectionStart, ta.selectionEnd);
      onChange(next.text);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(next.start, next.end);
      });
    },
    [value, onChange],
  );

  const applyRich = useCallback(
    (action: ToolAction) => {
      if (!editor) return;
      const chain = editor.chain().focus();
      switch (action) {
        case "heading":
          chain.toggleHeading({ level: 3 }).run();
          break;
        case "bold":
          chain.toggleBold().run();
          break;
        case "italic":
          chain.toggleItalic().run();
          break;
        case "strike":
          chain.toggleStrike().run();
          break;
        case "quote":
          chain.toggleBlockquote().run();
          break;
        case "code":
          chain.toggleCode().run();
          break;
        case "codeBlock":
          chain.toggleCodeBlock().run();
          break;
        case "link": {
          if (editor.isActive("link")) {
            chain.unsetLink().run();
            break;
          }
          const href = window.prompt("Link URL", "https://");
          if (!href) break;
          if (editor.state.selection.empty) chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
          else chain.setLink({ href }).run();
          break;
        }
        case "bulletList":
          chain.toggleBulletList().run();
          break;
        case "orderedList":
          chain.toggleOrderedList().run();
          break;
        case "taskList":
          chain.toggleList("taskList", "taskItem").run();
          break;
      }
    },
    [editor],
  );

  const apply = mode === "raw" ? applyRaw : applyRich;
  const isActive = (action: ToolAction): boolean => {
    if (mode !== "rich" || !editor) return false;
    switch (action) {
      case "heading":
        return editor.isActive("heading");
      case "quote":
        return editor.isActive("blockquote");
      case "taskList":
        return editor.isActive("taskList");
      default:
        return editor.isActive(action);
    }
  };

  const onSplitterPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const chat = chatRef.current;
    if (!chat || zen) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = chat.getBoundingClientRect();
      const frac = (rect.bottom - ev.clientY) / rect.height;
      onHeightFracChange(Math.min(COMPOSER_MAX_FRAC, Math.max(COMPOSER_MIN_FRAC, frac)));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const hasText = value.trim().length > 0;
  const canSend = !disabled && hasText;
  const sized = heightFrac !== null && !zen;
  const onSaveKey = (e: KeyboardEvent): boolean => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (hasText) onSave();
      return true;
    }
    return false;
  };

  return (
    <>
      {!zen && (
        <div
          className="splitter"
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize; double-click to reset"
          onPointerDown={onSplitterPointerDown}
          onDoubleClick={() => onHeightFracChange(null)}
        />
      )}
      <form
        className={`composer${zen ? " zen" : ""}${sized ? " sized" : ""}`}
        style={sized ? { height: `${heightFrac * 100}%` } : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
        onKeyDown={onSaveKey}
      >
        {above}
        <div className="toolbar" role="toolbar" aria-label="Formatting">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tb${t.className ? ` ${t.className}` : ""}${isActive(t.id) ? " active" : ""}`}
              title={t.title}
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => apply(t.id)}
            >
              {t.label}
            </button>
          ))}
          <span className="spacer" />
          <div className="segmented small" role="tablist" aria-label="Editor mode">
            <button type="button" role="tab" aria-selected={mode === "raw"} className={mode === "raw" ? "active" : ""} onClick={() => onModeChange("raw")}>
              Markdown
            </button>
            <button type="button" role="tab" aria-selected={mode === "rich"} className={mode === "rich" ? "active" : ""} onClick={() => onModeChange("rich")}>
              Rich text
            </button>
          </div>
          <button type="button" className="tb" title={zen ? "Exit zen mode (Esc)" : "Zen mode"} aria-pressed={zen} onClick={() => onZenChange(!zen)}>
            <Icon d={zen ? ICONS.exitZen : ICONS.zen} />
          </button>
        </div>
        <div className="composer-body">
          {mode === "raw" ? (
            <textarea
              ref={textareaRef}
              value={value}
              placeholder={placeholder}
              disabled={disabled}
              rows={sized || zen ? undefined : Math.min(12, Math.max(3, value.split("\n").length))}
              onChange={(e) => onChange(e.target.value)}
              onSelect={trackRawSelection}
              onScroll={trackRawSelection}
              onBlur={dismiss}
              onKeyDown={(e) => {
                if (isSendKey(e) || (e.key === "Enter" && !e.shiftKey && !zen)) {
                  e.preventDefault();
                  onSend();
                } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
                  const k = e.key.toLowerCase();
                  if (k === "b" || k === "i") {
                    e.preventDefault();
                    applyRaw(k === "b" ? "bold" : "italic");
                  }
                }
              }}
            />
          ) : (
            <RichEditor value={value} onChange={onChange} onSend={onSend} disabled={disabled} placeholder={placeholder} onReady={setEditor} />
          )}
        </div>
        {selection && onTranslate && !disabled && (
          <div
            className="selection-tip"
            role="toolbar"
            aria-label="Selection actions"
            style={{ left: selection.x, top: selection.y - SELECTION_TIP_GAP }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {translateError ? (
              <>
                <span className="error">{translateError}</span>
                <button type="button" className="small" onClick={dismiss} aria-label="Dismiss">
                  {"\u00d7"}
                </button>
              </>
            ) : (
              <button type="button" className="small" disabled={translating} onClick={() => void translate()} title="Ask the Session's Provider to translate the selection">
                {translating ? "Translating\u2026" : "Translate to English"}
              </button>
            )}
          </div>
        )}
        <div className="composer-footer">
          <span className="muted hint">
            {mode === "raw" && !zen ? "Enter to send, Shift+Enter for a new line" : "Ctrl+Enter to send"}
            {" \u00b7 "}Markdown
          </span>
          <span className="spacer" />
          <button type="button" title="Keep this message in the Session's saved list (Ctrl+S)" disabled={!hasText} onClick={onSave}>
            Save for later
          </button>
          <button type="submit" className="primary" disabled={!canSend}>
            Send
          </button>
        </div>
      </form>
    </>
  );
}

function RichEditor({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  onReady,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
  onReady: (editor: Editor | null) => void;
}) {
  const lastEmitted = useRef(value);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder }),
      Markdown,
    ],
    content: value,
    contentType: "markdown",
    editable: !disabled,
    editorProps: {
      attributes: { class: "rich-editor" },
      handleKeyDown: (_view, event) => {
        if (isSendKey(event)) {
          event.preventDefault();
          sendRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = ed.isEmpty ? "" : ed.getMarkdown();
      lastEmitted.current = md;
      onChange(md);
    },
  });

  useEffect(() => {
    onReady(editor);
    return () => onReady(null);
  }, [editor, onReady]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  // External changes (a send clearing the box) are pushed in; our own edits are not
  // re-parsed, which would fight the cursor.
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    lastEmitted.current = value;
    if (value === "") editor.commands.clearContent(true);
    else editor.commands.setContent(value, { contentType: "markdown" });
  }, [editor, value]);

  return <EditorContent editor={editor} className="rich-editor-host" />;
}

// --- raw markdown editing helpers ---------------------------------------------------------

type Edit = { text: string; start: number; end: number };

function wrap(text: string, start: number, end: number, before: string, after = before, placeholder = ""): Edit {
  const sel = text.slice(start, end);
  const outerBefore = text.slice(start - before.length, start);
  const outerAfter = text.slice(end, end + after.length);
  if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
    const inner = sel.slice(before.length, sel.length - after.length);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  if (outerBefore === before && outerAfter === after) {
    return { text: text.slice(0, start - before.length) + sel + text.slice(end + after.length), start: start - before.length, end: end - before.length };
  }
  const inner = sel || placeholder;
  return {
    text: text.slice(0, start) + before + inner + after + text.slice(end),
    start: start + before.length,
    end: start + before.length + inner.length,
  };
}

function lineBounds(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  let to = text.indexOf("\n", Math.max(end, start));
  if (to < 0) to = text.length;
  return [from, to];
}

function prefixLines(text: string, start: number, end: number, prefix: (i: number) => string, strip: RegExp): Edit {
  const [from, to] = lineBounds(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const allPrefixed = lines.every((l) => strip.test(l));
  const next = lines.map((l, i) => (allPrefixed ? l.replace(strip, "") : prefix(i) + l.replace(strip, "")));
  const block = next.join("\n");
  return { text: text.slice(0, from) + block + text.slice(to), start: from, end: from + block.length };
}

function blockWrap(text: string, start: number, end: number, fence: string): Edit {
  const [from, to] = lineBounds(text, start, end);
  const body = text.slice(from, to);
  const open = `${fence}\n`;
  const close = `\n${fence}`;
  if (body.startsWith(open) && body.endsWith(close) && body.length >= open.length + close.length) {
    const inner = body.slice(open.length, body.length - close.length);
    return { text: text.slice(0, from) + inner + text.slice(to), start: from, end: from + inner.length };
  }
  return { text: text.slice(0, from) + open + body + close + text.slice(to), start: from + open.length, end: from + open.length + body.length };
}

export function applyMarkdownAction(action: ToolAction, text: string, start: number, end: number): Edit {
  switch (action) {
    case "bold":
      return wrap(text, start, end, "**", "**", "bold text");
    case "italic":
      return wrap(text, start, end, "_", "_", "italic text");
    case "strike":
      return wrap(text, start, end, "~~", "~~", "strikethrough");
    case "code":
      return wrap(text, start, end, "`", "`", "code");
    case "codeBlock":
      return blockWrap(text, start, end, "```");
    case "heading":
      return prefixLines(text, start, end, () => "### ", /^#{1,6}\s+/);
    case "quote":
      return prefixLines(text, start, end, () => "> ", /^>\s?/);
    case "bulletList":
      return prefixLines(text, start, end, () => "- ", /^[-*+]\s+(?!\[[ xX]\]\s)/);
    case "orderedList":
      return prefixLines(text, start, end, (i) => `${i + 1}. `, /^\d+\.\s+/);
    case "taskList":
      return prefixLines(text, start, end, () => "- [ ] ", /^[-*+]\s+\[[ xX]\]\s+/);
    case "link": {
      const sel = text.slice(start, end);
      const label = sel || "link text";
      const url = "url";
      const inserted = `[${label}](${url})`;
      const urlStart = start + 1 + label.length + 2;
      return { text: text.slice(0, start) + inserted + text.slice(end), start: urlStart, end: urlStart + url.length };
    }
  }
}
