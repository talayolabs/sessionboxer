# Changelog

## Unreleased

- Session header: the repositories collapse into one button — git's logo drawn in strokes when every repository is a clone, a folder when any is a copied directory, a count in the header's own colour when there are several — and a click lists them (branch, login, state, origin) with **Add or remove…** at the bottom. **Terminal** is a tab (after Desktop) and **Scheduled** moved into the ⋯ menu, whose button is as tall as the tabs and has no border.
- Recordings draw their own pointer: a large white arrow with an outline and a shadow (twice the size of X's), which shrinks while a button is down so clicks and drags are visible; the Sessionboxer badge at the top-right corner; captions in Inter. A moving pointer leaves a one-frame motion smear (two fading copies just behind it) instead of a trail line, and recorded glides keep under 40 px per frame (a move across the screen takes ~1.2 s), so long moves no longer strobe. Image rebuild. (ADR-0072)
- **Pin a session to the top** of the list: the pin that appears when you hover a session in the sidebar, or **Pin to top** in the session's ⋯ menu. Pinned sessions come first (newest first among them), then the rest by date as before; the pin is stored with the session, so every browser and the CLI see the same order. (ADR-0071)
- Recordings are smooth: 30 fps by default (up to 60), and while a recording runs the desktop MCP moves the pointer and types at a hand's pace — glides of 350–700 ms, about one letter per frame — so the video shows the motion instead of the pointer jumping and text landing in blocks; without a recording the agent keeps its full speed (image rebuild). (ADR-0070)
- Pull request triggers can filter by **who**: only PRs by a list of authors, and/or only PRs where one of a list of logins or GitHub teams (`org/team`) is asked to review; both inputs suggest the people seen on followed PRs (`GET /api/prs/people`), and requested teams now count as reviewers on GitHub.
- A new Session can start from a **snapshot**: the Environment dropdown of the New session screen (toolbar and Advanced → Environment) and of an automation's New Session action lists, under the three Environments, the twenty most recent snapshots of all Sessions and the ones picked lately; the Sandbox starts from that image (files, tools, repositories) with an empty conversation for the agent picked. `POST /api/sessions` takes `snapshotId`; `GET /api/snapshots/recent` lists them. For a pull request trigger the PR head is fetched by the agent (first line of the prompt) instead of cloned. (ADR-0069)
- Repositories are remembered: every clone URL and host folder named in a Session, a follow, an attached PR or an automation goes to `GET /api/repositories` and is suggested, as you type, in the New Session form, a Session's Repositories dialog, the Follow dialog and the Automations form (existing data backfilled at first start). An automation with a *pull request* trigger can follow a repository right in the form. (ADR-0068)
- Followed pull requests: an optional webhook per follow (*Webhook…* in the follow's menu) — registered on GitHub for repository follows, URL and secret to paste for Bitbucket Data Center and for *mine* / *requested* follows — makes the Control Plane poll a PR the moment the platform reports a change; deliveries are HMAC-verified hints only, polling stays the source of truth, and a follow with a healthy hook lists every 5 minutes instead of every minute. A PR both followed and attached to a live Session has its checks read by one poller. (ADR-0067)
- Auto QA: an automation with a *pull request* trigger can start a Session on the PR head that runs the Auto QA flow against a brief built from the PR, and the Control Plane posts the verdict, the cases and the video on the PR (attached through the host's `gh pr comment --attach` on GitHub CLI 2.99+, a link otherwise and on Bitbucket); the video is kept at `GET /api/automations/runs/:id/video`. The `e2e-verification` skill gains a pull request mode (image rebuild). (ADR-0066)
- Auto review: an automation with a *pull request* trigger can start a Session on the PR head (fork PRs fetched as the base repository's `refs/pull/{n}/head`, with no connector and no Docker in the box), review the change or only what changed since its last review, and hand the review to the Control Plane, which posts it under the connected login — one GitHub review with inline findings, or Bitbucket comments plus approved / needs-work — with the verdict capped by the automation, a marker naming the automation and run, a transcript marker and an optional notification. New MCP tool `pr_review_submit` (review runs only). `RepoSource.ref` accepts a full PR refspec. (ADR-0065)
- Pull requests: a top-level page (`#/prs`) follows the open PRs of a repository, the ones you opened or the reviews asked of you, without a session: comments, reviews, checks with their output to copy, the events the poller saw, attach to a session or start one on the PR's head. Automations with a *pull request* trigger react to those events (attach, notify, prompt the attached session) within their limits. New MCP tools `pr_follow`, `pr_followed_list`. (ADR-0064)
- Automations: Scheduled tasks became automations (a trigger, an action, limits, a run history) at `#/automations`; existing tasks migrate with their ids and `#/schedules`, `/api/schedules*`, `schedule_create` and `schedule_list` keep working. New MCP tools `automation_create`, `automation_list`, `automation_runs`. (ADR-0063)
- PRs pane redesigned for narrow panes and phones: the overview is a row list (provider, `repo#number`, one-line title, one state/review chip, a needs-you line, a ⋯ menu) sorted needs-attention first; a PR opens as one column — chips, toolbar, auto-merge in a popover, Checks folded when green, comments grouped by thread, a selection bar only while something is ticked. No horizontal scrolling at 360 px. ([a86bb3d](https://github.com/talayolabs/sessionboxer/commit/a86bb3d))

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
