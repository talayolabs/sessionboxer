/**
 * The codes a Sandbox Daemon puts on a JSON-RPC error and the one mapping to HTTP the Control
 * Plane applies when it relays one (ADR-0080). The numbers are the ones Daemons have sent since
 * the first release, so an old Daemon and a new Control Plane (or the reverse) still agree:
 * -32601 and -32602 are JSON-RPC's own, the -3200x range is the server-defined one.
 */
export const DAEMON_ERROR_CODES = {
  /** What the request names does not exist (yet): no agent session, unknown terminal, missing file. */
  not_found: -32001,
  /** The Daemon may not do it: a path outside the workspace, a file it cannot read. */
  forbidden: -32002,
  /** Not now: a turn is active, a branch is in progress, the terminal has exited. Retry later. */
  conflict: -32003,
  /** The request itself is wrong: a Provider this Sandbox does not run, a model or option it does not offer. */
  invalid_params: -32602,
  /** The Daemon predates the method; the Control Plane tells the user to Stop and Resume. */
  method_not_found: -32601,
  /** Anything else: a bare `Error` thrown in the Daemon. */
  internal: -32000,
} as const;

export type DaemonErrorCode = keyof typeof DAEMON_ERROR_CODES;

/** JSON-RPC number → name, for codes the table knows. */
export const DAEMON_ERROR_NAMES: Readonly<Record<number, DaemonErrorCode>> = Object.fromEntries(
  (Object.keys(DAEMON_ERROR_CODES) as DaemonErrorCode[]).map((name) => [DAEMON_ERROR_CODES[name], name]),
) as Record<number, DaemonErrorCode>;

export function daemonErrorName(code: number): DaemonErrorCode | null {
  return DAEMON_ERROR_NAMES[code] ?? null;
}

const HTTP_STATUS: Record<DaemonErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  invalid_params: 400,
  method_not_found: 502,
  internal: 502,
};

/** The HTTP status a Daemon error is relayed as; unknown codes (an old Daemon's, a foreign one) are 502. */
export function httpStatusForDaemonError(code: number): number {
  const name = daemonErrorName(code);
  return name === null ? 502 : HTTP_STATUS[name];
}
