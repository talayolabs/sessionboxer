# ADR 0080: One `DaemonError` with named codes for the Sandbox Daemon RPC

## Status

Accepted

## Context

The Daemon answers the Control Plane's JSON-RPC calls in `packages/sandbox-daemon/src/index.ts` `handle()`; whatever a handler throws reaches the wire through one `.catch()` that reads an ad-hoc numeric `code` off the thrown value and falls back to -32000. Four shapes produced that code: `Object.assign(new Error(…), { code })` (`index.ts`, `mcp-mirror.ts`), `class FsError` (`workspace-fs.ts`, `fs-watch.ts`, mapped to HTTP again by hand in `raw-files.ts`), `class TerminalError` (`terminals.ts`), and some thirty-five bare `throw new Error("a turn is already active")`, `"agent not ready"`, `"this Sandbox does not run Codex"`, … in `index.ts` and `agent.ts`, which all arrived as -32000. The Control Plane's `daemonCall()` in `sessions.ts` mapped the numbers to HTTP with an inline chain (-32001 → 404, -32002 → 403, -32003 → 409, -32602 → 400, -32601 → 502 with the "older Daemon" hint, else 502), so a prompt sent while a turn was active was a 502 Bad Gateway, as was a model the Agent does not offer. The numbers were magic in both places (`docs/TECH-DEBT.md`, fix 6).

## Decision

**One table, in the protocol package.** `packages/protocol/src/daemon-errors.ts` exports `DAEMON_ERROR_CODES` — `not_found: -32001`, `forbidden: -32002`, `conflict: -32003`, `invalid_params: -32602`, `method_not_found: -32601`, `internal: -32000` — the `DaemonErrorCode` name type, the inverse `DAEMON_ERROR_NAMES` / `daemonErrorName()`, and `httpStatusForDaemonError(code)` (404 / 403 / 409 / 400 / 502 / 502; an unknown code is 502). The numbers are the ones Daemons have sent since the first release: an old Daemon with a new Control Plane, or the reverse, keeps working, because nothing on the wire changed but which code a given failure carries.

**One error class in the Daemon.** `packages/sandbox-daemon/src/daemon-error.ts`: `class DaemonError extends Error { readonly kind: DaemonErrorCode; readonly code: number }`, constructed by name; `code` stays a plain number so an older Control Plane reads it as before. `FsError`, `TerminalError` and the `Object.assign` shapes are replaced by it, every message string unchanged (the UI shows them; users search the docs for them). The one translation to the wire is `jsonRpcError(e)`, which `handle().catch()` calls: a numeric `code` is kept (a `DaemonError`'s, or one relayed from an MCP server by the tee mirror), anything else is `internal`. `raw-files.ts` uses `httpStatusForDaemonError` for its HTTP responses instead of its own chain.

**The bare throws are classified** rather than invented anew: `conflict` for "not now" (a turn is active, the Agent is reporting its context usage, the conversation is being branched, a context report is running, another branch operation is in progress, the MCP server is not connected or went away, the terminal has exited); `not_found` for "nothing to act on" (agent not ready, the Agent has no session yet, unknown terminal, path, MCP server or tool call); `invalid_params` for "the request is wrong" (this Sandbox does not run Codex/Cursor/pi/OpenCode/fx, an option or model the Agent does not offer, a path that is not a file or escapes the workspace); `method_not_found` for the default case. What is genuinely the Daemon's own failure (agent stdio unavailable, the agent stopped early, this Agent cannot fork its session) stays a bare `Error` → `internal`, as today, rather than guessed.

**The Control Plane reads the table.** `daemonCall()` keeps the -32601 special case (the "Stop and Resume" hint) under its name and otherwise answers `httpStatusForDaemonError(e.code)`; the `e.code === -32601` checks in `sessions.ts` say `DAEMON_ERROR_CODES.method_not_found`; `DaemonRpcError` keeps its shape. `scripts/daemon-errors.test.mjs` (`npm run test:daemon-errors`, in CI) pins the numbers, the HTTP mapping for every code and an unknown one, and the `{ code, message }` a `DaemonError` becomes on the wire.

## Consequences

- Wrong-state requests answer 409, 404 or 400 instead of 502: the UI and the `sessionboxer` MCP can tell "retry in a moment" from "the Sandbox is broken", and a client may switch on `daemonErrorName(code)`.
- Adding a code is one line in the table plus its HTTP status; the compiler finds every switch that must learn it. Changing a number is a wire change and needs both ends — do not.
- The change is in the Daemon image: `npm run build:image` and Stop → Resume of running Sessions, or an old Daemon keeps sending -32000 for the newly classified cases (which the new Control Plane still maps to 502, as before).
- `mcp-mirror.ts` still relays an MCP server's own JSON-RPC error code and `data` untouched; those codes are the server's, not in the table, and reach HTTP as 502.
