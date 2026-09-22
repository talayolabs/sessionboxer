# Changelog

## Unreleased

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
  shown next to the switch, and a merge raises a toast and a push notification (ADR-0038).
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
