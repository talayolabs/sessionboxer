import { z } from "zod";
import type { GrokLogin, Settings } from "@sessionboxer/protocol";
import { HttpError } from "./http-error.js";

/**
 * The Grok Build login (ADR-0086), the way `vibe-login.ts` and `copilot-login.ts` hold theirs: validation of a
 * pasted login, the public metadata, and which of two `~/.grok/auth.json` files is the newer one.
 */

/** The Grok Build login (ADR-0086): an xAI API key or the JSON of `~/.grok/auth.json`; `XAI_API_KEY` in the environment overrides. */
export function grokLogin(settings: Settings): string {
  return process.env.XAI_API_KEY?.trim() || settings.providerSecrets.grok.GROK_LOGIN;
}

/**
 * The parts of Grok Build's `auth.json` Sessionboxer looks at (the rest is passed through untouched):
 * `grok login` writes one entry per issuer, `{ "<issuer>::<client id>": { key, auth_mode, create_time,
 * user_id, email, refresh_token, expires_at, … } }`, the session token under `key`.
 */
const GrokAuthEntry = z.object({
  key: z.string().optional(),
  auth_mode: z.string().optional(),
  email: z.string().nullable().optional(),
  create_time: z.string().nullable().optional(),
  expires_at: z.union([z.number(), z.string()]).nullable().optional(),
});
type GrokAuthEntry = z.infer<typeof GrokAuthEntry>;

/** The entry holding a token: the file's first issuer entry with a `key`, or the object itself when it is one entry. */
function grokAuthEntry(parsed: unknown): GrokAuthEntry | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const flat = GrokAuthEntry.safeParse(parsed);
  if (flat.success && flat.data.key) return flat.data;
  for (const value of Object.values(parsed)) {
    const entry = GrokAuthEntry.safeParse(value);
    if (entry.success && entry.data.key) return entry.data;
  }
  return null;
}

/** Accepts an xAI API key or the JSON of a `grok login` file; `""` forgets it. Returns JSON compacted. */
export function normalizeGrokLogin(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (!trimmed.startsWith("{")) {
    if (!/^[\w.-]+$/.test(trimmed)) {
      throw new HttpError(400, "The Grok Build login must be an xAI API key (console.x.ai → API keys) or the JSON in ~/.grok/auth.json, as written by `grok login`.");
    }
    return trimmed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new HttpError(400, "The Grok Build login must be the JSON in ~/.grok/auth.json, as written by `grok login`.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "The Grok Build login must be the JSON object in ~/.grok/auth.json.");
  }
  if (!grokAuthEntry(parsed)) {
    throw new HttpError(400, "This file holds no Grok Build login; run `grok login` and copy ~/.grok/auth.json again.");
  }
  return JSON.stringify(parsed);
}

/** What the stored Grok Build login is, for Settings; nothing is verified. `null` for an empty or unusable string. */
export function describeGrokLogin(login: string): GrokLogin | null {
  const entry = grokLoginEntry(login);
  if (entry === null) return null;
  if (entry === "api-key") return { kind: "api-key", email: null, expiresAt: null };
  const raw = entry.expires_at;
  const expiresMs = typeof raw === "number" ? (raw > 1e12 ? raw : raw * 1000) : Date.parse(raw ?? "");
  return {
    kind: "account",
    email: entry.email?.trim() || null,
    expiresAt: Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : null,
  };
}

function grokLoginEntry(login: string): GrokAuthEntry | "api-key" | null {
  if (login.trim() === "") return null;
  if (!login.trimStart().startsWith("{")) return "api-key";
  try {
    return grokAuthEntry(JSON.parse(login));
  } catch {
    return null;
  }
}

/**
 * Which of two Grok Build login files is the newer one: Grok Build rewrites `auth.json` with a later
 * `expires_at` (and `create_time`) when it refreshes the session. `true` when `candidate` should
 * replace `current` (a login file whose token is not older); an API key in `current` is never replaced.
 */
export function grokAuthNewer(candidate: string, current: string): boolean {
  const a = grokLoginEntry(candidate);
  if (!a || a === "api-key") return false;
  let compact: string;
  try {
    compact = JSON.stringify(JSON.parse(candidate));
  } catch {
    return false;
  }
  if (compact === current) return false;
  const b = grokLoginEntry(current);
  if (b === "api-key") return false;
  if (!b) return true;
  const stamp = (e: GrokAuthEntry) => {
    const raw = e.expires_at ?? e.create_time;
    return typeof raw === "number" ? (raw > 1e12 ? raw : raw * 1000) : Date.parse(raw ?? "");
  };
  const [sa, sb] = [stamp(a), stamp(b)];
  if (!Number.isFinite(sa) || !Number.isFinite(sb)) return true;
  return sa >= sb;
}
