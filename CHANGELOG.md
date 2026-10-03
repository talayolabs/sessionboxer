# Changelog

## Unreleased

- Add Kimi CLI 1.52.0 as a Provider with Kimi Code OAuth paste/import and browser device sign-in, tmpfs token refresh sync, MCP tools and its ACP model picker; API-key-only ACP and QEMU · macOS are unavailable. ([ADR-0084](docs/adr/0084-kimi-cli-as-a-provider-on-a-kimi-login-or-api-key.md))

The Sandbox image changed: `npm run build:image`, then Stop → Resume existing sessions.

- Automations react to **MCP Events**: a new trigger, *When an MCP server reports an event*, subscribes the Control Plane to an event of a registry MCP server that speaks the experimental `events/*` extension (push `events/stream` or poll `events/poll`; the form asks the servers what they offer), so a prompt, a new Session or a notification follows an email, a ticket or an incident with no Session running; duplicates are dropped, the cursor is kept across restarts, the payload reaches the prompt as `{event.data…}` or as a fenced block of data. `GET /api/mcp-events/catalog`, `automation_create` with `mcp_event`, `scripts/mock-events-mcp-server.mjs` to try it. Webhook delivery is not offered. (ADR-0081)
- **Grok Build** (xAI's own coding agent) as an eighth agent, via `grok agent stdio`, on a `grok login` file or an xAI API key; Linux, macOS and Windows. Sign in with Grok Build from Settings (device flow). (ADR-0086)

- Daemon errors carry a code (`DaemonError`, `DAEMON_ERROR_CODES`): a prompt while a turn is active, a Provider this Sandbox does not run, an Agent with no session yet answer 409/400/404 instead of 502. (ADR-0080)
- GitHub Copilot CLI is a Provider: sign in with GitHub Copilot from Settings (the device flow), or paste a GitHub token with the Copilot Requests permission or `~/.copilot/config.json`; the token reaches the Agent as `COPILOT_GITHUB_TOKEN`, the MCP servers through its own `mcp-config.json`; Linux, macOS and Windows. ([ADR-0082](docs/adr/0082-github-copilot-cli-as-a-provider-on-a-copilot-login.md))
- Fix: the standing instructions reached a `first-prompt` Agent (Codex, Cursor, OpenCode, Devin, pi) only on paper: the first prompt was marked sent before the prefix was built, so it went without them.
- **Mistral Vibe** as an eighth agent, via `vibe-acp`, on a Mistral account (**Sign in with Mistral Vibe**) or a Mistral API key; Linux, macOS and Windows. (ADR-0085)
- **Gemini CLI** as a Provider, via `gemini --acp`, on a Google login (`~/.gemini/oauth_creds.json`) or a Gemini API key. ([ADR-0087](docs/adr/0087-gemini-cli-as-a-provider-on-a-google-login-or-api-key.md))
- **Qwen Code** as an eighth agent, via `qwen --acp`, on a Qwen OAuth login (`oauth_creds.json`) or any OpenAI-compatible endpoint (`OPENAI_API_KEY`/`OPENAI_MODEL`/`OPENAI_BASE_URL`); Linux, macOS and Windows. (ADR-0083)

## 1.5.0 — 2026-10-01

Install: `npx sessionboxer@1.5.0 serve`, the installers on the release, `docker compose up`, or
`curl -fsSL https://sessionboxer.talayolabs.com/install.sh | sh`. The Sandbox image changed:
Stop → Resume existing sessions.

- **HTML apps in the chat**: a self-contained `.html` file the agent writes runs inline as a sandboxed app, and in the new **App** pane. (ADR-0078) ([496ce31](https://github.com/talayolabs/sessionboxer/commit/496ce31))
- **MCP Apps**: tools that carry a view (MCP Apps, MCP-UI) render it under the tool call, through a per-server MCP tee in the Sandbox; verified against the official ext-apps examples. (ADR-0079) ([b3ca1b2](https://github.com/talayolabs/sessionboxer/commit/b3ca1b2))
- **pi** as a fifth agent, via `pi-acp`, on its `auth.json` or API keys. (ADR-0075) ([b59a3a5](https://github.com/talayolabs/sessionboxer/commit/b59a3a5))
- **OpenCode** as a sixth agent, via `opencode acp`, on its `auth.json` or an OpenCode Zen key. (ADR-0076) ([4a7e81b](https://github.com/talayolabs/sessionboxer/commit/4a7e81b))
- **fx** as a seventh agent, via `fx acp`, on an `fx login` file or an AI Gateway key; Linux and macOS only. (ADR-0077) ([5483b4b](https://github.com/talayolabs/sessionboxer/commit/5483b4b))
- **Utilities**: register the systems around your software once (observability, applications, per environment, credentials used by name and never seen by the agent), switch them on per Session; Procedures as skills. The Docker/Windows/macOS choice is now called the Machine. (ADR-0073) ([57ede89](https://github.com/talayolabs/sessionboxer/commit/57ede89))
- **Folders** in the sidebar: group Sessions, drag between folders, right-click menu with Pin, Move, Snapshots, Fork, Stop/Resume, Delete. (ADR-0074) ([a2557a2](https://github.com/talayolabs/sessionboxer/commit/a2557a2))
- **Pin a Session to the top** of the list. (ADR-0071) ([0bd1634](https://github.com/talayolabs/sessionboxer/commit/0bd1634))
- **Fork from "Now"**: no snapshot needed beforehand, also from the sidebar. ([019dba9](https://github.com/talayolabs/sessionboxer/commit/019dba9))
- **Automations** replace Scheduled tasks: a trigger, an action, limits and a run history at `#/automations`. (ADR-0063) ([1ef237b](https://github.com/talayolabs/sessionboxer/commit/1ef237b))
- **Pull requests page** (`#/prs`): follow a repository's open PRs, yours or the reviews asked of you, without a Session; automations react to their events. (ADR-0064) ([713d36c](https://github.com/talayolabs/sessionboxer/commit/713d36c))
- **Auto review** on a pull request trigger: a Session reviews the PR head and the Control Plane posts the review. (ADR-0065) ([4580917](https://github.com/talayolabs/sessionboxer/commit/4580917))
- **Auto QA** on a pull request trigger: the verdict, the cases and the video posted on the PR. (ADR-0066) ([bf1364b](https://github.com/talayolabs/sessionboxer/commit/bf1364b))
- Followed PRs: optional webhooks as poll-now hints, one checks poller per PR. (ADR-0067) ([b7fec7f](https://github.com/talayolabs/sessionboxer/commit/b7fec7f))
- Pull request triggers filter by author and by requested reviewer. ([ef31b77](https://github.com/talayolabs/sessionboxer/commit/ef31b77))
- Repositories are remembered and suggested in every repository input. (ADR-0068) ([da53ec4](https://github.com/talayolabs/sessionboxer/commit/da53ec4))
- A new Session or automation can start from a **snapshot**. (ADR-0069) ([0490893](https://github.com/talayolabs/sessionboxer/commit/0490893))
- **Camera** button in the composers: take a photo, record a video or the **screen**, attach it; `transcribe_media` MCP tool for video and audio attachments. ([b024152](https://github.com/talayolabs/sessionboxer/commit/b024152))
- **Draw**: a full-screen sketch sheet attached as PNG, also over an image attachment. ([1973339](https://github.com/talayolabs/sessionboxer/commit/1973339))
- Attachments show a thumbnail and open a preview; the formatting tools sit behind a **Style** toggle. ([4c1a5f8](https://github.com/talayolabs/sessionboxer/commit/4c1a5f8))
- Session header: repositories fold into one button, Terminal is a tab, Scheduled moved to the ⋯ menu; Session list marks regrouped. ([6926102](https://github.com/talayolabs/sessionboxer/commit/6926102))
- Recordings at 30 fps with hand-paced actions, their own drawn pointer and the Sessionboxer badge. (ADR-0070, ADR-0072) ([60decc8](https://github.com/talayolabs/sessionboxer/commit/60decc8))
- PRs pane redesigned for narrow panes and phones. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Tool telemetry distinguishes execution outcomes and evidence-based recovery. ([efdceba](https://github.com/talayolabs/sessionboxer/commit/efdceba))
- Fixes: the composer keeps its text after Enter; the New session draft survives navigating away; the Auto QA tab turns green while on; partial fx usage no longer crashes the turn stats; PR store UPDATE placeholders. ([9a7b3ee](https://github.com/talayolabs/sessionboxer/commit/9a7b3ee))

## 1.4.1 — 2026-09-25

Install: `npx sessionboxer@1.4.1 serve`, `brew install talayolabs/tap/sessionboxer`, the installers on the
release, `docker compose up`, or `curl -fsSL https://sessionboxer.talayolabs.com/install.sh | sh`. The Sandbox
image did not change.

- New defaults: verification off, automatic snapshots off, Agent tools on All Sessions; saved values are kept. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Advanced, Session and Global settings share one layout — Environment, Agent, MCP & connectors, Auto QA, Debug — with the explanations behind `?` popovers; the Verification pane is now Auto QA. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Attach files and dictate on the New session screen, sent with the first prompt. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- [MCP tools reference](https://sessionboxer.talayolabs.com/guide/mcp-tools/): every tool of the built-in `desktop` and `sessionboxer` servers. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))

## 1.4.0 — 2026-09-27

Install: `npx sessionboxer@1.4.0 serve`, `brew install talayolabs/tap/sessionboxer`, the installers on the
release, `docker compose up`, or `curl -fsSL https://sessionboxer.talayolabs.com/install.sh | sh`. The Sandbox
image changed: Stop → Resume existing sessions.

- The agent knows it runs inside Sessionboxer: a `sessionboxer` MCP in every box (`whoami`, `docs`, PRs, snapshot, queue, title, `verify`, `notify`, terminals, `ui_open`), `.sessionboxer/session.json`, a marker in the chat for every action; policy off / this Session / all Sessions in Settings → Agent tools. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Agents work across Sessions: list, create (you Allow or Deny in the chat), fork with their own handoff, message another Session (marked *from Session X* on both sides), wait, stop own children, schedules; children show *child of …* in the sidebar. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- The `sessionboxer` MCP in Windows and macOS Sessions too; the guide's *The agent and Sessionboxer itself* section (ADR-0062); Windows/macOS VMs no longer refuse to boot on a false low-RAM check. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Windows Sessions run the agent inside the VM: agent, MCP servers, git and the Terminal (PowerShell) are Windows-native, repositories in `C:\workspace`; reinstall the Windows base once. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- macOS Sessions run the agent inside the VM the same way (zsh Terminal, `/Users/agent/workspace`); an existing base is reprovisioned from Global settings → macOS VMs. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Environment per session: Docker · Linux, QEMU · Windows (a Windows VM next to the box, its desktop over RDP; Linux hosts with KVM, base installed once from Global settings). ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- QEMU · macOS as a third environment: a macOS VM (dockur/macos, OpenCore) next to the box, its desktop over VNC; Linux hosts with KVM and AVX2, Apple's licence terms apply. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- New session toolbar: Environment, Agent and Model dropdowns with logos; every native `<select>` replaced by the themed list; a *Runtime* item first in the set-up checklist. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- New session: picking an unconnected Agent opens Connect a Provider, picking an environment that is not installed opens its install dialog. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Sign in with Claude Code, Codex, Cursor or Devin from Settings in your own browser; a login already on the server's machine is copied with one click. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- One USB device of the host per Session (Connect USB device… menu; WSL2 via usbipd). ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Global settings as a split view with `#/settings/<section>` deep links and one Save. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- An in-repo design system: Radix Primitives for menus, dialogs and tooltips; `--vscode-*` aliases from the same palette as the VS Code theme. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Long conversations no longer lose messages on reload (the 5,000-event cap is gone); the Code pane keeps each Session's own tabs and layout. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- No more messages missing after the tab was in the background: a dead push socket is detected and the transcript refetched. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))

## 1.3.0 — 2026-09-25

Install: `npx sessionboxer@1.3.0 serve`, `brew install talayolabs/tap/sessionboxer`, the installers on the
release, `docker compose up`, or `curl -fsSL https://sessionboxer.talayolabs.com/install.sh | sh`.

- New first screen: a prompt box with the Provider, repositories and Start under it; the four Provider logos above it until one is connected. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Connect a Provider from the app: per-Provider dialog with the install, log-in and paste steps for your OS (macOS, Windows, Linux). ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Session settings behind "Advanced…", sections on the left, controls on the right. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- "To set up" checklist in the sidebar: Provider and Git account, each a two-click wizard; Git offers GitHub or Bitbucket. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Settings → Git accounts: GitHub with a personal access token (direct create link, exact permissions) next to the CLI and OAuth App logins. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Login page: "Where do I find the token?" per install method, for `docker compose up -d` and friends. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Pull request rows open the PR detail; the GitHub link stays a separate button. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- `sessionboxer serve` without Docker: one readable message and exit instead of a stack trace; a banner with Retry when the Sandbox image cannot be pulled. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Install: Homebrew tap, `sessionboxer` on npm, the desktop app's Get Docker link per OS. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))

## 1.2.0 — 2026-09-25

Install: `npx sessionboxer@1.2.0 serve`, the installers on the release, `docker compose up`, or
`curl -fsSL https://sessionboxer.talayolabs.com/install.sh | sh`. The Sandbox image changed:
Stop → Resume existing sessions.

- Cursor as a fourth agent, on your Cursor subscription (`agent login` file or API key). ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))

## 1.1.0 — 2026-09-24

Install: `npx sessionboxer@1.1.0 serve`, the installers on the release, `docker compose up`, or
`curl -fsSL https://sessionboxer.talayolabs.com/install.sh | sh`. The Sandbox image changed:
Stop → Resume existing sessions. Details in the [guide](docs/GUIDE.md) and the linked commits.

- Codex as a third agent, on your ChatGPT subscription. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Scheduled tasks: run a prompt on a cron schedule, into an existing session or a new one. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Color themes, eleven light and dark, shared with the VS Code in the box. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Verify each turn end to end, on by default, with a video; automatic snapshots off by default. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Verification pane: **Run now**. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- PR checks (GitHub Actions, statuses) watched, a failure announced once, fixed from the PR pane. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Bitbucket Data Center pull requests watched too, build statuses as checks. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- PR checks count only the newest run of each check; auto-merge says when it waits for an approval. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- A PR opens inside the PRs pane with a breadcrumb; comment HTML rendered, sanitised. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Fork: continue the conversation, start a new one, or hand off — to another agent or the same. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Usage limits: no-entry sign with a reset countdown, **Continue** / **Auto-continue**, three usage bars. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Chat folds the agent's messages of a turn behind one rule, with a count and the turn's duration. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- A time on every message, exact date on hover. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Tool-call screenshots stay inside the folded row, with a picture icon. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Composer: **Enqueue** replaces Save for later and the queue plays by itself. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Composer: one **Preview** switch, full-width context gauge, toolbar dividers, no typing lag. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Desktop MCP: the cursor glides to its target instead of jumping. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Session header: five tabs with icons and a ⋯ menu; provider logo; **Global settings** / **Session settings**. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Terminal pane: copy, paste and a right-click menu. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Inspect LLM on by default for Claude Code sessions. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Default agent instructions no longer ask for an end-to-end test (Verify each turn does that). ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Docker inside Sandboxes uses `192.168.240.0/20`, configurable. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Sandbox image layers ordered so a Sessionboxer change rebuilds in seconds. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))
- Fix: 1M Claude models were capped at a 200k window with Inspect LLM on. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))

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
