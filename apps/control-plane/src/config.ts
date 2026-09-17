import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONNECTORS,
  MCP_RESERVED_NAMES,
  Settings,
  type DockerMode,
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
  const { providerSecrets, mcpServers, connectors, ...rest } = update;
  const next: Settings = { ...current, ...stripUndefined(rest) };
  if (mcpServers) next.mcpServers = mergeMcpServers(current.mcpServers, mcpServers);
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
  const { providerSecrets, mcpServers, connectors, ...rest } = settings;
  return {
    ...rest,
    mcpServers: mcpServers.map(toPublicMcpServer),
    providerSecretsSet: {
      "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: claudeToken(settings) !== "" },
      devin: { WINDSURF_API_KEY: devinToken(settings) !== "" },
    },
    connectors: {
      github: { clientId: connectors.github.clientId, clientSecretSet: connectors.github.clientSecret !== "" },
    },
    dockerModeAvailable,
  };
}

/** Environment override so a token never has to touch config.json. */
export function claudeToken(settings: Settings): string {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || settings.providerSecrets["claude-code"].CLAUDE_CODE_OAUTH_TOKEN;
}

export function devinToken(settings: Settings): string {
  return process.env.WINDSURF_API_KEY || settings.providerSecrets.devin.WINDSURF_API_KEY;
}

/** Env injected into a Sandbox for the Session's Provider; other Providers' secrets stay on the host. */
export function providerEnv(provider: Provider, settings: Settings): Record<string, string> {
  switch (provider) {
    case "claude-code":
      return { CLAUDE_CODE_OAUTH_TOKEN: claudeToken(settings) };
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
