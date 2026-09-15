# Sessionboxer

A local, self-hosted session manager for coding agents. Every Session gets its own Docker Sandbox with a Linux desktop; the Agent (Claude Code first) drives it like a human would (mouse, keyboard, screenshots) while you watch, edit files and open terminals from a browser UI.

Vocabulary lives in [CONTEXT.md](./CONTEXT.md). Hard decisions live in [docs/adr](./docs/adr). This file is the MVP plan that came out of the design session.

## Shape

```
┌──────────────── host (your machine) ────────────────┐
│  Control Plane  (Node, Hono + WS, dockerode, SQLite) │
│  Web UI         (React/Vite: chat, noVNC, Monaco,    │
│                  xterm.js)   http://127.0.0.1:4000   │
│         │ Docker network, no published ports         │
│   ┌─────┴───── Sandbox (one per Session) ─────────┐  │
│   │ Sandbox Daemon ── ACP/stdio ── claude-agent-acp│  │
│   │      (also serves _sessionboxer/fs and /pty)  │  │
│   │ Xvfb :1 1024x768 + xfce4 + x11vnc + noVNC     │  │
│   │ computer-use MCP (xdotool, screenshots)       │  │
│   │ Workspace  (/workspace, seeded from Source)   │  │
│   └───────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

- Agent runs inside the Sandbox with `bypassPermissions`; the container is the safety boundary (ADR-0001, ADR-0003).
- Auth is the user's Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN`, entered once in the UI, injected per Sandbox (ADR-0002).
- Desktop is X11 driven by a Sessionboxer-owned MCP server mirroring Anthropic's `computer` toolset, because Claude Code's built-in computer-use is macOS-only (ADR-0004).
- Sandboxes publish no host ports; the Control Plane proxies chat, noVNC and terminals under `/sessions/:id/...` (ADR-0005).
- The Daemon speaks ACP to the Agent so other Providers (Codex, Gemini CLI, OpenCode) are an adapter install away (ADR-0006).

## MVP decisions

| Topic | Decision |
| --- | --- |
| Target | Linux host, Claude Code only, Docker Engine on the same machine |
| Workspace Source | git clone URL, copy of a host directory (tar via Docker `putArchive`, `git ls-files -co --exclude-standard` + `.git` when it is a repo), or empty |
| UI | chat with inline screenshots and collapsed tool calls, live Desktop (view-only by default, "take control" toggle), file tree + Monaco (last write wins, watcher pushes disk changes), terminal |
| Session states | `creating` → `idle` → `running` → `stopped` → (`error`); `deleted` removes container and volume; stop during `running` sends `session/cancel` first |
| Session title | auto from first prompt, editable |
| Persistence | Control Plane SQLite (`better-sqlite3`) holds Session metadata and the normalized ACP `session/update` stream; the Agent's own history stays in the container for resume |
| Reconnect | Daemon ring-buffers the current turn with sequence numbers; Control Plane resumes from last seen seq |
| Image | one `sessionboxer/sandbox:dev` built locally: Ubuntu 24.04, Node 22, Python 3, git, curl, build-essential, gh, Firefox ESR, xdotool, scrot/ImageMagick, xfce4, Xvfb, x11vnc, noVNC; Daemon and MCP compiled in; global `CLAUDE.md` describing the Desktop |
| Display | fixed 1024x768, screenshots unscaled |
| Limits | 2 CPUs, 4 GB RAM per Sandbox, global setting |
| Git | user.name/email injected; no GitHub token in Sandboxes for MVP |
| Model | Provider defaults; per-Session settings object reserved in the schema |
| Control Plane | runs on the host, binds `127.0.0.1:4000`, no auth |
| Provider secrets | per-Provider map in `~/.sessionboxer/config.json` (0600), only the Session's Provider gets its env vars |

## Repository layout

npm workspaces:

```
apps/control-plane      Hono + WebSocket + dockerode + better-sqlite3 (host)
apps/web                React/Vite UI: chat, live Desktop (noVNC), Files (Monaco), Terminal (xterm.js)
apps/cli                `sessionboxer` command: serve the Control Plane, `new .`, ls/open/stop/resume/rm
packages/sandbox-daemon runs in every Sandbox: ACP client for the Agent, JSON-RPC over WS for the Control Plane
packages/computer-use-mcp  stdio MCP server mirroring Anthropic's computer toolset
packages/protocol       shared zod types + JSON-RPC framing
images/sandbox          Dockerfile (desktop stack + claude-code + claude-agent-acp + daemon + MCP)
```

## Running it

Requires Docker, Node 22 and a token from `claude setup-token`.

```sh
npm install
npm run build:image        # sessionboxer/sandbox:dev, ~3 GB, rebuild after changing the daemon/MCP/image
npm run build
npm start                  # http://127.0.0.1:4000  (same as `npx sessionboxer serve`)
```

