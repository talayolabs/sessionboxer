<img src="docs/assets/sessionboxer-icon.png" alt="" width="96" align="left" />

# Sessionboxer

Run coding agents in boxes. Each session gets its own Docker container with a full Linux desktop, and the agent (Claude Code or Devin) works in it like a person would: terminal, editor, browser, mouse and keyboard. You watch the screen live, browse and edit the files, open terminals, and step in when you want to.

<br clear="left" />

![Sessionboxer demo](docs/assets/demo.gif)

*A new session with a first prompt; Claude Code writes and serves a page, opens it in Firefox on the box's desktop and checks it with a screenshot; the editor picks up its next edit live; a terminal inside the box. ([video](docs/assets/demo.mp4))*

## What you get

- **One box per session.** Every conversation runs in its own container with its own copy of the code. Nothing the agent does touches your machine; delete the session and it is all gone.
- **A real desktop.** The container runs a Linux desktop with Firefox. The agent can take screenshots, click and type, so it can test web apps, read documentation or use any GUI tool. You see the same screen in the browser and can take the controls at any time.
- **Agents that don't ask.** Inside the box the agent runs with all permissions granted, so it doesn't stop every few seconds to ask whether it may run a command. The container is the safety boundary.
- **Files and terminals.** A file tree with an editor that follows the agent's changes live, and as many shells in the box as you want.
- **Stop and resume.** Stop a session to free CPU and memory; resume it later with the conversation, files and installed tools exactly where they were.
- **Docker inside the box** (optional). Agents can run `docker`, `docker compose` and `docker build` inside their own container.
- **Your subscription.** Sessionboxer uses your own Claude or Devin account; there is no Sessionboxer account and nothing leaves your machine except the agent's own traffic.

## Requirements

