import { z } from "zod";
import type { QwenLogin, Settings } from "@sessionboxer/protocol";
import { envOfLines, normalizeEnvLines } from "./env-lines.js";
import { HttpError } from "./http-error.js";

/**
 * The Qwen Code login (ADR-0083): the `~/.qwen/oauth_creds.json` its Qwen OAuth device flow
 * writes (stored compacted; Qwen Code refreshes the token in it and the Sandbox writes the file
 * back here) and/or an OpenAI-compatible endpoint as `NAME=value` lines — `OPENAI_API_KEY`,
 * `OPENAI_MODEL`, `OPENAI_BASE_URL` — which reach the Agent process as environment.
 * `QWEN_OPENAI_API_KEY` (with `QWEN_OPENAI_MODEL`, `QWEN_OPENAI_BASE_URL`) in the Control
 * Plane's environment overrides the stored lines, as `AI_GATEWAY_API_KEY` does for fx; the
 * plain `OPENAI_*` names are not read from there because other tools set them for other reasons.
 */
export const QWEN_API_KEY_NAMES = ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"] as const;

export function qwenOauthJson(settings: Settings): string {
  return settings.providerSecrets.qwen.QWEN_OAUTH_JSON;
}

export function qwenApiKeys(settings: Settings): string {
  const key = process.env.QWEN_OPENAI_API_KEY?.trim();
  if (!key) return settings.providerSecrets.qwen.QWEN_API_KEYS;
  const fromEnv = QWEN_API_KEY_NAMES.map((name) => [name, process.env[`QWEN_${name}`]?.trim() ?? ""] as const).filter(([, value]) => value !== "");
  return fromEnv.map(([name, value]) => `${name}=${value}`).join("\n");
}

/** The OpenAI-compatible variables as the environment the Agent process gets. */
export const qwenApiKeyEnv = envOfLines;

/** The parts of `oauth_creds.json` Sessionboxer looks at (the rest is passed through untouched). */
const QwenOauthFile = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  token_type: z.string().optional(),
  resource_url: z.string().optional(),
  /** Milliseconds since the epoch; Qwen Code refuses a file where it is not a number. */
  expiry_date: z.number().optional(),
});

/** Accepts the JSON object Qwen Code's OAuth device flow writes; `""` forgets it. Returns JSON compacted. */
export function normalizeQwenOauthJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new HttpError(400, "The Qwen Code login must be the JSON in ~/.qwen/oauth_creds.json, as written by its Qwen OAuth sign-in (`qwen`, then /auth).");
  }
  const file = QwenOauthFile.safeParse(parsed);
  if (!file.success || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "The Qwen Code login must be the JSON object in oauth_creds.json: access_token, refresh_token, expiry_date.");
  }
  if (!file.data.access_token || !file.data.refresh_token) {
    throw new HttpError(400, "This file holds no Qwen Code login; run `qwen`, /auth → Qwen OAuth, and copy ~/.qwen/oauth_creds.json again.");
  }
  return JSON.stringify(parsed);
}

/** Accepts `OPENAI_API_KEY=…`, `OPENAI_MODEL=…` and `OPENAI_BASE_URL=…` lines; `""` forgets them. */
export function normalizeQwenApiKeys(text: string): string {
  const lines = normalizeEnvLines(text, (line) => `Qwen Code's endpoint is \`NAME=value\` lines (OPENAI_API_KEY=..., OPENAI_MODEL=..., OPENAI_BASE_URL=...): "${line}" is not one.`);
  if (lines === "") return "";
  const names = Object.keys(envOfLines(lines));
  const unknown = names.find((n) => !(QWEN_API_KEY_NAMES as readonly string[]).includes(n));
  if (unknown) throw new HttpError(400, `Qwen Code reads OPENAI_API_KEY, OPENAI_MODEL and OPENAI_BASE_URL only; ${unknown} is not one of them.`);
  if (!names.includes("OPENAI_API_KEY") || !names.includes("OPENAI_MODEL")) {
    throw new HttpError(400, "Qwen Code needs both OPENAI_API_KEY and OPENAI_MODEL for an OpenAI-compatible endpoint (OPENAI_BASE_URL is optional: api.openai.com by default).");
  }
  return lines;
}

/** What the stored login holds, for Settings: names and expiry only, nothing is verified. `null` when nothing is stored. */
export function describeQwenLogin(authJson: string, apiKeys: string): QwenLogin | null {
  const apiKeyNames = Object.keys(envOfLines(apiKeys));
  const oauth = describeQwenOauth(authJson);
  if (!oauth && apiKeyNames.length === 0) return null;
  return { oauth, apiKeyNames };
}

function describeQwenOauth(authJson: string): QwenLogin["oauth"] {
  if (authJson.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return null;
  }
  const file = QwenOauthFile.safeParse(parsed);
  if (!file.success || !file.data.access_token) return null;
  const expiresAt = file.data.expiry_date !== undefined && Number.isFinite(file.data.expiry_date) ? new Date(file.data.expiry_date).toISOString() : null;
  return { expiresAt, resourceUrl: file.data.resource_url ?? null };
}

/**
 * Which of two `oauth_creds.json` is the newer one: Qwen Code rewrites the file with a later
 * `expiry_date` when it refreshes the token. `true` when `candidate` should replace `current`
 * (a different file whose token is not older).
 */
export function qwenAuthNewer(candidate: string, current: string): boolean {
  const a = describeQwenOauth(candidate);
  if (!a) return false;
  if (JSON.stringify(JSON.parse(candidate)) === current) return false;
  const b = describeQwenOauth(current);
  if (!b?.expiresAt || !a.expiresAt) return true;
  return Date.parse(a.expiresAt) >= Date.parse(b.expiresAt);
}
