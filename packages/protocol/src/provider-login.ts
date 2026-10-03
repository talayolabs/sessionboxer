// ---------------------------------------------------------------------------
// Provider sign-in (ADR-0058): the Control Plane drives the Provider CLI's browser login (on this
// machine when the CLI is installed here, else in a throwaway container); the sign-in page opens in
// the user's own browser and, for CLIs that ask for one, the code comes back here.
// Nothing in these shapes is secret: the login goes straight into Settings.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { Provider } from "./common.js";

export const ProviderLoginStatus = z.enum(["starting", "awaiting_code", "exchanging", "done", "error"]);
export type ProviderLoginStatus = z.infer<typeof ProviderLoginStatus>;

export const ProviderLoginFlow = z.object({
  id: z.string(),
  provider: Provider,
  /**
   * `starting`: the CLI is booting; `awaiting_code`: open `url` in this browser and sign in, then
   * paste back the code the page shows (`pasteCode`), type `userCode` into the page, or just wait;
   * `exchanging`: the code is being redeemed; `done`: the login is stored in Settings.
   */
  status: ProviderLoginStatus,
  url: z.string().nullable(),
  /** The CLI wants the code the page shows after signing in (Claude Code, Devin). */
  pasteCode: z.boolean(),
  /** A one-time code the CLI wants entered on the page (Codex); `null` for the others. */
  userCode: z.string().nullable(),
  /** Non-secret account label the CLI reported after signing in, when it did. */
  account: z.string().nullable(),
  error: z.string().nullable(),
  expiresAt: z.string(),
});
export type ProviderLoginFlow = z.infer<typeof ProviderLoginFlow>;

export const ProviderLoginCodeRequest = z.object({ code: z.string().trim().min(1).max(4000) });
export type ProviderLoginCodeRequest = z.infer<typeof ProviderLoginCodeRequest>;

/** How a Provider can be connected without pasting: what the Control Plane offers for it. */
export const ProviderHostLogin = z.object({
  /** "Sign in with …" exists: the Provider CLI has a paste-a-code login the Control Plane can drive. */
  signIn: z.boolean(),
  /** "signed in as …" from the CLI's own non-secret account metadata on the Control Plane's machine; `null` when not logged in there. */
  account: z.string().nullable(),
  /** That host login can be copied into Settings as is (Devin's API key, Codex's and Cursor's `auth.json`). */
  importable: z.boolean(),
});
export type ProviderHostLogin = z.infer<typeof ProviderHostLogin>;
