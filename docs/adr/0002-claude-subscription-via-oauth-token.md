# Authenticate the Agent with a Claude subscription OAuth token, not an API key

Every Sandbox needs Claude credentials (ADR-0001), and creating a Session must not require logging in again. Pay-per-token API keys are ruled out on cost: Sessionboxer is meant to run on the user's existing Claude Pro/Max subscription. The user runs `claude setup-token` once on the host, the Control Plane stores the resulting long-lived token, and injects it into each Sandbox as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable. Sandboxes never run an interactive login.

## Considered Options

- `ANTHROPIC_API_KEY`: works everywhere but bills per token; rejected on cost. May be offered later as an opt-in fallback.
- Bind-mounting the host's `~/.claude` credentials: ties the image to the host's credential layout (Keychain on macOS, a JSON file on Linux) and shares mutable state across Sandboxes; rejected.
- `CLAUDE_CODE_OAUTH_TOKEN` (chosen): one login, one secret, plain env var.

## Consequences

- The token is a bearer credential for the user's whole subscription; the Control Plane must store it with restricted permissions and never write it into images or logs.
- Token expiry or revocation breaks every Session at once; the UI needs a visible "re-run setup-token" path.
