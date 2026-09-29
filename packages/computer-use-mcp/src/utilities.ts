import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export function fillUtilityPlaceholders(text: string, now = Date.now()): string {
  return text.replace(PLACEHOLDER, (match, utility: string, credential: string) => {
    const creds = credentialsOf(utility);
    if (!creds) return match;
    if (credential === "otp") {
      const secret = creds.get("totp");
      return secret ? totp(secret, now) : match;
    }
    return creds.get(credential) ?? match;
  });
}

/** Whether the text has a placeholder (the tool result then says so without echoing what was typed). */
export function hasUtilityPlaceholder(text: string): boolean {
  return new RegExp(PLACEHOLDER.source).test(text);
}

/** RFC 6238, SHA-1, 6 digits, 30 s: what authenticator apps do. */
export function totp(secretBase32: string, now: number, digits = 6, period = 30): string {
  const counter = Math.floor(now / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secretBase32)).update(msg).digest();
  const offset = h[19]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
