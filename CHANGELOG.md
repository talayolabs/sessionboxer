# Changelog

## Unreleased

- `sessionboxer service install|uninstall|start|stop|restart|status|log`: the Control Plane as a
  background service of your user account instead of a terminal kept open on `sessionboxer serve`
  — a launchd agent on macOS (`~/Library/LaunchAgents/com.talayolabs.sessionboxer.plist`, log in
  `~/.sessionboxer/logs/control-plane.log`), a systemd user unit on Linux
  (`~/.config/systemd/user/sessionboxer.service`, log in the journal), started at login and
  restarted if it dies. `install` refuses when something already answers on the port or when the
  CLI runs from npx's cache, bakes the shell's `SESSIONBOXER_*` and `DOCKER_HOST` into the unit,
  waits for the server and prints the login link. Not on Windows yet. `sessionboxer open` without
  an id opens the app itself.
- Desktop app, first cut (`apps/desktop`, ADR-0043): an Electron tray shell that runs the Control
  Plane in the background on Electron's own Node — no Node install needed, Docker still is — and
  shows the web UI in a window loaded from `http://127.0.0.1:4000`, so cookies, the service
  worker, WebSockets and the same-origin VS Code proxy work as in a browser. Closing the window
  hides it; the server, the Sessions, the phone's pairing and the tunnels stay up until *Quit* in
  the tray menu, which stops the Control Plane the way Ctrl-C does. One instance at a time (a
  second launch focuses the window); *Start at login*; if a `sessionboxer serve` or Compose
  install already answers at the URL, the app attaches to it and leaves it alone on quit. The
  window logs itself in with a one-use pairing link minted from the local access token. Without a
  Docker engine (`DOCKER_HOST`, `/var/run/docker.sock`, the Docker Desktop, OrbStack, Colima,
  Rancher Desktop and Podman sockets are checked) it points at the Docker install page instead
  of starting. `npm run start -w @sessionboxer/desktop` runs it from the checkout; `npm run dist
  -w @sessionboxer/desktop` packages it with electron-builder (AppImage/deb, dmg/zip, NSIS/zip),
  the Control Plane going in as the `sessionboxer` npm package under `resources/server`. Not yet:
  installers on the Releases page, signing/notarization, auto-update.
- `better-sqlite3` 13: the Control Plane's one native module is now built on Node-API, with the
  prebuilt binaries inside the npm package. One binary serves every Node ≥ 22 and Electron, so
  installing no longer downloads a per-Node-version build (or compiles one) and the same
  `node_modules` runs under Electron's Node without a rebuild.
- Dictation: a 🎤 button in the prompt box records a clip in the browser (tap to start, tap to
  stop) and appends its transcription to the draft; nothing is sent by itself. Transcription runs
  on the machine running Sessionboxer with whisper.cpp, offline — phones paired through a tunnel
  send their clip there. `whisper-cli` (from this repository's `whisper-cpp-v*` Releases, built by
  CI for Linux/macOS/Windows) and the model are downloaded once on first use, checksummed, into
  `~/.sessionboxer/bin` and `~/.sessionboxer/models/whisper`. Settings → Dictation: model (`small`
  by default; `tiny`, `base`, `medium (q5_0)`, `large-v3-turbo (q5_0)`), language (detect / a fixed
  one), download ahead of time, delete models. New routes `GET /api/speech`, `POST
  /api/speech/prepare`, `POST /api/speech/transcribe` (16 kHz mono WAV, 30 MB max), `DELETE
  /api/speech/models/:name`, all behind the usual login (ADR-0042).
- Draggable splitters on a desktop: the session list ↔ chat and chat ↔ pane (Desktop, Code,
  Terminal, Context, PRs) boundaries can be dragged; widths are remembered per browser and a
  double-click on a splitter resets one. Hiding the session list (`«`) no longer blanks the
  whole window; the `»` button that brings it back no longer covers the session title.

- One GitHub account per repository: with several GitHub entries connected, each git repository
  of a session gets an **Account** dropdown (New Session, repository dialog, `sessionboxer new
  --git <url> --as <login>`), *auto* by default — the account that can push to the repository,
  else the one that can see it. The repository is cloned as that account and, inside its
  directory, `git push`/`fetch` and every `gh` command act as it regardless of the box's active
  `gh` login (the directory's git config names the login, never a token); the header chip shows
  *as @login*, the briefing and `repos.json` carry it, PR watching / actions / auto-merge on that
  repository prefer it. Rebind or unbind at any time. Needs an image rebuild (ADR-0041).
- Several repositories per session: list git URLs and host folders when creating a session
  (or with `sessionboxer new --git <url>[@ref] ... [dir...]`), each cloned or copied into
  `/workspace/<name>`; add and remove repositories from a running session (removal refuses while
  uncommitted, unpushed or not-yet-pulled work would be lost); per-repository branch/dirty state
  in the header chips; `/workspace/.sessionboxer/repos.json` and a repository briefing for the
  agent; **Pull to folder** and PR `#123` shortcuts follow the list. Sessions created earlier keep
  their single project at `/workspace` (ADR-0037).
- Auto-merge for attached pull requests: **Auto-merge when checks pass** (merge commit, squash
  or rebase) in a PR's tab makes the Control Plane ask GitHub every 10 seconds whether the PR
  may be merged and merge it as soon as it may — every check green, reviews in, no conflict, not
  a draft — with the head commit pinned; what it is waiting for, the checks and the result are
  shown next to the switch, and a merge raises a toast and a push notification (ADR-0040).
- Control Plane: logging no longer loops on a closed stderr (Ctrl-C under `tee` hung at 100 % CPU).
- Bitbucket (Data Center / Server) connector: **Add Bitbucket** in Settings → MCP servers takes the
  host and one paste of an HTTP access token (the dialog links to the host's token page), verifies
  it and shows the account. While the entry is enabled for a session the box is logged in to that
  host: private repositories clone (`/scm/…`, `/projects/…/repos/…` and `ssh://…:7999` URLs, all
  over HTTPS), `git push` works, and the new `bb` CLI (github.com/talayolabs/bb, in the Sandbox
  image) creates, lists, views, checks, comments on and approves pull requests. Credentials live on
  tmpfs like `gh`'s; no MCP server is added (ADR-0038).

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
