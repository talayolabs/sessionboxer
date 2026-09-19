import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  type BoxCredential,
  CONNECTORS,
  MCP_RESERVED_NAMES,
  Settings,
  type DockerMode,
  type GitIdentity,
  type McpConnector,
  type McpKeyValue,
  type McpServerDef,
  type McpServerSpec,
  type Provider,
  type PublicMcpKeyValue,
  type PublicMcpServerDef,
  type PublicSettings,
  type UpdateSettingsRequest,
} from "@sessionboxer/protocol";
import { hostExtraCaCerts, parseExtraCaCerts } from "./ca-certs.js";
import { HttpError } from "./http-error.js";

export const DATA_DIR = process.env.SESSIONBOXER_HOME ?? join(homedir(), ".sessionboxer");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const DB_FILE = join(DATA_DIR, "db.sqlite");

export const HOST = process.env.SESSIONBOXER_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.SESSIONBOXER_PORT ?? 4000);
export const SANDBOX_IMAGE = process.env.SESSIONBOXER_IMAGE ?? "sessionboxer/sandbox:dev";
export const SANDBOX_NETWORK = process.env.SESSIONBOXER_NETWORK ?? "sessionboxer";
/** Name a Sandbox resolves to the host machine (`--add-host ...:host-gateway`), for MCP servers running on it. */
export const SANDBOX_HOST_ALIAS = "host.docker.internal";

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
  const { providerSecrets, mcpServers, connectors, claudeApi, ...rest } = update;
  const next: Settings = { ...current, ...stripUndefined(rest) };
  if (mcpServers) next.mcpServers = mergeMcpServers(current.mcpServers, mcpServers);
  if (claudeApi) {
    next.claudeApi = { ...current.claudeApi, ...stripUndefined(claudeApi) };
    next.claudeApi.baseUrl = next.claudeApi.baseUrl.trim();
    next.claudeApi.authToken = next.claudeApi.authToken.trim();
    next.claudeApi.apiKey = next.claudeApi.apiKey.trim();
    if (next.claudeApi.baseUrl !== "" && !/^https?:\/\//.test(next.claudeApi.baseUrl)) {
      throw new HttpError(400, "The Claude API base URL must start with http:// or https://.");
    }
  }
  if (update.extraCaCerts !== undefined) {
    try {
      next.extraCaCerts = parseExtraCaCerts(update.extraCaCerts).join("\n");
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  }
  if (connectors) {
    next.connectors = {
      github: { ...current.connectors.github, ...stripUndefined(connectors.github ?? {}) },
    };
    next.connectors.github.clientId = next.connectors.github.clientId.trim();
    next.connectors.github.clientSecret = next.connectors.github.clientSecret.trim();
  }
  if (providerSecrets) {
    next.providerSecrets = {
      "claude-code": {
        ...current.providerSecrets["claude-code"],
        ...stripUndefined(providerSecrets["claude-code"] ?? {}),
      },
      devin: {
        ...current.providerSecrets.devin,
        ...stripUndefined(providerSecrets.devin ?? {}),
      },
    };
  }
  return Settings.parse(next);
}

export function toPublicSettings(settings: Settings, dockerModeAvailable: Exclude<DockerMode, "none">): PublicSettings {
  const { providerSecrets, mcpServers, connectors, claudeApi, ...rest } = settings;
  const base = claudeBaseUrl(settings);
  return {
    ...rest,
    mcpServers: mcpServers.map(toPublicMcpServer),
    claudeApi: {
      baseUrl: claudeApi.baseUrl,
      authTokenSet: claudeAuthToken(settings) !== "",
      apiKeySet: claudeApiKey(settings) !== "",
      effectiveBaseUrl: base.url,
      effectiveBaseUrlSource: base.source,
    },
    providerSecretsSet: {
      "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: claudeToken(settings) !== "" },
      devin: { WINDSURF_API_KEY: devinToken(settings) !== "" },
    },
    connectors: {
      github: { clientId: connectors.github.clientId, clientSecretSet: connectors.github.clientSecret !== "" },
    },
    dockerModeAvailable,
    hostCaCerts: hostExtraCaCerts().map((c) => c.subject),
    hostGitIdentity: hostGitIdentity(),
  };
}

