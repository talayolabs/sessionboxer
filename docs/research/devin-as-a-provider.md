# Research: adding Devin as a Provider

Date: 2026-09-15. Status: research only, no decision taken (see open questions).

## Question

Can Sessionboxer run Devin inside a Sandbox as a second Provider next to Claude Code, and what does it cost?

## What Devin offers today

Three distinct "Devin" surfaces exist; only the first fits Sessionboxer's model.

### 1. Devin CLI, `devin acp` (fits)

Devin CLI is Cognition's local coding agent (Rust binary, `curl -fsSL https://cli.devin.ai/install.sh | bash`).
It ships an ACP server: `devin acp` speaks Agent Client Protocol JSON-RPC over stdio, exactly the interface the
Sandbox Daemon already drives for `claude-agent-acp` (ADR-0006). Verified by hand in a bare `ubuntu:24.04`
container (`devin 3000.10.27`, x86_64), with `.local/devin-acp-probe.sh` as the client:

- Install is non-interactive apart from a trailing `devin auth login` that we can let fail (`Error: Login canceled`);
  the binary lands in `~/.local/share/devin/cli/_versions/current/bin/devin`, symlinked from `~/.local/bin/devin`.
- `initialize` succeeds unauthenticated and reports `protocolVersion: 1`, `loadSession: true` (resume works like
  Claude's `session/load`), `promptCapabilities.image: true`, `mcpCapabilities: { http: false, sse: false }`
  (stdio MCP only, which is all we use).
- `session/new` accepts a client-supplied stdio `mcpServers` entry: the probe passed
  `{ name: "desktop", command: "/bin/cat" }` and the log shows `Starting stdio MCP server 'desktop'`. So the
  computer-use MCP is wired the same way as for Claude, no image-side config file needed
  (`~/.config/devin/mcp_config.json` also works if we prefer baking it in).
- Modes advertised on `session/new`: `accept-edits` (default), `smart`, `ask`, `plan`, `bypass`
  ("Auto-approve all tool calls"). ADR-0003 maps to `session/set_mode` -> `bypass`, plus the Daemon's existing
  allow-all answer to `session/request_permission`.
- A `model` config option is exposed (`swe-1-6-fast` default; `opus`, `sonnet`, `gpt`, `codex`, `gemini` short
  names per the docs, or `--model` / `DEVIN_MODEL`). This is the model picker we deferred in round 2 Q12, for free.
- Extras we can ignore: `_cognition.ai/*` notifications, slash commands advertised over ACP, session list/delete.
- Auth without a credential: `initialize` and `session/new` work, so (as with Claude) a Sandbox can come up before
  the token is verified; `session/prompt` is what will fail.

### 2. Devin API / Devin Cloud (does not fit)

`api.devin.ai` v1/v3 creates sessions on Cognition-hosted VMs. The agent, its desktop and its files live in
Cognition's cloud, so a Sessionboxer Session would be a chat proxy with no Sandbox, no Desktop pane, no Files,
no Terminal. Contradicts ADR-0001 (Agent inside the Sandbox); not pursued.

### 3. Devin Outposts (possible later, heavy)

Outposts run cloud Devin sessions on your own machine via `devin worker start --outpost=<name> --token=<token>`
(the worker claims sessions from a queue and executes them locally). A Sandbox could be an Outpost worker so the
full cloud Devin (its own planner, browser, computer use) executes inside our container. Requires an org with
Outposts enabled plus a v3 API token with `account.outposts.*` scopes, sessions are still created/driven from
app.devin.ai, and the transcript would not flow through our ACP path. Park it.

## Auth for path 1

Mirror ADR-0002 (one login, injected per Sandbox, never baked into the image):

- `devin auth login` (browser) or `devin auth login --force-manual-token-flow` (paste a token) stores a
  non-expiring API token in `~/.local/share/devin/credentials.toml` (`$XDG_DATA_HOME/devin/credentials.toml`).
  The docs explicitly allow copying this file between your own machines.
- `devin acp` reads `WINDSURF_API_KEY` from the environment first, then `credentials.toml`, and also accepts the
  ACP `authenticate` request / `/login <api-key>` command.
- Proposed onboarding: Settings -> Devin -> "run `devin auth login` on this machine" and the Control Plane reads
  the token from the host `credentials.toml`; fallback is a paste field. Injection: either `WINDSURF_API_KEY` in
  the Sandbox env (simplest, same as `CLAUDE_CODE_OAUTH_TOKEN`) or write `credentials.toml` into
  `/home/agent/.local/share/devin/` at provision time.
- Open: the exact `credentials.toml` key name and whether a Devin Cloud API key from app.devin.ai is accepted as
  `WINDSURF_API_KEY`. Both need a real login to check; `devin auth login --force-manual-token-flow` inside a
  helper container is the way to test without touching the host.
- Billing: Devin CLI usage counts against the Pro/Max/Teams quota (docs: "A daily and weekly usage quota that
  covers Devin sessions, Devin CLI, and Devin Desktop").

## Fit against the current code

Changes are local to the Provider seams that already exist:

| Area | Today | For Devin |
| --- | --- | --- |
| `packages/protocol` `PROVIDERS` | `["claude-code"]` | add `"devin"`; `providerSecrets.devin.WINDSURF_API_KEY` |
| `images/sandbox/Dockerfile` | installs `claude-agent-acp` | also run the Devin CLI installer as `agent`, drop the trailing login (`|| true`), pin a version if the installer allows |
| `packages/sandbox-daemon` `AgentManager` | `SESSIONBOXER_ACP_COMMAND ?? "claude-agent-acp"` | per-Provider command table: `devin` -> `devin acp`; call `session/set_mode` `bypass` when the mode list contains it |
| `apps/control-plane/src/sessions.ts` | injects `CLAUDE_CODE_OAUTH_TOKEN`, 400 if missing | inject `WINDSURF_API_KEY` for `provider === "devin"`, same 400 pattern |
| `images/sandbox/CLAUDE.md` | Claude-only path `~/.claude/CLAUDE.md` | Devin CLI reads `AGENTS.md` and Claude/Cursor/Windsurf configs (`read_config_from`), so put the desktop briefing in `/home/agent/AGENTS.md` too, or rely on it reading `CLAUDE.md` |
| `apps/web` New Session form | Provider hidden (single value) | show a Provider select; optional model field for Devin |
| Settings UI | Claude token only | Devin token section |

Nothing changes in the Control Plane event store, the UI transcript, Desktop, Files or Terminal: they consume
normalized ACP `session/update`s already.

## Risks / unknowns

- Devin CLI's tool-call `content` shapes (screenshots as image blocks, diffs) may differ from `claude-agent-acp`;
  the Transcript renderer might need small tolerance fixes. Only a real turn shows this.
- Sandbox image grows (Rust binary + its runtime; installer downloaded ~150 MB on x86_64 in the probe).
- The Devin CLI auto-updates by default (`auto_update: true`); set it to `false` in the image's
  `~/.config/devin/config.json` for reproducible Sandboxes.
- Devin CLI's own `--sandbox` (bubblewrap) is unnecessary inside our container; leave it off.
- `agentInfo.version` reports `0.0.0-dev` and the ACP surface carries many `_cognition.ai/*` extensions; treat the
  extension set as unstable.

## Recommendation

Proceed with path 1 as "M6: Devin Provider", gated (like M0) on a spike: install Devin CLI in the image, run one
authenticated `session/prompt` through the Daemon with the `desktop` MCP and `bypass` mode, confirm a screenshot
round-trips into the transcript. Estimated at one session including the spike, the Provider seams above, and
browser verification. Codex (`codex-acp`) would follow the identical recipe afterwards.
