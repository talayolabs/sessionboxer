import { z } from "zod";
import type { KimiLogin, Settings } from "@sessionboxer/protocol";
import { HttpError } from "./http-error.js";

const KimiAuthFile = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().finite().nonnegative().optional(),
});

export function kimiLogin(settings: Settings): string {
  return settings.providerSecrets.kimi.KIMI_LOGIN;
}

export function normalizeKimiLogin(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new HttpError(400, "Paste the JSON in ~/.kimi/credentials/kimi-code.json, written by `kimi login`. Kimi CLI 1.52.0 does not support API-key-only ACP sessions.");
  }
  if (!KimiAuthFile.safeParse(parsed).success) {
    throw new HttpError(400, "This file holds no Kimi login. Run `kimi login` and copy ~/.kimi/credentials/kimi-code.json again.");
  }
  return JSON.stringify(parsed);
}

export function describeKimiLogin(login: string): KimiLogin | null {
  try {
    const parsed = KimiAuthFile.safeParse(JSON.parse(login));
    if (!parsed.success) return null;
    const date = new Date((parsed.data.expires_at ?? 0) * 1000);
    return { kind: "oauth", expiresAt: parsed.data.expires_at && Number.isFinite(date.getTime()) ? date.toISOString() : null };
  } catch {
    return null;
  }
}

export function kimiAuthNewer(candidate: string, current: string): boolean {
  const a = describeKimiLogin(candidate);
  if (!a || JSON.stringify(JSON.parse(candidate)) === current) return false;
  const b = describeKimiLogin(current);
  return !b?.expiresAt || !a.expiresAt || Date.parse(a.expiresAt) >= Date.parse(b.expiresAt);
}
