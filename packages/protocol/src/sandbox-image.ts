// ---------------------------------------------------------------------------
// The Sandbox image (`/api/sandbox-image`): pulled once, every Docker Session's container starts from it.
// ---------------------------------------------------------------------------

import { z } from "zod";

/**
 * `GET /api/sandbox-image`: whether the Sandbox image is on this machine. The first Session waits
 * on a multi-GB pull, so the UI shows where it stands instead of a silent "Creating…".
 */
export const SandboxImageStatus = z.object({
  image: z.string(),
  state: z.enum(["checking", "pulling", "ready", "error"]),
  /** Bytes so far and in total across the layers Docker has announced (0 until known). */
  received: z.number(),
  total: z.number(),
  error: z.string().nullable(),
});
export type SandboxImageStatus = z.infer<typeof SandboxImageStatus>;
