import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { describeKimiLogin, kimiLogin, normalizeKimiLogin } from "./kimi-login.js";
import {
  PROVIDERS,
  ANTHROPIC_DEFAULT_BASE_URL,
  type BoxCredential,
  type CodexLogin,
  type CursorLogin,
  type OpenCodeLogin,
  type FxLogin,
  describeCopilotLogin,
  CONNECTORS,
  connectorHasMcp,
  MCP_RESERVED_NAMES,
  PAST_DEFAULT_INSTRUCTIONS,
  Settings,
  TUNNEL_NAME_RE,
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
  type RemoteAccess,
  type TunnelStatuses,
  type UpdateSettingsRequest,
  WINDOWS_VERSIONS,
  MACOS_VERSIONS,
} from "@sessionboxer/protocol";
import { hostExtraCaCerts, parseExtraCaCerts } from "./ca-certs.js";
import { describeGeminiLogin, geminiLogin, normalizeGeminiLogin } from "./gemini-login.js";
import { HttpError } from "./http-error.js";
import { piApiKeys, piAuthJson, normalizePiApiKeys, normalizePiAuthJson, describePiLogin } from "./pi-login.js";
import { copilotLogin, normalizeCopilotLogin } from "./copilot-login.js";

export { piApiKeyEnv, piApiKeys, piAuthJson, piAuthNewer, normalizePiApiKeys, normalizePiAuthJson, describePiLogin } from "./pi-login.js";
export { copilotLogin, copilotAuthNewer, normalizeCopilotLogin } from "./copilot-login.js";
import { describeQwenLogin, normalizeQwenApiKeys, normalizeQwenOauthJson, qwenApiKeys, qwenOauthJson } from "./qwen-login.js";
import { describeVibeLogin, normalizeVibeLogin, vibeLogin } from "./vibe-login.js";
import { describeGrokLogin, grokLogin, normalizeGrokLogin } from "./grok-login.js";
export { grokLogin, grokAuthNewer, normalizeGrokLogin, describeGrokLogin } from "./grok-login.js";
import { jwtClaims } from "./jwt.js";
import { generateVapidKeys } from "./web-push.js";
import { mergeProcedures, mergeUtilities, mergeUtilityEnvironments, toPublicUtility } from "./utilities.js";

/**
 * Root of this installation: the checkout, or the installed `sessionboxer` npm package, which mirrors
 * its layout (apps/control-plane/dist → ../../..). The Sandbox Daemon, protocol and web UI are found
 * relative to it.
 */
