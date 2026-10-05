// ---------------------------------------------------------------------------
// The Sandbox images (`/api/sandbox-image`): one per Provider plus a base one (ADR-0088), each
// pulled the first time something needs it; every Docker Session's container starts from one.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { PROVIDERS, Provider } from "./common.js";

/** Which Sandbox image: a Provider's (its Agent plus the runtime) or `base` (the runtime alone, for the VM helpers). */
export const SandboxImageSelector = z.enum([...PROVIDERS, "base"]);
export type SandboxImageSelector = z.infer<typeof SandboxImageSelector>;

/**
 * `GET /api/sandbox-image?provider=…`: where the selected image stands on this machine. The first
 * Session of a Provider waits on a multi-GB pull, so the UI shows where it stands instead of a
 * silent "Creating…". `missing`: not here and nothing is downloading it (a Session, a sign-in or
 * `POST …/pull` would); `error`: the last pull failed, or it cannot be pulled at all.
 */
export const SandboxImageStatus = z.object({
  image: z.string(),
  state: z.enum(["checking", "missing", "pulling", "ready", "error"]),
  /** Bytes so far and in total across the layers Docker has announced (0 until known). */
  received: z.number(),
  total: z.number(),
  error: z.string().nullable(),
});
export type SandboxImageStatus = z.infer<typeof SandboxImageStatus>;

/** The image a Sandbox was created from, as resolved and inspected then (Session and Snapshot diagnostics). */
export const SandboxImageInfo = z.object({
  /** The reference it was created from: the resolved tag, `SESSIONBOXER_IMAGE`, or a Snapshot's image id. */
  reference: z.string(),
  /** Docker's image id (`sha256:…`). */
  id: z.string(),
  /** The Agents the image carries by its `io.sessionboxer.providers` label; `null` for a legacy image without labels (taken as all of them). */
  providers: z.array(Provider).nullable(),
});
export type SandboxImageInfo = z.infer<typeof SandboxImageInfo>;
