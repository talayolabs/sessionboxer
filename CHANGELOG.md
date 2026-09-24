# Changelog

## Unreleased

- `npm run build:image` after a Sessionboxer change reuses the expensive layers: the Sandbox Dockerfile is ordered from rarely to often changed — apt, agents, VS Code, TTS model, `bb`, the agent user and the Devin CLI first; then Sessionboxer's own runtime dependencies installed from `package.json` alone; then configuration, briefing and skills; the compiled Daemon / MCP / protocol last — and each version pin is declared right before the layer that uses it (an `ARG` is part of the cache key of every later `RUN`). The build context is the three compiled packages and `images/sandbox` only (`.dockerignore`). A Daemon code change now rebuilds in seconds instead of re-running the npm installs, the `bb` bundle and the Devin download; same image size.
- Fork: an **Agent** pick — the fork can run another agent (Claude Code → Devin, …) on the same snapshot — and a third **Conversation** choice, **Hand off**: the origin's agent writes a handoff document in a hidden turn (goal, state of the work, decisions, open items, files and places, how to run and test, gotchas; no secret values) and the fork starts a new conversation with it as its first message — towards another agent or a fresh session of the same one. **Continue it** stays for the origin's agent only (its memory cannot be loaded into another; the dialog greys it out and the API answers 400). The origin's chat shows *Writing a handoff for a fork…*, the fork's shows the document folded under *Handoff from the origin's Agent*; a fork with another agent starts from that agent's default model and options and its token must be configured. `ForkSessionRequest.provider`, `conversation: "handoff"`, `user_prompt.origin: "handoff_request" | "handoff"`, `forked.fromProvider` (ADR-0052).
- Chat: every message carries its time at the bubble's bottom-right, as people say it (*just now*, *12 min ago*, *today 14:32*, *yesterday 14:32*, *Mon 14:32*, *12 Sep 14:32*), with the exact RFC 5322 date (`Tue, 22 Sep 2026 10:47:12 +0200`, browser time zone) on hover; the turn divider's tooltip uses the same form. The folded Agent group shows how long the turn is taking — a live *m:ss* while it works, then the time it took (*Show all 10 messages · 0:26*).
- Instructions for the agent: the shipped default no longer asks the Agent to test each change end to end and record a video — **Verify each turn end to end** does that as its own step. The default is now the git-identity rule alone; a `config.json` still holding the old default verbatim moves to the new text (an edited one is left alone).
- PRs: a PR opens **inside the PRs pane** instead of as its own header tab — the list shows one row per PR, a row opens the PR, and a breadcrumb at the top (**Pull requests › owner/repo#123**) leads back; the **PRs** tab stays lit while a PR is open. Comment bodies render the HTML GitHub allows in them (coverage-report tables, `<details>`, images) instead of showing the tags as text: the same Markdown renderer as the chat with `rehype-raw` + `rehype-sanitize` on GitHub's allowlist — no script/style/iframe/form/svg, no `on*` handlers, `http(s)`/`mailto` links only, ids prefixed. Chat messages are unchanged (HTML still not interpreted).
- Fix: PR checks — GitHub's rollup lists every run on the head commit, so a workflow that ran twice (branch renamed, a re-run, push + pull_request events) showed each job twice or thrice and auto-merge waited on stale failed runs (*22/25 checks*, *waiting: 2 failed*). Only the newest run of each check (workflow / app + name) counts now, in the Checks list and for auto-merge, as in GitHub's merge box; a check is followed by workflow + name (`PrCheckItem.id` changes, so a failure standing at upgrade is announced once more). Auto-merge's line also says what else it waits for besides checks: *an approval from a reviewer* / *changes were requested by a reviewer*.
- PRs: pull requests on a **Bitbucket Data Center** are watched too — attach one by URL (`https://host/projects/KEY/repos/slug/pull-requests/12`, pasted or found in the chat; `KEY/slug#12` / `#12` shorthands for Workspace repositories) and the Control Plane polls it with the session's Bitbucket entry for that host, box running or not: comments with their replies, inline comments with `path:line`, tasks, resolved threads, approvals and *needs work* as items; the head commit's **build statuses** as Checks (*running* / *passed* / *failed* / *cancelled*, parent build as source, required-build merge checks as *required*, link to the build), announced and fixed like GitHub's — the fix prompts speak `bb` (`bb pr checks`, `bb pr comment --reply-to`) instead of `gh`. The PR pane names the provider and host; Auto-merge stays GitHub-only and is hidden for Bitbucket PRs. `PullRequest.provider` / `.host` (defaults `github` / `github.com` for existing rows), `PrCheckItem.kind: "build"`, `parsePrUrl` / `prUrl` provider-aware. Not covered: Bitbucket Cloud, a Data Center under a context path (ADR-0051).
- PRs: the checks on a watched PR's head commit (GitHub Actions and other check runs, commit statuses) are watched with the comments — the PRs row counts failed / running / passed, a failure is announced once like a comment (toast, browser and push notification *a check failed*; again on a new push or a re-run that fails again), and the PR's tab has a **Checks** list where one or several failed checks go to the Agent with **To prompt**, **Fix** or **Fix & push** (name, conclusion, log link and summary; alone or together with ticked comments). `GET /api/sessions/:id/prs/:prId/checks`, `pr_checks` broadcast, `PrActionRequest.checkIds` (ADR-0050).
- Fix: a PR poll cut short by stopping the Session showed *error: daemon connection closed* instead of *watching paused — Sandbox stopped*.
- Fork: a **Conversation** choice — **Continue it** (as before: the chat up to the snapshot is copied and the Agent remembers it) or **Start a new one** (empty chat; the Agent starts a fresh session on the same files and tools). `ForkSessionRequest.conversation: "continue" | "new"`; the Daemon ignores the origin's persisted Agent session on the fork's first boot (`SESSIONBOXER_NEW_CONVERSATION`).
- Composer: typing no longer lags — the draft lives outside the Session view's React state, so a keystroke re-renders only the composer instead of the whole Session (header, transcript, panes); Markdown messages are memoised too, so a streaming message no longer re-parses its neighbours.
- Chat: the Agent's consecutive messages of a turn (text, thoughts, tool calls, plans) fold behind one GitHub-style squiggly rule — a spinner and *Working… n messages so far* while it works, then only its last message (the summary) with **Show all n messages**; open to see every message as before, and fold them again from either end.
- Verification pane: **Run now** starts a verification turn on demand for the work so far (against the last request), whether the "Verify each turn" switch is on or off; `POST /api/sessions/:id/e2e/run`. Disabled while the Agent works, a run is open, or the session is stopped.
- Fix: with Inspect LLM on, Claude Code took the loopback recorder for a third-party backend and capped the 1M models (Fable, Opus 5, Sonnet 5) at a 200k window — the gauge read `/ 200k` and compaction would have come at a fifth of the real window. The recorder now tells Claude Code it forwards to Anthropic when it does. Daemon change: Stop → Resume existing sessions (ADR-0032).
- Chat: screenshots a tool call returned (the desktop MCP's) are no longer shown inline while folded; they sit inside the folded tool row, which shows a picture icon next to its chevron when it holds one.
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
