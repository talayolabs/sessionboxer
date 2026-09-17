# Markdown documents, Mermaid diagrams and syntax highlighting in the Web UI

Agents write Markdown: replies, and files they are asked to produce (`docs/arch.md`, a `.mmd` diagram). ADR-0017 made media files from the Workspace viewable inline; Markdown files still opened as raw text in Monaco, a ```mermaid block was a grey code block, and fenced code had no colours anywhere (chat, rich prompt editor, documents). This ADR covers rendering all three.

## Considered Options

### Syntax highlighting

- **`lowlight` (highlight.js grammars as a virtual-DOM highlighter) shared by both renderers (chosen)**: `rehype-highlight` for `react-markdown` in the chat and documents, `@tiptap/extension-code-block-lowlight` for the rich prompt editor (replacing StarterKit's plain code block; the Markdown extension keeps serialising the node as a fence with its language). One grammar set (`lowlight`'s `common`, ~40 languages, aliases like `ts`/`sh`/`js` included) and one small CSS palette (`.hljs-*`, GitHub-dark-like) in `styles.css`, so a block looks the same in the prompt and in the reply. Unknown languages are left uncoloured; no auto-detection (a fence without a language stays plain, cheaper and never wrong).
- Shiki (rejected): better grammars but WASM + per-language bundles, and no ready tiptap node; Monaco's tokenizer (rejected): heavy to instantiate per code block.

### Mermaid

- **`mermaid` rendered client-side, lazily (chosen)**: a `<Mermaid code>` component calls `mermaid.render()` and injects the SVG. The library (~2 MB) is a dynamic import, fetched the first time a diagram appears, so the app bundle does not pay for it. `securityLevel: "strict"` (Mermaid sanitises labels, no click handlers or scripts) and `suppressErrorRendering` so a syntax error becomes our own error box (message + the source as a code block) instead of Mermaid's bomb SVG, and never throws into React. In `react-markdown` the `pre` component checks the hast node for `code.language-mermaid` and swaps in the component; `rehype-highlight` is told to leave `mermaid` fences as plain text.
- Rendering in the Sandbox (mermaid-cli / headless Chromium) (rejected): a heavy image dependency and a round trip for something the browser does fine.

### Documents

- **Reuse the media pipeline (chosen)**: `MediaKind` gains `markdown` (md, markdown) and `mermaid` (mmd, mermaid), so the same scan of the reply that finds `demo.mp4` finds `docs/arch.md`, the same card (`AttachmentCard`: name, size, Open, Download) hosts it, and the same raw endpoint (`GET /api/sessions/:id/fs/raw`) serves the bytes (now with `text/markdown; charset=utf-8`). `DocumentView` fetches the text and renders `<Markdown>` / `<Mermaid>` inside the card, scrolling past 520 px.
- Relative links and images inside a document (`![](img/a.png)`, `[spec](../spec.md)`) resolve against the document's folder: `Markdown` takes a `base` and `workspacePath(href, base)` collapses `.`/`..` segments, refusing anything that climbs out of the Workspace (falls back to the literal href, which the browser will 404).
- Files pane: `.md`/`.mmd` files open in **Preview** (rendered from the current draft, so edits show as soon as you switch back) with a **Preview | Edit** toggle to get Monaco; Save behaves as before. Truncated (very large) Markdown files go through the card path, which streams the whole file.

## Consequences

- Web deps: `mermaid`, `lowlight`, `rehype-highlight`, `@tiptap/extension-code-block-lowlight`. Mermaid is code-split; the rest adds ~150 kB gzipped to the main bundle.
- Protocol: `MediaKind` widened; `MEDIA_EXTENSIONS` now matches `.md`, so every Workspace `.md` an agent names in a reply gets a card (`README.md` mentions included; a missing file shows "not found"). If that proves noisy, cards for `markdown` can be collapsed by default.
- Daemon: content type for `.md` changed via the shared table; existing boxes serve `application/octet-stream` until Stop → Resume (harmless: the UI reads the body as text either way).
- Web: `highlight.ts` (shared lowlight instance and grammars), `Mermaid.tsx`, `Document.tsx`, `Markdown.tsx` (`pre` override, `base`), `Composer.tsx` (`CodeBlockLowlight`), `Files.tsx` (Preview/Edit), `attachment-paths.ts` (`workspacePath(href, base)`, `dirOf`).
- Not done: Mermaid theme following a light UI theme (the UI is dark-only today), copy button on code blocks, line numbers, clicking a `.md` link inside a document opening it in the Files pane (it opens the raw file in a new tab).
