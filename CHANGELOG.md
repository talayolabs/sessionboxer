# Changelog

## Unreleased

- Fix: with Inspect LLM on, Claude Code took the loopback recorder for a third-party backend and capped the 1M models (Fable, Opus 5, Sonnet 5) at a 200k window — the gauge read `/ 200k` and compaction would have come at a fifth of the real window. The recorder now tells Claude Code it forwards to Anthropic when it does. Daemon change: Stop → Resume existing sessions (ADR-0032).
- Composer: the context gauge is a full-width bar above the formatting toolbar instead of a small footer control.
- Composer: **Save for later** is **Enqueue**, and the queue plays by itself: an enqueued message goes out as soon as the Agent is idle (now, after the current turn, or when a stopped Session resumes) with no *Play all* step; **Pause** / **Resume** hold and release it. A fork's copied queue plays after its first prompt.
- Composer: the Markdown / Rich text pair is a single **Preview** switch (on: formatted editing, off: raw Markdown).
- Color themes: eleven light and dark themes (Sessionboxer, GitHub, Catppuccin, Solarized, Dracula, Nord, One Dark) chosen under Global settings, or following the system with a light and a dark pick; the terminal, diagrams, code blocks and the desktop frame follow, and the VS Code in the Code pane starts in and switches live to the same palette, shipped into the box as a generated VS Code theme. Stored per browser. Needs an image rebuild (ADR-0048).
- Naming: the sidebar's **Settings** is now **Global settings** (button and page title), and the per-session dialog in the header's ⋯ menu is **Session settings**.
- Session header: five tabs with icons — **Desktop**, **Code**, **PRs**, **Verification** and the new **Scheduled** (the scheduled tasks that prompt this session, add and edit them there) — and a **⋯** menu with the rest: Terminal, Context, Snapshot, Fork…, Pull to folder…, Session settings, Stop, Delete, each with an icon. The phone sheet lists the same entries.
- Session header: no more "empty workspace" label — **Add repository…** sits there directly, and once a repository is in the Workspace it becomes a **+** button with the same tooltip next to the repository chips.
- The "Docker (privileged)" label is now a red Docker icon with the warning as tooltip — in the session header, the session list and on the Settings button when Sysbox is missing; Sysbox boxes and sessions without Docker show no Docker icon.
- Session header shows the provider as its logo (Claude Code, Devin, Codex) with the name as a tooltip; the phone sheet keeps the name.
- Inspect LLM is on by default for new Claude Code sessions (New Session and scheduled-task templates pre-check it; forks keep the original's setting).
- Terminal pane: copy and paste work — Ctrl+C with a selection, Ctrl+Shift+C or Ctrl+Insert copy; Ctrl+V, Ctrl+Shift+V or Shift+Insert paste (Ctrl+V used to send `^V` to the shell); right-click menu with Copy, Paste, Select all and Clear, also in the desktop app.
- Scheduled tasks: a page in the sidebar to run a prompt on a cron schedule (with time zone, plain-words preview and next runs), into an existing Session or a new one from a template that stops when the turn ends; Run now, on/off, run history, skip or catch up runs missed while the Control Plane was off, push notification on failure (ADR-0047).
- Codex as a third agent, on your ChatGPT subscription: `codex login` on your machine, paste `~/.codex/auth.json` in Settings; the file lives on tmpfs in the box and refreshed tokens are stored back. Needs an image rebuild (ADR-0046).
- Verify each turn end to end (on by default; Global settings, per-session Session settings, the Verification pane's switch, `sessionboxer new --no-e2e`): after each turn the agent plans 2–5 test cases from your prompt, runs them on the box's desktop while recording, fixes and reruns what fails, and posts the video; the **Verification** pane opens by itself and shows cases, timers and cycles live. Needs an image rebuild (ADR-0044).
- Automatic snapshots after every turn are off by default on a fresh install (a `config.json` that has the setting keeps it); the verification run takes that place (ADR-0044).
- Docker inside Sandboxes now uses `192.168.240.0/20` instead of Docker's `172.17.0.0/16`, so company or VPN hosts in 172.16–31.x stop failing with "No route to host" from Docker-enabled sessions; change it under Settings → **Addresses for Docker inside Sandboxes**. Needs an image rebuild (ADR-0045).

## 1.0.0 — 2026-09-22

Install: `npx sessionboxer@1.0.0 serve`, the desktop installers below, `docker compose up` with
this release's `docker-compose.yml`, or `curl -fsSL https://sessionboxer.talayolabs.com/install.sh | sh`.
Upgrading from 0.1.0: the Sandbox image changed (`ghcr.io/talayolabs/sessionboxer-sandbox:1.0.0`
is pulled on first use; `npm run build:image` for source installs).

- `sessionboxer service install|…`: run the Control Plane as a background service of your user account (launchd on macOS, systemd user unit on Linux), started at login.
- Desktop app, first cut: an Electron tray shell that runs the Control Plane and shows the web UI in a window; no Node install needed, Docker still is (ADR-0043). Installers for Linux, macOS and Windows are built by the release workflow and attached to each GitHub Release (unsigned for now).
- `better-sqlite3` 13: Node-API prebuilds, so one binary serves every Node ≥ 22 and Electron without a rebuild.
- Dictation: a 🎤 button in the prompt box records your voice and appends the transcript to the draft; whisper.cpp runs offline on your machine, model and language in Settings (ADR-0042).
- Draggable splitters between the session list, the chat and the right pane; hiding the session list no longer blanks the window.
- One GitHub account per repository (**Account** dropdown, `--as <login>`); clone, push and `gh` in that repository act as it. Needs an image rebuild (ADR-0041).
- Several repositories per session, each under `/workspace/<name>`; add and remove them live (ADR-0037).
- Auto-merge for attached pull requests: merged as soon as GitHub allows it, polled every 10 s (ADR-0040).
- Bitbucket (Data Center / Server) connector with the `bb` CLI in the Sandbox (ADR-0038).
- Control Plane: logging no longer loops on a closed stderr.

## 0.1.0 — 2026-09-20

First release. Sessionboxer runs coding agents (Claude Code, Devin) in one Docker Sandbox per
session, each with its own desktop, terminal, editor and browser, managed from a web UI that
also works on a phone.

Install: `npx sessionboxer@0.1.0 serve`, or `docker compose up` with the `docker-compose.yml`
from this release, or `curl -fsSL https://sessionboxer.talayolabs.com/install.sh | sh`. The
Sandbox image `ghcr.io/talayolabs/sessionboxer-sandbox:0.1.0` (linux/amd64, linux/arm64) is
pulled on first use.

### Sessions and Sandboxes
- One Docker Sandbox per session (Ubuntu 24.04 desktop: Xvfb, XFCE, Firefox, noVNC), agent runs
  inside it; workspaces from a git URL, a copied host folder, or empty; CPU/memory limits.
- Claude Code (subscription via OAuth token or API key/base URL) and Devin CLI, both over ACP;
  model and agent-option pickers; per-session instructions.
- Snapshots after each turn and on demand; fork a session from any snapshot; branches with
  revert/switch; stop/resume with the conversation replayed.
- Docker inside the Sandbox (Sysbox when available, privileged fallback, or off).
- Saved messages and a send queue; attachments (images, files) in prompts.

### Panes
- Chat with inline screenshots, tool calls, videos/images/PDFs the agent produced, clickable
  file paths that open in the Code pane.
- Desktop (noVNC), Terminal (xterm.js), Code (VS Code in the browser), Context (usage gauge,
  compactions, exact LLM requests/responses when inspection is on), PRs (comments and reviews
  of attached pull requests, with "address and reply" actions).
- Recordings with captions and narration from the agent's `start_recording`/`annotate_recording`.

### Integrations
- MCP server registry with per-session activation and secret injection; GitHub login (device
  flow or existing `gh`) forwarded into the Sandbox as `gh`/git credentials; git identity.
- Pull request polling and notifications.

### Remote access
- Access token + per-device cookies in front of everything; QR pairing for phones.
- Pair another device over: the local network, an embedded Cloudflare quick tunnel, the
  Sessionboxer tunnel (frp at tunnel-sessionboxer.talayolabs.com, stable subdomain, verified
  TLS), or your own server over SSH.
- Phone layout, installable PWA, Web Push for "turn ended" and PR feedback.
- Trusts this machine's CA certificates (Cloudflare WARP, corporate proxies) for its own
  downloads and inside Sandboxes.

### Distribution
- `sessionboxer` on npm (Control Plane, web UI and CLI in one package).
- `ghcr.io/talayolabs/sessionboxer` (Control Plane) and `ghcr.io/talayolabs/sessionboxer-sandbox`
  images for linux/amd64 and linux/arm64; `docker-compose.yml`.
- `npm run build:image` still builds the Sandbox image locally for development.
