// ---------------------------------------------------------------------------
// Terminals (UI <-> Control Plane <-> Daemon). PTYs live in the Daemon, so they
// survive UI reloads and Control Plane restarts; byte payloads are base64.
// ---------------------------------------------------------------------------

import { z } from "zod";

export const PTY_SCROLLBACK_BYTES = 256 * 1024;

export const PtyInfo = z.object({
  id: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** Process exit code once the shell has exited; `null` while it runs. */
  exitCode: z.number().int().nullable(),
  createdAt: z.string(),
});
export type PtyInfo = z.infer<typeof PtyInfo>;

export const PtyListResult = z.object({ terminals: z.array(PtyInfo) });
export type PtyListResult = z.infer<typeof PtyListResult>;

export const PtyOpenParams = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
});
export type PtyOpenParams = z.infer<typeof PtyOpenParams>;

export const PtyIdParams = z.object({ id: z.string() });
export type PtyIdParams = z.infer<typeof PtyIdParams>;

/** Attaching returns the retained scrollback (last `PTY_SCROLLBACK_BYTES`), base64. */
export const PtyAttachResult = PtyInfo.extend({ scrollback: z.string() });
export type PtyAttachResult = z.infer<typeof PtyAttachResult>;

export const PtyInputParams = z.object({ id: z.string(), data: z.string() });
export type PtyInputParams = z.infer<typeof PtyInputParams>;

export const PtyResizeParams = PtyOpenParams.extend({ id: z.string() });
export type PtyResizeParams = z.infer<typeof PtyResizeParams>;

/** Daemon -> Control Plane notifications. */
export const PtyOutputParams = z.object({ id: z.string(), data: z.string() });
export type PtyOutputParams = z.infer<typeof PtyOutputParams>;

export const PtyExitParams = z.object({ id: z.string(), exitCode: z.number().int() });
export type PtyExitParams = z.infer<typeof PtyExitParams>;

/**
 * Frames on the UI terminal WebSocket (`/api/sessions/:id/terminals/:ptyId/ws`).
 * Binary frames carry raw bytes (input from the UI, output from the shell);
 * text frames carry these JSON control messages.
 */
export type TerminalClientMessage = { type: "resize"; cols: number; rows: number };
export type TerminalServerMessage =
  | { type: "attached"; terminal: PtyInfo }
  | { type: "exit"; exitCode: number }
  | { type: "error"; message: string };
