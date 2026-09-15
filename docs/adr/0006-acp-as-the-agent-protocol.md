# The Sandbox Daemon speaks Agent Client Protocol (ACP) to the Agent

Sessionboxer targets Claude Code first but must be extendable to other Providers (Codex, Gemini CLI, ...). Rather than binding the Sandbox Daemon to the Claude Agent SDK and inventing our own abstraction when the second Provider arrives, the Daemon is an ACP client: it spawns the Provider's ACP adapter over stdio (`claude-agent-acp` for Claude Code, `codex-acp` for Codex, native for Gemini CLI and OpenCode) and forwards the ACP JSON-RPC stream to the Control Plane over a WebSocket. Sessionboxer's own concerns (file tree, editor, terminals, event replay) ride on the same connection as `_sessionboxer/*` methods, ACP's documented extension convention. The Daemon answers every `session/request_permission` with allow, which is how ADR-0003 is implemented without Provider-specific flags.

## Considered Options

- Claude Agent SDK directly: most control over Claude-specific knobs, but every UI message type would be Claude-shaped and a second Provider forces a rewrite of the Daemon and the UI's message model.
- ACP (chosen): an agent-neutral message model (message chunks, tool calls, diffs, plans, permission requests, terminals) already used by Zed and JetBrains; adding a Provider is installing its adapter in the image plus a Provider entry.

## Consequences

- Claude features not surfaced by `claude-agent-acp` are only reachable through its extensions or by contributing upstream.
- The design is gated on a spike proving `claude-agent-acp` + `CLAUDE_CODE_OAUTH_TOKEN` + Sessionboxer's computer-use MCP server work together inside the Sandbox image. If it fails, the fallback is a Daemon-internal adapter that emits ACP-shaped events from the Claude Agent SDK, keeping the Control Plane and UI unchanged.
- The Control Plane stores the ACP `session/update` stream (normalized, per Session) in SQLite, so the UI renders history for any Provider and for stopped Sandboxes.
