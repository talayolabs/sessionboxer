import { z } from "zod";
import type { GeminiLogin, Settings } from "@sessionboxer/protocol";
import { HttpError } from "./http-error.js";
import { jwtClaims } from "./jwt.js";

/*
 * The Gemini CLI login (ADR-0087): a Gemini API key or the `~/.gemini/oauth_creds.json` its Login
 * with Google writes, validated, described for Settings (never the secret) and compared for the
 * refresh sync. Out of config.ts for its size budget, like the Provider rows it sits beside.
 */

/** The Gemini CLI login (ADR-0087): a Gemini API key or the JSON of its `oauth_creds.json`; `GEMINI_API_KEY` in the environment overrides. */
export function geminiLogin(settings: Settings): string {
  return process.env.GEMINI_API_KEY?.trim() || settings.providerSecrets.gemini.GEMINI_LOGIN;
}

/**
 * The parts of Gemini CLI's `~/.gemini/oauth_creds.json` Sessionboxer looks at (the rest is passed
 * through untouched): the google-auth-library credentials a "Login with Google" leaves behind.
 */
const GeminiOauthFile = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  token_type: z.string().optional(),
  expiry_date: z.number().optional(),
});

/** Accepts a Gemini API key or the JSON object of `oauth_creds.json`; `""` forgets it. Returns JSON compacted. */
export function normalizeGeminiLogin(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (!trimmed.startsWith("{")) {
    if (!/^[\w.-]+$/.test(trimmed)) {
      throw new HttpError(400, "The Gemini CLI login must be a Gemini API key (aistudio.google.com → Get API key) or the JSON in ~/.gemini/oauth_creds.json, as written by its Login with Google.");
    }
    return trimmed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new HttpError(400, "The Gemini CLI login must be the JSON in ~/.gemini/oauth_creds.json, as written by its Login with Google.");
  }
  const file = GeminiOauthFile.safeParse(parsed);
  if (!file.success || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "The Gemini CLI login must be the JSON object in ~/.gemini/oauth_creds.json.");
  }
  if (!file.data.access_token || !file.data.refresh_token) {
    throw new HttpError(400, "This file holds no Google login; run `gemini`, choose Login with Google, and copy ~/.gemini/oauth_creds.json again.");
  }
  return JSON.stringify(parsed);
}

/** What the stored Gemini CLI login is, for Settings; nothing is verified. `null` for an empty or unusable string. */
export function describeGeminiLogin(login: string): GeminiLogin | null {
  if (login.trim() === "") return null;
  if (!login.trimStart().startsWith("{")) return { kind: "api-key", expiresAt: null, email: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(login);
  } catch {
    return null;
  }
  const file = GeminiOauthFile.safeParse(parsed);
  if (!file.success || !file.data.access_token) return null;
  const expiresAt = file.data.expiry_date !== undefined && Number.isFinite(file.data.expiry_date) ? new Date(file.data.expiry_date).toISOString() : null;
  const email = file.data.id_token ? jwtClaims(file.data.id_token)?.email : undefined;
  return { kind: "google", expiresAt, email: typeof email === "string" ? email : null };
}

/**
 * Which of two Gemini login files is the newer one: Gemini CLI rewrites `oauth_creds.json` with a
 * later `expiry_date` when it refreshes the access token. `true` when `candidate` should replace
 * `current` (a Google login whose token is not older); an API key in `current` is never replaced.
 */
export function geminiAuthNewer(candidate: string, current: string): boolean {
  const a = describeGeminiLogin(candidate);
  if (!a || a.kind === "api-key") return false;
  let compact: string;
  try {
    compact = JSON.stringify(JSON.parse(candidate));
  } catch {
    return false;
  }
  if (compact === current) return false;
  const b = describeGeminiLogin(current);
  if (b?.kind === "api-key") return false;
  if (!b?.expiresAt || !a.expiresAt) return true;
  return Date.parse(a.expiresAt) >= Date.parse(b.expiresAt);
}
