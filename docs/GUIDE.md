# Sessionboxer user guide

Everything the [README](../README.md) leaves out: every option, every setting, every environment variable. Sections follow the UI top to bottom.

## What you get

- **One box per session.** Every conversation runs in its own container with its own copy of the code. Nothing the agent does touches your machine; delete the session and it is all gone.
- **A real desktop.** The container runs a Linux desktop with Firefox. The agent can take screenshots, click and type, so it can test web apps, read documentation or use any GUI tool. You see the same screen in the browser and can take the controls at any time.
- **Agents that don't ask.** Inside the box the agent runs with all permissions granted, so it doesn't stop every few seconds to ask whether it may run a command. The container is the safety boundary.
- **VS Code and terminals.** Full VS Code running inside the box (with its AI features switched off, the agent in the chat is the one you talk to), and as many shells as you want.
- **Context you can see.** A gauge under the prompt box shows how full the agent's context window is (green to red, *rotting* past half), how many times the conversation was compacted, and what each turn cost; a Context pane breaks the window down by system prompt, tools, MCP servers, memory files and messages.
- **Videos and documents in the chat.** Ask for a screen recording of a feature and the agent records the box's desktop to an .mp4 you can play right there; images, SVGs and PDFs it produces show up the same way, with a download button.
- **Stop and resume.** Stop a session to free CPU and memory; resume it later with the conversation, files and installed tools exactly where they were.
- **Docker inside the box** (optional). Agents can run `docker`, `docker compose` and `docker build` inside their own container.
- **Your subscription.** Sessionboxer uses your own Claude or Devin account; there is no Sessionboxer account and nothing leaves your machine except the agent's own traffic.
- **From your phone, if you want.** Run it on a home server or a VPS and reach it over a private Headscale/Tailscale network or a tunnel: every browser logs in once with an access token or a QR code and stays logged in as a device you can revoke.

## Requirements