- Linux with [Docker Engine](https://docs.docker.com/engine/install/) (your user must be able to run `docker`), or macOS with [OrbStack](https://orbstack.dev) or Docker Desktop (see [macOS](#macos))
- Node.js 22+
- A Claude Code subscription and/or a Devin account
- Optional: [Sysbox](https://github.com/nestybox/sysbox) if you want Docker inside sessions without giving the agent a privileged container (see below)

## Install

```sh
git clone https://github.com/talayolabs/sessionboxer.git
cd sessionboxer
npm install
npm run build:image     # builds the sandbox image (~3 GB, takes a few minutes the first time)
npm run build
```

Start it with

```sh
npm start               # http://127.0.0.1:4000
```

and open http://127.0.0.1:4000 in your browser. Sessionboxer only listens on localhost.

To update, `git pull` and run the three build commands again.

## First run: connect your agent

Open **Settings** (bottom of the sidebar) and paste a token for the agent you want to use:

- **Claude Code**: run `claude setup-token` on your machine and paste the result.
- **Devin**: run `devin auth login` on your machine, then paste the token from `~/.local/share/devin/credentials.toml`.

Tokens are stored in `~/.sessionboxer/config.json` (readable only by you) and are only handed to the containers of sessions that use that agent. Settings also holds the git name and email that commits made by agents will carry, and how much CPU and memory each session gets (2 CPUs and 4 GB by default).

## Using it

### Start a session

Click **+ New**, pick the agent, choose where the code comes from:

- **Empty directory**: start from scratch.
- **Clone a git URL**: any URL `git clone` accepts, optionally a branch or tag. Private repositories need credentials embedded in the URL or a public mirror for now.
- **Copy a host directory**: a folder on your machine (type the path or pick it with **Browse…**). Git repositories are copied the way `git` sees them (tracked and untracked files, but nothing ignored by `.gitignore`, so `node_modules` or build output stay behind), plus the `.git` folder so the agent can commit. Other folders are copied whole. The copy is one-way: changes in the box do not flow back.

Optionally type the first prompt right there; it is sent as soon as the box is ready. The session title defaults to the first prompt and can be edited later.

### Talk to the agent

The chat shows the agent's messages and, folded, each tool it used: commands, file edits, and the screenshots it took while using the desktop. Press Enter to send, Shift+Enter for a newline. **Cancel turn** interrupts the agent.

The prompt box is Markdown: write it raw or switch to **Rich text**, use the toolbar for formatting either way, drag the divider to make the box taller, or go full screen with the zen button. **Save for later** (Ctrl+S) keeps a message in the session's *Saved for later* list instead of sending it; from there you can load it back, send it now, reorder, or press **▶ Play all** to send the saved messages one by one, each as soon as the agent finishes the previous one.

### Snapshots and forks

Every time the agent finishes a turn, Sessionboxer takes a **snapshot** of the box (a `docker commit`): files, installed packages, browser state, the agent's own memory of the conversation. Snapshots appear in the chat as `📷 Snapshot #n` markers with their size, and the sidebar shows under each session how much disk the box itself uses ("machine", what it changed on top of its image) and how much its snapshots take. **Snapshot** in the header takes one by hand.

**Fork from here** on a marker (or **Fork…** in the header) starts a *new* session with its *own* box from that snapshot: same files, same tools, same conversation up to that point, and the agent remembers it all. Pick what the fork should do first: nothing, one of the messages that were queued in *Saved for later* when the snapshot was taken (or is queued now), or a new prompt, and optionally copy the rest of the queue over. The original session, its box and its queue are not touched, so you can try two approaches side by side.

In Settings you can turn automatic snapshots off and choose how many to keep per session (default 10; older automatic ones are removed, manual snapshots and snapshots a fork was started from are kept). A snapshot's ✕ deletes it; snapshots that a fork was started from cannot be deleted while that fork exists. Tokens are never stored in snapshot images.

### Watch and take over the desktop

**Show desktop** opens the box's screen next to the chat. While the agent is working the view is read-only so you don't fight over the mouse; **Take control** hands it to you until the agent's next turn. When the agent is idle the desktop is always interactive: log into a site for it, open a program, arrange windows.

### Files and terminals

**Files** lists the project folder in the box and opens files in an editor. Save with Ctrl+S. When the agent changes a file you have open, the editor reloads it, or warns you if you had unsaved edits.

**Terminal** opens a shell in the project folder inside the box; open as many tabs as you want. Reloading the page keeps the terminals and their scrollback.

### Stop, resume, delete

- **Stop** pauses the box. It uses no CPU or memory while stopped; the conversation, files, installed packages and everything else in the container are kept.
- **Resume** brings it back where it was. The agent reloads the conversation, so you can continue as if nothing happened.
- **Delete** removes the session, its container and its snapshots for good (forks started from it keep working).

### Docker inside sessions

Some tasks need Docker: running a database for tests, `docker compose up`, building images. Tick **Docker inside the Sandbox** when creating a session, or turn it on for all new sessions in Settings, and the box gets its own Docker daemon. Images and containers created inside survive Stop/Resume and disappear with the session.

There are two ways this can run, and Sessionboxer picks automatically:

- With [Sysbox](https://github.com/nestybox/sysbox) installed on your machine (`sysbox-ce` package from its releases page), the box stays a normal, unprivileged container. Recommended.
- Without Sysbox, the box has to run as a *privileged* container, which means the agent could break out of it onto your machine. Sessionboxer still lets you do it, but shows a ⚠ on the Settings button, explains it next to the option, and marks such sessions in the sidebar and header. Only use this with agents and tasks you trust, or install Sysbox.

## Command line

The `sessionboxer` command talks to the running server and opens the browser on the new session. Run it as `npx sessionboxer` from the checkout, or `npm link -w @sessionboxer/cli` once to have it on your PATH.

```sh
sessionboxer serve                                   # start the server (same as npm start)
sessionboxer new .                                   # box the current directory
sessionboxer new . -p "run the tests and fix what breaks"
sessionboxer new . --provider devin --docker
sessionboxer new --git https://github.com/org/repo.git --ref main
sessionboxer new --empty -t scratch --no-open
sessionboxer ls
sessionboxer open <id> | stop <id> | resume <id> | rm <id>
```

`SESSIONBOXER_URL` points it at a server other than `http://127.0.0.1:4000`.

## Where things live

| | |
| --- | --- |
| Settings and tokens | `~/.sessionboxer/config.json` |
| Sessions and chat history | `~/.sessionboxer/db.sqlite` |
| Session containers | `sbx-<session id>` on the `sessionboxer` Docker network, no published ports |
| Project folder in the box | `/workspace` |
| Sandbox image | `sessionboxer/sandbox:dev` (built locally) |
| Snapshot images | `sessionboxer/snapshot:<session id>-<n>`; unreferenced ones are removed at startup |

`CLAUDE_CODE_OAUTH_TOKEN` or `WINDSURF_API_KEY` set in the environment of `npm start` take precedence over the tokens in Settings.

## Troubleshooting

- **"docker: permission denied"** when starting: add your user to the `docker` group (`sudo usermod -aG docker $USER`, then log out and in).
- **Session goes to *error* with "sandbox image not found"**: run `npm run build:image`.
- **Devin session fails right after creation**: Devin occasionally times out while loading team settings on a cold start. Sessionboxer retries a few times; if it still fails, Resume the session.
- **Docker inside the box can't pull images**: Docker Hub rate-limits anonymous pulls per IP; log in with `docker login` in the box's Terminal or pull from another registry.

### macOS

Sessionboxer talks to each box over the private `sessionboxer` Docker network. On macOS the Docker daemon runs in a VM, and only [OrbStack](https://orbstack.dev) routes container addresses to the host. Sessionboxer checks which daemon it is talking to at startup (the `sandbox reach: ip|localhost` line in the log):

- **OrbStack**: boxes are reached by container address, exactly as on Linux.
- **Docker Desktop, Colima, …**: each box additionally publishes its two internal ports (daemon and desktop) on `127.0.0.1` with random host ports, and the server dials those. Nothing is exposed beyond your machine. `SESSIONBOXER_SANDBOX_REACH=ip` or `=localhost` overrides the detection (for example `ip` with Docker Desktop + [docker-mac-net-connect](https://github.com/chipmk/docker-mac-net-connect)).

Other notes: Colima does not create `/var/run/docker.sock`, so export `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` before `npm start`. Sysbox is Linux-only, so *Docker inside the Sandbox* always uses the privileged mode on macOS (the box is still inside the Docker VM, not your Mac). The sandbox image builds natively on Apple Silicon (arm64).

## For contributors

Architecture, decisions and the milestone log are in [docs/DESIGN.md](docs/DESIGN.md), the vocabulary in [CONTEXT.md](CONTEXT.md), and the reasoning behind each decision in [docs/adr](docs/adr). Layout is npm workspaces: `apps/control-plane` (server), `apps/web` (UI), `apps/cli`, `packages/sandbox-daemon` and `packages/computer-use-mcp` (run inside the box), `packages/protocol` (shared types), `images/sandbox` (the Docker image). `npm run dev -w @sessionboxer/web` starts the UI with hot reload against a running server.