let hostGit: GitIdentity | undefined;
/** The host user's own `git config` identity (global/system scope), read once; blank parts when git or the keys are absent. */
export function hostGitIdentity(): GitIdentity {
  if (!hostGit) {
    const read = (key: string): string => {
      try {
        return execFileSync("git", ["config", "--global", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
      } catch {
        return "";
      }
    };
    hostGit = { name: read("user.name"), email: read("user.email") };
  }
  return hostGit;
}

/** Identity a new Session's Sandbox commits with: the request's, else Settings, else the host's git config, per part. */
export function resolveGitIdentity(settings: Settings, requested: Partial<GitIdentity> | undefined): GitIdentity {
  const host = hostGitIdentity();
  const pick = (req: string | undefined, setting: string, fallback: string): string => (req ?? (setting || fallback)).trim();
  return {
    name: pick(requested?.name, settings.gitUserName, host.name),
    email: pick(requested?.email, settings.gitUserEmail, host.email),
  };
}

/** Environment override so a token never has to touch config.json. */
export function claudeToken(settings: Settings): string {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || settings.providerSecrets["claude-code"].CLAUDE_CODE_OAUTH_TOKEN;
}

export function devinToken(settings: Settings): string {
  return process.env.WINDSURF_API_KEY || settings.providerSecrets.devin.WINDSURF_API_KEY;
}

/** `ANTHROPIC_AUTH_TOKEN` for Claude Sandboxes (a company proxy's bearer credential); env override like the tokens. */
export function claudeAuthToken(settings: Settings): string {
  return process.env.ANTHROPIC_AUTH_TOKEN || settings.claudeApi.authToken;
}

export function claudeApiKey(settings: Settings): string {
  return process.env.ANTHROPIC_API_KEY || settings.claudeApi.apiKey;
}

export type ClaudeBaseUrlSource = PublicSettings["claudeApi"]["effectiveBaseUrlSource"];

/** `ANTHROPIC_BASE_URL` a Claude Sandbox gets: Settings, else this process's own environment, else Anthropic. */
export function claudeBaseUrl(settings: Settings): { url: string; source: ClaudeBaseUrlSource } {
  const fromSettings = settings.claudeApi.baseUrl.trim();
  if (fromSettings !== "") return { url: fromSettings, source: "settings" };
  const fromEnv = process.env.ANTHROPIC_BASE_URL?.trim() ?? "";
  if (fromEnv !== "") return { url: fromEnv, source: "env" };
  return { url: ANTHROPIC_DEFAULT_BASE_URL, source: "default" };
}

/** Everything `providerEnv` may set per Provider: what Snapshots blank out. */
export const PROVIDER_ENV_KEYS: Record<Provider, readonly string[]> = {
  "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
  devin: ["WINDSURF_API_KEY"],
};

/** The Provider has a credential to run with (`providerSetupHint` says what is missing otherwise). */
export function providerReady(provider: Provider, settings: Settings): boolean {
  switch (provider) {
    case "claude-code":
      return claudeToken(settings) !== "" || claudeAuthToken(settings) !== "" || claudeApiKey(settings) !== "";
    case "devin":
      return devinToken(settings) !== "";
  }
}

/**
 * Env injected into a Sandbox for the Session's Provider; other Providers' secrets stay on the host.
 * Only set values: Claude's OAuth token can be left out when a proxy credential stands in for it,
 * and `ANTHROPIC_BASE_URL` is only given when it differs from Anthropic's (the Daemon forwards
 * the Agent there, directly or through its inspector).
 */
export function providerEnv(provider: Provider, settings: Settings): Record<string, string> {
  switch (provider) {
    case "claude-code": {
      const env: Record<string, string> = {};
      const token = claudeToken(settings);
      if (token !== "") env.CLAUDE_CODE_OAUTH_TOKEN = token;
      const base = claudeBaseUrl(settings);
      if (base.source !== "default") env.ANTHROPIC_BASE_URL = rewriteHostUrl(base.url);
      const authToken = claudeAuthToken(settings);
      if (authToken !== "") env.ANTHROPIC_AUTH_TOKEN = authToken;
      const apiKey = claudeApiKey(settings);
      if (apiKey !== "") env.ANTHROPIC_API_KEY = apiKey;
      return env;
    }
    case "devin":
      return { WINDSURF_API_KEY: devinToken(settings) };
  }
}

export function providerSetupHint(provider: Provider): string {
  switch (provider) {
    case "claude-code":
      return "No Claude token configured. Run `claude setup-token` and paste it in Settings.";
    case "devin":
      return "No Devin token configured. Run `devin auth login` and paste the token from ~/.local/share/devin/credentials.toml in Settings.";
  }
}

// ---------------------------------------------------------------------------
// MCP registry
// ---------------------------------------------------------------------------

/** Secret values leave as `null` (set) or `""` (empty); the UI sends `null` back to keep them. */
export function toPublicMcpServer(def: McpServerDef): PublicMcpServerDef {
  const hide = (kv: McpKeyValue): PublicMcpKeyValue => ({ ...kv, value: kv.secret && kv.value !== "" ? null : kv.value });
  return { ...def, env: def.env.map(hide), headers: def.headers.map(hide) };
}

/** The whole registry as sent by the UI, with `null` secrets filled from what is stored. */
export function mergeMcpServers(current: McpServerDef[], incoming: PublicMcpServerDef[]): McpServerDef[] {
  const byId = new Map(current.map((s) => [s.id, s]));
  const ids = new Set<string>();
  const names = new Set<string>();
  return incoming.map((pub) => {
    const prev = byId.get(pub.id);
    const name = pub.name;
    if ((MCP_RESERVED_NAMES as readonly string[]).includes(name)) throw new HttpError(400, `MCP server name "${name}" is reserved.`);
    if (names.has(name)) throw new HttpError(400, `Duplicate MCP server name "${name}".`);
    if (ids.has(pub.id)) throw new HttpError(400, `Duplicate MCP server id "${pub.id}".`);
    names.add(name);
    ids.add(pub.id);
    if (pub.transport === "stdio" && pub.command.trim() === "") throw new HttpError(400, `MCP server "${name}" needs a command.`);
    if (pub.transport !== "stdio" && !/^https?:\/\//.test(pub.url.trim())) {
      throw new HttpError(400, `MCP server "${name}" needs an http(s) URL.`);
    }
    const fill = (list: PublicMcpKeyValue[], prevList: McpKeyValue[]): McpKeyValue[] =>
      list
        .filter((kv) => kv.name.trim() !== "")
        .map((kv) => ({
          name: kv.name.trim(),
          secret: kv.secret,
          value: kv.value ?? prevList.find((p) => p.name === kv.name.trim())?.value ?? "",
        }));
    const headers = fill(pub.headers, prev?.headers ?? []);
    return {
      ...pub,
      command: pub.command.trim(),
      url: pub.url.trim(),
      env: fill(pub.env, prev?.env ?? []),
      headers,
      connector: mergeConnector(pub.connector, prev?.connector ?? null, headers),
    };
  });
}

/** Login state is owned by the Control Plane: the form can keep or drop a Connector, not log it in. */
function mergeConnector(incoming: McpConnector | null, prev: McpConnector | null, headers: McpKeyValue[]): McpConnector | null {
  if (!incoming) return null;
  const kept = prev?.kind === incoming.kind ? prev : { kind: incoming.kind, account: null, connectedAt: null, expiresAt: null };
  const hasToken = headers.some((h) => h.name === CONNECTORS[incoming.kind].tokenHeader && h.value !== "");
  return hasToken ? kept : { ...kept, account: null, connectedAt: null, expiresAt: null };
}

/** Full definitions (secrets included) of the enabled ids, as the Daemon needs them; unknown ids are dropped. */
export function resolveMcpServers(settings: Settings, enabledIds: string[]): McpServerSpec[] {
  const enabled = new Set(enabledIds);
  return settings.mcpServers
    .filter((s) => enabled.has(s.id))
    .map(({ enabledByDefault: _default, connector: _connector, ...spec }) => ({ ...spec, url: spec.url ? rewriteHostUrl(spec.url) : spec.url }));
}

/** Logins the Sandbox gets from the enabled Connector entries (registry order), tokens included. */
export function resolveBoxCredentials(settings: Settings, enabledIds: string[]): BoxCredential[] {
  const enabled = new Set(enabledIds);
  const out: BoxCredential[] = [];
  for (const s of settings.mcpServers) {
    if (!enabled.has(s.id) || !s.connector?.account) continue;
    const header = CONNECTORS[s.connector.kind].tokenHeader;
    const token = s.headers.find((h) => h.name === header)?.value.replace(/^Bearer\s+/i, "") ?? "";
    if (token !== "") out.push({ kind: s.connector.kind, account: s.connector.account, token });
  }
  return out;
}

/** `localhost` from the user's point of view is the host machine, not the Sandbox. */
export function rewriteHostUrl(url: string): string {
  try {
    const u = new URL(url);
    if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname) || u.hostname === "::1") {
      u.hostname = SANDBOX_HOST_ALIAS;
      return u.toString();
    }
  } catch {
    // not a URL; let the Agent report it
  }
  return url;
}

/** Ids of the registry entries a new Session starts with when the request does not say. */
export function defaultMcpEnabled(settings: Settings): string[] {
  return settings.mcpServers.filter((s) => s.enabledByDefault).map((s) => s.id);
}

/** Keeps only ids that still exist in the registry. */
export function knownMcpIds(settings: Settings, ids: string[]): string[] {
  const known = new Set(settings.mcpServers.map((s) => s.id));
  return ids.filter((id) => known.has(id));
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
