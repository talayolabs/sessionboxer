# Changelog

## 1.1.0 — 2026-09-24

Install: `npx sessionboxer@1.1.0 serve`, the installers on the release, `docker compose up`, or
`curl -fsSL https://sessionboxer.talayolabs.com/install.sh | sh`. The Sandbox image changed:
Stop → Resume existing sessions. Details in the [guide](docs/GUIDE.md) and the linked commits.

- Codex as a third agent, on your ChatGPT subscription. ([fa615a2](https://github.com/talayolabs/sessionboxer/commit/fa615a2))
- Scheduled tasks: run a prompt on a cron schedule, into an existing session or a new one. ([dfdd394](https://github.com/talayolabs/sessionboxer/commit/dfdd394))
- Color themes, eleven light and dark, shared with the VS Code in the box. ([7f2b908](https://github.com/talayolabs/sessionboxer/commit/7f2b908))
- Verify each turn end to end, on by default, with a video; automatic snapshots off by default. ([217fe5a](https://github.com/talayolabs/sessionboxer/commit/217fe5a))
- Verification pane: **Run now**. ([ffae185](https://github.com/talayolabs/sessionboxer/commit/ffae185))
- PR checks (GitHub Actions, statuses) watched, a failure announced once, fixed from the PR pane. ([9b8442d](https://github.com/talayolabs/sessionboxer/commit/9b8442d))
- Bitbucket Data Center pull requests watched too, build statuses as checks. ([ede0ace](https://github.com/talayolabs/sessionboxer/commit/ede0ace))
- PR checks count only the newest run of each check; auto-merge says when it waits for an approval. ([2dea40d](https://github.com/talayolabs/sessionboxer/commit/2dea40d))
- A PR opens inside the PRs pane with a breadcrumb; comment HTML rendered, sanitised. ([043c4ca](https://github.com/talayolabs/sessionboxer/commit/043c4ca))
- Fork: continue the conversation, start a new one, or hand off — to another agent or the same. ([4e44832](https://github.com/talayolabs/sessionboxer/commit/4e44832))
- Usage limits: no-entry sign with a reset countdown, **Continue** / **Auto-continue**, three usage bars. ([ab871ea](https://github.com/talayolabs/sessionboxer/commit/ab871ea))
- Chat folds the agent's messages of a turn behind one rule, with a count and the turn's duration. ([8f2b55f](https://github.com/talayolabs/sessionboxer/commit/8f2b55f))
- A time on every message, exact date on hover. ([c604e9b](https://github.com/talayolabs/sessionboxer/commit/c604e9b))
- Tool-call screenshots stay inside the folded row, with a picture icon. ([9a4157c](https://github.com/talayolabs/sessionboxer/commit/9a4157c))
- Composer: **Enqueue** replaces Save for later and the queue plays by itself. ([75816ff](https://github.com/talayolabs/sessionboxer/commit/75816ff))
- Composer: one **Preview** switch, full-width context gauge, toolbar dividers, no typing lag. ([5ab1767](https://github.com/talayolabs/sessionboxer/commit/5ab1767))
- Desktop MCP: the cursor glides to its target instead of jumping. ([ce964c5](https://github.com/talayolabs/sessionboxer/commit/ce964c5))
- Session header: five tabs with icons and a ⋯ menu; provider logo; **Global settings** / **Session settings**. ([623d146](https://github.com/talayolabs/sessionboxer/commit/623d146))
- Terminal pane: copy, paste and a right-click menu. ([bf04308](https://github.com/talayolabs/sessionboxer/commit/bf04308))
- Inspect LLM on by default for Claude Code sessions. ([e1a91f3](https://github.com/talayolabs/sessionboxer/commit/e1a91f3))
- Default agent instructions no longer ask for an end-to-end test (Verify each turn does that). ([2e96398](https://github.com/talayolabs/sessionboxer/commit/2e96398))
- Docker inside Sandboxes uses `192.168.240.0/20`, configurable. ([a39e546](https://github.com/talayolabs/sessionboxer/commit/a39e546))
- Sandbox image layers ordered so a Sessionboxer change rebuilds in seconds. ([2c4895d](https://github.com/talayolabs/sessionboxer/commit/2c4895d))
- Fix: 1M Claude models were capped at a 200k window with Inspect LLM on. ([3c34f4e](https://github.com/talayolabs/sessionboxer/commit/3c34f4e))

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
