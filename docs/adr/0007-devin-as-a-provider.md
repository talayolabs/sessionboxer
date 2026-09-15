# Devin is the second Provider, via Devin CLI's ACP server inside the Sandbox

Devin can be added without touching the Control Plane ⇄ Daemon protocol because the Devin CLI ships `devin acp`, an ACP server over stdio (protocol version 1, `loadSession`, image prompts, client-supplied stdio MCP servers). The Sandbox Daemon spawns it exactly like `claude-agent-acp`, passes the same `desktop` MCP server, and switches the session to Devin's `bypass` mode, which is Devin's spelling of ADR-0003. The Agent still runs inside the Sandbox (ADR-0001); the user's Devin account is used through one token (`WINDSURF_API_KEY`) entered once in Settings and injected only into Devin Sessions, mirroring ADR-0002.

## Considered Options

- Devin Cloud API (chosen against): Cognition runs the agent, its desktop and the workspace on their infrastructure; Sessionboxer would become a thin client over their session API, losing the per-Session Sandbox, the local Desktop, Files and Terminal panes, and the ACP transcript.
- Devin Outposts (parked): `devin worker start --outpost=...` runs Devin's worker on your machine, but orchestration and the transcript stay in Devin Cloud, and it needs an organization with Outposts enabled plus a v3 API token. Revisit if a Cloud-orchestrated mode is ever wanted.
- Devin CLI `devin acp` (chosen): same shape as the Claude adapter; adding it is an image install plus a Provider entry, which is the extension path ADR-0006 was designed for.

## Consequences

- `Provider` gains `devin`; the Daemon maps it to `devin acp` (`SESSIONBOXER_PROVIDER` selects, `SESSIONBOXER_ACP_COMMAND` overrides for experiments) and, after `session/new` or `session/load`, calls `session/set_mode` with the first advertised mode among `bypassPermissions`/`bypass`.
- Settings hold `providerSecrets.devin.WINDSURF_API_KEY`; the Control Plane refuses to create a Devin Session without it (400 with a setup hint) and never passes the Claude token to a Devin Sandbox or vice versa.
- The image installs a pinned Devin CLI version as the `agent` user (`~/.local/bin/devin`, on `PATH`), with `~/.config/devin/config.json` setting `auto_update: false` so a Sandbox runs the version it was built with. The installer's trailing `devin setup` login fails without a TTY and is ignored; credentials are never baked into the image.
- The Desktop briefing that was `images/sandbox/CLAUDE.md` is now `images/sandbox/sandbox-briefing.md`, worded for any harness, and still installed as `~/.claude/CLAUDE.md`: Devin CLI reads Claude's user config as an always-on rule (`devin rules list` shows it), so one file briefs both Providers. Should that stop being true, Devin's native location is `~/.devin/global_rules.md`.
- Model selection (`devin acp --model` / `DEVIN_MODEL`) is still Provider default, as decided for the MVP; a per-Session model is a later UI + schema change.
- Devin emits `_cognition.ai/*` extension notifications on the ACP stream; the Daemon forwards them like any `session/update` and the UI ignores what it does not know.

## Spike result (M6)

Unauthenticated probe in a bare `ubuntu:24.04` container (`devin 3000.10.27`): `initialize` and `session/new` succeed, the client-supplied stdio `desktop` MCP is spawned (`Starting stdio MCP server 'desktop'`), advertised modes are `accept-edits`, `smart`, `ask`, `plan`, `bypass` (default model `swe-1-6-fast`); the only `authMethods` entry is `devin-browser`, so a token must come through the environment. Full notes: `docs/research/devin-as-a-provider.md`.

Authenticated run: pending.
