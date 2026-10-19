# ADR 0090: Claude API credential from a command on the host (`apiKeyHelper`)

## Status

Accepted

## Context

Company Claude gateways are set up by an installer that writes `~/.claude/settings.json` on the developer's machine: `env.ANTHROPIC_BASE_URL` points at the gateway, and `apiKeyHelper` names a host binary that prints a short-lived credential (a JWT valid for hours). Claude Code runs that command through `/bin/sh`, sends the output as `Authorization: Bearer` and `X-Api-Key`, and re-runs it every five minutes.

Sessionboxer read none of this. Global settings → Providers → Claude API took a base URL and a static **Proxy auth token** / **Proxy API key** (ADR-0002 for the OAuth token itself), which a daily-rotating gateway token defeats: every day the token has to be pasted again and every Session Stopped and Resumed. The helper binary lives on the host, not in the Sandbox, so copying `~/.claude/settings.json` into the box would not work either.

## Decision

A **Credential command (apiKeyHelper)** in the Claude API section (`Settings.claudeApi.credentialCommand`), pre-fillable from the machine: the section lists what `~/.claude/settings.json` on the Control Plane's machine configures (`PublicSettings.claudeApi.host`, honoring `CLAUDE_CONFIG_DIR`), and **Use this machine's Claude settings** (`POST /api/claude-api/import-host`) copies its base URL, `apiKeyHelper` and any `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` from `env` into Settings.

The Control Plane runs the command on the host (`/bin/sh -c`, `cmd /c` on Windows, 60 s timeout), caches the output for four minutes (`ClaudeApiCredential`), and pushes it to every Claude Sandbox over the Daemon RPC (`_sessionboxer/claude-api-credential/set`): right after the Daemon connects, before the Agent starts; every five minutes while a command is configured; and when the command changes. The Daemon writes the value to `/dev/shm/sessionboxer/claude-api-credential` (tmpfs, mode 0600) and sets `apiKeyHelper: "cat /dev/shm/sessionboxer/claude-api-credential"` in the Sandbox's `~/.claude/settings.json`, beside the keys it already manages (`availableModels`). Claude Code picks the new value up on its own schedule, so a rotated token reaches a running Session without restarting the Agent. An empty credential removes the file and the key.

While a command is configured, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are not injected into the Sandbox: Claude Code ranks those variables above `apiKeyHelper`, so they would pin a stale value. `CLAUDE_CODE_OAUTH_TOKEN` ranks below the helper and is still passed when set. A configured command counts as a credential for the Provider gate.

Inspect LLM is unchanged: the recorder sits in front of whatever `ANTHROPIC_BASE_URL` the Sandbox has and forwards every header that is not hop-by-hop, the two credential headers included, so the chain is Claude Code → recorder → gateway → Anthropic, inspected or not.

## Consequences

- One Sandbox image change (the Daemon); older Daemons answer `method_not_found`, which the push tolerates — Stop → Resume gets the new Daemon.
- The credential exists on the host only inside the Control Plane process and on the wire of the Daemon RPC, and in the box only on tmpfs. It is never logged; the command itself is not a secret and is shown in Settings.
- Sessions in a Windows or macOS VM (ADR-0057, ADR-0059) do not get the credential: the Daemon reports `applied: false`, logged once per push, since Claude Code there runs on the guest's filesystem where the tmpfs path does not exist.
- A credential command that fails leaves the previous value in place in the Sandboxes and logs the failure on the Control Plane, without the command's output.
- The refresh is coarse: a token rotated between two Control Plane runs reaches Claude Code within about ten minutes (four-minute cache plus Claude Code's five-minute helper cache), which suits tokens valid for hours; a helper that mints per-call tokens would need the Sandbox to run it, which it cannot.
