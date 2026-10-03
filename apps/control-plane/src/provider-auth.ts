import { DAEMON_METHODS, PROVIDER_LABELS, type Provider, type Settings, type UpdateSettingsRequest } from "@sessionboxer/protocol";
import {
  codexAuthJson,
  codexAuthNewer,
  cursorAuthNewer,
  cursorLogin,
  fxAuthNewer,
  fxLogin,
  opencodeAuthJson,
  opencodeAuthNewer,
  piApiKeyEnv,
  piApiKeys,
  piAuthJson,
  piAuthNewer,
} from "./config.js";

/**
 * The Agents whose login the Control Plane hands to the Sandbox Daemon and takes back when the CLI
 * refreshes its tokens (Codex ADR-0046, Cursor ADR-0054, pi ADR-0075, OpenCode ADR-0076, fx
 * ADR-0077). Claude Code and Devin get their credentials as environment at container start instead.
 */
export const SYNCED_AUTH_PROVIDERS = ["codex", "cursor", "pi", "opencode", "fx"] as const;
export type SyncedAuthProvider = (typeof SYNCED_AUTH_PROVIDERS)[number];

/** How one Agent's login travels between the stored Settings and its Sandbox. */
export interface ProviderAuthSync {
  /** The Daemon method that sets the login in the Sandbox. */
  readonly setMethod: string;
  /** The Daemon notification that brings a refreshed login file back. */
  readonly changedMethod: string;
  /** The `setMethod` params, from the stored Settings (environment overrides included). */
  params(settings: Settings): Record<string, unknown>;
  /** The stored login a refreshed file competes with. */
  stored(settings: Settings): string;
  /** `true` when a refreshed `candidate` should replace the stored `current`. */
  newer(candidate: string, current: string): boolean;
  /** The Settings update that stores a refreshed login file. */
  storeUpdate(authJson: string): UpdateSettingsRequest;
  /** Whether a Settings update touches this login. */
  changedBy(update: UpdateSettingsRequest): boolean;
  /** A Daemon that predates `setMethod` is logged and skipped instead of failing the connect. */
  readonly tolerateMissingMethod: boolean;
}

export const PROVIDER_AUTH: Record<SyncedAuthProvider, ProviderAuthSync> = {
  codex: {
    setMethod: DAEMON_METHODS.codexAuthSet,
    changedMethod: DAEMON_METHODS.codexAuthChanged,
    params: (settings) => ({ authJson: codexAuthJson(settings) }),
    stored: codexAuthJson,
    newer: codexAuthNewer,
    storeUpdate: (authJson) => ({ providerSecrets: { codex: { CODEX_AUTH_JSON: authJson } } }),
    changedBy: (update) => update.providerSecrets?.codex?.CODEX_AUTH_JSON !== undefined,
    tolerateMissingMethod: true,
  },
  cursor: {
    setMethod: DAEMON_METHODS.cursorAuthSet,
    changedMethod: DAEMON_METHODS.cursorAuthChanged,
    params: (settings) => ({ login: cursorLogin(settings) }),
    stored: cursorLogin,
    newer: cursorAuthNewer,
    storeUpdate: (authJson) => ({ providerSecrets: { cursor: { CURSOR_LOGIN: authJson } } }),
    changedBy: (update) => update.providerSecrets?.cursor?.CURSOR_LOGIN !== undefined,
    tolerateMissingMethod: false,
  },
  pi: {
    setMethod: DAEMON_METHODS.piAuthSet,
    changedMethod: DAEMON_METHODS.piAuthChanged,
    params: (settings) => ({ authJson: piAuthJson(settings), apiKeys: piApiKeyEnv(piApiKeys(settings)) }),
    stored: piAuthJson,
    newer: piAuthNewer,
    storeUpdate: (authJson) => ({ providerSecrets: { pi: { PI_AUTH_JSON: authJson } } }),
    changedBy: (update) => update.providerSecrets?.pi?.PI_AUTH_JSON !== undefined || update.providerSecrets?.pi?.PI_API_KEYS !== undefined,
    tolerateMissingMethod: false,
  },
  opencode: {
    setMethod: DAEMON_METHODS.opencodeAuthSet,
    changedMethod: DAEMON_METHODS.opencodeAuthChanged,
    params: (settings) => ({ authJson: opencodeAuthJson(settings) }),
    stored: opencodeAuthJson,
    newer: opencodeAuthNewer,
    storeUpdate: (authJson) => ({ providerSecrets: { opencode: { OPENCODE_AUTH_JSON: authJson } } }),
    changedBy: (update) => update.providerSecrets?.opencode?.OPENCODE_AUTH_JSON !== undefined,
    tolerateMissingMethod: false,
  },
  fx: {
    setMethod: DAEMON_METHODS.fxAuthSet,
    changedMethod: DAEMON_METHODS.fxAuthChanged,
    params: (settings) => ({ login: fxLogin(settings) }),
    stored: fxLogin,
    newer: fxAuthNewer,
    storeUpdate: (authJson) => ({ providerSecrets: { fx: { FX_LOGIN: authJson } } }),
    changedBy: (update) => update.providerSecrets?.fx?.FX_LOGIN !== undefined,
    tolerateMissingMethod: false,
  },
};

export function isSyncedAuthProvider(provider: Provider): provider is SyncedAuthProvider {
  return (SYNCED_AUTH_PROVIDERS as readonly string[]).includes(provider);
}

/** The Agents whose live Sessions need their login pushed again after this Settings update. */
export function providersAuthChangedBy(update: UpdateSettingsRequest): SyncedAuthProvider[] {
  return SYNCED_AUTH_PROVIDERS.filter((p) => PROVIDER_AUTH[p].changedBy(update));
}

/** The Agent behind a Daemon `*AuthChanged` notification; `null` for any other method. */
export function providerOfAuthChanged(method: string): SyncedAuthProvider | null {
  return SYNCED_AUTH_PROVIDERS.find((p) => PROVIDER_AUTH[p].changedMethod === method) ?? null;
}

export function providerAuthLabel(provider: SyncedAuthProvider): string {
  return PROVIDER_LABELS[provider];
}
