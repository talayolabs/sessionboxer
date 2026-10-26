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

**Login command** (`Settings.claudeApi.loginCommand`, beside the credential command): the command that renews the login the helper depends on (the gateway's SSO). A device flow prints a code and a URL and then waits for the browser, so the command runs in the background on the host (`ClaudeApiLoginRun`, one at a time, five-minute timeout, output capped at 16 KB, killed as a process group): `POST /api/claude-api/login` starts it, `GET` serves the output so far with `running`/`ok`, `DELETE` cancels; the browser follows every second and makes the URLs clickable. On success the cached credential is dropped and pushed again to every Claude Session. The Control Plane marks a Session `claudeAuthFailed` when, on the gateway with a credential command configured, a Messages call answers 401 (an `llm_call` event, Inspect LLM on — side calls included, since Claude Code's five-minute helper cache means they are the first to carry a renewed credential) or a turn fails with an `agent_error` that reads like it (`401`, "authenticate", "token is invalid or expired"); a Messages call that gets through or the agent's next reply clears it, as does a successful login or leaving the gateway. The Session shows a notice with **Run login command** and **Use Anthropic directly for this Session** while the flag is set.

**Per-Session gateway switch** (`SessionSettings.claudeGateway`, default on; the Debug section of the Session settings and the New session screen when a gateway is configured): off, the Session's Claude Code talks to Anthropic directly with the Claude login, as a Session without a gateway does, so a gateway policy that blocks a request does not stop the work. The Sandbox keeps the gateway URL in its own environment (`ANTHROPIC_BASE_URL`, plus `SESSIONBOXER_CLAUDE_GATEWAY=0` when created off the gateway); the Daemon derives the Agent's environment from the inspection and gateway choices together (`claudeAgentEnv`): off the gateway, `ANTHROPIC_BASE_URL` is Anthropic's, a static `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` is blanked, the `apiKeyHelper` key leaves the Sandbox's `~/.claude/settings.json` (the last pushed credential is kept in memory and served again when the Session returns), and the inspector's upstream follows (`LlmInspector.setUpstream`), so Inspect LLM records either way. `_sessionboxer/claude-gateway/set` applies it with the in-place Agent restart of `llm/inspect/set` (after the turn when one is active; `DaemonStatus.claudeGateway` reports the started Agent's choice, `Session.claudeGatewayPending` the wait).

## Consequences

- One Sandbox image change (the Daemon); older Daemons answer `method_not_found`, which the push tolerates — Stop → Resume gets the new Daemon.
- The credential exists on the host only inside the Control Plane process and on the wire of the Daemon RPC, and in the box only on tmpfs. It is never logged; the command itself is not a secret and is shown in Settings.
- Sessions in a Windows or macOS VM (ADR-0057, ADR-0059) do not get the credential: the Daemon reports `applied: false`, logged once per push, since Claude Code there runs on the guest's filesystem where the tmpfs path does not exist.
- The login command runs non-interactively (no terminal): a command that prints a URL and waits for the browser works, one that asks on stdin does not — its output tells, and the five-minute cap ends it.
- Older Daemons do not know `claude-gateway/set`: turning the gateway off for such a Session answers 502 (Stop → Resume gets the new Daemon); on stays silent, as before.
- A credential command that fails leaves the previous value in place in the Sandboxes and logs the failure on the Control Plane, without the command's output.
- The refresh is coarse: a token rotated between two Control Plane runs reaches Claude Code within about ten minutes (four-minute cache plus Claude Code's five-minute helper cache), which suits tokens valid for hours; a helper that mints per-call tokens would need the Sandbox to run it, which it cannot.
