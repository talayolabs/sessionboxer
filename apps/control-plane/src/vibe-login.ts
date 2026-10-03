import type { Settings, VibeLogin } from "@sessionboxer/protocol";
import { HttpError } from "./http-error.js";

/**
 * The Mistral Vibe login (ADR-0085), as `config.ts` holds the other Providers': a Mistral API key
 * pasted as is, or the `~/.vibe/.env` Vibe writes at sign-in (dotenv lines, `MISTRAL_API_KEY` among
 * them). Validated and described here; the Daemon turns either into the `.env` the Agent reads.
 */

/** The Mistral Vibe login (ADR-0085): a Mistral API key, or the dotenv text of the `~/.vibe/.env` Vibe writes at sign-in; `MISTRAL_API_KEY` in the environment overrides. */
export function vibeLogin(settings: Settings): string {
  return process.env.MISTRAL_API_KEY?.trim() || settings.providerSecrets.vibe.VIBE_LOGIN;
}

const DOTENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** The `MISTRAL_API_KEY` a dotenv text sets (quotes stripped); `null` when a line is not dotenv or the key is missing or empty. */
function dotenvMistralKey(text: string): string | null {
  let key: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = DOTENV_LINE.exec(line);
    if (!m) return null;
    if (m[1] === "MISTRAL_API_KEY") key = m[2]!.replace(/^(['"])(.*)\1$/, "$2").trim() || null;
  }
  return key;
}

/** Accepts a Mistral API key or the `~/.vibe/.env` Vibe wrote (dotenv lines, `MISTRAL_API_KEY` among them); `""` forgets it. Returns the key, or the file's lines trimmed. */
export function normalizeVibeLogin(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (!trimmed.includes("=")) {
    if (!/^[\w.-]+$/.test(trimmed)) {
      throw new HttpError(400, "The Mistral Vibe login must be a Mistral API key (console.mistral.ai → API Keys) or the ~/.vibe/.env file Vibe writes when you sign in.");
    }
    return trimmed;
  }
  if (!dotenvMistralKey(trimmed)) {
    throw new HttpError(400, "This file holds no Mistral API key: Vibe writes a MISTRAL_API_KEY=… line to ~/.vibe/.env when you sign in; copy that file, or paste the key itself.");
  }
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join("\n");
}

/** What the stored Mistral Vibe login is, for Settings; nothing is verified. `null` for an empty or unusable string. */
export function describeVibeLogin(login: string): VibeLogin | null {
  if (login.trim() === "") return null;
  if (!login.includes("=")) return { kind: "api-key" };
  return dotenvMistralKey(login) ? { kind: "env-file" } : null;
}

/** The API key a stored or reported Vibe login resolves to; `null` when it has none. */
function vibeApiKey(login: string): string | null {
  return login.includes("=") ? dotenvMistralKey(login) : login.trim() || null;
}

/**
 * Whether the `.env` Vibe rewrote (a sign-in from inside the Agent) should replace the stored login:
 * when it holds another key. A sign-out leaves no key behind and is not stored.
 */
export function vibeAuthNewer(candidate: string, current: string): boolean {
  const key = vibeApiKey(candidate);
  return key !== null && key !== vibeApiKey(current);
}
