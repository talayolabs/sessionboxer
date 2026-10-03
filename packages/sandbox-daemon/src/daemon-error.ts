import { DAEMON_ERROR_CODES, type DaemonErrorCode } from "@sessionboxer/protocol";

/**
 * An error the RPC handler answers with a known code (ADR-0080): `code` is the JSON-RPC number
 * from `DAEMON_ERROR_CODES`, which is what reaches the wire and what an older Control Plane reads.
 */
export class DaemonError extends Error {
  readonly code: number;

  constructor(
    readonly kind: DaemonErrorCode,
    message: string,
  ) {
    super(message);
    this.code = DAEMON_ERROR_CODES[kind];
  }
}

/** What a rejected `handle()` becomes on the wire: a numeric `code` is kept, anything else is `internal`. */
export function jsonRpcError(e: unknown): { code: number; message: string } {
  const code = typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : DAEMON_ERROR_CODES.internal;
  return { code, message: e instanceof Error ? e.message : String(e) };
}
