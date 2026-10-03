import { z } from "zod";
import { type PiLogin, type Settings } from "@sessionboxer/protocol";
import { HttpError } from "./http-error.js";

/**
 * The pi login (ADR-0075): the `~/.pi/agent/auth.json` pi's `/login` writes (stored compacted; pi
 * refreshes OAuth tokens in it and the Sandbox writes the file back here) and/or API keys as
 * `NAME=value` lines, which reach the Agent process as environment. No environment override:
 * the keys are many and provider-specific.
 */
export function piAuthJson(settings: Settings): string {
  return settings.providerSecrets.pi.PI_AUTH_JSON;
}

export function piApiKeys(settings: Settings): string {
  return settings.providerSecrets.pi.PI_API_KEYS;
}

/** pi's `auth.json`: one entry per model provider, `{ "type": "api_key" | "oauth", ... }`. */
const PiAuthFile = z.record(z.string(), z.object({ type: z.string() }).passthrough());

/** Accepts the JSON object pi's `/login` writes; `""` forgets it. Returns JSON compacted. */
export function normalizePiAuthJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new HttpError(400, "The pi login must be the JSON in pi's auth.json (~/.pi/agent/auth.json), as written by its /login.");
  }
  const file = PiAuthFile.safeParse(parsed);
  if (!file.success || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "The pi login must be the JSON object in pi's auth.json: one entry per model provider.");
  }
  if (Object.keys(file.data).length === 0) {
    throw new HttpError(400, "This auth.json holds no pi login; run `pi`, `/login` a provider, and copy the file again.");
  }
  return JSON.stringify(parsed);
}

/** Accepts `NAME=value` lines (`export NAME=value` too; blank and `#` lines skipped); `""` forgets them. */
export function normalizePiApiKeys(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    const value = m?.[2]?.trim().replace(/^(["'])(.*)\1$/, "$2") ?? "";
    if (!m || value === "") throw new HttpError(400, `pi API keys are \`NAME=value\` lines, one per model provider (ANTHROPIC_API_KEY=..., OPENAI_API_KEY=...): "${raw.trim()}" is not one.`);
    lines.push(`${m[1]}=${value}`);
  }
  return lines.join("\n");
}

/** The API keys as the environment the Agent process gets. */
export function piApiKeyEnv(apiKeys: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of apiKeys.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

/** What the stored login holds, for Settings; names only, nothing is verified. `null` when nothing is stored. */
export function describePiLogin(authJson: string, apiKeys: string): PiLogin | null {
  const apiKeyNames = Object.keys(piApiKeyEnv(apiKeys));
  const authProviders: PiLogin["authProviders"] = [];
  if (authJson.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(authJson);
    } catch {
      parsed = null;
    }
    const file = PiAuthFile.safeParse(parsed);
    if (file.success) {
      for (const [id, cred] of Object.entries(file.data)) {
        authProviders.push({ id, kind: cred.type === "oauth" ? "oauth" : cred.type === "api_key" ? "api_key" : "other" });
      }
    }
  }
  if (authProviders.length === 0 && apiKeyNames.length === 0) return null;
  return { authProviders, apiKeyNames };
}

/**
 * Which of two pi `auth.json` is the newer one: pi writes a later `expires` when it refreshes an
 * OAuth token. `true` when `candidate` should replace `current` (a different file whose tokens are
 * not older); a file without OAuth entries never does.
 */
export function piAuthNewer(candidate: string, current: string): boolean {
  const expiresOf = (json: string): number | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return null;
    }
    const file = PiAuthFile.safeParse(parsed);
    if (!file.success) return null;
    let max: number | null = null;
    for (const cred of Object.values(file.data)) {
      if (cred.type !== "oauth") continue;
      const exp = typeof cred.expires === "number" ? cred.expires : 0;
      max = max === null ? exp : Math.max(max, exp);
    }
    return max;
  };
  const a = expiresOf(candidate);
  if (a === null) return false;
  if (JSON.stringify(JSON.parse(candidate)) === current) return false;
  const b = expiresOf(current);
  if (b === null) return current.trim() === "";
  return a >= b;
}