- Linux with [Docker Engine](https://docs.docker.com/engine/install/) (your user must be able to run `docker`), or macOS with [OrbStack](https://orbstack.dev) or Docker Desktop (see [macOS](#macos))
- Node.js 22+
- A Claude Code subscription and/or a Devin account
- Optional: [Sysbox](https://github.com/nestybox/sysbox) if you want Docker inside sessions without giving the agent a privileged container (see below)

## Install

Pick one. All of them download the Sandbox image `ghcr.io/talayolabs/sessionboxer-sandbox` (a few GB, linux/amd64 and linux/arm64) the first time the server starts; the log shows the progress. Then open the `log in at http://127.0.0.1:4000/#pair=…` link the server prints: that logs the browser in once (see [Remote access](#remote-access-phone-and-other-machines) for how the login works and how to reach it from elsewhere). By default Sessionboxer listens on localhost only.

**One line** (Linux, macOS): picks npm when Node 22+ is installed, otherwise Docker Compose.

```sh
curl -fsSL https://sessionboxer.talayolabs.com/install.sh | sh
```

**npm** — the laptop case. Needs Node 22+ and Docker.

```sh
npx sessionboxer serve                 # or: npm i -g sessionboxer && sessionboxer serve
```

Rather than keeping that terminal open, install it as a background service of your user account — started now and at every login, restarted if it dies, same `~/.sessionboxer`: a launchd agent on macOS, a systemd user unit on Linux (`loginctl enable-linger` keeps it up after you log out of a headless machine). `SESSIONBOXER_*` and `DOCKER_HOST` set in the shell that runs `install` are baked into the service.

```sh
npm i -g sessionboxer                  # not npx: the service points at the installed files
sessionboxer service install           # prints the login link; then status | stop | start | restart | log | uninstall
```

**Docker Compose** — the home server, VPS, Raspberry Pi or Coolify case; only Docker is needed.

```sh
curl -fsSLO https://raw.githubusercontent.com/talayolabs/sessionboxer/v1.0.0/docker-compose.yml
docker compose up -d                   # http://127.0.0.1:4000; `docker compose logs -f` for the login link
```

The Control Plane runs from `ghcr.io/talayolabs/sessionboxer` with `/var/run/docker.sock` mounted and its data in the `sessionboxer-data` volume. Sessions become sibling containers on the same Docker host. Copy [`.env.example`](../.env.example) to `.env` to change the port, listen on all interfaces, set a public URL or a fixed access token. *Copy a folder* and *Pull to folder* need the folder to be visible inside the container: uncomment the `/workspaces` bind mount in the compose file and refer to `/workspaces/<name>` in the UI. Giving a container the Docker socket is the same as giving it root on the host; it is what lets Sessionboxer create the boxes, so run it only on a machine you would give the agent's boxes anyway.

**Releases**: [GitHub Releases](https://github.com/talayolabs/sessionboxer/releases) has the notes and the npm tarball for every version; the images are on GHCR ([Control Plane](https://github.com/talayolabs/sessionboxer/pkgs/container/sessionboxer), [Sandbox](https://github.com/talayolabs/sessionboxer/pkgs/container/sessionboxer-sandbox)). The Control Plane pulls the Sandbox image with its own version number, so the two always match; `SESSIONBOXER_IMAGE` overrides it.

**From source** (to hack on it):

```sh
git clone https://github.com/talayolabs/sessionboxer.git
cd sessionboxer
npm install
npm run build
npm start                              # pulls the published Sandbox image for this version…
npm run build:image                    # …or build it here (~5 GB, a few minutes) — tagged with the same name
```

To update, `git pull`, `npm run build`, `npm start`; `npm run build:image` again only when `images/sandbox` changed.

**Desktop app** (early): installers for Linux (AppImage, deb; x64 and arm64), macOS (dmg; Apple silicon and Intel) and Windows (x64) are on the [Releases page](https://github.com/talayolabs/sessionboxer/releases) from the next version on, with `SHA256SUMS` next to them. They are not code-signed yet: macOS wants `xattr -dr com.apple.quarantine /Applications/Sessionboxer.app` after you drag the app to Applications, Windows *More info → Run anyway* in SmartScreen. Under the hood it is an Electron tray shell in `apps/desktop` that starts the same Control Plane in the background, opens the UI in a window and keeps serving when the window is closed — the phone keeps its pairing, tunnels stay up — until you *Quit* from the tray/menu bar. It needs Docker like everything else, but not Node: the Control Plane runs on the Node inside Electron. If a `sessionboxer serve`, `sessionboxer service` or Compose install already answers at `http://127.0.0.1:4000` (or `SESSIONBOXER_URL`), the app attaches to it instead of starting another and leaves it running on quit. Same `~/.sessionboxer` as the other installs; the server log is in the app's log folder (`~/.config/Sessionboxer/logs`, `~/Library/Logs/Sessionboxer`, `%APPDATA%\Sessionboxer\logs`).

```sh
npm run build
npm run start -w @sessionboxer/desktop   # run it from the checkout
npm run dist -w @sessionboxer/desktop    # or package it yourself: build/desktop/ (AppImage + deb, dmg + zip, NSIS + zip on the matching OS; `-- --dir` for an unpacked folder)
```

## First run: connect your agent

Open **Settings** (bottom of the sidebar) and paste a token for the agent you want to use:

- **Claude Code**: run `claude setup-token` on your machine and paste the result.
- **Devin**: run `devin auth login` on your machine, then paste the token from `~/.local/share/devin/credentials.toml`.

Tokens are stored in `~/.sessionboxer/config.json` (readable only by you) and are only handed to the containers of sessions that use that agent. Settings also holds the default git name and email that commits made by agents will carry (blank means your machine's `git config`; either can be overridden per session when creating it), and how much CPU and memory each session gets (2 CPUs and 4 GB by default).

## Using it

### Start a session

Click **+ New**, pick the agent, and list the **repositories** the session works on: none (the Workspace starts empty), one, or several (a frontend, a backend, the CI repositories, the docs…) with **+ Git repository** / **+ Host folder**. Each lands in its own directory in the box, `/workspace/<name>`, `<name>` being the repository or folder basename (`-2`, `-3` on a clash; change it in the **name** field). The Workspace root `/workspace` stays the agent's working directory and the place for anything that belongs to no repository (recordings, notes); `/workspace/.sessionboxer/repos.json` lists the repositories, and the agent's briefing tells it to treat each top-level directory as its own git repository and to say which one a path, commit or PR belongs to.

- **Clone a git URL**: any URL `git clone` accepts, optionally a branch or tag. With a GitHub entry enabled for the new session (see [GitHub with one click](#github-with-one-click)), private GitHub repositories clone as that account, and `git@github.com:…` SSH URLs are cloned over HTTPS the same way (the box has no SSH keys). Likewise a [Bitbucket entry](#bitbucket-data-center-with-one-paste) clones private repositories of that host (`https://bitbucket.example.com/scm/KEY/repo.git`, the `…/projects/KEY/repos/repo/browse` page URL or `ssh://git@bitbucket.example.com:7999/KEY/repo.git`, all over HTTPS). Other private hosts need credentials embedded in the URL for now. Below the URL, **Git author for commits made in the Sandbox** shows the name and email the agent's commits will carry (`user.name` / `user.email` in the box, author and committer): prefilled from **Settings** (or, when blank there, from your machine's own `git config`), editable for this session only, with **Reset to the global identity** to go back; it is fixed once the session exists and travels with forks. The header's source tooltip shows what a session got.
- **Copy a host directory**: a folder on your machine (type the path or pick it with **Browse…**). Git repositories are copied the way `git` sees them (tracked and untracked files, but nothing ignored by `.gitignore`, so `node_modules` or build output stay behind), plus the `.git` folder so the agent can commit. Other folders are copied whole. Changes the agent makes stay in the box until you **Pull to folder…** (below).

The header shows one chip per repository (`⋯` while it is being cloned or copied, `⚠` when that failed, `●` when it holds uncommitted or unpushed work; hover for the branch and state). Click the chips to **add** a repository to a running session (cloned or copied in place, the agent is told on its next prompt) or **remove** one: the directory is deleted in the box, never your folder or the remote. Removing refuses when the repository has uncommitted changes, commits no remote has, or (for a copied folder) changes not yet pulled to your machine, until you confirm you want to lose them. Sessions created before repositories existed keep their single project at `/workspace` itself and cannot take a second one; start a new session for that.

**Model** lists the models the chosen agent offers (Claude Code: Sonnet/Opus/Haiku/Fable and its default; Devin: the catalog your account has, grouped by family); leave it on *Provider default* to let the agent decide. The list is what the agent reported the last time a session of that provider started, so it is empty until you have run one. Next to it come the agent's other settings, when it has any: for Claude Code, **Effort** (default, low … max) and **Fast mode**. Devin's Cloud tiers (Lite, Normal, Ultra) are not something its CLI offers; pick a model with the effort level you want instead (`…-high`, `…-fast`, …).

Claude Code only lets Sessionboxer pick from the aliases in **Settings → Claude model aliases** (`opus, sonnet, haiku, fable` by default; that list is written to Claude's `availableModels`). Add an alias there if your account has a model the picker does not show; it takes effect for new sessions and for idle sessions right away.

**Instructions for the agent** is prefilled with the text from **Settings → Instructions for the agent** and is fixed for the session once created (empty means none). These are standing rules given to the agent itself rather than left in a file it may or may not read: Claude Code gets them appended to its system prompt (on every start of the session, including Resume and rewinds), and Devin, whose CLI has no such hook, gets them prepended to the first message of each conversation the box starts for the session (once; later messages go verbatim). They come on top of the Sandbox briefing and the project's own `CLAUDE.md` / `AGENTS.md`. The shipped default asks the agent to keep its name out of git (no `Co-Authored-By` trailer or "generated with" line: Claude Code's own byline is also switched off in the box) and to run the application, test the change end to end on the desktop and record a video of it after changing code. The **⚙ Settings** button in a session's header shows what that session got, next to its other per-session settings (model and options, MCP servers, Inspect LLM, snapshots, sandbox).

Optionally type the first prompt right there; it is sent as soon as the box is ready. The session title defaults to the first prompt and can be edited later.

### Talk to the agent

The chat shows the agent's messages and, folded, each tool it used: commands, file edits, and the screenshots it took while using the desktop. Press Enter to send, Shift+Enter for a newline. While the agent works, **Send** turns into **Stop**, which interrupts the turn; what you typed stays in the box. Hover a message for **Copy** (its Markdown source) and **Copy rich** (formatted: headings, lists, links and coloured code survive a paste into a document or mail) in its top-right corner.

The model picker at the bottom left of the prompt box switches the model for the rest of the conversation, and the pickers next to it (Claude Code: **Effort**, **Fast mode**) do the same for the agent's other settings; the agent decides which appear for the current model (Fable, for one, has no Effort or Fast mode). While the agent is working a change waits until the current turn ends (the picker shows *pending*), and the chat shows a `Model now: …` / `Effort now: …` marker when it takes effect. The choices survive Stop/Resume, and a setting the current model does not offer is kept for when you switch to one that does.

**Attach files** with the 📎 button, by dropping them on the prompt box or by pasting them (a screenshot from the clipboard works). Each file is uploaded into the box under `/workspace/.sessionboxer/uploads/` before you send, with a progress bar on its chip (✕ removes it); a chip that failed says why. When you send, the prompt tells the agent the path of every file, so it can read, run or convert anything with its own tools or a shell. Images (PNG, JPEG, GIF, WebP up to 5 MB) and text files up to 64 KB are also handed to the model directly, as part of the prompt, when the agent supports that (Claude Code and Devin both do); other files, or larger ones, are reachable by path only. Up to 20 files per prompt, 512 MB each. Your message in the chat shows the files it carried, images inline and the rest as chips with a **Download** link. The uploads folder is left out of `git status` (through `.git/info/exclude`) and of **Pull to folder**, but it is part of the box like any other file (snapshots carry it); delete it in the box when you no longer need it.

**Dictate** with the 🎤 button in the prompt box's toolbar: tap to record, tap again and the words are added to the end of your draft (nothing is sent until you press Send). The clip is transcribed on the machine running Sessionboxer with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), offline — a phone paired through a tunnel sends its clip there too, so no account and no cloud speech service are involved. The first time, `whisper-cli` (a few MB, from this repository's Releases) and the model (`small`, 466 MB, from Hugging Face) are downloaded once into `~/.sessionboxer/`; the line under the box shows the progress, then *Transcribing…*. Settings → Dictation picks the model — `base` is faster and rougher, `medium (q5_0)` more accurate and 2–3× slower — and the language (detect, English, Spanish, …; naming it makes transcription about twice as fast) and can download the model ahead of time or delete ones you no longer use. A 15-second prompt takes about 3 s with `small` on a laptop CPU. The microphone needs a secure page: `localhost`, or `https://` through a tunnel — plain `http://` over the LAN has no microphone, use the keyboard's own dictation there (Win+H, the mic key on macOS/iOS/Android), which types into the box like anywhere else.

The prompt box is Markdown: write it raw or switch to **Rich text**, use the toolbar for formatting either way, drag the divider to make the box taller, or go full screen with the zen button. **Save for later** (Ctrl+S) keeps a message in the session's *Saved for later* list instead of sending it; from there you can load it back, send it now, reorder, or press **▶ Play all** to send the saved messages one by one, each as soon as the agent finishes the previous one.

### Snapshots and forks

Every time the agent finishes a turn, Sessionboxer takes a **snapshot** of the box (a `docker commit`): files, installed packages, browser state, the agent's own memory of the conversation. Snapshots appear in the chat as `📷 Snapshot #n` markers with their size, and the sidebar shows under each session the total disk it uses (the box's changes on top of its image plus its snapshots). **Snapshot** in the header takes one by hand.

**Fork from here** on a marker (or **Fork…** in the header) starts a *new* session with its *own* box from that snapshot: same files, same tools, same conversation up to that point, and the agent remembers it all. Pick what the fork should do first: nothing, one of the messages that were queued in *Saved for later* when the snapshot was taken (or is queued now), or a new prompt, and optionally copy the rest of the queue over. The original session, its box and its queue are not touched, so you can try two approaches side by side.

Click the size under a session in the sidebar to open its **Snapshots** popup: the machine/snapshots breakdown, a switch to turn automatic snapshots on or off for that session only, the list of its snapshots with their sizes and **Fork** / **Delete** buttons, **Delete all**, and **Snapshot now**. Sessions with automatic snapshots off show `📷×` in the sidebar.

In Settings you set the default for automatic snapshots (off on a fresh install; a config that already has the setting keeps it) and how many to keep per session (default 10; older automatic ones are removed, manual snapshots and snapshots a fork was started from are kept). A snapshot's ✕ in the chat deletes it too; snapshots that a fork was started from cannot be deleted while that fork exists. Tokens are never stored in snapshot images.

If snapshots start failing with *the Sandbox's image is missing sha256:… from Docker's content store*, Docker lost part of the image the box was created from (typically after a disk failure or an over-eager `docker image prune`); the box itself still runs, but `docker commit` needs the whole chain. **Rebuild Sandbox** in the Snapshots popup fixes it: the box is stopped, its whole filesystem is exported into a fresh single-layer image (recorded as a `rebuild` snapshot, the size of the full box), and a new box starts from it with the same session, files and conversation; the old box is removed only once the new one runs. Terminals and the Code pane reconnect afterwards. That snapshot cannot be deleted while the box runs on it. When an automatic snapshot fails, the error is shown once instead of failing silently after each turn.

### Go back and try another way

Each time the agent finishes a turn, a line divides the chat: *turn ended 14:03*. The last one marks where the agent is waiting for you. Every earlier line has **↶ Revert to here**: the chat is cut back to that point and you continue from there, in the same box, with the agent remembering only what came before. Nothing is lost: what followed is kept as another **branch** of the conversation. The divider where they part shows a button to jump to the other branch (**↪ Continue on main**, **⑂ Try it with…**), and a **⑂** selector in the header lists all of them. A branch is named after the first words of the prompt that started it. Sessions with branches get a **▸** chevron in the sidebar: expand it to see the branches as a tree (main, and under it what forked from where). Clicking a branch that parts from the chat you are looking at scrolls to that divider, where the jump button is; clicking one that is out of sight asks to confirm before switching the conversation to it. Only one branch talks to the agent at a time, and you can only revert or switch while it is idle.

Claude keeps the branch's memory exact (its session is forked at that point); Devin is given a transcript of the conversation up to the point instead. Branches share the box, so files changed on one branch stay changed on the others; take a snapshot and fork a new session if you want the files to go back too.

### Videos, images and documents from the box

Ask the agent to *show* you something ("record a video of the login flow", "take a screenshot of the chart", "export the report as PDF") and it saves the file in the project folder and names it in its reply. Any such file mentioned in a reply (`/workspace/recordings/login.mp4`, `docs/report.pdf`) is shown inline in the chat: videos with a player, images and SVGs as pictures, PDFs embedded, audio with controls, each with **Open** and **Download** links. The file is streamed from the box, so the session must be running to view it (a stopped one says so; **Resume** brings it back).

Recordings use the desktop MCP's `start_recording` / `stop_recording` tools (ffmpeg, H.264 .mp4, 15 fps by default, saved under `recordings/`); the agent drives the desktop as usual in between. When a recording stops it is condensed: every stretch where nothing changes on screen (a page loading, a build, the agent thinking between clicks) is cut down to a 1.5 s hold instead of being removed, so the waiting is gone but each state stays on screen long enough to read; motion plays at real speed. The tool result reports both the recorded and the final length. The agent can pass `condense: false` when real timing matters, or change `hold_seconds`.

Recordings carry captions written by the agent as it works: before each step it calls `annotate_recording` with a sentence about what it is doing, and each caption stays until the next one. When the recording stops the captions are burned into a band added under the desktop (so nothing on screen is covered; the band fits about three lines, and a longer caption grows upwards rather than being cut off) and also written as a WebVTT file next to the video (`demo.vtt` beside `demo.mp4`). In the chat the player lists the captions as clickable steps that follow playback (click one to jump there) and offers them as a subtitle track in the player's controls. Captions survive condensing without any adjustment: they are drawn before the static frames are dropped, so they stay attached to the frames they described, and the `.vtt` is re-timed the same way. The agent can pass `captions: "burn"`, `"track"` or `"none"` to `stop_recording` to change what happens with them.

Captions can also be *spoken*: a text-to-speech model inside the box (Kokoro, no account, nothing leaves your machine) reads each caption at the moment it appears and the speech is muxed into the video as an audio track. When a sentence is longer than its step is on screen, the step's last frame is held until the sentence ends, so the video grows a little instead of the speech overrunning the next step; the `.vtt` and the step list are re-timed to match. Narration costs processing when the recording stops (about a quarter of the spoken time plus a re-encode: a 30 s demo with three captions takes about 4 s, one with eight about 10 s). **Settings → Narrated recordings** decides: *Ask when it takes longer than N seconds* (the default, N = 5) narrates by itself under the threshold and otherwise delivers the silent video with the agent asking you whether to add the narration (say yes and it does, in place); *Always* and *Never* do what they say. Captions are spoken in the language they are written in when the agent passes `narration_language` (en, en-gb, es, fr, hi, it, pt); a voice can be chosen with `narration_voice`.

### Markdown, diagrams and code

Replies and your prompts render as Markdown. Fenced code with a language (```ts, ```python, ```bash…) is syntax-highlighted in the chat, in the rich prompt editor and in documents; a ```mermaid block is drawn as a diagram (flowcharts, sequence diagrams, Gantt…), with the error and the source shown if the syntax is off. Ask the agent for a document ("write the architecture to docs/arch.md with a diagram") and the `.md` (or `.mmd`) it names in its reply appears rendered in the chat, and relative links and images inside it resolve against the box's files.

### Watch and take over the desktop

**Show desktop** opens the box's screen next to the chat. While the agent is working the view is read-only so you don't fight over the mouse; **Take control** hands it to you until the agent's next turn. When the agent is idle the desktop is always interactive: log into a site for it, open a program, arrange windows.

### VS Code and terminals

**Code** opens VS Code on the project folder, running inside the box ([openvscode-server](https://github.com/gitpod-io/openvscode-server), same editor as VS Code for the Web): search, Git view, integrated terminal (extensions from [Open VSX](https://open-vsx.org) via Ctrl+Shift+X; the Extensions icon and the remote indicator are hidden, everything here is remote). The server starts the first time you open the pane (a few seconds) and stops with the box; **Restart** relaunches it and **Open in new tab** gives it a whole window. Settings and extensions you install live in the box, so they survive Stop → Resume and travel with snapshots; the agent sees the same files, so its edits show up as you watch. VS Code's own AI features (Copilot chat, agent mode, inline completions) are turned off in the box so there is one agent per session, the one in the chat; flip `chat.disableAIFeatures` in VS Code's settings if you want them back. No Get Started page either.

Files the chat names are links into that editor: a project path in a reply, a prompt or a tool call (`src/App.tsx`, `/workspace/src/App.tsx:42`, `src/App.tsx:42:7`, `src/App.tsx#L42`) opens the file in the Code pane, at that line and column; the **Read** / **Edit** tool rows link the file they touched. Videos, images and PDFs keep their inline card instead. Bare filenames without a folder (`index.ts`) are left alone in prose unless they carry a `:line`, to avoid turning every mention into a link.

**Terminal** opens a shell in the project folder inside the box; open as many tabs as you want. Reloading the page keeps the terminals and their scrollback.

### How full is the context

Every agent works inside a context window, and the fuller it gets the worse it works: it forgets earlier instructions, repeats itself, and at some point the agent *compacts* the conversation into a summary and loses detail. Sessionboxer shows where you are.

The **gauge at the bottom of the prompt box** reads `32.6k / 1M 3%`: tokens in the window after the agent's last reply, the window's size, and the share used. Its bar goes from green when empty towards red as the window fills, and once more than half is used it turns red and says **rotting** — that is the point from which you should think about a fresh session, a fork from an earlier snapshot, or asking the agent to `/compact`. Next to it, `♻ 2` counts the compactions so far in this session, with a ⚠ as soon as there has been one, since the agent has already lost part of the conversation. Hover the gauge for the exact numbers and the session's cost so far (Claude Code reports one).

Each **turn divider** in the chat carries what that turn did to the window: `+12.3k context · 3 model calls · in 2 / cached 30.1k / written 2.5k / out 610 · $0.04` — how much the window grew or shrank, how many times the model was called (one per tool round), the turn's input / cache-read / cache-written / output tokens, and its cost. A compaction shows up as its own marker, `♻ Context compacted 180k → 42k (automatic)`.

**Click a compaction marker** to see what the agent actually did: the dialog lists the messages that were *compacted away* (for Claude Code, the ones it carried into the new window word for word are flagged *kept verbatim*) next to the *summary it became* — the text that is, from then on, all the agent remembers of that part of the conversation. The details are read from the agent's own records in the box when you open the dialog (Claude Code's transcript file, Devin's session database), so the box must be running; a stopped session says so. Devin does not record the trigger or the size after compaction, and the dialog says that too rather than guessing.

Click the gauge, or **Context** in the pane switcher, for the **Context pane**: the occupancy, the compactions, a history of the window over the session (the half-way line marked, drops are compactions), and the **breakdown by category**, taken by asking the agent `/context` while it is idle: for Claude Code that is the system prompt, built-in tools, MCP tools (each of your servers' tools with its tokens), memory files (`CLAUDE.md`), skills, messages, free space and the autocompact buffer; for Devin the system prompt, tools, messages and free space, estimated. **Take breakdown** / **Refresh breakdown** asks again (a `Context inspected: …` marker appears in the chat; the exchange itself is not part of the conversation), and the raw report is a click away.

### See exactly what goes to the model

For Claude Code sessions, **Inspect LLM** in the session's **⚙ Settings** turns on a recorder for the agent's model API calls: from then on every request Claude Code makes to the Anthropic API (or to your company's proxy, see below) and the response it got are kept, byte for byte. The agent bubbles and tool calls that came out of a call get an **`LLM #n`** label over their top-left corner; click it (or Tab to it and press Enter) for the call: **Request** and **Response** are the exact decoded bodies (byte count, *pretty* JSON, **Copy**, **Download**), **Tree** parses both (settings, the system blocks with their cache markers, every tool schema with its size, each message block; the response's content and stream events) and **Diff** shows what changed against the previous conversation call, so you can see what a turn added. Calls that produce no bubble (Claude naming the session, counting tokens, health checks) are in **Context → Model API calls**, a table of every call with its kind, model, status, tokens, sizes and duration; each row opens the same dialog. The recording turns on for the next call: switching it while the agent is working shows *pending* until the turn ends, since the agent process is restarted in place (it keeps the conversation).

The bodies stay inside the box, in memory (tmpfs): the last 40 calls with their bodies, older ones keep their summary line but say *body no longer in the Sandbox*, each body cut at 4 MB, and all of it goes when the box stops (the summaries stay in the chat). Headers are never recorded, so tokens and API keys are not either; what is recorded is everything the agent read, the system prompt and your prompts, which is why it is off by default and per session. Devin sessions have no such label: what its CLI sends from the box is a message to Cognition's servers, where the prompt is assembled and the model called, so there are no exact model bytes to show.

**Settings → Claude API base URL** shows where Claude Code in each box sends its calls right now and where that comes from: a URL set there, else the `ANTHROPIC_BASE_URL` of the Control Plane's environment, else Anthropic's `https://api.anthropic.com`. Set your company's Claude proxy there (a `localhost` URL on your machine works, the box reaches it as `host.docker.internal`), plus, if the proxy wants its own credential instead of the OAuth token, a **Proxy auth token** (`ANTHROPIC_AUTH_TOKEN`) or **Proxy API key** (`ANTHROPIC_API_KEY`), which are shown only as *set*/*not set* afterwards and stripped from snapshots like the tokens. With inspection on the chain is Claude Code → loopback recorder in the box → your proxy → Anthropic: the recorder forwards to the configured URL (trusting the extra CA certificates from Settings, as the agent does) and records what Claude Code sent, before any rewriting your proxy may do; with it off there is no hop at all. It applies to Sandboxes created afterwards.

### Pull requests attached to a session

Paste a GitHub pull request URL into a prompt, or ask the agent to open one (`gh pr create` in the box), and the PR is **attached** to the session: a **PRs** tab appears in the pane switcher with one row per PR (state, review decision, unread items, open review threads, last activity, watch switch, **Refresh** / **Detach** / GitHub link), and one **#123** tab per PR with its conversation comments, inline review comments and reviews in a table. You can also attach one by hand from the PRs tab: a URL, `owner/repo#123`, or just `#123` when exactly one GitHub repository is in the workspace (`owner/repo#123` when there are several). Detaching only forgets it here; nothing changes on GitHub.

Sessionboxer then **watches** each attached PR: about every minute while the session is idle or stopped, every five minutes while the agent is working (GitHub's conditional requests keep unchanged polls free). The requests run as `gh api` *inside the box*, with whatever GitHub login the box has: a GitHub entry from Settings (see below), a manual `gh auth login` in a terminal, or a `GH_TOKEN`; the login used is shown in the row (`synced 20s ago as @you`). When the box is stopped the Control Plane polls with the connected GitHub account instead, if one of them can read the PR; otherwise the row says *watching paused — Sandbox stopped* until you resume. A PR nobody can read says so, and a closed or merged PR stops being watched a day after closing.

New comments and reviews by other people make the PR's number in the sidebar and the tab light up with an unread count, and show a toast (and a browser notification, if you allow them from the PRs tab). When the agent is busy the toast waits until its turn ends, so it does not talk over the reply you are reading; the counts update right away. Opening a PR's tab marks its items read.

In a PR's tab every item has a checkbox and three buttons, and the bar above the table applies the same three to the ticked items at once:

- **To prompt** puts the item(s) into the prompt box, quoted and with the PR, author and `path:line`, for you to edit and send. Nothing is sent.
- **Address** sends that prompt to the agent (if it is busy, the prompt goes to *Saved for later* and the queue is started, so it is sent when the turn ends): edit, verify and commit on the PR's branch in the workspace, but do **not** reply or push; you keep the GitHub conversation.
- **Address & reply** does the same and additionally has the agent push, reply to each item on GitHub with `gh api` from the box and resolve the review threads it addressed. Bulk replies ask for confirmation first.

The prompt tells the agent the quoted text comes from GitHub reviewers and is feedback to evaluate, not instructions from you. **Address** buttons are only enabled when the PR belongs to one of the repositories in the workspace; for another repository use **To prompt** and tell the agent where to work. A `path:line` in an inline comment is a link into the Code pane, and the item's status column follows it: *in prompt*, *addressing*, then *addressed* once the agent replied in the thread or the thread was resolved.

**Auto-merge.** Tick **Auto-merge when checks pass** in a PR's tab (and pick *merge commit*, *squash* or *rebase* next to it) and the Control Plane asks GitHub every 10 seconds whether the PR may be merged, and merges it the moment the answer is yes: every check green — required or not — the reviews branch protection wants in, no conflict, not a draft, still open. The line next to the switch says what it is waiting for (*3 running — build, lint, e2e*, *conflicts with the base branch*, *reviews required*…), with the list of checks and links to them underneath; a branch that fell behind its base is brought up to date once per head. The merge is the normal GitHub merge — with the head commit pinned, so a push that lands between the check and the merge makes GitHub refuse and the next check starts over — so it never bypasses protection rules, and it runs with the same login the PR is watched with (the box's `gh`, or the connected GitHub account while the box is stopped). Once merged, the row says so, a toast and a push notification tell you, and nothing is checked again; untick to stop at any time.

### Pull the box's changes into your folder

Sessions with a copied host folder (folder icon next to the agent logo in the list; a git mark means a clone) have **Pull to folder…** in the header; with several copied folders, pick which one at the top of the dialog. It compares that repository's directory in the box with the folder on your machine and shows what would change before anything is written: new files (`+`), changed files (`~`), files the agent deleted (`−`). **Pull changes** applies them; files ignored by git (`node_modules`, build output) and `.git` itself stay in the box, and anything you added or changed only on your machine is left alone. A file that changed on both sides is a conflict: it is skipped and marked *kept yours*, unless you tick **Also overwrite…** (you are asked to confirm). Symlinks that would point outside your folder are never written. Pull as often as you like; each pull records the new common state, so the next one only shows what changed since. Pulling waits for the agent's turn to end and needs the box running.

### Verify each turn end to end

On by default. Turn it off (or back on) in **Settings → Verification** (the default for new sessions), per session in its ⚙ Settings or in the New Session form (*Settings default / On / Off*), from the switch in the **Verification** pane, or with `sessionboxer new --no-e2e` / `--e2e`.

With it on, every turn the agent finishes is followed by a hidden verification turn. The agent runs the `e2e-verification` skill installed in the box: it looks at what the turn changed (`git status` in each repository, what it did), and either records the run as **skipped** with a reason (an answer, research, nothing testable) or plans **2–5 test cases** from your prompt and what it understood you wanted (up to 10 for a very large change, rarely). It then starts a desktop recording and runs the cases one by one with the mouse, keyboard and browser of the box, captioning the video as it goes. A case that fails is fixed — that is normal agent work, in the same turn — and rerun as a new *cycle* of the same case, at most three fix attempts, after which it stays failed. At the end the recording stops and the agent replies with the video, which plays inline in the chat like any recording.

The **Verification** pane (**Verify** on the phone) opens by itself the moment the first case starts running, for the session you are looking at. It shows the run's status, a progress bar, each case with its state, a live timer while it runs, its cycle, the agent's note and a screenshot, the steps and expected result on click, the video when done, and earlier runs under *Earlier runs*. A marker at the end of the turn in the chat ("Verified: 4/4 passed · 2:13 · video", or "Verification skipped: …") opens the pane on that run. A run stays with the session across Stop/Resume; stopping the session or the Control Plane while one is open marks it *aborted*.

A verification turn never verifies itself, and a saved message waits until the verification is over. Each verified turn costs a second turn of model time plus the minutes the agent spends driving the desktop; switch it off for sessions where that is not worth it.

### Stop, resume, delete

- **Stop** pauses the box. It uses no CPU or memory while stopped; the conversation, files, installed packages and everything else in the container are kept.
- **Resume** brings it back where it was. The agent reloads the conversation, so you can continue as if nothing happened.
- **Delete** removes the session, its container and its snapshots for good (forks started from it keep working).

### Docker inside sessions

Some tasks need Docker: running a database for tests, `docker compose up`, building images. Tick **Docker inside the Sandbox** when creating a session, or turn it on for all new sessions in Settings, and the box gets its own Docker daemon. Images and containers created inside survive Stop/Resume and disappear with the session.

There are two ways this can run, and Sessionboxer picks automatically:

- With [Sysbox](https://github.com/nestybox/sysbox) installed on your machine (`sysbox-ce` package from its releases page), the box stays a normal, unprivileged container. Recommended.
- Without Sysbox, the box has to run as a *privileged* container, which means the agent could break out of it onto your machine. Sessionboxer still lets you do it, but shows a ⚠ on the Settings button, explains it next to the option, and marks such sessions in the sidebar and header. Only use this with agents and tasks you trust, or install Sysbox.

### MCP servers

The agent always has the built-in `desktop` MCP server (screen, mouse, keyboard). You can give it more: register **MCP servers** once in Settings, then choose per session which ones are on.

- **Settings → MCP servers**: **Add server** (a name, then either a command to run inside the box such as `npx -y @modelcontextprotocol/server-github` or `uvx mcp-server-fetch`, or the URL of an HTTP/SSE server, plus environment variables or headers) or **Import JSON…** and paste the `{"mcpServers": {...}}` block most servers document for Claude Desktop or Cursor. Mark values like tokens as **secret**: they are stored in `~/.sessionboxer/config.json`, never shown again in the UI, and never end up in snapshot images. **Default** decides whether new sessions start with the server on.
- **New session** shows the registered servers as checkboxes.
- **MCP** in the session header shows how many servers are on and opens a switch per server. Toggle at any time: when the agent is idle it restarts in place and keeps the conversation; while it is working the change waits until the current turn ends (the button shows *pending*). The chat shows an `MCP servers now: …` marker when the set changes.

Servers running on your machine are reachable from the box: `localhost` in a URL means your machine, and `host.docker.internal` works too. `node`, `npx`, `python3`, `uv`/`uvx` and `docker` are available in the box for command-based servers.

#### GitHub with one click

GitHub's own remote MCP server (issues, pull requests, code search, Actions…) needs a login token, and you do not have to paste one: click **Add GitHub** in Settings → MCP servers, give the entry a name, and click **Log in with GitHub**: it runs the GitHub CLI's login (open the link, type the code, approve). The card then shows **Connected as @you**. Add it **more than once with different names** (`github-work`, `github-personal`…) to log in with different GitHub accounts and pick per session which one the agent uses. **Reconnect** logs in again, **Disconnect** forgets the token but keeps the entry. The token is stored like any other secret header and never shown or snapshotted.

The login goes through the GitHub CLI (`gh`) on purpose: organizations that restrict third-party OAuth Apps still allow GitHub's own CLI, so private organization repositories work without asking an owner to approve anything. If `gh` is already logged in on your machine the dialog also offers **Use my gh login as @you** (no browser step); if `gh` is not installed, Sessionboxer downloads the official release (checksum-verified) into `~/.sessionboxer/bin` on first use. Either way it uses a private configuration under `~/.sessionboxer`, so your own `gh` accounts are never touched. **Log in with the Sessionboxer OAuth App** remains as a fallback; to use your own OAuth App instead, register one on GitHub (callback `<your public URL>/api/connectors/github/callback` — Settings shows the exact address —, Device Flow enabled) and put its Client ID in **Settings → GitHub login**; with the Client secret set too, that login switches from the device code to a plain browser redirect.

While a GitHub entry is enabled for a session, the box itself is logged in as that account too: `gh pr create --draft`, `gh pr view --comments`, `git push` and `git clone` of private HTTPS repositories work in the agent's shell and in the Terminal pane. Switch the entry off in the session's **MCP** popover and the login is gone from the box; it lives on tmpfs, so Snapshots and stopped boxes never carry it. SSH remotes are not covered; use HTTPS URLs for the box.

**Several accounts, one session.** Each GitHub repository of a session is bound to one of the connected logins: the **Account** dropdown next to a git URL (in New Session and in the header's repository dialog) lists every `Connected as @…` entry, with *auto* as the default — Sessionboxer asks GitHub which of the session's accounts can push to that repository (else which can see it, else the first) and binds that one; picking an account that is not yet enabled for the session turns its entry on. The repository is cloned as that account, and inside its directory `git push`/`git fetch` and every `gh` command act as it, whatever `gh auth status` says is active elsewhere (the directory's `.git/config` names the login, `sessionboxer.githubAccount`, never a token; `gh auth …` itself is left alone). The header chip shows *as @login*, the agent's briefing and `repos.json` say which account each repository uses, and PR watching, actions and auto-merge on that repository's pull requests use it first. Change the binding any time in the repository dialog (also while the box is stopped; it applies at resume), or choose *Active login (no binding)* to fall back to the box's active `gh` account (the first enabled entry; `gh auth switch` picks another). Copied host folders are not bound. CLI: `sessionboxer new --git <url> --as <login>`.

#### Bitbucket (Data Center) with one paste

A self-hosted Bitbucket (Data Center / Server, `bitbucket.yourcompany.com`) has no login an application can run on its own without its administrator, so this one takes a single paste: click **Add Bitbucket** in Settings → MCP servers, type the host, follow the link to its **HTTP access tokens** page (your profile → *Manage account* → *HTTP access tokens*), create a token with **Project → Read** and **Repository → Write**, paste it, **Connect**. Sessionboxer checks the token against the host, finds out whose it is and shows **Connected as @you on bitbucket.yourcompany.com**; the token is stored like any other secret header and never shown or snapshotted. Add one entry per host or account.

Unlike GitHub's, this entry adds **no MCP server**: it is a login for the box. While it is enabled for a session, `git clone`/`git push` to that host and [`bb`](https://github.com/talayolabs/bb) — a `gh`-like CLI for Bitbucket Data Center that ships in the Sandbox image — work as that account: `bb pr create`, `bb pr list`, `bb pr view --comments`, `bb pr checks`, `bb pr comment [--reply-to]`, `bb pr approve` / `request-changes` and `bb api <path>`. Git asks `bb auth git-credential`, whose `hosts.yml` the Daemon writes on tmpfs exactly like `gh`'s, so switching the entry off removes the login and Snapshots never carry it. Merging a PR is not among the commands (Bitbucket does not let HTTP access tokens merge; `bb pr view --web` opens it in the browser), and the PRs pane does not follow Bitbucket pull requests yet. Bitbucket Cloud (`bitbucket.org`) is not covered.

#### Behind Cloudflare WARP, Zscaler or another TLS-inspecting proxy

If your machine goes through a proxy that re-signs HTTPS, the agent and MCP servers inside a box would see `self signed certificate in certificate chain`, because the box only trusts the public CAs. Sessionboxer therefore copies the CA certificates your machine trusts *beyond* the public ones (the proxy's root) into every box at start and points Node, Python and OpenSSL at them, so HTTPS from the box works like from your machine. The Control Plane trusts the same certificates itself (Node alone would not), so its own downloads (`gh`, `cloudflared`, `frpc`) and the tunnel server's API pass the proxy too. **Settings → TLS certificates in Sandboxes** lists what was found, lets you turn the copy off, and takes extra PEM certificates for CAs not installed on this machine. Changes apply at Sandbox start: Stop → Resume running sessions. `npm run build:image` hands the same certificates to `docker build`, so the downloads during the image build (apt, npm, GitHub releases) pass the proxy too; it prints which ones it found.

## Remote access: phone and other machines

Everything the Control Plane serves — the UI, the API, terminals, the desktop, VS Code — is behind a login, whether you reach it on `127.0.0.1` or through a tunnel. There is one **access token** per Control Plane, generated at first start into `~/.sessionboxer/config.json` (`SESSIONBOXER_ACCESS_TOKEN` in the environment overrides it; `sessionboxer token` prints it). A browser logs in with it once, on the login screen, and gets its own **device**: an HttpOnly cookie that lasts a year, until you revoke it. `npm start` prints a one-time **pairing link** (`http://127.0.0.1:4000/#pair=…`, valid 5 minutes) so the first browser never sees the token.

**Settings → Devices and remote access** lists the browsers that are logged in (name, last seen, from where), with **Revoke** per device and **Log out** for the current one. **Pair another device** shows a QR code and a link, good once for 5 minutes: scan it with the phone (or open the link on the other machine) and that browser is logged in as its own device — the token itself never leaves the browser you are on. **Show access token** reveals it on demand, and **Rotate token** makes a new one, logging out every other device and every CLI that used the old token (not available when the token comes from the environment). Wrong tokens and codes are rate-limited per address; cookies are `SameSite=Lax` and requests from another origin are refused.

### The phone, from anywhere: Pair another device ▾

**Pair another device** is a menu: **Local network** (the address the Control Plane listens on, for a phone on the same Wi-Fi), **Cloudflare quick tunnel**, **Sessionboxer tunnel** and **Own server over SSH**. Each of the three tunnels is an outbound connection from the Control Plane to something on the internet, so nothing is opened on the home router; picking one switches it on if it was off (the switch, its address and its last error live in the same section), and the QR / link is made with that tunnel's address once it is up — so the phone side is always: scan, tap, logged in. The tunnels you switch on stay on across restarts of the Control Plane; their programs stop with it and are restarted with back-off if they die. Several can be up at once, and a phone paired through one keeps working through any of them (the cookie is for the device, not the address).

Whatever the transport, **the access token is the only wall**: anonymous requests through a tunnel get a 401 exactly as on `localhost`, and a tunnel's forwarded headers (`X-Forwarded-For`, so the device list shows the phone's address, and `X-Forwarded-Proto`, so cookies are `Secure`) are only believed on requests that arrive from that tunnel's program on this machine carrying the tunnel's hostname. `SESSIONBOXER_PUBLIC_URL` is not touched by any of them — configured links and the GitHub OAuth callback keep using it.

- **Cloudflare quick tunnel** — zero setup, changing address. The Control Plane downloads `cloudflared` on first use (a pinned release, SHA-256 checked, kept in `~/.sessionboxer/bin`; an installed one on the PATH is used instead) and runs `cloudflared tunnel --url` to itself: a random `https://<four-words>.trycloudflare.com` with a real certificate, no Cloudflare account, no DNS. Traffic passes Cloudflare's edge, TLS-terminated there and re-encrypted to your machine, and **the address changes every time the tunnel starts** (paired phones stay logged in; bookmarks go stale). Quick tunnels are Cloudflare's try-out tier: no uptime promise, rate limits, may be changed or discontinued. `SESSIONBOXER_CLOUDFLARED_VERSION` picks another release (checksums then read from the release notes).
- **Sessionboxer tunnel** — stable address, no account: `https://<name>.tunnel-sessionboxer.talayolabs.com`. The Control Plane downloads `frpc` ([frp](https://github.com/fatedier/frp), pinned, SHA-256 checked, `~/.sessionboxer/bin/frpc`) and connects it over TLS to the project's `frps` server at `frps.tunnel-sessionboxer.talayolabs.com:443`, which routes the hostname to your machine; the server's certificate (the same Let's Encrypt one your phone sees) is verified against the roots this machine trusts — first by the Control Plane, before the secret is sent anywhere, then by `frpc` on every connection (`transport.tls.trustedCaFile`) — so a server that cannot prove its name gets nothing but an error in Settings. The **name** is yours to pick (default: this machine's hostname; 3–40 lowercase letters, digits and dashes; the field checks availability as you type) and is bound to a secret the Control Plane generated into `config.json` at first start — the first machine to log in with a name owns it, another secret is refused, so nobody can take your address; forget the secret (a fresh `~/.sessionboxer`) and the name is gone with it. Traffic passes the tunnel server (Hetzner, Finland — so latency is phone→Helsinki→you), where TLS is terminated (as at Cloudflare's edge) and re-encrypted to your machine; it keeps connection counts and bytes per name for its usage graphs, not content. Any server that speaks the same small API can be entered instead (the **Server** field; deploy your own from [talayolabs/sessionboxer-tunnel](https://github.com/talayolabs/sessionboxer-tunnel), which also has Prometheus + Grafana). `SESSIONBOXER_FRP_VERSION` picks another frp release.
- **Own server over SSH** — a machine you already have with a public address and `sshd`: the Control Plane runs your system `ssh -N -R` to it (user, host, port, key file — or your agent — with host keys checked on first use and remembered), so the server's `<remote port>` forwards to the Control Plane. Choose **bind: all addresses** and the phone opens `http://<host>:<remote port>` — this needs `GatewayPorts yes` (or `clientspecified`) in that server's `sshd_config` and the port open in its firewall — or **bind: localhost only** with a reverse proxy on the server (Caddy, nginx) in front that has the certificate, and enter the **public URL** it serves. Plain `http://` works for the chat, desktop and terminals but browsers only allow the clipboard, notifications and the VS Code pane from a secure context, so prefer the proxy with HTTPS for daily use.

### Your own address

The address itself is your choice; what Sessionboxer needs is HTTPS when you are not on `localhost` (browsers only allow the clipboard, notifications and the VS Code pane from a secure context) and `SESSIONBOXER_PUBLIC_URL` set to the URL you type in the browser, so that pairing links, the printed login link and the GitHub OAuth callback carry it. `Settings → Devices` says which address the Control Plane believes it is reached at.

- **Private network: Tailscale (or a Headscale server you host).** Both the machine that runs Sessionboxer and your phone or laptop join a private WireGuard network; nothing is exposed to the internet and only your devices can even connect — the phone needs the Tailscale app. `tailscale up`, then `tailscale serve --bg 4000` gives `https://<server>.<tailnet>.ts.net` with a real certificate, tailnet-only; set `SESSIONBOXER_PUBLIC_URL` to that URL and `SESSIONBOXER_TRUST_PROXY=1`. Headscale cannot issue certificates for its MagicDNS names, so there serve HTTPS yourself: Caddy on the server (`reverse_proxy 127.0.0.1:4000`, certificate via a DNS-01 challenge or `tls internal` with its root installed on the phone) plus `SESSIONBOXER_PUBLIC_URL` and `SESSIONBOXER_TRUST_PROXY=1`, or the Control Plane's own `SESSIONBOXER_TLS_CERT` / `SESSIONBOXER_TLS_KEY` with `SESSIONBOXER_HOST=<tailnet IP>`.
- **A permanent URL that works from any browser: a named Cloudflare Tunnel.** The grown-up version of the quick tunnel: `cloudflared tunnel` on the server keeps an outbound connection to Cloudflare, which terminates TLS on a hostname of a domain you have there and forwards to `http://127.0.0.1:4000`; put **Cloudflare Access** in front for a second login (email code, Google, GitHub). Set `SESSIONBOXER_PUBLIC_URL=https://box.yourdomain.tld` and `SESSIONBOXER_TRUST_PROXY=1`. Cloudflare drops idle WebSockets after 100 s; the Control Plane pings every 25 s, so terminals and the desktop survive.
- **The server is a VPS with a public address.** Run Caddy (or nginx) on it with automatic certificates, proxying to `127.0.0.1:4000`, and again `SESSIONBOXER_PUBLIC_URL` + `SESSIONBOXER_TRUST_PROXY=1`. Consider still joining it to a tailnet and firewalling `:443` to the tailnet, since the access token is then the only wall.

`SESSIONBOXER_TRUST_PROXY=1` makes the Control Plane believe `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` (the device list then shows the real client address and cookies are marked `Secure`); leave it unset when nothing sits in front. `SESSIONBOXER_HOST=0.0.0.0` binds every interface, for the rare case where the proxy runs on another machine. From another machine the CLI uses `SESSIONBOXER_URL` and `SESSIONBOXER_TOKEN` (or `sessionboxer pair` on the server to get a link for a browser).

### On the phone

Below 800 px wide the same UI becomes a phone layout: the session list is a drawer behind the ☰ button, the session shows **one pane at a time** picked from tabs along the bottom — Chat, Desktop, Code, Terminal, Context and PRs (with its unread count) — and the header's actions (Snapshot, Fork, Pull, Settings, branch, Stop/Delete) sit in a sheet behind ⋯. The composer follows the on-screen keyboard (the app resizes to the visual viewport instead of scrolling away) and respects the notch and home indicator. The Desktop pane's **Keyboard** button opens a bar that brings up the phone's keyboard and adds the keys it lacks — Ctrl, Alt, Shift, Super as sticky modifiers, Esc, Tab, Enter, Backspace and the arrows — everything is sent as key events to the box, so `Ctrl`+`c` or `Alt`+`Tab` work; noVNC's touch gestures (tap, two-finger scroll, long-press for right click, pinch) are unchanged. The app is installable: *Add to Home Screen* on iPhone, *Install app* on Android, and it opens full-screen without browser chrome.

**Notifications while the phone sleeps.** In **Settings → Devices and remote access**, *Notify this device when a turn ends or a pull request gets feedback* subscribes that browser to Web Push (needs HTTPS — the tunnel or your own address — and on iPhone the app added to the Home Screen first, iOS 16.4+). The Control Plane generates its VAPID key pair into `config.json` on first start, encrypts every message per RFC 8291 itself (no third-party service beyond the browser vendor's push relay, which only sees ciphertext) and sends one when an agent's turn ends (with the first line of its last message) or a pull request gets new comments or reviews — to every subscribed device *except* those with the page on screen, which see it happen live. Tapping the notification opens the session, the PR overview or the single PR. **Send a test notification** checks the path end to end. Subscriptions belong to the device: revoking a device or logging out drops its subscription, a push service answering 404/410 does too, and the endpoint and keys are never shown in the UI or the API.

## Command line

The `sessionboxer` command talks to the running server and opens the browser on the new session. It comes with the npm package (`npx sessionboxer …`, or on your PATH after `npm i -g sessionboxer`); from a checkout, `npm link -w @sessionboxer/cli` once.

```sh
sessionboxer serve                                   # start the server (same as npm start)
sessionboxer service install                         # …or run it in the background, now and at every login (macOS, Linux)
sessionboxer service status | stop | start | restart | log | uninstall
sessionboxer new .                                   # box the current directory
sessionboxer new . -p "run the tests and fix what breaks"
sessionboxer new . --provider devin --docker
sessionboxer new . --e2e                             # verify each turn end to end (--no-e2e to turn it off)
sessionboxer new . --model haiku                     # a model id as the provider names it
sessionboxer new . --model opus --option effort=high --option fast=on
sessionboxer new . --instructions @rules.md          # standing instructions from a file ("" for none)
sessionboxer new --git https://github.com/org/repo.git --ref main
sessionboxer new --git https://github.com/org/frontend@main --git https://github.com/org/backend ../docs   # several repositories, /workspace/<name> each
sessionboxer new --git https://github.com/org/repo.git --name app             # pick the directory name
sessionboxer new --git https://github.com/org/repo.git --git-name "Jane Doe" --git-email jane@work.example
sessionboxer new --empty -t scratch --no-open
sessionboxer ls
sessionboxer open [id] | stop <id> | resume <id> | rm <id>
```

`SESSIONBOXER_URL` points it at a server other than `http://127.0.0.1:4000`; on the machine that runs the Control Plane the CLI reads the access token from `~/.sessionboxer/config.json`, elsewhere set `SESSIONBOXER_TOKEN`. `sessionboxer token` prints the token, `sessionboxer pair` a one-time login link for a browser.

## Where things live

| | |
| --- | --- |
| Settings, tokens, MCP servers | `~/.sessionboxer/config.json` |
| Sessions and chat history | `~/.sessionboxer/db.sqlite` |
| Session containers | `sbx-<session id>` on the `sessionboxer` Docker network, no published ports |
| Workspace root in the box (repositories in `/workspace/<name>`) | `/workspace` |
| Sandbox image | `ghcr.io/talayolabs/sessionboxer-sandbox:<version>` (pulled, or built locally by `npm run build:image`); `SESSIONBOXER_IMAGE` overrides |
| Snapshot images | `sessionboxer/snapshot:<session id>-<n>`; unreferenced ones are removed at startup |
| What was last pulled into a copied folder | `~/.sessionboxer/sync/<session id>.json` |
| Downloaded `cloudflared` / `frpc` (tunnels), `whisper-cli` (dictation) | `~/.sessionboxer/bin/` |
| Whisper models for dictation | `~/.sessionboxer/models/whisper/ggml-<name>.bin` |
| Sessionboxer tunnel secret, generated `frpc.toml`, CA bundle for `frpc` | `~/.sessionboxer/config.json`, `~/.sessionboxer/frpc.toml` (mode 600), `~/.sessionboxer/tunnel-ca.pem` |

`CLAUDE_CODE_OAUTH_TOKEN` or `WINDSURF_API_KEY` set in the environment of `npm start` take precedence over the tokens in Settings. `SESSIONBOXER_HOST` / `SESSIONBOXER_PORT` change where the Control Plane listens (default `127.0.0.1:4000`); `SESSIONBOXER_PUBLIC_URL`, `SESSIONBOXER_TRUST_PROXY`, `SESSIONBOXER_TLS_CERT` / `SESSIONBOXER_TLS_KEY` and `SESSIONBOXER_ACCESS_TOKEN` are described under [Remote access](#remote-access-phone-and-other-machines).

## Troubleshooting

- **"docker: permission denied"** when starting: add your user to the `docker` group (`sudo usermod -aG docker $USER`, then log out and in).
- **Session goes to *error* with "cannot pull ghcr.io/…"**: the Sandbox image for this version is still downloading (watch the Control Plane log) or the machine cannot reach ghcr.io; `npm run build:image` builds it locally instead. **"sandbox image … not found; run `npm run build:image`"** appears only with a custom `SESSIONBOXER_IMAGE`.
- **"method not found: _sessionboxer/…"** after updating Sessionboxer: the box still runs the previous version's internals. Stop and Resume the session; the current build is copied into the box on every start, so `npm run build:image` is only needed when the image itself changes (system packages, agent CLIs).
- **Code pane says "openvscode-server is not installed in this Sandbox image"**: run `npm run build:image`, then Stop → Resume the session.
- **Devin session fails right after creation**: Devin occasionally times out while loading team settings on a cold start. Sessionboxer retries a few times; if it still fails, Resume the session.
- **`cannot fetch https://github.com/…: self-signed certificate in certificate chain`** in the Control Plane log (downloading `frpc`, `cloudflared` or `gh`): the same proxy, and the Control Plane did not find its CA — see **Settings → TLS certificates in Sandboxes**, paste the PEM there (applies at once, no restart), or put the binary in `~/.sessionboxer/bin/` yourself.
- **"self signed certificate in certificate chain"** from an MCP server or the agent inside a box: your machine goes through a TLS-inspecting proxy (Cloudflare WARP, Zscaler…). Check **Settings → TLS certificates in Sandboxes** lists its CA (paste the PEM there if not), then Stop → Resume the session. The same error from `curl` or `npm` *during* `npm run build:image` means that CA was not found on this machine: `build:image` prints the ones it uses; paste the PEM in that Settings section and build again.
- **Docker inside the box can't pull images**: Docker Hub rate-limits anonymous pulls per IP; log in with `docker login` in the box's Terminal or pull from another registry.

### macOS

Sessionboxer talks to each box over the private `sessionboxer` Docker network. On macOS the Docker daemon runs in a VM, and only [OrbStack](https://orbstack.dev) routes container addresses to the host. Sessionboxer checks which daemon it is talking to at startup (the `sandbox reach: ip|localhost` line in the log):

- **OrbStack**: boxes are reached by container address, exactly as on Linux.
- **Docker Desktop, Colima, …**: each box additionally publishes its two internal ports (daemon and desktop) on `127.0.0.1` with random host ports, and the server dials those. Nothing is exposed beyond your machine. `SESSIONBOXER_SANDBOX_REACH=ip` or `=localhost` overrides the detection (for example `ip` with Docker Desktop + [docker-mac-net-connect](https://github.com/chipmk/docker-mac-net-connect)).

Other notes: Colima does not create `/var/run/docker.sock`, so export `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` before `npm start`. Sysbox is Linux-only, so *Docker inside the Sandbox* always uses the privileged mode on macOS (the box is still inside the Docker VM, not your Mac). The sandbox image builds natively on Apple Silicon (arm64).

## For contributors

Architecture, decisions and the milestone log are in [docs/DESIGN.md](DESIGN.md), the vocabulary in [CONTEXT.md](../CONTEXT.md), and the reasoning behind each decision in [docs/adr](adr). Layout is npm workspaces: `apps/control-plane` (server), `apps/web` (UI), `apps/cli`, `apps/desktop` (Electron tray shell), `packages/sandbox-daemon` and `packages/computer-use-mcp` (run inside the box), `packages/protocol` (shared types), `images/sandbox` (the Sandbox image), `images/control-plane` (the Control Plane image for Compose). `npm run dev -w @sessionboxer/web` starts the UI with hot reload against a running server.

Releasing: bump the version in the root and every workspace `package.json` (including the `@sessionboxer/*` dependency versions) and `package-lock.json` (`npm install`), add a `## <x.y.z>` section to [CHANGELOG.md](../CHANGELOG.md), commit, then `git tag v<x.y.z> && git push origin main v<x.y.z>`. The [release workflow](../.github/workflows/release.yml) checks that the tag matches the version, typechecks and builds, assembles the npm package (`npm run pack` → `build/sessionboxer-<x.y.z>.tgz`), builds both images for amd64 and arm64 on native runners and pushes them to GHCR as `<x.y.z>` and `latest`, publishes to npm when the `NPM_TOKEN` repository secret is set (otherwise `npm publish build/sessionboxer-*.tgz --access public` by hand), and creates the GitHub Release from the changelog section.