Open the UI, paste the token under Settings (stored in `~/.sessionboxer/config.json`, mode 0600; `CLAUDE_CODE_OAUTH_TOKEN` in the Control Plane's environment overrides it), create a Session, prompt. Each Session is one container `sbx-<id>` on the private `sessionboxer` Docker network with no host ports; **Stop** keeps the container for **Resume** (Claude Code history is reloaded via ACP `session/load`), **Delete** removes it. Session metadata and the normalized event stream live in `~/.sessionboxer/db.sqlite`.

The Desktop pane is the Sandbox's screen streamed over `GET /api/sessions/:id/desktop` (RFB over WebSocket, bridged by the Control Plane to websockify inside the container). It is view-only while the Agent is `running`; **Take control** shares the Agent's mouse and keyboard until the next turn starts. An `idle` Sandbox is always interactive.

The Files pane lists the Workspace and edits files in Monaco through the Sandbox Daemon (`_sessionboxer/fs/list|read|write`, proxied as `GET /api/sessions/:id/fs?path=`, `GET|PUT /api/sessions/:id/fs/file`). Paths are Workspace-relative and may not escape it, symlinks included. Saves are last-write-wins; the Daemon watches the Workspace (chokidar, ignoring `.git`, `node_modules`, `.venv`, `__pycache__`, `.cache`) and pushes `fs_changed` over the UI WebSocket, so an open editor reloads the Agent's edits, or warns when you also have unsaved changes. Binary files and files over 2 MB are not opened.

The Terminal pane runs `bash -l` shells in the Workspace, owned by the Sandbox Daemon (node-pty; `_sessionboxer/pty/list|open|attach|input|resize|close`, output and exit as notifications). The Control Plane exposes them as `GET|POST /api/sessions/:id/terminals`, `DELETE /api/sessions/:id/terminals/:ptyId` and one WebSocket per terminal at `/api/sessions/:id/terminals/:ptyId/ws` (binary frames are raw bytes both ways, text frames are JSON control messages: `attached`, `exit`, `error`, `resize`). The Daemon keeps the last 256 KiB of output per terminal, so a page reload reattaches with scrollback; exited shells stay listed for five minutes. Terminals die with the Sandbox on **Stop**; **Resume** opens a fresh one.

**Workspace Sources.** *Empty*, *git clone* (`git clone [--branch ref] url` inside the Sandbox) or *copy a host directory*: the Control Plane tars the directory (the path must be absolute; it runs on your machine, so no bind mount) and streams it into `/workspace` with Docker `putArchive`. Inside a git work tree only tracked and untracked-but-not-ignored files are copied (`git ls-files -co --exclude-standard`, so `node_modules`, build output and secrets in `.gitignore` stay behind), plus `.git` when the directory is the repository root; any other directory is copied whole. Symlinks are copied as symlinks. The copy is one-way: nothing in the Sandbox writes back to the host.

**CLI.** `npx sessionboxer` (from this checkout; `npm link -w @sessionboxer/cli` to have it on your PATH) talks to a running Control Plane (`SESSIONBOXER_URL`, default `http://127.0.0.1:4000`) and opens the browser on the new Session:

```sh
sessionboxer serve                          # run the Control Plane in the foreground
sessionboxer new .                          # box the current directory
sessionboxer new . -p "run the tests and fix what breaks"
sessionboxer new --git https://github.com/org/repo.git --ref main
sessionboxer new --empty -t scratch --no-open
sessionboxer ls | open <id> | stop <id> | resume <id> | rm <id>
```

Dev loop for the UI: `npm run dev -w @sessionboxer/web` (Vite on :5173, proxies `/api` to :4000).

## Milestones

- **M0 spike (gate for ADR-0006), done**: build the image; run `claude-agent-acp` with `CLAUDE_CODE_OAUTH_TOKEN` and the computer-use MCP by hand; the Agent takes a screenshot, opens Firefox, clicks something. Result recorded in ADR-0006.
- **M1, done**: Control Plane + Daemon: create / stop / resume / delete Sessions, chat over ACP, SQLite history, token onboarding, event replay after Control Plane restart.
- **M2, done**: live Desktop in the UI (noVNC proxied through the Control Plane, view-only while the Agent runs, explicit takeover).
- **M3, done**: file tree + Monaco editor (Daemon fs RPC + Workspace watcher, external-change handling).
- **M4, done**: terminal (Daemon PTYs over the existing connection, xterm.js pane with reattach).
- **M5, done**: "copy host directory" Workspace Source (git-aware tar into the Sandbox), `sessionboxer` CLI wrapper; Settings (token, git identity, Sandbox CPU/memory) had landed with M1.

## Running the M0 spike by hand

Requires Docker, Node 22 and a token from `claude setup-token`.

```sh
npm install
npm run build:image                       # sessionboxer/sandbox:dev, ~3 GB
docker network create sessionboxer-spike
docker run -d --name sbx-spike --network sessionboxer-spike \
  --cpus 2 --memory 4g sessionboxer/sandbox:dev
docker cp scripts/spike-acp.mjs sbx-spike:/tmp/spike-acp.mjs
docker exec -e CLAUDE_CODE_OAUTH_TOKEN sbx-spike node /tmp/spike-acp.mjs \
  "Take a screenshot, open https://example.com in Firefox, take another screenshot."
```

The token is passed as an environment variable at `docker exec` time only. Screenshots the Agent took land in `/tmp/acp-*.png` inside the container; the Desktop is viewable at `http://sbx-spike:6080/vnc.html` from any container on the same network (no host ports are published).
