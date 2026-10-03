import { readFileSync } from "node:fs";
import { join } from "node:path";
import { totpCode } from "@sessionboxer/protocol";

/**
 * `${util:<name>.<credential>}` in text the Agent types (ADR-0073): the Sandbox Daemon keeps each
 * enabled Utility's credentials in `UTILITY_CREDENTIALS_DIR/<name>.json` on tmpfs; the value is
 * typed, the Agent never sees it. `${util:<name>.otp}` is the current TOTP code of the `totp`
 * credential. An unknown Utility or credential is typed as written, so the Agent notices.
 */
const UTILITY_CREDENTIALS_DIR = process.env.SESSIONBOXER_UTILITIES_DIR ?? "/dev/shm/sessionboxer/utilities";
const PLACEHOLDER = /\$\{util:([a-z0-9][a-z0-9_-]*(?:@[a-z0-9][a-z0-9_-]*)?)\.([A-Za-z0-9_-]+)\}/g;

interface CredentialFile {
  credentials: Array<{ name: string; value: string }>;
}

function credentialsOf(utility: string): Map<string, string> | null {
  try {
    const file = JSON.parse(readFileSync(join(UTILITY_CREDENTIALS_DIR, `${utility}.json`), "utf8")) as CredentialFile;
    return new Map(file.credentials.map((c) => [c.name, c.value]));
  } catch {
    return null;
  }
}

export async function fillUtilityPlaceholders(text: string, now = Date.now()): Promise<string> {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    out += text.slice(last, m.index) + (await placeholderValue(m[0], m[1]!, m[2]!, now));
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

async function placeholderValue(match: string, utility: string, credential: string, now: number): Promise<string> {
  const creds = credentialsOf(utility);
  if (!creds) return match;
  if (credential === "otp") {
    const secret = creds.get("totp");
    return secret ? totpCode(secret, now) : match;
  }
  return creds.get(credential) ?? match;
}

/** Whether the text has a placeholder (the tool result then says so without echoing what was typed). */
export function hasUtilityPlaceholder(text: string): boolean {
  return new RegExp(PLACEHOLDER.source).test(text);
}
