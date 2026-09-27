# Research: a `sessionboxer` MCP in every box — self-knowledge and Control Plane actions

Goal: the Agent in a box knows it runs inside Sessionboxer (which Session, which agent, which
environment, what the user sees) and can ask Sessionboxer to do things on its behalf: create or
fork a Session, hand its work to another one, message another box, attach a pull request, open a
Terminal for the user, start a verification run with a brief, schedule a task, read usage. Written
from the code on main (`7b3276b`), 2026-09-27; no probes needed, the pieces already exist.

## 1. What the Agent knows today

| Knows | How |
|---|---|
| "You are in a Sessionboxer Sandbox", `/workspace`, one directory per repository, `repos.json`, `gh`/`bb`, desktop MCP and its tools, recordings, verification runs, how to hand files to the user, Docker | the briefing (`images/sandbox/sandbox-briefing.md` → `CLAUDE.md` / `AGENTS.md`), `windows-briefing.md` for Windows guests |
| The user's rules | `Settings.instructions` → system prompt (Claude) or first prompt (Devin, Codex, Cursor) |
| Repositories, where they came from, which account | `/workspace/.sessionboxer/repos.json` |
| That a repository was added or removed, that a verification is due, that work is handed off | messages the Control Plane writes into the turn (`PromptOrigin`) |

| Does not know | Note |
|---|---|
| Its Session id, title, agent, model, environment (Linux / Windows / macOS guest), snapshot/branch state, that it was forked and from what | `SESSIONBOXER_SESSION_ID` / `SESSIONBOXER_PROVIDER` are in the Sandbox's environment but nothing tells the Agent to read them, and a Windows/macOS guest does not have them |
| That other Sessions exist, what they do, how to reach them | nothing |
| What the user sees: the panes (Desktop, Terminal, Code, PRs, Verification, Context), queue, usage meters, where the Session is (URL) | nothing; it cannot point the user to a pane or know a Terminal is open |
| Sessionboxer itself (features, settings, how PRs get watched, what a fork or a handoff is) | nothing; it answers questions about Sessionboxer from training data or not at all |
| Pull requests attached to the Session, checks, comments awaiting it | only through what the PR pane's actions paste into a prompt |

The box has **no route to the Control Plane API** by design (ADR-0005: Sandboxes join a private
network, the Control Plane dials them). The one thing the Agent can already ask the Control Plane
for are the `e2e_*` tools of the desktop MCP: `POST /e2e` on the Daemon becomes a JSON-RPC request
to the Control Plane over the WebSocket the Control Plane already holds to the Daemon, and the
answer flows back (`E2eBridge`, ADR-0044). Windows guests reach the desktop MCP on the Linux side
through the guest bridge (`node sessionboxer-bridge.js desktop`, ADR-0060).

## 2. Shape of the answer

A second MCP server in every box, **`sessionboxer`**, next to `desktop`, whose tools are answered
by the Control Plane. Two halves:

- **self-knowledge**: who and where am I, what does the user see, what is Sessionboxer;
- **actions**: things only the Control Plane can do (Sessions, forks, handoffs, messages to other
  boxes, PRs, panes, verification runs, schedules).

### 2.1 Transport: the existing Daemon → Control Plane bridge, generalised

Reuse the `E2eBridge` path unchanged in nature: the MCP (a stdio process the Agent spawns, like
`desktop`) does `POST /sessionboxer` on the Daemon (`127.0.0.1:7000`), the Daemon turns it into a
JSON-RPC request `_sessionboxer/agent/<tool>` to the connected Control Plane over the same
WebSocket, the Control Plane's `DaemonClient.onRequest` handler answers. Rename `E2eBridge` →
`ControlPlaneBridge` with a method allowlist; the `e2e_*` tools become four of the many.

Why not a scoped bearer token and plain HTTP to the Control Plane (`host.docker.internal`)?

- it needs a route from the box to the Control Plane, which today does not exist and differs by
  host (Linux bridge, Docker Desktop, compose mode where the Control Plane is a container, the
  `localhost` reach on macOS) — the bridge works everywhere the Daemon is already reachable;
