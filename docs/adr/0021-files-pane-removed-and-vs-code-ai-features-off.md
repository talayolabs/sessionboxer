# Files pane removed; VS Code's AI features switched off in the Sandbox

The Files pane (tree + Monaco editor, ADR-0006/0017/0018) was the way to look at and edit Workspace files before VS Code ran in the Sandbox (ADR-0019). With the Code pane, it was a second, weaker editor with its own file-tree, watcher and JSON-RPC surface to keep in step, and it shipped Monaco (and its five web workers) in the bundle for that alone. Separately, the VS Code that runs in the box shows its built-in AI affordances (Copilot status item, "Toggle Chat", the Chat view and the many `Chat:` commands) even though no AI extension is installed there, which reads as a second agent next to the one in the chat.

## Decisions

### Files pane removed

- Removed: the `Files` pane and `Files.tsx`, the Monaco setup (`monaco.ts`, `monaco-editor`, `@monaco-editor/react`), the `fsList` / `fsRead` / `fsWrite` API methods and REST routes (`/api/sessions/:id/fs`, `/fs/file`), the `_sessionboxer/fs/list|read|write` Daemon RPCs, the chokidar Workspace watcher with its `_sessionboxer/fs/changed` notification and the `fs_changed` UI broadcast, and the `FsEntry` / `FsListResult` / `FsReadResult` / `FsWrite*` / `FsChange*` protocol types.
- Kept, because the chat depends on them: `GET /fs/raw` on the Daemon (proxied as `/api/sessions/:id/fs/raw`) with its lexical + realpath containment (`WorkspaceFs.raw`, now the class's only job), the `AttachmentCard` / `DocumentView` / `Markdown` / `Mermaid` components that render files named in agent replies, and the manifest + tar RPCs behind **Pull to folder…** (ADR-0020).
- Editing files by hand is the Code pane's job; the Terminal pane covers the rest. `localStorage` values of `files` for the pane selection fall back to Desktop.

### VS Code AI features off

- `images/sandbox/openvscode-machine-settings.json` (installed as `~/.openvscode-server/data/Machine/settings.json`) now sets `chat.disableAIFeatures: true` (VS Code's own switch: hides the Chat view, the title-bar chat button, the Copilot status item and the chat/agent commands), `chat.agent.enabled: false`, `editor.inlineSuggest.enabled: false` (no ghost-text completions if a provider ever gets installed) and `workbench.settings.showAISearchToggle: false`.
- Machine settings rather than a locked policy: the user can flip `chat.disableAIFeatures` back in the box's settings if they want VS Code's Copilot; the intent is a clean default, not a prohibition. The one remaining `Chat:` command is VS Code's "Use AI Features with Copilot for free…" re-enable entry point.
- Verified on the rebuilt image with the settings file present vs. removed: present → no "Toggle Chat" in the command center, no "Copilot status" item, command palette lists one `Chat:` entry; removed → both items back and the full `Chat …` command list.

## Consequences

- Smaller web bundle (Monaco and its workers gone), one fewer dependency in the Daemon (chokidar), no filesystem watcher running in every Sandbox.
- No in-app file editing outside VS Code; Markdown files still render in the chat when the agent names them, but there is no Preview/Edit toggle for arbitrary `.md` files any more (open them in the Code pane).
- ADR-0017/0018/0019 mention the Files pane where it existed at the time; they are left as written.
