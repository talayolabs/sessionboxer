# The Sandbox Daemon speaks Agent Client Protocol (ACP) to the Agent

Sessionboxer targets Claude Code first but must be extendable to other Providers (Codex, Gemini CLI, ...). Rather than binding the Sandbox Daemon to the Claude Agent SDK and inventing our own abstraction when the second Provider arrives, the Daemon is an ACP client: it spawns the Provider's ACP adapter over stdio (`claude-agent-acp` for Claude Code, `codex-acp` for Codex, native for Gemini CLI and OpenCode) and forwards the ACP JSON-RPC stream to the Control Plane over a WebSocket. Sessionboxer's own concerns (file tree, editor, terminals, event replay) ride on the same connection as `_sessionboxer/*` methods, ACP's documented extension convention. The Daemon answers every `session/request_permission` with allow, which is how ADR-0003 is implemented without Provider-specific flags.

## Considered Options

- Claude Agent SDK directly: most control over Claude-specific knobs, but every UI message type would be Claude-shaped and a second Provider forces a rewrite of the Daemon and the UI's message model.
- ACP (chosen): an agent-neutral message model (message chunks, tool calls, diffs, plans, permission requests, terminals) already used by Zed and JetBrains; adding a Provider is installing its adapter in the image plus a Provider entry.

## Consequences

- Claude features not surfaced by `claude-agent-acp` are only reachable through its extensions or by contributing upstream.
- The design was gated on a spike proving `claude-agent-acp` + `CLAUDE_CODE_OAUTH_TOKEN` + Sessionboxer's computer-use MCP server work together inside the Sandbox image. The fallback would have been a Daemon-internal adapter that emits ACP-shaped events from the Claude Agent SDK.
- The Control Plane stores the ACP `session/update` stream (normalized, per Session) in SQLite, so the UI renders history for any Provider and for stopped Sandboxes.

## Spike result (M0)

Gate passed with `claude-agent-acp@0.77.0` (ACP protocol version 1) inside `sessionboxer/sandbox:dev`; `scripts/spike-acp.mjs` is the client used. Findings that shape the Sandbox Daemon:

- `session/new` accepts the computer-use server as a stdio `mcpServers` entry; no `_meta` is needed for permissions because the image ships `~/.claude/settings.json` with `permissions.defaultMode: bypassPermissions`, which the adapter reports as the current mode. `session/set_mode` is available as a belt-and-braces call.
- `CLAUDE_CODE_OAUTH_TOKEN` in the adapter's environment is the only credential needed; without it `session/prompt` fails with `Authentication required` while `initialize` and `session/new` still succeed, so the Daemon can bring a Sandbox up before the token is verified.
- Screenshots come back as `tool_call_update.content[].content` image blocks (base64 PNG), which is what the Control Plane persists and the UI renders inline.
- The adapter runs the Claude CLI bundled with its own `@anthropic-ai/claude-agent-sdk`, not the globally installed `@anthropic-ai/claude-code`; the global install is still useful for `claude setup-token`-style tooling but is not on the ACP path.
- The MCP server name `computer-use` is reserved by Claude Code and silently skipped; ours is registered as `desktop` (tools surface as `mcp__desktop__*`).