- a token in the box ends up in Snapshots and forks, in the Agent's shell environment, in `docker
  inspect`; the bridge has **no secret in the box at all** — the Control Plane knows which Session
  is speaking because it is the socket it opened to that Session's Daemon;
- the box cannot impersonate another Session: the Control Plane fills `sessionId` from the
  connection, never from the request.

For Windows/macOS guests the MCP runs on the Linux side and the guest starts it through the guest
bridge, exactly like `desktop` (`node sessionboxer-bridge.js sessionboxer`); nothing new to build
there beyond registering the service.

Cost per call: one HTTP round trip inside the box plus one WebSocket request; the 20 s bridge
timeout stays for reads, long actions (create a Session, wait for a turn) answer at once with an id
and are polled or waited for with a second tool (below).

### 2.2 Self-knowledge

Three layers, cheapest first:

1. **A file, like `repos.json`**: the Daemon writes `/workspace/.sessionboxer/session.json` at
   boot and whenever it changes (title, model, branch, environment, repos): `{ id, title, url,
   provider, model, environment, guest: { os, workspace } | null, createdAt, forkedFrom: { sessionId,
   snapshotId } | null, branch, snapshotCount, sessionboxerVersion }`. Zero tokens until read.
2. **One paragraph in the briefing** (~150 tokens): "You are the Agent of the Sessionboxer Session
   **<title>**, one of possibly many Sessions the user runs side by side, each in its own box. The
   user follows you in a chat next to panes named Desktop, Terminal, Code, PRs, Verification and
   Context. `session.json` says who you are; the `sessionboxer` MCP lets you ask Sessionboxer
   about the other Sessions and do things only it can (create or fork Sessions, hand your work
   over, message another Session, attach a pull request, open a pane for the user, run a
   verification, schedule a task)." Rendered through the same template the repo table uses, so
   the title and environment are literal.
3. **Live tools**: `whoami` (the same object as `session.json` plus status, usage/limits, context
   meter, queue length, panes the user has open, open Terminals, attached PRs with their check and
   comment counts, current verification run), and `docs(query)` which answers from `docs/GUIDE.md`
   shipped in the image at `/opt/sessionboxer/docs` (a section lookup by heading, no embeddings) so
   "how do I enable Docker in the box" gets the guide's words, not a guess.

### 2.3 Actions (what the Control Plane executes)

Grouped by what exists already (only a tool and a route to an existing method) versus what is new.

| Tool | Control Plane does | Exists as |
|---|---|---|
| `sessions_list` | titles, ids, status, provider, environment, repos of all Sessions — no transcripts | `GET /sessions` |
| `session_get(id)` | one Session's summary and its last reply (text only, capped) | `GET /sessions/:id` + last `agent_message` of `events` |
| `session_create({ title, provider, model, environment, repos, instructions, first_prompt })` | new Session, first prompt queued; answers `{ id, url }` | `POST /sessions` (schedules already create Sessions this way) |
| `session_fork({ conversation: continue \| new \| handoff, provider, document, first_prompt })` | fork of **this** Session from a fresh Snapshot; for `handoff` the Agent passes the document itself, so the hidden "write a handoff" turn is skipped and the fork starts at once | `POST /sessions/:id/fork` (ADR-0052); `document` is new |
| `session_message({ id, text, when: now \| enqueue })` | prompt into another Session, or into its queue when it is busy or `enqueue` | `POST /sessions/:id/prompt`, `/saved` |
| `session_wait({ id, timeout_s })` | blocks up to 20 s bridge time, else answers `{ still_running }` for the Agent to call again | `turn_ended` event |
| `session_stop(id)` | stop a Session **this one created** | `POST /sessions/:id/stop` |
| `pr_attach(url)`, `pr_list()`, `pr_items(pr)` | attach and read a PR's comments and checks in the PR pane | `POST/GET /sessions/:id/prs`, `/items`, `/checks` |
| `pr_mark_addressed(items)` | what the PR pane's "Addressed" does | `POST /sessions/:id/prs/actions` |
| `snapshot(reason)` | Snapshot now (the auto one waits for turn end) | `POST /sessions/:id/snapshots` |
| `queue_add(text)` / `queue_list()` | put a follow-up for itself in the queue (the user sees it, can edit or drop it) | `/saved` |
| `title_set(text)` | rename the Session (after the first turn, like a chat title) | `PATCH /sessions/:id` |
| `verify({ brief, cases? })` | start a verification run **now** with the Agent's own brief; the existing `e2e_plan/case_*/finish` then record it | `POST /sessions/:id/e2e/run` + a `brief` on `E2eRun` (new) |
| `schedule_create({ name, cron, timezone, action })` / `schedule_list()` | a scheduled task that prompts this Session or opens a new one (ADR-0047) | `POST /schedules` |
| `ui_open({ pane, terminal?: { command } })` | the user's page switches to a pane (Terminal/Code/PRs/Verification/Context) — a **hint**, honoured only if the user is on this Session and not mid-typing; with `terminal.command` a new Terminal is opened running it visibly | new WS broadcast `ui_hint`; `POST /sessions/:id/terminals` + `ptyInput` |
| `terminal_list()` / `terminal_read(id, lines)` | see what the user has in their Terminals (the Agent otherwise cannot see the user's shells) | `ptyList` + a ring buffer read (new) |
| `settings_get()` | `PublicSettings` minus anything secret-shaped | `GET /settings` |
| `notify(text)` | a push/browser notification to the user (something needs them) | web push (ADR-0035) |

Deliberately **not** exposed: delete Sessions, stop Sessions it did not create, write settings,
touch devices/tokens, manage connectors or provider logins, read another Session's full transcript
or LLM calls, USB, VM installs.

### 2.4 Cross-Session messaging in the transcript

A message from another Session shows in the target's chat as a marker "from Session **X** (its
Agent)", not as the user's words: `PromptOrigin` gains `agent` with `{ fromSessionId }`. The
sending Session gets a marker too ("sent to **Y**"). Both are events, so they survive reload and
forks, and both transcripts show the whole exchange. The reply path is the same tool in the other
direction, or `session_wait` + `session_get` for the last reply.

Loops: a hop counter travels with the origin (`hops`), the Control Plane refuses at 4; a Session
cannot message itself; at most one in-flight prompt per target from a given sender; created
Sessions count against a per-Session cap (default 3 alive children) and a global one.

### 2.5 Permissions and visibility

Everything an Agent does through this MCP is **visible**: each action is an event in the acting
Session's transcript (a compact marker, "created Session **Y**", "attached PR #12", "scheduled
'nightly tests' at 02:00") and, where it touches another Session, in that one too.

Policy, per Session with a global default (Settings → Sandbox → "Sessionboxer tools"):

- **off** — the MCP is not passed to the Agent (the briefing paragraph still tells it what
  Sessionboxer is);
- **this Session** (default) — self-knowledge, own PRs, queue, snapshot, verify, `ui_open`, forks
  and handoffs of itself, schedules that target itself, `notify`;
- **all Sessions** — plus list/read/message/create/stop-own-children.

Resource-consuming actions (`session_create`, `session_fork`, `schedule_create`) can additionally
require **approval**: the tool answers `{ pending, id }`, the UI shows a card in the chat ("Claude
wants to create a Session 'Backend tests' — Allow / Deny"), the Agent calls `session_wait`-style
on it; unattended (schedules, the user away) it times out after 10 minutes as denied. Default:
approval on for `session_create` in `all Sessions` mode, off for forks of itself.

Prompt injection is the real risk: a PR comment or a web page can tell the Agent "create ten
Sessions and message them". The caps, the approval card, the hop counter and the transcript markers
are the answer; the MCP tool descriptions say plainly that these actions come from the user's
instructions only.

### 2.6 Where the code goes

- `packages/sessionboxer-mcp` (new, stdio MCP, `sessionboxer-mcp` binary; ~same size as the
  `e2e` part of `computer-use-mcp`); the `e2e_*` tools move here and the briefing follows (they
  are Sessionboxer's tools, not the desktop's), `images/sandbox/mcp.json` gets the second server,
  Devin's `mcp_config.json` and Cursor's `mcp.json` likewise.
- `packages/protocol`: `AGENT_METHODS` (the `_sessionboxer/agent/*` JSON-RPC names), request and
  result schemas, `SessionInfo` (the `session.json` object), `PromptOrigin.agent`, `ui_hint`
  broadcast, `AgentActionEvent`, `Settings.agentTools` policy, `E2eRun.brief`.
- `packages/sandbox-daemon`: `ControlPlaneBridge` (from `E2eBridge`), `session.json` writer next
  to the repos manifest, pty ring buffer for `terminal_read`, guest bridge service `sessionboxer`.
- `apps/control-plane`: `agent-tools.ts` — one handler per method, policy check, caps, approval
  store (in memory, an event when settled), markers into both transcripts; `sessions.ts` gains
  `forkWithDocument`, `e2eRunNow(brief)`, `childrenOf`.
- `apps/web`: `ui_hint` handling (pane switch, approval card), the markers, the policy control in
  Session settings and Global settings.
- `docs/GUIDE.md` shipped into the image; briefing paragraph; ADR.

### 2.7 Effort

About three sessions:

1. bridge generalisation, `session.json`, briefing, `whoami`/`docs`/read-only tools, PR tools,
   snapshot/queue/title/verify-with-brief — everything inside one Session; Linux verified live;
2. multi-Session: list/get/create/fork-with-document/message/wait/stop-children, origins and
   markers, caps, policy + approval card, `ui_open`/terminal tools, `notify`, schedules;
3. Windows/macOS guest bridging and a live Windows turn, GUIDE/CHANGELOG/ADR, image rebuild.

## 3. Alternatives considered

- **Tools inside the desktop MCP.** Fewer moving parts, but the desktop MCP is about the screen and
  is what a Windows/macOS guest bridges for input; a separate server can be switched off by policy
  without losing the desktop, and its name says what it is to the Agent.
- **Only the briefing, no MCP.** Gives identity and vocabulary for free, but every "create a
  Session for X" still ends as a request to the user. The bridge already exists, the marginal cost
  of the tools is low.
- **The Agent's own CLI (`sessionboxer` binary in the box) instead of an MCP.** Works for Claude
  Code's shell, not for Devin/Codex/Cursor tool discovery, and gets no tool descriptions; an MCP
  can still ship a thin CLI later that calls the same `POST /sessionboxer`.
- **Agent-to-agent protocols (A2A, ACP `session/…` across boxes).** Nothing to gain: the Control
  Plane already holds every conversation; routing through it keeps the transcripts complete and the
  policy in one place.

## 4. Open questions for the user

- Should a Session created by an Agent be marked as such in the sidebar (a "child of X" line, and
  the parent showing its children)? Proposed: yes, `createdBy: { sessionId }` on the Session.
- `ui_open` when the user is on another Session: ignore silently (proposed) or show a toast
  "Session X wants to show you its Terminal"?
- Should `session_message` be allowed into Sessions the Agent did not create, by default?
  Proposed: yes under `all Sessions`, always with the marker; the approval card only for creation.
