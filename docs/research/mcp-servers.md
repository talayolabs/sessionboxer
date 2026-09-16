# Research: user-defined MCP servers (global registry, per-Session activation)

Goal: let the user register MCP servers once, enable them per Session, and toggle them at any point while a Session
is alive. Probed hands-on on 2026-09-16 inside real Sandboxes (`claude-agent-acp` 0.77.0 / Claude Code 2.1.272,
`devin` 3000.10.27) with `.local/mcp-probe.mjs` and a tiny stdio server (`.local/dyn-mcp.mjs`) whose tool list changes
at runtime.

## How each Provider discovers MCP servers today

| | Claude Code (`claude-agent-acp`) | Devin (`devin acp`) |
|---|---|---|
| Servers passed in ACP `session/new` / `session/load` `mcpServers` | Used (that is how `desktop` is wired) | Spawned but **invisible to the model** (ADR-0007) |
| Config file | `~/.claude.json` / `.mcp.json` (unused by us) | `~/.config/devin/mcp_config.json` (user scope; `desktop` is registered there) |
| `initialize.agentCapabilities.mcpCapabilities` | `{ http: true, sse: true }` | `{ http: false, sse: false }` over ACP, but the config file accepts `transport: stdio\|sse\|http` (`devin mcp add --transport`) |
| Tool naming seen by the model | `mcp__<server>__<tool>` | `mcp_list_tools` / `mcp_call_tool` meta-tools, server by name |

## Findings

1. **Changing the server set on reload works (Claude).** `session/new` with servers `desktop`+`dyn`, then a fresh
   process + `session/load` of the same session with `desktop`+`extra`: the model listed `mcp__desktop__*` and
   `mcp__extra__alpha`, `dyn` was gone, history intact. So a toggle can be implemented exactly like Resume already is:
   restart the ACP process with the new list and `session/load`.
2. **Both agents honour `notifications/tools/list_changed` mid-turn.** Prompted "call `alpha`, then `beta`" where
   `beta` only appears after `alpha` is called: Claude called `ToolSearch → alpha → ToolSearch → beta`; Devin
   `Listed MCP tools → alpha → Listed MCP tools → beta`. A Daemon-hosted gateway MCP could therefore add/remove tools
   without restarting the agent (option B below).
3. **Devin reads its config file per process.** Adding `dyn` with `devin mcp add --scope user` before spawning made
   it usable by the model; `mcp_config.json` is what Devin's model sees, so per-Session activation for Devin means
   writing that file before spawning `devin acp` (the Daemon already owns the spawn).
4. **Servers running on the user's machine are reachable from a Sandbox** via `--add-host=host.docker.internal:host-gateway`
   (verified: HTTP 200 from a Sandbox on the `sessionboxer` network to a host-only listener). URLs pointing at
   `localhost`/`127.0.0.1` need rewriting to `host.docker.internal`; Sandboxes publish no ports (ADR-0005), so the
   opposite direction is not needed.
5. **Runtimes in the image.** `node`/`npx` and `python3` are present; `uvx` (common for Python MCP servers) is not,
   `pip`-installed servers would need a venv. Adding `uv` to the image is cheap.
6. **Secrets.** MCP `env`/`headers` typically carry API tokens. For Claude they only travel over the ACP stdio pipe
   (in-memory in the agent process). For Devin they would be written to `mcp_config.json`, which `docker commit`
   would capture in every snapshot; the file must live on a tmpfs (`/dev/shm`, excluded from commits) behind a
   symlink, rewritten by the Daemon on each start, like tokens are already blanked in snapshot images.

## Options for "toggle at any point"

- **A. Reload (recommended for the first version).** Toggle ⇒ Control Plane sends the Daemon the new list ⇒ Daemon
  kills the ACP process, rewrites Devin's config (Devin only), respawns and `session/load`s. Applied immediately when
  the Session is idle, otherwise queued and applied at `turn_ended` (same hook as auto-snapshot). Tool names stay
  native (`mcp__github__create_issue`), no proxying of resources/prompts/OAuth, ~1 s for Claude, a few seconds for
  Devin (its cold `session/new` retries, ADR-0007, do not apply to `session/load`).
- **B. Gateway MCP.** Daemon runs one aggregating MCP server (registered once for both Providers); enabling a server
  connects to it and emits `list_changed`. Instant and mid-turn, but tools become `mcp__sessionboxer__<server>_<tool>`,
  and the gateway must proxy tool calls, resources, prompts, OAuth and errors for every transport. Worth it later only
  if the restart in A is felt.

## Proposed design (A)

- **Settings → MCP servers**: global registry in `config.json` (0600): `{ id, name, transport: stdio|http|sse,
  command/args or url, env/headers, enabledByDefault }`, plus "Import JSON" accepting a Claude-Desktop-style
  `{"mcpServers": {...}}` blob. Secret-looking values are write-only in the UI (like Provider tokens).
- **Per Session**: `session.mcp: { enabled: string[] }` in SQLite, initialised from `enabledByDefault` at creation (and
  selectable in New Session), copied on Fork. An "MCP" button in the Session header opens a popover with a switch per
  global server and a "pending, applies after this turn" hint while the agent is busy.
- **Daemon**: `_sessionboxer/mcp/set { servers }` RPC; stores the list, restarts the agent when idle or at turn end,
  writes `mcp_config.json` (tmpfs) for Devin, passes the list in `session/new`/`session/load` for both. The built-in
  `desktop` server stays implicit and always on.
- **Control Plane**: resolves the Session's enabled ids to full definitions (with secrets) when talking to the Daemon,
  rewrites `localhost` URLs to `host.docker.internal`, adds `ExtraHosts` to the container spec, exposes REST for the
  registry and the per-Session set.
- **Image**: add `uv` (`uvx`) so Python servers work out of the box.

Estimate: one session (protocol + Daemon + Control Plane + Settings/popover UI + image), with the probe scripts
turned into the verification run.
