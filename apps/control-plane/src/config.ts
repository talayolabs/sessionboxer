import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Settings, type PublicSettings, type UpdateSettingsRequest } from "@sessionboxer/protocol";

export const DATA_DIR = process.env.SESSIONBOXER_HOME ?? join(homedir(), ".sessionboxer");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const DB_FILE = join(DATA_DIR, "db.sqlite");

export const HOST = process.env.SESSIONBOXER_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.SESSIONBOXER_PORT ?? 4000);
export const SANDBOX_IMAGE = process.env.SESSIONBOXER_IMAGE ?? "sessionboxer/sandbox:dev";
export const SANDBOX_NETWORK = process.env.SESSIONBOXER_NETWORK ?? "sessionboxer";

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

export function loadSettings(): Settings {
  ensureDataDir();
  if (!existsSync(CONFIG_FILE)) return Settings.parse({});
  return Settings.parse(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
}

export function saveSettings(settings: Settings): void {
  ensureDataDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

export function applySettingsUpdate(current: Settings, update: UpdateSettingsRequest): Settings {
  const { providerSecrets, ...rest } = update;
  const next: Settings = { ...current, ...stripUndefined(rest) };
  if (providerSecrets?.["claude-code"]) {
    next.providerSecrets = {
      ...current.providerSecrets,
      "claude-code": {
        ...current.providerSecrets["claude-code"],
        ...stripUndefined(providerSecrets["claude-code"]),
      },
    };
  }
  return Settings.parse(next);
}

export function toPublicSettings(settings: Settings): PublicSettings {
  const { providerSecrets, ...rest } = settings;
  return {
    ...rest,
    providerSecretsSet: {
      "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: claudeToken(settings) !== "" },
    },
  };
}

/** Environment override so a token never has to touch config.json. */
export function claudeToken(settings: Settings): string {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || settings.providerSecrets["claude-code"].CLAUDE_CODE_OAUTH_TOKEN;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
