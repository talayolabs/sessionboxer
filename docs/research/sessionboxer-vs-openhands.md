# Sessionboxer vs OpenHands

The owner asked: *why might Sessionboxer be better than OpenHands? I'm not sure what features we have that OpenHands does not have.* This document answers that honestly: where Sessionboxer is ahead, where OpenHands is ahead, where they are the same, and what the site's comparison table gets wrong today.

Short version: **the two products solve different problems and overlap less than the site's table suggests.** OpenHands is an agent *framework and platform*: its own LLM-agnostic agent (plus, since 2026, Claude Code / Codex / Gemini CLI over ACP), a Python SDK and REST API, a browser UI ("Agent Canvas"), a large catalogue of automations (cron, webhooks, GitHub/GitLab/Slack/Jira/Linear), and paid Cloud and Enterprise editions with auth, RBAC and budgets. Sessionboxer is a *workbench for the vendors' agents*: one agent per session inside a real machine (Linux desktop, or a Windows/macOS VM the agent runs in), which you can watch, take over, snapshot, fork, stop and resume, with the agent proving its work on video after every turn — and, since the automations work on `main` (ADR-0063 to 0069), a reviewer and a QA-on-video pass over every pull request of a repository you follow. Where the two overlap — MCP, automations, PRs, remote access, context display — they are close, with different strengths.

## What was reviewed, and when

Reviewed on **2026-09-28**. OpenHands moves fast (Agent Canvas shipped v1.20 → v1.24 between 2026-09-17 and 2026-09-25; the SDK had three releases in the same week), so treat every OpenHands statement below as "true at these commits".

| Thing | What | Where |
| --- | --- | --- |
| Sessionboxer | 1.4.1 plus the unreleased `main` at `0490893` (automations, followed pull requests, Auto review, Auto QA on a PR, webhooks, start from a snapshot — [ADR-0063](../adr/0063-automations-triggers-actions-and-limits-run-by-the-control-plane.md) to [ADR-0069](../adr/0069-new-sessions-and-automations-start-from-a-snapshot.md)) | this repository: `README.md`, `docs/GUIDE.md`, `docs/MCP.md`, `CHANGELOG.md`, `docs/adr/` |
| OpenHands Agent Canvas (the app, formerly `All-Hands-AI/OpenHands`) | v1.24.0, commit `c3c252ad6196de1237324b81b7d19146acce444c` | https://github.com/OpenHands/OpenHands |
| OpenHands Software Agent SDK + Agent Server (the V1 agent, tools, sandbox images) | commit `978f3b46130416528fd076628ef685343819f05c` (v1.49.6 released 2026-09-25) | https://github.com/OpenHands/software-agent-sdk |
| OpenHands legacy app (V0 GUI, archived) | commit `ee9e78b7defdfa744e0bbe48c9cafa90b6135ad7`, last commit 2026-07-25 | https://github.com/OpenHands/legacy |
| OpenHands docs | the full index at https://docs.openhands.dev/llms.txt and the pages linked below | https://docs.openhands.dev |
| Run locally | legacy GUI `docker.openhands.dev/openhands/openhands:1.8` (prints *OpenHands SDK v1.27.0*) and Agent Canvas `ghcr.io/openhands/agent-canvas:1.24.0` | screenshots at the end |
| Site table | `pages/features.mjs`, OpenHands column | https://github.com/talayolabs/sessionboxer-site |

Updated later on 2026-09-28 for the Sessionboxer commits `1ef237b` → `0490893` (Automations replacing Scheduled tasks, the Pull requests page, Auto review and Auto QA on PRs, webhooks); the OpenHands side was not re-checked and is still at the commits above.

Two things changed since the site's table was written and since the task brief was drafted:

- The GitHub organisation is now `OpenHands` (not `All-Hands-AI`) and the docs live at `docs.openhands.dev` (not `docs.all-hands.dev`). The old monorepo (Python backend + React frontend, "V0") is archived as `OpenHands/legacy`; the `OpenHands/OpenHands` repository now holds **Agent Canvas**, a TypeScript UI that talks to a backend built on the Python SDK. Docs: https://docs.openhands.dev/openhands/usage/agent-canvas/overview.md, https://docs.openhands.dev/openhands/usage/agent-canvas/architecture.md.
- OpenHands is no longer "own agent only": Agent Canvas offers **Claude Code, Codex and Gemini CLI as ACP agents** next to the OpenHands agent (https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents.md, https://docs.openhands.dev/sdk/guides/agent-acp.md; seen in the onboarding, screenshot 04). Sessionboxer's "we run the vendors' agents, they run their own" differentiator is now partly shared.

Four editions of OpenHands are compared, because features differ between them: **local Agent Canvas** (open source, `npm i -g @openhands/agent-canvas` or Docker), **self-hosted backend** (the same open-source services on a VM), **OpenHands Cloud** (managed, paid) and **OpenHands Enterprise** (self-hosted, commercial). The matrix is at https://docs.openhands.dev/enterprise/enterprise-vs-oss.md. When a row says "Cloud" or "Enterprise" the feature is *not* in the open-source local install.

**The local attempt**: both images were started with the documented `docker run` commands and their UIs were reached and screenshotted (legacy GUI on :3000, Agent Canvas on :8000). **No model-backed task was run**: there is no Anthropic (or other provider) key in this session's secret store, and the UI refuses to start a conversation without one (screenshot 06). Everything about what the agent *does* in a conversation therefore comes from the docs and the source, not from watching it.

Legend for the tables: **✓** verified available · **✗** verified absent (stated in the docs, or the mechanism to provide it does not exist in the reviewed source) · **—** not found in the reviewed docs/source (not proof of absence) · **Cloud** / **Ent** only in that edition.

## Feature by feature

### 1. The agent

| | Sessionboxer | OpenHands | Notes |
| --- | --- | --- | --- |
| Who is the agent | The vendors' own: Claude Code, Codex, Cursor, Devin, over ACP, on your subscription ([README](../../README.md), [ADR-0001](../adr/0001-agent-runs-inside-the-sandbox.md)). No agent of its own. | Its own agent (SDK `Agent`, default tools: terminal, file editor, task tracker, browser toolset, delegate/task toolset — `openhands-tools/openhands/tools/preset/default.py` @ `978f3b4`) **and** Claude Code / Codex / Gemini CLI / any custom ACP server ([ACP agents](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents.md)). | Both run vendor agents over ACP. Only OpenHands has an agent of its own. |
| Model choice | Whatever the vendor agent offers, switched mid-conversation ([GUIDE](../GUIDE.md#talk-to-the-agent)). | Any LiteLLM-supported provider, OpenAI-compatible endpoints, OpenHands-hosted keys; profiles per agent ([model configuration](https://docs.openhands.dev/openhands/usage/agent-canvas/model-configuration.md), [agent profiles](https://docs.openhands.dev/openhands/usage/agent-canvas/agent-profiles.md)). | OpenHands ahead for its own agent (open-weight and local models included). Same for ACP agents (the vendor decides). |
| Paying for it | The subscription's meter; Sessionboxer shows the vendor's 5-hour / weekly bars and auto-continues at reset ([GUIDE](../GUIDE.md#usage-limits-the-bars-the-no-entry-sign-continue-and-auto-continue)). | API key per token by default; subscription login exists for some providers/ACP agents ([LLM subscriptions](https://docs.openhands.dev/sdk/guides/llm-subscriptions.md)); Cloud has organisation budgets ([budgets](https://docs.openhands.dev/openhands/usage/cloud/organizations/budgets.md), Cloud). | Different. Flat-rate subscriptions favour Sessionboxer's model for heavy users; metered API favours OpenHands for occasional or bring-your-own-model use. |
| Tool-calling, quality | The vendor's; Sessionboxer adds two MCP servers (`desktop`, `sessionboxer`) and the `e2e-verification` skill ([MCP.md](../MCP.md)). | Own agent: tools, condenser, critic, skills are OpenHands'. For ACP agents the SDK is explicit that `tools`, `mcp_config`, `condenser`, `critic` do not apply — the external agent owns them ([agent-acp](https://docs.openhands.dev/sdk/guides/agent-acp.md)). | Not comparable head to head; see §11. |
| Skills / plugins / hooks | The agent's own (`CLAUDE.md`, `AGENTS.md`, Claude Code skills and hooks). Sessionboxer installs one skill and a system prompt; no plugin format of its own. | `.openhands/skills` (formerly microagents), `.openhands/setup.sh`, `.openhands/hooks.json` (Stop hooks can block completion until tests pass), plugins bundling skills + MCP + hooks + commands ([repository customisation](https://docs.openhands.dev/openhands/usage/customization/repository.md), [hooks](https://docs.openhands.dev/openhands/usage/customization/hooks.md), [plugins](https://docs.openhands.dev/openhands/usage/agent-canvas/plugins.md)). | **OpenHands ahead** (for its own agent). |
| Memory, condensation | Does not compact; shows the agent's compaction: gauge, `♻ n`, what was compacted away vs the summary, `/context` breakdown ([GUIDE](../GUIDE.md#how-full-is-the-context), [ADR-0030](../adr/0030-context-observability-from-acp-usage-and-the-agents-own-context-report.md), [ADR-0031](../adr/0031-compaction-details-read-from-the-providers-own-records-in-the-sandbox.md)). | Own condenser (LLM summarising, configurable) and a context meter with manual compaction in the UI; persistent memory across conversations ([context condenser](https://docs.openhands.dev/sdk/guides/context-condenser.md), [conversations](https://docs.openhands.dev/openhands/usage/agent-canvas/conversations.md)). | Different. OpenHands *does* compaction; Sessionboxer *explains* the vendor's. See §4 for the display. |
| Repo instructions | Whatever the agent reads (`CLAUDE.md`, `AGENTS.md`) plus Sessionboxer's system prompt. | `.openhands/` directory: skills, setup script, hooks, plugins; `AGENTS.md` maintained by a template automation (seen in screenshot 07). | Equivalent in effect; OpenHands' is its own format. |

**Verdict**: OpenHands ahead on agent flexibility (own agent, any model, its own skills/hooks/plugins). Sessionboxer's pitch is the opposite — no agent of its own, the vendors' agents unchanged — which is a choice, not a gap, but it can no longer be sold as unique.

### 2. The sandbox

| | Sessionboxer | OpenHands | Notes |
| --- | --- | --- | --- |
| Where the agent runs | One Docker sandbox per session (Sysbox, a full Linux with systemd-less desktop), or a QEMU Windows/macOS VM the agent runs *inside* ([ADR-0001](../adr/0001-agent-runs-inside-the-sandbox.md), [ADR-0060](../adr/0060-the-agent-runs-inside-the-windows-vm.md), [ADR-0061](../adr/0061-the-agent-runs-inside-the-macos-vm.md)). | Backends: Docker (one `agent-server` container per conversation), **process** (no isolation, on the host), remote/VM (agent-server on a machine you run), Modal, Cloud, Enterprise ([backends](https://docs.openhands.dev/openhands/usage/agent-canvas/backends.md), [Docker backend](https://docs.openhands.dev/openhands/usage/agent-canvas/backend-setup/docker.md), [VM](https://docs.openhands.dev/openhands/usage/agent-canvas/backend-setup/vm.md), [Modal](https://docs.openhands.dev/openhands/usage/agent-canvas/backend-setup/modal.md), [sandboxes](https://docs.openhands.dev/openhands/usage/sandboxes/overview.md)). The archived V0 GUI also listed Remote, Local (no Docker), E2B, Modal, Runloop and Daytona runtimes ([V0 runtimes](https://docs.openhands.dev/openhands/usage/v0/runtimes/V0_overview.md)); those are V0-only. | Equivalent for Docker. OpenHands has more *kinds* of backend (including a no-sandbox process mode and hosted ones). |
| Image customisation | One image, extended by the agent at runtime (Docker in the box). | Custom agent-server images ([Docker sandbox](https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox.md)); Enterprise custom runtime images ([Ent vs OSS](https://docs.openhands.dev/enterprise/enterprise-vs-oss.md)). | OpenHands ahead. |
| Resource limits | Docker limits per sandbox via the daemon's defaults; not surfaced per session. | Docker/Modal options of the backend; not surfaced per conversation in the reviewed docs. | — both; no verified per-session UI in either. |
| Docker inside the box | ✓ Sysbox; `docker run` works inside ([ADR-0008](../adr/0008-docker-inside-sandboxes-via-sysbox.md)). | — not found in the V1 docs or the agent-server Dockerfile (`openhands-agent-server/openhands/agent_server/docker/Dockerfile` @ `978f3b4` installs OpenVSCode Server, no Docker daemon). | Sessionboxer ahead as far as the docs go. |
| Persistence across restarts | The sandbox is the session's machine: stop it, resume it, everything is where it was ([GUIDE](../GUIDE.md), [ADR-0009](../adr/0009-snapshots-via-docker-commit-and-forks-as-new-sandboxes.md)). | Conversation events persist; files inside an unmounted container are lost when it is removed, mounted host directories persist ([FAQ](https://docs.openhands.dev/overview/faqs.md)). The SDK can `pause()`/resume a running agent loop (`openhands-sdk/openhands/sdk/conversation/base.py` @ `978f3b4`) — that pauses the *agent*, not the machine. | **Sessionboxer ahead**: stop/resume with the machine intact is the product's core; OpenHands' persistence is the workspace mount. |
| Snapshots and forks of the machine | ✓ `docker commit` snapshots by hand or after every turn; fork a new session from any ([ADR-0009](../adr/0009-snapshots-via-docker-commit-and-forks-as-new-sandboxes.md)). | ✗ for the machine. **Conversation fork** exists: a new conversation with the events copied ([convo-fork](https://docs.openhands.dev/sdk/guides/convo-fork.md)), the sandbox is not cloned. | **Sessionboxer ahead.** |
| Windows and macOS *environments* | ✓ QEMU VM, agent, repos and MCP servers native in the guest ([ADR-0057](../adr/0057-a-windows-vm-next-to-the-linux-sandbox-qemu-kvm-over-rdp.md), [ADR-0059](../adr/0059-a-macos-vm-with-dockur-opencore.md)). | ✗ none documented. Windows/macOS are supported as *hosts* (Docker Desktop, WSL) ([setup](https://docs.openhands.dev/openhands/usage/agent-canvas/setup.md), [local setup](https://docs.openhands.dev/openhands/usage/run-openhands/local-setup.md)); the sandbox is always Linux. | **Sessionboxer ahead.** Sessionboxer needs a Linux host with KVM for these; OpenHands runs on more hosts. |

**Verdict**: OpenHands has more places to run the agent; Sessionboxer treats the sandbox as a machine you keep (stop/resume, snapshot, fork, Docker inside, Windows/macOS guests). This is Sessionboxer's clearest lead.

### 3. Desktop and browser

| | Sessionboxer | OpenHands | Notes |
| --- | --- | --- | --- |
| What the agent sees | The whole X display (or the VM's desktop over RDP/VNC): `screenshot`, `zoom`, mouse, keyboard, scroll — 21 `desktop` tools ([MCP.md](../MCP.md), [ADR-0004](../adr/0004-x11-desktop-with-custom-computer-use-mcp.md)). | A browser (browser-use / Playwright): navigate, click, type, scroll, tabs, storage, get state with screenshot — the `Browser*Tool` classes in `openhands-tools/openhands/tools/browser_use/definition.py` @ `978f3b4` ([browser use](https://docs.openhands.dev/sdk/guides/agent-browser-use.md)). | Different scope: OpenHands controls *web pages*; Sessionboxer controls *the screen* (native apps, Electron, Windows/macOS UIs). |
| GUI-desktop control (xdotool-style) | ✓ | — no `xdotool`/X11/VNC in the SDK tools or agent-server image (searched at `978f3b4`). | Sessionboxer ahead, as far as the reviewed source goes. |
| What the user sees | Live desktop (noVNC), **Take control** with your own mouse and keyboard ([GUIDE](../GUIDE.md)). | Tabs: Changes, VS Code, Terminal, App, Browser; the GUI docs say *the browser is non-interactive* ([key features](https://docs.openhands.dev/openhands/usage/key-features.md)). | **Sessionboxer ahead** on watching and taking over. |
| VS Code, terminal | ✓ in the box, files named in chat open at the line ([README](../../README.md)). | ✓ OpenVSCode Server in the agent-server image (Dockerfile above), Terminal tab ([key features](https://docs.openhands.dev/openhands/usage/key-features.md)). | Equivalent. The site's `—` for OpenHands VS Code is wrong. |
| Recordings | ✓ desktop video, captions and narration burned in and as VTT, in the chat ([ADR-0017](../adr/0017-desktop-recording-with-ffmpeg-and-inline-workspace-media-in-the-chat.md), [ADR-0026](../adr/0026-recording-captions-narrated-by-the-agent-burned-in-and-as-a-vtt-track.md)). | `BrowserStartRecordingTool` / `BrowserStopRecordingTool` record the *browser* session (same file); screenshots appear in the chat. No captions/narration found. | Sessionboxer ahead; OpenHands has the browser half. The site's `—` is too harsh. |

**Verdict**: Sessionboxer ahead. This is where "sees the screen" is a true differentiator: OpenHands' agent has a browser, not a desktop, and the user cannot take over.

### 4. Conversations

| | Sessionboxer | OpenHands | Notes |
| --- | --- | --- | --- |
| Many at once, resume | ✓ sessions; stopped ones use nothing and come back ([README](../../README.md)). | ✓ conversations; folders per workspace/repository ([conversations](https://docs.openhands.dev/openhands/usage/agent-canvas/conversations.md), sidebar in screenshot 06). | Equivalent. |
| Revert / branch | ✓ revert to a turn and branch, in the same box, with the machine snapshot if one exists ([ADR-0012](../adr/0012-conversation-branches-in-one-sandbox-via-acp-fork-or-replay.md)). | Conversation fork = new conversation from the copied history ([convo-fork](https://docs.openhands.dev/sdk/guides/convo-fork.md)). Revert-in-place: —. | Sessionboxer ahead (revert + snapshot together). OpenHands' fork covers "try another way". |
| Hand off to another agent | ✓ fork with another agent, handoff written by the origin's agent ([ADR-0052](../adr/0052-forks-with-another-agent-and-handoffs-written-by-the-origins-agent.md)). | — not found. Delegation to sub-agents of the *same* kind exists (`openhands-tools/openhands/tools/delegate` @ `978f3b4`). | Sessionboxer ahead. |
| Queue | ✓ Enqueue (Ctrl+S), plays when idle ([GUIDE](../GUIDE.md#talk-to-the-agent)). | — not found. | Sessionboxer ahead (—). |
| Attachments | ✓ files and images uploaded into the box, images to the model ([GUIDE](../GUIDE.md#talk-to-the-agent)). | ✓ image paste/upload in the chat (`src/components/features/chat/uploaded-image.tsx`, `chat-add-file-button.tsx` @ `c3c252a`). | Equivalent. |
| Voice input | ✓ whisper.cpp on your machine, offline ([GUIDE](../GUIDE.md#talk-to-the-agent)). | — no `SpeechRecognition`/`getUserMedia` in the Canvas source @ `c3c252a`. | Sessionboxer ahead (—). |
| Context / tokens display | ✓ gauge, per-turn tokens and cost, compaction dialog, `/context` breakdown ([GUIDE](../GUIDE.md#how-full-is-the-context)). | ✓ context meter, manual compaction, per-conversation cost and metrics (`src/utils/conversation-metrics.ts`, `budget-usage-text.tsx` @ `c3c252a`; [conversations](https://docs.openhands.dev/openhands/usage/agent-canvas/conversations.md)). | Both have it. Sessionboxer's is finer-grained (per turn, what a compaction dropped). The site's `—` is wrong. |
| Per-call LLM inspection | ✓ every request/response byte for byte, `LLM #n` labels, Claude Code only ([ADR-0032](../adr/0032-exact-model-api-calls-recorded-by-a-loopback-proxy-in-the-sandbox.md)). | Transcript export and metrics; an exact request/response viewer — not found. | Sessionboxer ahead (—). |
| Cost display | ✓ `$` per turn ([GUIDE](../GUIDE.md#how-full-is-the-context)). | ✓ `$` per conversation and in automation runs. | Equivalent. |
| Confirmation / "don't ask" | Agents run with every permission inside the box ([README](../../README.md)). | Confirmation mode with an always-approve setting ([critic page](https://docs.openhands.dev/openhands/usage/agent-canvas/critic.md), Verification settings in screenshot 03). | Equivalent. |

**Verdict**: close. Sessionboxer ahead on revert-with-machine, handoff, queue, dictation and exact LLM calls; equivalent on the rest.

### 5. Repositories and Git

| | Sessionboxer | OpenHands | Notes |
| --- | --- | --- | --- |
| Several repos per session | ✓ under `/workspace/<name>` ([ADR-0037](../adr/0037-several-repositories-per-session-under-workspace-name.md)). | Workspace = a directory; one repository per conversation in the docs ([git sync](https://docs.openhands.dev/openhands/usage/agent-canvas/git-sync.md)). Several — not found. | Sessionboxer ahead (—). |
| Git hosts | GitHub, Bitbucket Data Center; several accounts, one per repository ([README](../../README.md)). | GitHub, GitLab, Bitbucket Cloud via Cloud integrations ([GitHub](https://docs.openhands.dev/openhands/usage/cloud/github-installation.md), [GitLab](https://docs.openhands.dev/openhands/usage/cloud/gitlab-installation.md), [Bitbucket](https://docs.openhands.dev/openhands/usage/cloud/bitbucket-installation.md)); locally, tokens in Secrets. Legacy had Bitbucket DC integration code (`legacy/openhands/integrations/`). | OpenHands covers more hosts (GitLab, Bitbucket Cloud). Sessionboxer covers Bitbucket DC. |
| PR following | ✓ attach a PR to a session: comments and checks arrive in the chat, mark addressed, **auto-merge** ([pull-requests research](pull-requests-attached-to-a-session.md), [ADR-0040](../adr/0040-auto-merge-attached-pull-requests-when-github-allows-it.md)). ✓ **follow without a session**: a `#/prs` page lists every open PR of a repository, the ones you opened or the reviews asked of you, polled by the Control Plane with your login (checks with logs, comments by thread, events); attach one to a session or start a session on its head ([ADR-0064](../adr/0064-followed-pull-requests-polled-by-the-control-plane.md), [GUIDE](../GUIDE.md#pull-requests-you-follow)). | Cloud: `@openhands` on issues/PR comments and labels start work, the agent opens PRs and replies ([GitHub](https://docs.openhands.dev/openhands/usage/cloud/github-installation.md)); locally the *GitHub repository monitor* / *GitHub issue to PR* / *GitHub delivery watchdog* templates do the same through automations (screenshot 07; [event automations](https://docs.openhands.dev/openhands/usage/automations/event-automations.md)). | Both react to PR events now. Sessionboxer polls (works behind NAT, no inbound URL needed; a webhook only speeds it up — [ADR-0067](../adr/0067-webhooks-only-accelerate-polling-of-followed-pull-requests.md)); OpenHands needs a backend the event source can reach. |
| PR-event automations (review, QA, prompt when a PR opens or changes) | ✓ an automation with a *pull request* trigger — events `opened`, `synchronize`, `ready_for_review`, `review_requested`, `review_submitted`, `comment`, `check_failed`, `merged`, `closed`…; filters for drafts, forks, authors, base branch, title, labels; limits per day / per PR / debounce — runs **Auto review** (a session on the PR head, one GitHub review with inline findings or Bitbucket comments, posted by the Control Plane under your login, verdict capped), **Auto QA** (the e2e flow on the PR head, verdict, cases and **video posted on the PR**), a prompt into a new or the attached session, attach, or a push notification ([ADR-0063](../adr/0063-automations-triggers-actions-and-limits-run-by-the-control-plane.md), [ADR-0065](../adr/0065-auto-review-sessions-post-through-the-control-plane.md), [ADR-0066](../adr/0066-auto-qa-sessions-record-a-pr-and-the-control-plane-posts-the-video.md)). | ✓ Cloud GitHub App reacts to PR comments and mentions ([GitHub](https://docs.openhands.dev/openhands/usage/cloud/github-installation.md)); locally the *QA changes* and *delivery watchdog* templates run on PR events (screenshot 07; [event automations](https://docs.openhands.dev/openhands/usage/automations/event-automations.md)). A review with inline findings under the user's login and a QA video on the PR — not found in the reviewed docs. | Roughly equivalent on the trigger; **Sessionboxer ahead** on the two built-in actions (inline review, QA video on the PR) and on working from a laptop behind NAT; OpenHands ahead on breadth of events (see next row). |
| Resolver ("mention the bot on an issue, get a PR") | ✗ nothing reacts to an **issue**, an `@mention` or a label; only pull request events of a followed repository or account trigger anything, and a PR trigger cannot yet be told to wait for a keyword ([MCP.md](../MCP.md#automation_create): `filters` are drafts, forks, authors, base branch, title, labels). | ✓ Cloud GitHub App; locally as an event automation needing a reachable backend. | **OpenHands ahead.** Sessionboxer covers PRs, not issues or mentions. |
| Auto-merge | ✓ when GitHub allows it ([ADR-0040](../adr/0040-auto-merge-attached-pull-requests-when-github-allows-it.md)). | The *delivery watchdog* template merges "current heads with independent review, tests, and passing CI" (screenshot 07). | Roughly equivalent, different mechanism. |

**Verdict**: close. OpenHands ahead on issue/mention triggers and on hosts (GitLab, Bitbucket Cloud); Sessionboxer ahead on what happens to a PR once it is followed (inline Auto review, Auto QA with the video on the PR, attach to a session, polling that works without a public URL), on several repos in one box and on PR-in-the-session ergonomics.

### 6. Automations and integrations

| | Sessionboxer | OpenHands | Notes |
| --- | --- | --- | --- |
| Scheduled tasks | ✓ one trigger of an **automation** (`{ trigger, action, limits }`, `#/automations`, run history of 500 with the result of each run): a prompt on a timetable into a running or a fresh session — a fresh one optionally **from a snapshot**, so the box is not cloned and installed every run; the agent can create automations too ([ADR-0063](../adr/0063-automations-triggers-actions-and-limits-run-by-the-control-plane.md), [ADR-0069](../adr/0069-new-sessions-and-automations-start-from-a-snapshot.md), [MCP.md](../MCP.md#automations)). | ✓ cron automations, fresh sandbox per run, saved history ([automations](https://docs.openhands.dev/openhands/usage/automations/overview.md), [managing](https://docs.openhands.dev/openhands/usage/agent-canvas/managing-automations.md)); local and VM backends included ([Ent vs OSS](https://docs.openhands.dev/enterprise/enterprise-vs-oss.md)). | Equivalent. |
| Event-driven (webhooks, GitHub/GitLab/Slack/Jira/Linear events) | Partly: **pull request events** on GitHub and Bitbucket Data Center (followed repository / your PRs / reviews asked of you), derived by polling; a GitHub or Bitbucket webhook can be registered per follow but only pulls the poll forward ([ADR-0064](../adr/0064-followed-pull-requests-polled-by-the-control-plane.md), [ADR-0067](../adr/0067-webhooks-only-accelerate-polling-of-followed-pull-requests.md)). ✗ generic webhooks, issues, Slack, Jira, Linear, GitLab. | ✓ webhooks and GitHub events ([event automations](https://docs.openhands.dev/openhands/usage/automations/event-automations.md)); 22 templates in the UI (screenshot 07). Needs a backend the event source can reach — self-hosted VM or Cloud/Enterprise. | **OpenHands ahead** on breadth of triggers; Sessionboxer's PR triggers need no reachable backend. |
| Chat/tracker integrations | ✗ | Slack, Jira, Linear, custom webhooks — Cloud ([Slack](https://docs.openhands.dev/openhands/usage/cloud/slack-installation.md), [integrations settings](https://docs.openhands.dev/openhands/usage/settings/integrations-settings.md)); MCP-based templates locally. | **OpenHands ahead.** |
| API to create conversations | REST used by the UI/CLI; the `sessionboxer` MCP lets an *agent* create/message/fork/wait on sessions with an approval card ([ADR-0062](../adr/0062-the-sessionboxer-mcp-in-every-box-self-knowledge-and-control-plane-actions.md)). | REST V1 (Sandbox Server) and Cloud API, Python SDK ([API V1](https://docs.openhands.dev/openhands/usage/api/v1.md), [Cloud API](https://docs.openhands.dev/openhands/usage/cloud/cloud-api.md)). | OpenHands ahead for programmatic use; Sessionboxer ahead for agent-to-agent orchestration with human approval. |
| Push to a phone | ✓ Web Push from the Control Plane, no third party ([ADR-0035](../adr/0035-phone-layout-installable-app-and-web-push-remote-access-stages-2-and-3.md)). | — no `pushManager`/Notification API in the Canvas source @ `c3c252a`. Slack replies serve the purpose in Cloud. | Sessionboxer ahead (—). |

**Verdict**: OpenHands ahead, by less than before. Automations are a product line for them (22 templates, generic webhooks, Slack/Jira/Linear, GitLab); Sessionboxer's automations have three triggers (schedule, PR event, manual), six actions and a run history, and two actions OpenHands' catalogue was not seen to have (an inline PR review posted under your login, a QA video posted on the PR).

### 7. MCP

| | Sessionboxer | OpenHands | Notes |
| --- | --- | --- | --- |
| Transports | stdio and remote servers, registered once in Global settings, switched on per session, the agent restarted on toggle ([ADR-0010](../adr/0010-mcp-servers-global-registry-per-session-switches-restart-on-toggle.md), [mcp-servers research](mcp-servers.md)). | stdio, SSE, streamable HTTP, OAuth; configured in the UI, `config.toml`, or `mcp_config` in the SDK ([MCP settings](https://docs.openhands.dev/openhands/usage/settings/mcp-settings.md), [SDK MCP](https://docs.openhands.dev/sdk/guides/mcp.md)). Stdio in production is recommended through a proxy such as SuperGateway. | Equivalent; OpenHands documents OAuth explicitly. |
| Scope | Global registry + per-session toggle. | Global settings; per-conversation switching — not found. | Sessionboxer slightly ahead (—). |
| Where servers run | In the box; on Windows/macOS natively in the guest ([MCP.md](../MCP.md)). | In the agent-server sandbox (own agent); for ACP agents the external agent's own MCP config applies ([agent-acp](https://docs.openhands.dev/sdk/guides/agent-acp.md)). | Equivalent. |
| Built-ins | `desktop` (21 tools) and `sessionboxer` (self-knowledge, PRs, PR follows, review submission, snapshots, queue, verify, automations, cross-session) ([MCP.md](../MCP.md)). | No built-in MCP servers; built-in *tools* instead (terminal, editor, browser, tasks, delegate). | Different shape, same idea. |

**Verdict**: equivalent.

### 8. Verification and QA

| | Sessionboxer | OpenHands | Notes |
| --- | --- | --- | --- |
| After every turn | ✓ Auto QA: hidden verification turn, 2–5 e2e cases planned from the prompt, run on the desktop on video with captions, failures fixed and rerun up to three times ([GUIDE](../GUIDE.md), [ADR-0044](../adr/0044-end-to-end-verification-after-each-turn.md)). ✓ the same flow **on a pull request** from an automation, in a *pull request mode* that never fixes or pushes; verdict, cases and video posted on the PR ([ADR-0066](../adr/0066-auto-qa-sessions-record-a-pr-and-the-control-plane-posts-the-video.md)). | ✗ nothing that runs desktop tests on video after each turn. Related: **Critic** (experimental) scores the likelihood of success and can iterate below a threshold ([critic](https://docs.openhands.dev/openhands/usage/agent-canvas/critic.md), [SDK critic](https://docs.openhands.dev/sdk/guides/critic.md)); **Stop hooks** block completion until tests/lint pass ([hooks](https://docs.openhands.dev/openhands/usage/customization/hooks.md)); the **QA changes** automation template exercises a PR "as a real user would" and edits the PR description (screenshot 07). | **Sessionboxer ahead** on the after-every-turn loop and on the QA video on the PR; OpenHands ahead on *model-based* judging (Critic) and deterministic gates (hooks). |
| Evaluation infrastructure | None. | `OpenHands/benchmarks` (evaluation harness for V1). | OpenHands ahead; see §11. |

### 9. Remote access and mobile

| | Sessionboxer | OpenHands | Notes |
| --- | --- | --- | --- |
| Login | ✓ one access token in front of everything, device cookies, revoke per device, rotate ([ADR-0033](../adr/0033-access-token-and-device-cookies-in-front-of-everything-remote-access-stage-1.md)). | Local install: no authentication or multi-user isolation ([FAQ](https://docs.openhands.dev/overview/faqs.md)); the backend has an API key when self-hosted ([backends](https://docs.openhands.dev/openhands/usage/agent-canvas/backends.md)); Cloud/Enterprise have accounts, SSO/SAML, RBAC ([Ent vs OSS](https://docs.openhands.dev/enterprise/enterprise-vs-oss.md)). | Sessionboxer ahead for a single-user local install; OpenHands Enterprise ahead for teams. |
| Phone | ✓ QR pairing over Cloudflare quick tunnel, Sessionboxer frp tunnel, or your own SSH server; phone layout; installable PWA; Web Push ([ADR-0034](../adr/0034-embedded-cloudflare-quick-tunnel-for-zero-setup-phone-access.md), [ADR-0035](../adr/0035-phone-layout-installable-app-and-web-push-remote-access-stages-2-and-3.md), [ADR-0036](../adr/0036-selectable-pairing-transports-cloudflare-sessionboxer-frp-tunnel-and-own-ssh-server.md)). | Browser on the phone through Tailscale or ngrok you set up yourself, with the warning to add auth first ([mobile access](https://docs.openhands.dev/openhands/usage/agent-canvas/mobile-access.md)); `public/site.webmanifest` with `display: standalone` @ `c3c252a` (installable); push —. Cloud: any browser. | **Sessionboxer ahead** self-hosted; Cloud is the OpenHands answer. |
| Dictation on the phone | ✓ sent to the host's whisper.cpp ([GUIDE](../GUIDE.md#talk-to-the-agent)). | — | Sessionboxer ahead (—). |

### 10. Operations

| | Sessionboxer | OpenHands | Notes |
| --- | --- | --- | --- |
| Install | `curl … install.sh \| sh`, `brew install talayolabs/tap/sessionboxer`, `npx sessionboxer serve`, `docker compose up`, desktop app ([README](../../README.md)). | `npm install -g @openhands/agent-canvas` / `agent-canvas`; `docker run … ghcr.io/openhands/agent-canvas:1.24.0`; `uv tool install openhands` / `install.openhands.dev/install.sh` for the CLI; Cloud ([setup](https://docs.openhands.dev/openhands/usage/agent-canvas/setup.md), [CLI install](https://docs.openhands.dev/openhands/usage/cli/installation.md)). Electron desktop build in the repo (`electron-builder.config.mjs` @ `c3c252a`). | Equivalent. |
| Host requirements | Linux with Docker; KVM for Windows/macOS guests; Node ≥ 22 for `npx`. | Linux/macOS/Windows with Docker; Node 24 + `uv` from source. Windows/macOS hosts are first class. | OpenHands runs on more hosts. |
| Footprint | Control Plane (Node + SQLite) + one container per session with a desktop (~1 GB image); a VM per Windows/macOS session. | Canvas + Python backend + one `agent-server` container per conversation (Python image with OpenVSCode). | Both one container per unit of work; Sessionboxer's carries a desktop. Not measured here. |
| Licence | MIT ([README](../../README.md)). | MIT for Agent Canvas, SDK, benchmarks, automation repos; Cloud and Enterprise are commercial ([Ent vs OSS](https://docs.openhands.dev/enterprise/enterprise-vs-oss.md)). | Equivalent for the open-source parts. |
| Community, cadence, funding (facts only) | 1.3.0 → 1.4.1 between 2026-09-25 and 2026-09-28 ([CHANGELOG](../../CHANGELOG.md)); ~1 star. | `OpenHands/OpenHands` ~89.4k stars, ~11.8k forks; SDK ~1.2k stars; Canvas v1.20 → v1.24 in eight days; All Hands AI raised over $20M ([community](https://docs.openhands.dev/overview/community.md)). | OpenHands is a funded company with a large community; Sessionboxer is not. |

### 11. Benchmarks

OpenHands publishes results for its own agent: the SDK README carries a **SWE-bench 77.6** badge linking to their results sheet and a tech report ([README @ `978f3b4`](https://github.com/OpenHands/software-agent-sdk/blob/978f3b46130416528fd076628ef685343819f05c/README.md), [arXiv 2511.03690](https://arxiv.org/abs/2511.03690)), and maintains an evaluation harness (https://github.com/OpenHands/benchmarks). Sessionboxer publishes nothing, because it has no agent: the code is written by Claude Code, Codex, Cursor or Devin, whose vendors publish their own numbers.

A fair statement: *"Sessionboxer does not have an agent to benchmark. Its sessions run the vendors' agents unchanged, so their published results are the relevant ones. OpenHands publishes SWE-bench results for its own agent."* Anything stronger in either direction is not supported.

## What Sessionboxer has that OpenHands doesn't

Verified against the docs and source listed above. "—" means not found rather than proven absent.

- **Stop and resume with the machine intact** — the box is the session's machine ([ADR-0009](../adr/0009-snapshots-via-docker-commit-and-forks-as-new-sandboxes.md)); OpenHands persists the conversation and mounted files, not the container ([FAQ](https://docs.openhands.dev/overview/faqs.md)).
- **Snapshots and forks of the whole machine**, by hand or after every turn ([ADR-0009](../adr/0009-snapshots-via-docker-commit-and-forks-as-new-sandboxes.md)); OpenHands forks the conversation only ([convo-fork](https://docs.openhands.dev/sdk/guides/convo-fork.md)).
- **Windows and macOS sessions** with the agent inside the VM ([ADR-0060](../adr/0060-the-agent-runs-inside-the-windows-vm.md), [ADR-0061](../adr/0061-the-agent-runs-inside-the-macos-vm.md)); OpenHands sandboxes are Linux.
- **A full desktop the agent drives** with mouse and keyboard, not only a browser ([ADR-0004](../adr/0004-x11-desktop-with-custom-computer-use-mcp.md)); OpenHands' tools are browser-only (`browser_use/definition.py`).
- **Watch and take control** of that desktop ([README](../../README.md)); OpenHands' browser tab is non-interactive ([key features](https://docs.openhands.dev/openhands/usage/key-features.md)).
- **Captioned, narrated desktop recordings in the chat** ([ADR-0017](../adr/0017-desktop-recording-with-ffmpeg-and-inline-workspace-media-in-the-chat.md), [ADR-0026](../adr/0026-recording-captions-narrated-by-the-agent-burned-in-and-as-a-vtt-track.md)); OpenHands records the browser session, without captions.
- **Auto QA after every turn**: planned e2e cases, run on the desktop, on video, failures fixed ([ADR-0044](../adr/0044-end-to-end-verification-after-each-turn.md)); OpenHands has Critic scoring and hooks, not this loop.
- **Auto QA on every pull request of a repository, the video posted on the PR** ([ADR-0066](../adr/0066-auto-qa-sessions-record-a-pr-and-the-control-plane-posts-the-video.md)); OpenHands' *QA changes* template edits the PR description, no recording of a desktop was found.
- **Auto review posted as one review with inline findings under your own login**, verdict capped by the automation, fork PRs reviewed with no credential in the box ([ADR-0065](../adr/0065-auto-review-sessions-post-through-the-control-plane.md)) — —.
- **Follow the PRs of a repository or account without a session, behind NAT**: polling with the Control Plane's login, webhooks optional ([ADR-0064](../adr/0064-followed-pull-requests-polled-by-the-control-plane.md), [ADR-0067](../adr/0067-webhooks-only-accelerate-polling-of-followed-pull-requests.md)); OpenHands' event automations need a reachable backend ([event automations](https://docs.openhands.dev/openhands/usage/automations/event-automations.md)).
- **Automation runs that start from a snapshot** instead of a fresh clone ([ADR-0069](../adr/0069-new-sessions-and-automations-start-from-a-snapshot.md)); OpenHands runs each automation in a fresh sandbox ([automations](https://docs.openhands.dev/openhands/usage/automations/overview.md)).
- **Revert to a turn in the same box**, with the snapshot ([ADR-0012](../adr/0012-conversation-branches-in-one-sandbox-via-acp-fork-or-replay.md)).
- **Hand off to a different vendor's agent**, with the handoff written by the origin's agent ([ADR-0052](../adr/0052-forks-with-another-agent-and-handoffs-written-by-the-origins-agent.md)) — —.
- **Exact model API calls**, byte for byte, per bubble ([ADR-0032](../adr/0032-exact-model-api-calls-recorded-by-a-loopback-proxy-in-the-sandbox.md)) — —.
- **Compaction shown as what was dropped vs the summary** ([ADR-0031](../adr/0031-compaction-details-read-from-the-providers-own-records-in-the-sandbox.md)) — —.
- **Prompt queue** ([GUIDE](../GUIDE.md#talk-to-the-agent)) — —.
- **Offline dictation** with whisper.cpp ([GUIDE](../GUIDE.md#talk-to-the-agent)) — —.
- **Several repositories per session**, several Git accounts ([ADR-0037](../adr/0037-several-repositories-per-session-under-workspace-name.md)) — —.
- **Phone pairing by QR over a built-in tunnel, PWA, Web Push**, a login in front of everything ([ADR-0033](../adr/0033-access-token-and-device-cookies-in-front-of-everything-remote-access-stage-1.md)–[0036](../adr/0036-selectable-pairing-transports-cloudflare-sessionboxer-frp-tunnel-and-own-ssh-server.md)); OpenHands local has no login and leaves the tunnel to you ([mobile access](https://docs.openhands.dev/openhands/usage/agent-canvas/mobile-access.md)).
- **Docker inside the box** via Sysbox ([ADR-0008](../adr/0008-docker-inside-sandboxes-via-sysbox.md)) — —.
- **USB devices into a box** ([README](../../README.md)) — —.
- **Subscription usage bars and auto-continue at reset** ([GUIDE](../GUIDE.md#usage-limits-the-bars-the-no-entry-sign-continue-and-auto-continue)) — —.
- **An agent that knows its session and can create, message, fork and wait on other sessions behind an approval card** ([ADR-0062](../adr/0062-the-sessionboxer-mcp-in-every-box-self-knowledge-and-control-plane-actions.md)); OpenHands delegates to sub-agents of the same kind and offers an API to humans.

## What OpenHands has that Sessionboxer doesn't

- **Its own agent with any model** (LiteLLM, OpenAI-compatible, local models) ([model configuration](https://docs.openhands.dev/openhands/usage/agent-canvas/model-configuration.md)). Sessionboxer is limited to the four vendors' agents and their models.
- **Gemini CLI and custom ACP servers** as agents ([ACP agents](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents.md)); Sessionboxer has Claude Code, Codex, Cursor, Devin.
- **Skills, plugins, hooks and setup scripts of its own** (`.openhands/`), including Stop hooks that gate completion ([hooks](https://docs.openhands.dev/openhands/usage/customization/hooks.md), [plugins](https://docs.openhands.dev/openhands/usage/agent-canvas/plugins.md)).
- **A context condenser it controls**, and persistent memory ([context condenser](https://docs.openhands.dev/sdk/guides/context-condenser.md)).
- **Critic**: a model that scores the result and can make the agent iterate ([critic](https://docs.openhands.dev/openhands/usage/agent-canvas/critic.md)).
- **Event-driven automations and a resolver**: `@openhands` on an issue or PR, labels, webhooks, Slack mentions → a conversation, a PR, a reply ([event automations](https://docs.openhands.dev/openhands/usage/automations/event-automations.md), [GitHub Cloud](https://docs.openhands.dev/openhands/usage/cloud/github-installation.md)). Sessionboxer reacts to pull request events only — not to issues, mentions, labels-as-a-command, Slack or generic webhooks ([ADR-0063](../adr/0063-automations-triggers-actions-and-limits-run-by-the-control-plane.md)).
- **Slack, Jira, Linear, GitLab, Bitbucket Cloud integrations** (Cloud, or via MCP templates) ([integrations](https://docs.openhands.dev/openhands/usage/settings/integrations-settings.md)).
- **A Python SDK and REST API** for building agents and creating conversations programmatically ([SDK](https://docs.openhands.dev/sdk), [API V1](https://docs.openhands.dev/openhands/usage/api/v1.md)).
- **More backends**: process (no sandbox), remote VM, Modal, Cloud, Enterprise ([backends](https://docs.openhands.dev/openhands/usage/agent-canvas/backends.md)); custom sandbox images.
- **Windows and macOS hosts** (Docker Desktop) ([setup](https://docs.openhands.dev/openhands/usage/agent-canvas/setup.md)); Sessionboxer's Control Plane needs Linux with Docker (and KVM for VM sessions).
- **A managed Cloud and an Enterprise edition** with accounts, SSO/SAML, RBAC, budgets, LLM gateway, observability ([Ent vs OSS](https://docs.openhands.dev/enterprise/enterprise-vs-oss.md)).
- **Published benchmarks and an evaluation harness** (§11).
- **A large community and a funded company behind it** (§10).

## Same in both

- One Linux Docker sandbox per session/conversation, the agent inside it with full permissions ([ADR-0001](../adr/0001-agent-runs-inside-the-sandbox.md); [Docker backend](https://docs.openhands.dev/openhands/usage/agent-canvas/backend-setup/docker.md)).
- Claude Code and Codex over ACP ([README](../../README.md); [ACP agents](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents.md)).
- VS Code and a terminal in the sandbox, reachable from the UI.
- Screenshots the agent takes shown in the chat; a browser the agent drives.
- Many conversations, resume, a fork/branch of the conversation.
- Image and file attachments.
- Context meter and cost display (Sessionboxer per turn, OpenHands per conversation).
- Model switched per session/conversation.
- MCP servers (stdio and remote), configured centrally.
- Scheduled tasks into a fresh or existing session/conversation, with a run history.
- Automations that start work when a pull request opens or changes (Sessionboxer: review, QA video, prompt; OpenHands: templates and the Cloud GitHub App).
- Pull requests opened and followed up by the agent (different mechanisms, §5).
- Confirmation-free operation.
- Runs locally with no account; MIT.
- Corporate proxy support: Sessionboxer per Claude API URL and proxy token ([GUIDE](../GUIDE.md#see-exactly-what-goes-to-the-model)); OpenHands via the LLM base URL / LiteLLM proxy ([model configuration](https://docs.openhands.dev/openhands/usage/agent-canvas/model-configuration.md)).

## A positioning paragraph for the site

> OpenHands is an open-source agent platform: its own agent with any model, a Python SDK, automations that react to issues, PRs and Slack, and a paid cloud for teams. Sessionboxer is a workbench for the agents you already pay for — Claude Code, Codex, Cursor, Devin — each in its own machine: a Linux desktop or a Windows or macOS VM that you can watch, take over, snapshot, fork, stop and resume, where the agent tests its work on video after every turn, and where every pull request of a repository you follow can get a review and a QA video without you asking. Pick OpenHands if you want to build with or automate an agent; pick Sessionboxer if you want to see one work and keep the machine it worked in.

## Proposed changes to the OpenHands column in `pages/features.mjs`

Old → new, with the source. Keep `—` where nothing was found; use a short phrase where the value is neither yes nor no. Rows not listed are correct as they are.

| Row | Old | New | Why |
| --- | --- | --- | --- |
| `subscription` | `API key` | `API key or provider login` | Subscription login for some providers / ACP agents: https://docs.openhands.dev/sdk/guides/llm-subscriptions.md |
| `agents` | `own agent, any model` | `own agent (any model), Claude Code, Codex, Gemini CLI` | https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents.md; screenshot 04 |
| `sandbox` | `Docker` | `Docker, VM, Modal, cloud` | https://docs.openhands.dev/openhands/usage/agent-canvas/backends.md (also a no-sandbox *process* mode) |
| `desktop` | `browser` | `browser` (keep) | Browser tools only: `openhands-tools/openhands/tools/browser_use/definition.py` @ `978f3b4` |
| `watch` | `—` | `browser tab, read-only` | https://docs.openhands.dev/openhands/usage/key-features.md ("The browser is non-interactive") |
| `vscode` | `—` | `✓` | OpenVSCode Server in `openhands-agent-server/openhands/agent_server/docker/Dockerfile` @ `978f3b4`; VS Code tab in https://docs.openhands.dev/openhands/usage/key-features.md |
| `revert` | `—` | `fork conversation` | https://docs.openhands.dev/sdk/guides/convo-fork.md (no in-place revert found) |
| `prs` | `address` | `open, address, react to @mentions` (and rename the row's Sessionboxer cell to `follow, address, auto-merge, review + QA on every PR`) | https://docs.openhands.dev/openhands/usage/cloud/github-installation.md; local *GitHub repository monitor* / *issue to PR* templates (screenshot 07) |
| `scheduled` | `✓` | `✓ + events (GitHub, Slack, webhooks)` (and rename the row to *Scheduled tasks and PR-triggered automations*, as the README now does; Sessionboxer `✓ schedule, PR events`) | https://docs.openhands.dev/openhands/usage/automations/event-automations.md; [ADR-0063](../adr/0063-automations-triggers-actions-and-limits-run-by-the-control-plane.md) |
| `llm` | `—` | `metrics, no raw calls` | `src/utils/conversation-metrics.ts` @ `c3c252a`; raw request/response viewer not found |
| `phone` | `web` | `web (own tunnel, no login locally)` | https://docs.openhands.dev/openhands/usage/agent-canvas/mobile-access.md; https://docs.openhands.dev/overview/faqs.md |
| `open` | `MIT` | `MIT (Cloud/Enterprise paid)` | https://docs.openhands.dev/enterprise/enterprise-vs-oss.md |
| `contextGauge` | `—` | `meter + manual compact` | https://docs.openhands.dev/openhands/usage/agent-canvas/conversations.md; `budget-usage-text.tsx` @ `c3c252a` |
| `recordings` | `—` | `browser only, no captions` | `BrowserStartRecordingTool` in `browser_use/definition.py` @ `978f3b4` |
| `pause` | `—` | `—` (keep; add note "agent loop pauses, container not kept") | `openhands-sdk/openhands/sdk/conversation/base.py` @ `978f3b4`; https://docs.openhands.dev/overview/faqs.md |
| `mcp` | `✓` | `✓ (stdio, SSE, HTTP, OAuth)` | https://docs.openhands.dev/openhands/usage/settings/mcp-settings.md |
| `proxy` | `host's setup` | `LLM base URL / LiteLLM` | https://docs.openhands.dev/openhands/usage/agent-canvas/model-configuration.md |
| `verify` | `—` | `critic score, hooks` | https://docs.openhands.dev/openhands/usage/agent-canvas/critic.md; https://docs.openhands.dev/openhands/usage/customization/hooks.md |
| `usage` | `n/a` | `$ per conversation; budgets in Cloud` | `conversation-metrics.ts` @ `c3c252a`; https://docs.openhands.dev/openhands/usage/cloud/organizations/budgets.md |
| `noAsk` | `✓` | `✓` (keep) | Confirmation mode / always approve, screenshot 03 |
| `repos`, `snapshots`, `dictation`, `handoff`, `dind`, `queue`, `fold` | `—` | `—` (keep) | Not found at the commits above; `snapshots` could become `✗ (conversation fork only)` since the fork docs describe copying events, not the sandbox |
| `local`, `editorTheme` | `✓`, `n/a` | keep | |

New rows worth adding (values Sessionboxer / OpenHands):

- **Event automations** (issue/PR mention, webhook, Slack → a run): `PR events only (polled, no public URL needed)` / `✓ (needs a reachable backend)` — [ADR-0064](../adr/0064-followed-pull-requests-polled-by-the-control-plane.md); https://docs.openhands.dev/openhands/usage/automations/event-automations.md
- **Auto review of every PR, inline, under your login**: `✓` / `— (Cloud App replies to mentions)` — [ADR-0065](../adr/0065-auto-review-sessions-post-through-the-control-plane.md); https://docs.openhands.dev/openhands/usage/cloud/github-installation.md
- **QA video posted on the PR**: `✓` / `—` — [ADR-0066](../adr/0066-auto-qa-sessions-record-a-pr-and-the-control-plane-posts-the-video.md)
- **Windows/macOS sessions** (agent inside a Windows or macOS machine): `✓` / `✗` — https://docs.openhands.dev/openhands/usage/agent-canvas/setup.md documents hosts only
- **Own agent, any model**: `✗` / `✓` — https://docs.openhands.dev/openhands/usage/agent-canvas/model-configuration.md
- **Skills/hooks/plugins format**: `agent's own` / `✓ .openhands/` — https://docs.openhands.dev/openhands/usage/customization/repository.md
- **Login in front of the UI**: `✓ token + devices` / `— locally; Cloud/Enterprise` — https://docs.openhands.dev/overview/faqs.md
- **Team edition** (accounts, RBAC, budgets): `✗` / `Cloud/Enterprise` — https://docs.openhands.dev/enterprise/enterprise-vs-oss.md
- **Agent-to-agent orchestration with approval**: `✓ sessionboxer MCP` / `delegate to sub-agents` — `openhands-tools/openhands/tools/delegate` @ `978f3b4`

## Features of OpenHands worth considering for Sessionboxer

Effort in sessions (one session ≈ one to two focused human-weeks).

1. **Issue and mention triggers — the rest of a resolver.** PR events are done (ADR-0063/0064): what is missing is an **issue** trigger (opened, labelled, commented) and a **keyword filter** on comments (`@sessionboxer …` on an issue or PR → a session from a template prompt, the reply posted back). The poller, the automation engine, the `new_session` action with `{pr.*}` placeholders and the HMAC webhook receiver exist; add `issue_follows`/issue events to the poller, `{issue.*}` placeholders, a `comment_matches` filter and a *reply on the thread* action. **1 session.**
2. **Repository-defined hooks that gate the turn.** OpenHands' Stop hook that refuses "done" until a command passes is a small, deterministic complement to Auto QA: a `.sessionboxer/hooks` (or reuse of the agents' own hook formats where they have one) that runs `npm test`/lint before the verification turn and feeds the failure back. **1 session.**
3. **A Critic-style judge.** After a turn, a second model call scores whether the prompt was actually satisfied and lists issues; below a threshold the agent gets the list as a follow-up. Cheaper than Auto QA and useful for turns Auto QA skips (answers, refactors). Could reuse the handoff-writer mechanism for the extra turn. **1–2 sessions.**
4. **Slack as a channel.** A Slack app: a mention in a channel starts or continues a session, and the turn's summary is posted back in the thread, with the recording link. Reuses the automation engine and the `/api/hooks/*` receiver (ADR-0067), which need a tunnel with a stable hostname. **1–2 sessions.**
5. **Cost across sessions and runs.** The Automations page now has the run history with each run's result (ADR-0063); what OpenHands still shows and Sessionboxer does not is `$` per run and per period in one place. Cost per automation run / session / week over the existing per-turn numbers is mostly UI over SQLite data. **0.5–1 session.**

Not recommended: an agent of Sessionboxer's own, or arbitrary-model support. It is the product's premise not to have one, and OpenHands (and the vendors) cover that ground.

## The local attempt

Started with the documented commands on 2026-09-28; no provider key was available, so no conversation was run. Screenshots are attached to the session that produced this document and summarised here.

1. **Legacy GUI** `docker.openhands.dev/openhands/openhands:1.8` on `:3000` ([GUI mode docs](https://docs.openhands.dev/openhands/usage/run-openhands/gui-mode.md)): first-run *AI Provider Configuration* modal (provider OpenHands, model `claude-opus-4-5-20251101`, empty key), *Open Repository* / *Start from Scratch*, settings sections Agent, LLM, Condenser, Verification, MCP, Skills, Integrations, Application, Secrets; Verification has *Confirmation Mode* and *Enable Critic* (screenshots 01–03).
2. **Agent Canvas** `ghcr.io/openhands/agent-canvas:1.24.0` on `:8000/canvas` ([setup docs](https://docs.openhands.dev/openhands/usage/agent-canvas/setup.md)): onboarding *Choose your agent* (OpenHands, Claude Code, Codex, Gemini CLI) → *Set up your LLM* (Authentication: API key, Provider, Model, Key) → first message or one of 22 workflow templates; home page *What do you want to work on?* with *Open Workspace*, *Plugins*, recommended automations, and a banner *Your LLM isn't set up yet, so conversations won't run*; Automations dashboard with *Git Sync* and templates; Settings → Agent profiles, LLM, Condenser, Agent Context, Verification, Application, Secrets (screenshots 04–08). The container needs its home mount writable by uid 10001 or it fails with `sqlite3.OperationalError: unable to open database file`.

Neither run shows what the agent does inside a conversation; those claims rest on the docs and the source above.