export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const VERSION = ((): string => {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export const DATA_DIR = process.env.SESSIONBOXER_HOME ?? join(homedir(), ".sessionboxer");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const DB_FILE = join(DATA_DIR, "db.sqlite");

export const HOST = process.env.SESSIONBOXER_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.SESSIONBOXER_PORT ?? 4000);
/**
 * The Sandbox image, pinned to this version: published by the release workflow for amd64 and
 * arm64, pulled on first use when it is not on this machine; `npm run build:image` builds it
 * locally under the same name. `SESSIONBOXER_IMAGE` overrides it.
 */
export const SANDBOX_IMAGE_REPO = "ghcr.io/talayolabs/sessionboxer-sandbox";
export const SANDBOX_IMAGE = process.env.SESSIONBOXER_IMAGE?.trim() || `${SANDBOX_IMAGE_REPO}:${VERSION}`;
export const SANDBOX_NETWORK = process.env.SESSIONBOXER_NETWORK ?? "sessionboxer";
/** Name a Sandbox resolves to the host machine (`--add-host ...:host-gateway`), for MCP servers running on it. */
export const SANDBOX_HOST_ALIAS = "host.docker.internal";

/** PEM files that make the Control Plane serve HTTPS itself (both or neither). */
export const TLS_CERT_FILE = process.env.SESSIONBOXER_TLS_CERT ?? "";
export const TLS_KEY_FILE = process.env.SESSIONBOXER_TLS_KEY ?? "";
export const TLS = TLS_CERT_FILE !== "" || TLS_KEY_FILE !== "";
/** Believe `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host` (only behind a reverse proxy you run). */
export const TRUST_PROXY = ["1", "true", "yes"].includes((process.env.SESSIONBOXER_TRUST_PROXY ?? "").toLowerCase());

/** Origin the Control Plane is reached at from a browser: `SESSIONBOXER_PUBLIC_URL`, else the bind address. */
export const PUBLIC_URL = (() => {
  const env = process.env.SESSIONBOXER_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  if (env !== "") {
    if (!/^https?:\/\//.test(env)) throw new Error(`SESSIONBOXER_PUBLIC_URL must start with http:// or https://, got ${env}`);
    return env;
  }
  const host = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST;
  return `${TLS ? "https" : "http"}://${host}:${PORT}`;
})();

/** The access token: environment first (never touches config.json), else Settings (generated by `ensureAccessToken`). */
export function accessToken(settings: Settings): string {
  return process.env.SESSIONBOXER_ACCESS_TOKEN?.trim() || settings.accessToken;
}

export function accessTokenSource(): RemoteAccess["accessTokenSource"] {
  return process.env.SESSIONBOXER_ACCESS_TOKEN?.trim() ? "env" : "settings";
}

export function newAccessToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Generates and stores a token when there is none anywhere; returns the (possibly updated) Settings. */
export function ensureAccessToken(settings: Settings): Settings {
  if (accessToken(settings) !== "") return settings;
  const next = { ...settings, accessToken: newAccessToken() };
  saveSettings(next);
  return next;
}

/**
 * Generates and stores the Sessionboxer tunnel secret at first start: the tunnel server binds this
 * laptop's name to it at first login, so a new secret would lose the name.
 */
export function ensureTunnelSecret(settings: Settings): Settings {
  if (settings.tunnels.sessionboxer.secret !== "") return settings;
  const next = { ...settings, tunnels: { ...settings.tunnels, sessionboxer: { ...settings.tunnels.sessionboxer, secret: randomBytes(32).toString("hex") } } };
  saveSettings(next);
  return next;
}

/** Generates and stores the VAPID key pair at first start; a new pair would orphan every push subscription. */
export function ensureVapidKeys(settings: Settings): Settings {
  if (settings.vapid) return settings;
  const next = { ...settings, vapid: generateVapidKeys() };
  saveSettings(next);
  return next;
}

export function remoteAccess(tunnels: TunnelStatuses): RemoteAccess {
  return { publicUrl: PUBLIC_URL, tls: TLS, accessTokenSource: accessTokenSource(), trustProxy: TRUST_PROXY, tunnels };
}

/** Where the tunnel programs (cloudflared, frpc, ssh) reach the Control Plane: its own listener on this machine. */
export const LOCAL_ORIGIN = (() => {
  const host = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST;
  return `${TLS ? "https" : "http"}://${host}:${PORT}`;
})();

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

export function loadSettings(): Settings {
  ensureDataDir();
  if (!existsSync(CONFIG_FILE)) return Settings.parse({});
  const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
  // `quickTunnel: true` from before the transports were several means the Cloudflare one.
  if (typeof raw.quickTunnel === "boolean" && raw.tunnels === undefined) raw.tunnels = { cloudflare: { enabled: raw.quickTunnel } };
  delete raw.quickTunnel;
  // A shipped default that was never edited follows the current one.
  if (typeof raw.instructions === "string" && PAST_DEFAULT_INSTRUCTIONS.includes(raw.instructions)) delete raw.instructions;
  return Settings.parse(raw);
}

export function saveSettings(settings: Settings): void {
  ensureDataDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

export function applySettingsUpdate(current: Settings, update: UpdateSettingsRequest): Settings {
  const { providerSecrets, mcpServers, utilities, utilityEnvironments, procedures, connectors, claudeApi, tunnels, windows, macos, ...rest } = update;
  const next: Settings = { ...current, ...stripUndefined(rest) };
  if (mcpServers) next.mcpServers = mergeMcpServers(current.mcpServers, mcpServers);
  if (utilities) next.utilities = mergeUtilities(current.utilities, utilities, utilityEnvironments ?? current.utilityEnvironments);
  if (utilityEnvironments) next.utilityEnvironments = mergeUtilityEnvironments(utilityEnvironments, next.utilities);
  if (procedures) next.procedures = mergeProcedures(procedures);
  if (windows) {
    next.windows = { ...current.windows, ...stripUndefined(windows) };
    next.windows.version = next.windows.version.trim().toLowerCase();
    if (!WINDOWS_VERSIONS.some((v) => v.code === next.windows.version)) {
      throw new HttpError(400, `Unknown Windows edition "${next.windows.version}".`);
    }
  }
  if (macos) {
    next.macos = { ...current.macos, ...stripUndefined(macos) };
    next.macos.version = next.macos.version.trim().toLowerCase();
    if (!MACOS_VERSIONS.some((v) => v.code === next.macos.version)) {
      throw new HttpError(400, `Unknown macOS release "${next.macos.version}".`);
    }
  }
  if (tunnels) {
    next.tunnels = {
      cloudflare: { ...current.tunnels.cloudflare, ...stripUndefined(tunnels.cloudflare ?? {}) },
      sessionboxer: { ...current.tunnels.sessionboxer, ...stripUndefined(tunnels.sessionboxer ?? {}) },
      ssh: { ...current.tunnels.ssh, ...stripUndefined(tunnels.ssh ?? {}) },
    };
    const sb = next.tunnels.sessionboxer;
    sb.server = sb.server.trim().replace(/\/+$/, "");
    sb.name = sb.name.trim().toLowerCase();
    if (sb.server === "") throw new HttpError(400, "The tunnel server address is required.");
    if (!/^https?:\/\//.test(sb.server)) throw new HttpError(400, "The tunnel server must be an http:// or https:// URL.");
    if (sb.name !== "" && !TUNNEL_NAME_RE.test(sb.name)) {
      throw new HttpError(400, "A tunnel name is 3–40 lowercase letters, digits and dashes, not starting or ending with a dash.");
    }
    const ssh = next.tunnels.ssh;
    ssh.host = ssh.host.trim();
    ssh.user = ssh.user.trim();
    ssh.identityFile = ssh.identityFile.trim();
    ssh.publicUrl = ssh.publicUrl.trim().replace(/\/+$/, "");
    if (/[\s@]/.test(ssh.host) || ssh.host.startsWith("-")) throw new HttpError(400, "The SSH host is a hostname or IP address (user goes in its own field).");
    if (/[\s@:]/.test(ssh.user) || ssh.user.startsWith("-")) throw new HttpError(400, "That is not a valid SSH user name.");
    if (ssh.identityFile.startsWith("-")) throw new HttpError(400, "That is not a valid key file path.");
    if (ssh.publicUrl !== "" && !/^https?:\/\//.test(ssh.publicUrl)) throw new HttpError(400, "The public URL must start with http:// or https://.");
    if (ssh.enabled && ssh.host === "") throw new HttpError(400, "Set the SSH server host before turning the SSH tunnel on.");
  }
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
    // Per Provider, the stored keys with the update's set ones on top (an explicit `""` forgets one).
    next.providerSecrets = Object.fromEntries(
      PROVIDERS.map((p) => [p, { ...current.providerSecrets[p], ...stripUndefined(providerSecrets[p] ?? {}) }]),
    ) as Settings["providerSecrets"];
    if (providerSecrets.codex?.CODEX_AUTH_JSON !== undefined) {
      next.providerSecrets.codex.CODEX_AUTH_JSON = normalizeCodexAuthJson(providerSecrets.codex.CODEX_AUTH_JSON);
    }
    if (providerSecrets.cursor?.CURSOR_LOGIN !== undefined) {
      next.providerSecrets.cursor.CURSOR_LOGIN = normalizeCursorLogin(providerSecrets.cursor.CURSOR_LOGIN);
    }
    if (providerSecrets.pi?.PI_AUTH_JSON !== undefined) {
      next.providerSecrets.pi.PI_AUTH_JSON = normalizePiAuthJson(providerSecrets.pi.PI_AUTH_JSON);
    }
    if (providerSecrets.pi?.PI_API_KEYS !== undefined) {
      next.providerSecrets.pi.PI_API_KEYS = normalizePiApiKeys(providerSecrets.pi.PI_API_KEYS);
    }
    if (providerSecrets.opencode?.OPENCODE_AUTH_JSON !== undefined) {
      next.providerSecrets.opencode.OPENCODE_AUTH_JSON = normalizeOpenCodeAuthJson(providerSecrets.opencode.OPENCODE_AUTH_JSON);
    }
    if (providerSecrets.fx?.FX_LOGIN !== undefined) {
      next.providerSecrets.fx.FX_LOGIN = normalizeFxLogin(providerSecrets.fx.FX_LOGIN);
    }
    if (providerSecrets.kimi?.KIMI_LOGIN !== undefined) {
      next.providerSecrets.kimi.KIMI_LOGIN = normalizeKimiLogin(providerSecrets.kimi.KIMI_LOGIN);
    }
    if (providerSecrets.copilot?.COPILOT_LOGIN !== undefined) {
      next.providerSecrets.copilot.COPILOT_LOGIN = normalizeCopilotLogin(providerSecrets.copilot.COPILOT_LOGIN);
    }
    if (providerSecrets.vibe?.VIBE_LOGIN !== undefined) {
      next.providerSecrets.vibe.VIBE_LOGIN = normalizeVibeLogin(providerSecrets.vibe.VIBE_LOGIN);
    }
    if (providerSecrets.grok?.GROK_LOGIN !== undefined) {
      next.providerSecrets.grok.GROK_LOGIN = normalizeGrokLogin(providerSecrets.grok.GROK_LOGIN);
    }
    if (providerSecrets.gemini?.GEMINI_LOGIN !== undefined) {
      next.providerSecrets.gemini.GEMINI_LOGIN = normalizeGeminiLogin(providerSecrets.gemini.GEMINI_LOGIN);
    }
    if (providerSecrets.qwen?.QWEN_OAUTH_JSON !== undefined) {
      next.providerSecrets.qwen.QWEN_OAUTH_JSON = normalizeQwenOauthJson(providerSecrets.qwen.QWEN_OAUTH_JSON);
    }
    if (providerSecrets.qwen?.QWEN_API_KEYS !== undefined) {
      next.providerSecrets.qwen.QWEN_API_KEYS = normalizeQwenApiKeys(providerSecrets.qwen.QWEN_API_KEYS);
    }
  }
  return Settings.parse(next);
}

export function toPublicSettings(
  settings: Settings,
  dockerModeAvailable: Exclude<DockerMode, "none">,
  tunnels: TunnelStatuses,
  environments: PublicSettings["environments"],
  dockerReachable: boolean,
): PublicSettings {
  const { providerSecrets, mcpServers, utilities, connectors, claudeApi, accessToken: _token, vapid: _vapid, tunnels: tunnelSettings, windows, macos, ...rest } = settings;
  const base = claudeBaseUrl(settings);
  const { secret, ...sessionboxer } = tunnelSettings.sessionboxer;
  const { password: _password, ...publicWindows } = windows;
  const { password: _macPassword, ...publicMacos } = macos;
  return {
    ...rest,
    windows: publicWindows,
    macos: publicMacos,
    environments,
    dockerReachable,
    tunnels: { ...tunnelSettings, sessionboxer: { ...sessionboxer, secretSet: secret !== "" } },
    mcpServers: mcpServers.map(toPublicMcpServer),
    utilities: utilities.map(toPublicUtility),
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
      codex: { CODEX_AUTH_JSON: codexAuthJson(settings) !== "" },
      cursor: { CURSOR_LOGIN: cursorLogin(settings) !== "" },
      pi: { PI_AUTH_JSON: piAuthJson(settings) !== "", PI_API_KEYS: piApiKeys(settings) !== "" },
      opencode: { OPENCODE_AUTH_JSON: opencodeAuthJson(settings) !== "" },
      fx: { FX_LOGIN: fxLogin(settings) !== "" },
      kimi: { KIMI_LOGIN: kimiLogin(settings) !== "" },
      copilot: { COPILOT_LOGIN: copilotLogin(settings) !== "" },
      vibe: { VIBE_LOGIN: vibeLogin(settings) !== "" },
      grok: { GROK_LOGIN: grokLogin(settings) !== "" },
      gemini: { GEMINI_LOGIN: geminiLogin(settings) !== "" },
      qwen: { QWEN_OAUTH_JSON: qwenOauthJson(settings) !== "", QWEN_API_KEYS: qwenApiKeys(settings) !== "" },
    },
    codexLogin: codexLogin(codexAuthJson(settings)),
    cursorLogin: describeCursorLogin(cursorLogin(settings)),
    piLogin: describePiLogin(piAuthJson(settings), piApiKeys(settings)),
    opencodeLogin: describeOpenCodeLogin(opencodeAuthJson(settings)),
    fxLogin: describeFxLogin(fxLogin(settings)),
    kimiLogin: describeKimiLogin(kimiLogin(settings)),
    copilotLogin: describeCopilotLogin(copilotLogin(settings)),
    vibeLogin: describeVibeLogin(vibeLogin(settings)),
    grokLogin: describeGrokLogin(grokLogin(settings)),
    geminiLogin: describeGeminiLogin(geminiLogin(settings)),
    qwenLogin: describeQwenLogin(qwenOauthJson(settings), qwenApiKeys(settings)),
    connectors: {
      github: { clientId: connectors.github.clientId, clientSecretSet: connectors.github.clientSecret !== "" },
    },
    dockerModeAvailable,
    hostPlatform: process.platform,
    hostCaCerts: hostExtraCaCerts().map((c) => c.subject),
    hostGitIdentity: hostGitIdentity(),
    remote: remoteAccess(tunnels),
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

/**
 * Codex's `auth.json` (ADR-0046). No environment override: Codex rotates the tokens inside and
 * the refreshed file is written back here, which a fixed environment value could not follow.
 */
export function codexAuthJson(settings: Settings): string {
  return settings.providerSecrets.codex.CODEX_AUTH_JSON;
}

/** Rejects anything but the JSON object `codex login` writes; `""` forgets it. Returns it compacted. */
export function normalizeCodexAuthJson(text: string): string {
  if (text.trim() === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "The Codex login must be the JSON in ~/.codex/auth.json, as written by `codex login`.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "The Codex login must be the JSON object in ~/.codex/auth.json.");
  }
  const login = codexLogin(text);
  if (!login) throw new HttpError(400, "This auth.json holds neither a ChatGPT login nor an API key; run `codex login` and copy ~/.codex/auth.json again.");
  return JSON.stringify(parsed);
}

/**
 * What an `auth.json` says about its account: the ChatGPT id token is a JWT whose claims carry the
 * email and, under `https://api.openai.com/auth`, the plan; nothing is verified, this is only what
 * Settings shows. `null` for an empty or unusable string.
 */
export function codexLogin(authJson: string): CodexLogin | null {
  if (authJson.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    return null;
  }
  const file = CodexAuthFile.safeParse(parsed);
  if (!file.success) return null;
  const apiKey = typeof file.data.OPENAI_API_KEY === "string" && file.data.OPENAI_API_KEY !== "";
  const tokens = file.data.tokens;
  if (!tokens && !apiKey) return null;
  const claims = tokens ? jwtClaims(tokens.id_token) : null;
  const auth = claims?.["https://api.openai.com/auth"];
  const plan = typeof auth === "object" && auth !== null && "chatgpt_plan_type" in auth ? auth.chatgpt_plan_type : null;
  return {
    email: typeof claims?.email === "string" ? claims.email : null,
    plan: typeof plan === "string" ? plan : null,
    lastRefresh: file.data.last_refresh ?? null,
    apiKey,
  };
}

/** The parts of Codex's `auth.json` Sessionboxer looks at (the rest is passed through untouched). */
const CodexAuthFile = z.object({
  OPENAI_API_KEY: z.string().nullable().optional(),
  tokens: z.object({ id_token: z.string(), access_token: z.string(), refresh_token: z.string() }).nullable().optional(),
  last_refresh: z.string().nullable().optional(),
});

/**
 * Which of two `auth.json` is the newer one: Codex stamps `last_refresh` when it rotates the tokens.
 * `true` when `candidate` should replace `current` (a different file that is not older).
 */
export function codexAuthNewer(candidate: string, current: string): boolean {
  const a = codexLogin(candidate);
  if (!a) return false;
  if (JSON.stringify(JSON.parse(candidate)) === current) return false;
  const b = codexLogin(current);
  if (!b?.lastRefresh || !a.lastRefresh) return true;
  return Date.parse(a.lastRefresh) >= Date.parse(b.lastRefresh);
}

/**
 * The Cursor login (ADR-0054): a Cursor API key (`CURSOR_API_KEY` in this process's environment
 * overrides it) or the whole `auth.json` an `agent login` wrote. Like Codex's, an `auth.json` has
 * no environment override: the CLI rotates its tokens and the refreshed file is written back here.
 */
export function cursorLogin(settings: Settings): string {
  return process.env.CURSOR_API_KEY?.trim() || settings.providerSecrets.cursor.CURSOR_LOGIN;
}

/** The parts of Cursor's `auth.json` Sessionboxer looks at (the rest is passed through untouched). */
const CursorAuthFile = z.object({
  accessToken: z.string().nullable().optional(),
  refreshToken: z.string().nullable().optional(),
  apiKey: z.string().nullable().optional(),
});

/** Accepts an API key or the JSON object `agent login` writes; `""` forgets it. Returns JSON compacted. */
export function normalizeCursorLogin(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (!trimmed.startsWith("{")) {
    if (!/^[\w.-]+$/.test(trimmed)) throw new HttpError(400, "The Cursor login must be an API key (cursor.com → Dashboard → Integrations) or the JSON in Cursor's auth.json.");
    return trimmed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new HttpError(400, "The Cursor login must be the JSON in Cursor's auth.json, as written by `agent login`.");
  }
  const file = CursorAuthFile.safeParse(parsed);
  if (!file.success || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "The Cursor login must be the JSON object in Cursor's auth.json.");
  }
  if (!file.data.accessToken && !file.data.apiKey) {
    throw new HttpError(400, "This auth.json holds no Cursor login; run `agent login` and copy the file again.");
  }
  return JSON.stringify(parsed);
}

/** What the stored login is, for Settings; nothing is verified. `null` for an empty or unusable string. */
export function describeCursorLogin(login: string): CursorLogin | null {
  if (login.trim() === "") return null;
  if (!login.trimStart().startsWith("{")) return { kind: "api-key", expiresAt: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(login);
  } catch {
    return null;
  }
  const file = CursorAuthFile.safeParse(parsed);
  if (!file.success) return null;
  if (!file.data.accessToken) return file.data.apiKey ? { kind: "api-key", expiresAt: null } : null;
  const exp = jwtClaims(file.data.accessToken)?.exp;
  return { kind: "auth-json", expiresAt: typeof exp === "number" ? new Date(exp * 1000).toISOString() : null };
}

/**
 * Which of two Cursor `auth.json` is the newer one: the CLI issues a fresh access token when it
 * refreshes. `true` when `candidate` should replace `current` (a different file whose token is
 * not older); an API key in `current` is never replaced.
 */
export function cursorAuthNewer(candidate: string, current: string): boolean {
  const a = describeCursorLogin(candidate);
  if (a?.kind !== "auth-json") return false;
  if (JSON.stringify(JSON.parse(candidate)) === current) return false;
  const b = describeCursorLogin(current);
  if (b?.kind === "api-key") return false;
  if (!b?.expiresAt || !a.expiresAt) return true;
  return Date.parse(a.expiresAt) >= Date.parse(b.expiresAt);
}

/**
 * The OpenCode login (ADR-0076): the whole `auth.json` an `opencode auth login` wrote (one record per
 * model provider: an OAuth login, an API key or a well-known token), or an OpenCode Zen API key
 * normalised into such a file. No environment override: OpenCode rotates the OAuth tokens in the
 * file and the refreshed file is written back here.
 */
export function opencodeAuthJson(settings: Settings): string {
  return settings.providerSecrets.opencode.OPENCODE_AUTH_JSON;
}

/** One record of OpenCode's `auth.json`, the parts Sessionboxer looks at (the rest is passed through untouched). */
const OpenCodeAuthRecord = z.object({
  type: z.enum(["oauth", "api", "wellknown"]),
  key: z.string().optional(),
  token: z.string().optional(),
  access: z.string().optional(),
  refresh: z.string().optional(),
  expires: z.number().optional(),
});
const OpenCodeAuthFile = z.record(z.string(), OpenCodeAuthRecord);

const OPENCODE_AUTH_HELP = "run `opencode auth login` on your machine and paste ~/.local/share/opencode/auth.json, or an API key from opencode.ai/auth.";

/** Accepts an OpenCode Zen API key or the JSON object `opencode auth login` writes; `""` forgets it. Returns JSON compacted. */
export function normalizeOpenCodeAuthJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (!trimmed.startsWith("{")) {
    if (!/^[\w.-]+$/.test(trimmed)) throw new HttpError(400, `The OpenCode login must be an API key or the JSON in OpenCode's auth.json: ${OPENCODE_AUTH_HELP}`);
    return JSON.stringify({ opencode: { type: "api", key: trimmed } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new HttpError(400, `The OpenCode login must be the JSON in OpenCode's auth.json: ${OPENCODE_AUTH_HELP}`);
  }
  const file = OpenCodeAuthFile.safeParse(parsed);
  if (!file.success || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "The OpenCode login must be the JSON object in OpenCode's auth.json: a provider id to a record of type oauth, api or wellknown each.");
  }
  const entries = Object.entries(file.data);
  if (entries.length === 0) throw new HttpError(400, `This auth.json holds no login; ${OPENCODE_AUTH_HELP}`);
  for (const [id, record] of entries) {
    const complete =
      record.type === "oauth" ? record.access !== undefined && record.refresh !== undefined : record.type === "api" ? record.key !== undefined : record.key !== undefined && record.token !== undefined;
    if (!complete) throw new HttpError(400, `The ${record.type} record for ${id} in this auth.json is incomplete; ${OPENCODE_AUTH_HELP}`);
  }
  return JSON.stringify(parsed);
}

/** Which model providers the stored login covers, for Settings; nothing is verified. `null` for an empty or unusable string. */
export function describeOpenCodeLogin(login: string): OpenCodeLogin | null {
  if (login.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(login);
  } catch {
    return null;
  }
  const file = OpenCodeAuthFile.safeParse(parsed);
  if (!file.success) return null;
  const providers = Object.entries(file.data).map(([id, record]) => ({
    id,
    kind: record.type,
    expiresAt: record.type === "oauth" && typeof record.expires === "number" && record.expires > 0 ? new Date(record.expires).toISOString() : null,
  }));
  return providers.length === 0 ? null : { providers };
}

/** The latest OAuth expiry in a login, ms since the epoch; `null` when it holds no dated OAuth record. */
function opencodeLatestExpiry(login: OpenCodeLogin): number | null {
  const times = login.providers.flatMap((p) => (p.expiresAt ? [Date.parse(p.expiresAt)] : []));
  return times.length === 0 ? null : Math.max(...times);
}

/**
 * Which of two OpenCode `auth.json` is the newer one: OpenCode writes a later expiry when it
 * refreshes an OAuth login. `true` when `candidate` should replace `current` (a different, valid
 * file whose logins are not older).
 */
export function opencodeAuthNewer(candidate: string, current: string): boolean {
  const a = describeOpenCodeLogin(candidate);
  if (!a) return false;
  if (JSON.stringify(JSON.parse(candidate)) === current) return false;
  const b = describeOpenCodeLogin(current);
  if (!b) return true;
  const ea = opencodeLatestExpiry(a);
  const eb = opencodeLatestExpiry(b);
  if (ea === null || eb === null) return true;
  return ea >= eb;
}

/** The fx login (ADR-0077): an AI Gateway API key or the JSON of an `fx login` file; `AI_GATEWAY_API_KEY` in the environment overrides. */
export function fxLogin(settings: Settings): string {
  return process.env.AI_GATEWAY_API_KEY?.trim() || settings.providerSecrets.fx.FX_LOGIN;
}

/**
 * The parts of fx's login files Sessionboxer looks at (the rest is passed through untouched):
 * `fx login` writes an OAuth session (`token_type`, `expires_at`), `fx login codex` / `fx login grok`
 * write `{ version, access_token, refresh_token, expires_at_ms, account_id }`.
 */
const FxAuthFile = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  token_type: z.string().optional(),
  account_id: z.string().optional(),
  expires_at: z.union([z.number(), z.string()]).optional(),
  expires_at_ms: z.number().optional(),
});

/** Accepts an AI Gateway API key or the JSON object one of `fx login`'s files holds; `""` forgets it. Returns JSON compacted. */
export function normalizeFxLogin(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (!trimmed.startsWith("{")) {
    if (!/^[\w.-]+$/.test(trimmed)) {
      throw new HttpError(400, "The fx login must be an AI Gateway API key (vercel.com → AI Gateway → API keys) or the JSON in a login file of `fx login`.");
    }
    return trimmed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new HttpError(400, "The fx login must be the JSON in ~/.fx/auth.json (or chatgpt-auth.json, grok-auth.json), as written by `fx login`.");
  }
  const file = FxAuthFile.safeParse(parsed);
  if (!file.success || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "The fx login must be the JSON object in one of fx's login files.");
  }
  if (!file.data.access_token || !file.data.refresh_token) {
    throw new HttpError(400, "This file holds no fx login; run `fx login` (or `fx login codex`, `fx login grok`) and copy the file again.");
  }
  return JSON.stringify(parsed);
}

/** What the stored fx login is, for Settings; nothing is verified. `null` for an empty or unusable string. */
export function describeFxLogin(login: string): FxLogin | null {
  if (login.trim() === "") return null;
  if (!login.trimStart().startsWith("{")) return { kind: "api-key", expiresAt: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(login);
  } catch {
    return null;
  }
  const file = FxAuthFile.safeParse(parsed);
  if (!file.success || !file.data.access_token) return null;
  const expiresMs =
    file.data.expires_at_ms ??
    (typeof file.data.expires_at === "number" ? (file.data.expires_at > 1e12 ? file.data.expires_at : file.data.expires_at * 1000) : Date.parse(file.data.expires_at ?? ""));
  const expiresAt = Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : null;
  if (file.data.token_type !== undefined || file.data.account_id === undefined) return { kind: "vercel", expiresAt };
  const iss = jwtClaims(file.data.access_token)?.iss;
  return { kind: typeof iss === "string" && /openai\.com/i.test(iss) ? "codex" : "grok", expiresAt };
}

/**
 * Which of two fx login files is the newer one: fx rewrites the file with a later expiry when it
 * refreshes the tokens. `true` when `candidate` should replace `current` (a login file of the same
 * kind whose token is not older); an API key in `current` is never replaced.
 */
export function fxAuthNewer(candidate: string, current: string): boolean {
  const a = describeFxLogin(candidate);
  if (!a || a.kind === "api-key") return false;
  let compact: string;
  try {
    compact = JSON.stringify(JSON.parse(candidate));
  } catch {
    return false;
  }
  if (compact === current) return false;
  const b = describeFxLogin(current);
  if (b?.kind === "api-key" || (b && b.kind !== a.kind)) return false;
  if (!b?.expiresAt || !a.expiresAt) return true;
  return Date.parse(a.expiresAt) >= Date.parse(b.expiresAt);
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

/** The Provider has a credential to run with (`providerSetupHint` says what is missing otherwise). */
export function providerReady(provider: Provider, settings: Settings): boolean {
  switch (provider) {
    case "claude-code":
      return claudeToken(settings) !== "" || claudeAuthToken(settings) !== "" || claudeApiKey(settings) !== "";
    case "devin":
      return devinToken(settings) !== "";
    case "codex":
      return codexAuthJson(settings) !== "";
    case "cursor":
      return cursorLogin(settings) !== "";
    case "pi":
      return piAuthJson(settings) !== "" || piApiKeys(settings) !== "";
    case "opencode":
      return opencodeAuthJson(settings) !== "";
    case "fx":
      return fxLogin(settings) !== "";
    case "kimi":
      return kimiLogin(settings) !== "";
    case "copilot":
      return copilotLogin(settings) !== "";
    case "vibe":
      return vibeLogin(settings) !== "";
    case "grok":
      return grokLogin(settings) !== "";
    case "gemini":
      return geminiLogin(settings) !== "";
    case "qwen":
      return qwenOauthJson(settings) !== "" || qwenApiKeys(settings) !== "";
  }
}

/**
 * Env injected into a Sandbox for the Session's Provider; other Providers' secrets stay on the host.
 * Only set values: Claude's OAuth token can be left out when a proxy credential stands in for it,
 * and `ANTHROPIC_BASE_URL` is only given when it differs from Anthropic's (the Daemon forwards
 * the Agent there, directly or through its inspector). Gemini CLI's login travels over the Daemon
 * RPC (ADR-0087); only a `GOOGLE_GEMINI_BASE_URL` set on the Control Plane (a proxy, or a mock in
 * tests) is forwarded, for its API-key path.
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
    case "codex":
    case "cursor":
    case "pi":
    case "opencode":
    case "fx":
    case "kimi":
    case "copilot":
    case "vibe":
    case "grok":
    case "qwen":
      return {};
    case "gemini":
      return process.env.GOOGLE_GEMINI_BASE_URL?.trim() ? { GOOGLE_GEMINI_BASE_URL: rewriteHostUrl(process.env.GOOGLE_GEMINI_BASE_URL.trim()) } : {};
  }
}

export { providerSetupHint } from "./provider-setup-hint.js";

// ---------------------------------------------------------------------------
// MCP registry
// ---------------------------------------------------------------------------

/** Secret values leave as `null` (set) or `""` (empty); the UI sends `null` back to keep them. */
export function toPublicMcpServer(def: McpServerDef): PublicMcpServerDef {
  const tokenHeader = def.connector ? CONNECTORS[def.connector.kind].tokenHeader : null;
  const hide = (kv: McpKeyValue, secret = kv.secret): PublicMcpKeyValue => ({ ...kv, secret, value: secret && kv.value !== "" ? null : kv.value });
  return {
    ...def,
    env: def.env.map((kv) => hide(kv)),
    headers: def.headers.map((kv) => hide(kv, kv.secret || kv.name === tokenHeader)),
  };
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
    const credentialOnly = pub.connector !== null && !connectorHasMcp(pub.connector.kind);
    if (pub.transport !== "stdio" && !credentialOnly && !/^https?:\/\//.test(pub.url.trim())) {
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
  const kept = prev?.kind === incoming.kind ? prev : { kind: incoming.kind, account: null, connectedAt: null, expiresAt: null, host: null };
  const hasToken = headers.some((h) => h.name === CONNECTORS[incoming.kind].tokenHeader && h.value !== "");
  return hasToken ? kept : { ...kept, account: null, connectedAt: null, expiresAt: null, host: null };
}

/** Full definitions (secrets included) of the enabled ids, as the Daemon needs them; unknown ids are dropped. */
export function resolveMcpServers(settings: Settings, enabledIds: string[]): McpServerSpec[] {
  const enabled = new Set(enabledIds);
  return settings.mcpServers
    .filter((s) => enabled.has(s.id) && (!s.connector || connectorHasMcp(s.connector.kind)))
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
    if (token === "") continue;
    const host = s.connector.kind === "github" ? "github.com" : s.connector.host;
    if (host) out.push({ kind: s.connector.kind, host, account: s.connector.account, token });
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

/**
 * `enabled` plus the GitHub entry logged in as each of `accounts` (a repository bound to an
 * account needs its token in the Sandbox); throws for a login no entry has.
 */
export function withGitHubAccounts(settings: Settings, enabled: string[], accounts: string[]): string[] {
  const out = [...enabled];
  for (const account of new Set(accounts)) {
    const entries = settings.mcpServers.filter((s) => s.connector?.kind === "github" && s.connector.account === account);
    if (entries.length === 0) throw new Error(`No GitHub entry is logged in as @${account} (Settings → MCP servers).`);
    if (!entries.some((e) => out.includes(e.id))) out.push(entries[0]!.id);
  }
  return out;
}

/** Keeps only ids that still exist in the registry. */
export function knownMcpIds(settings: Settings, ids: string[]): string[] {
  const known = new Set(settings.mcpServers.map((s) => s.id));
  return ids.filter((id) => known.has(id));
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
