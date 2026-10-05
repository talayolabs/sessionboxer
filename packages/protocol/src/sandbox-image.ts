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

/** An Agent payload staged into a Sandbox after its creation (a cross-Provider fork, ADR-0088 §9): what, from where, and the content digest of what went in. */
export const ProviderPayload = z.object({
  provider: Provider,
  /** The Agent's version, from the payload's `manifest.json`. */
  version: z.string(),
  /** `sha256:…` over the payload's entries (names, modes, link targets, contents), the same wherever the payload sits. */
  digest: z.string(),
  bytes: z.number().int().nonnegative(),
  /** The image the payload was taken from. */
  from: z.string(),
});
export type ProviderPayload = z.infer<typeof ProviderPayload>;

/** The image a Sandbox was created from, as resolved and inspected then (Session and Snapshot diagnostics). */
export const SandboxImageInfo = z.object({
  /** The reference it was created from: the resolved tag, `SESSIONBOXER_IMAGE`, or a Snapshot's image id. */
  reference: z.string(),
  /** Docker's image id (`sha256:…`). */
  id: z.string(),
  /** The Agents the image carries by its `io.sessionboxer.providers` label; `null` for a legacy image without labels (taken as all of them). */
  providers: z.array(Provider).nullable(),
  /** The Sessionboxer release the image's runtime belongs to (`io.sessionboxer.runtime`); `null` for a legacy image. */
  runtime: z.string().nullable().default(null),
  /** Agent payloads staged into the Sandbox after its creation, newest last. */
  payloads: z.array(ProviderPayload).default([]),
});
export type SandboxImageInfo = z.infer<typeof SandboxImageInfo>;
