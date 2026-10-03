#!/usr/bin/env node
import { ACP_COMMANDS } from "./provider-commands.js";
import { KimiAuth, KIMI_AGENT_ENV } from "./kimi-auth.js";
import { GrokLogin, GROK_AGENT_ENV } from "./grok-login.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  AgentDocsArgs,
  GUIDE_PATH,
  CodeOpenParams,
  CodeStartParams,
  CodeThemeParams,
  DAEMON_METHODS,
  DAEMON_PORT,
  LLM_INSPECTOR_PORT,
  PROVIDER_ENV_KEYS,
  DaemonLlmCallBodyParams,
  type DaemonLlmCallBodyResult,
  type DaemonLlmCallsResult,
  DaemonLlmInspectSetParams,
  type DaemonLlmInspectSetResult,
  DaemonAskParams,
  DaemonClaudeModelsSetParams,
  DaemonCodexAuthParams,
  DaemonCursorAuthParams,
  DaemonPiAuthParams,
  DaemonOpenCodeAuthParams,
  DaemonFxAuthParams,
  DaemonKimiAuthParams,
  DaemonCopilotAuthParams,
  DaemonQwenAuthParams,
  DaemonVibeAuthParams,
  DaemonGrokAuthParams,
  DaemonGeminiAuthParams,
  DaemonCompactionDetailsParams,
  type DaemonCompactionDetailsResult,
  DaemonGhApiParams,
  DaemonHelloParams,
  DaemonMcpSetParams,
  type McpServerSpec,
  DaemonMcpAppsCallToolParams,
  DaemonMcpAppsReadResourceParams,
  DaemonMcpAppsResourceParams,
  DaemonMcpAppsToolResultParams,
  DaemonMcpAppsToolsParams,
  DaemonModelSetParams,
  DaemonOptionSetParams,
  DaemonPromptParams,
  DaemonRecordingPrefsSetParams,
  type DaemonRecordingPrefsSetResult,
  DaemonReposInspectParams,
  DaemonReposRemoveParams,
  DaemonReposSeedParams,
  SESSION_INFO_PATH,
  UTILITIES_MANIFEST_PATH,
  DaemonUtilitiesSetParams,
  SessionInfo,
  DaemonReposSetParams,
  FsManifestParams,
  FsWatchParams,
  DaemonSessionForkParams,
  type DaemonSessionForkResult,
  DaemonSessionSwitchParams,
  type DaemonSessionSwitchResult,
  Provider,
  PtyIdParams,
  PtyInputParams,
  PtyOpenParams,
  PtyReadParams,
  PtyResizeParams,
  claudeRejectedReset,
  claudeUsageWindows,
  classifyUsageLimit,
  codexStatusWindows,
  instructionsDelivery,
  isJsonRpcRequest,
  mergeUsageWindows,
  isJsonRpcResponse,
  parseJsonRpc,
  MACOS_GUEST_USER,
  MACOS_GUEST_WORKSPACE,
  WINDOWS_GUEST_USER,
  WINDOWS_GUEST_WORKSPACE,
  type DaemonEvent,
  type DaemonStatus,
  type JsonRpcId,
  type UsageWindow,
} from "@sessionboxer/protocol";
import { AgentManager } from "./agent.js";
import { ClaudeSettings } from "./claude-settings.js";
import { CodeServer } from "./code-server.js";
import { AuthFile } from "./auth-file.js";
import { fxLoginKind, type FxLoginKind } from "./provider-files.js";
import { registerCursorExtensions } from "./cursor-ext.js";
import { readCompactionDetails } from "./compactions.js";
import { ControlPlaneBridge } from "./control-plane-bridge.js";
import { DaemonError, jsonRpcError } from "./daemon-error.js";
import { Docs } from "./docs.js";
import { GhApi } from "./gh-api.js";
import { BbCredentials } from "./bb-credentials.js";
import { GhCredentials } from "./gh-credentials.js";
import { LlmInspector } from "./llm-inspector.js";
import { CopilotMcpConfig, DevinMcpConfig, PiMcpConfig, onPath, type BuiltinMcp, type McpTee } from "./mcp-config.js";
import { COPILOT_AGENT_ENV, CopilotLogin } from "./copilot.js";
import { VIBE_AGENT_ENV, VibeLogin } from "./vibe.js";
import { GEMINI_AGENT_ENV, GeminiLogin } from "./gemini.js";
import { guestProviderFiles } from "./guest-provider-files.js";
import { McpTeeHub } from "./mcp-mirror.js";
import { FsWatches } from "./fs-watch.js";
import { serveRawFile } from "./raw-files.js";
import { Repos } from "./repos.js";
import { SessionInfoFile } from "./session-info.js";
import { UtilitiesFiles } from "./utilities.js";
import { Uploads } from "./uploads.js";
import { Terminals } from "./terminals.js";
import { ToolTelemetry } from "./tool-telemetry.js";
import { handleToolTelemetry } from "./telemetry-http.js";
import {
  BRIDGE_SERVICE_DESKTOP,
  BRIDGE_SERVICE_SESSIONBOXER,
  GuestAgentTransport,
  GuestRepoHost,
  MacGuest,
  registerBridgeServices,
  sandboxAddress,
  WindowsGuest,
  type Guest,
} from "./guest.js";
import { windowsBriefing, macosBriefing } from "./vm-briefings.js";
import { WorkspaceFs } from "./workspace-fs.js";
import { serveTar, workspaceDir, workspaceManifest } from "./workspace-sync.js";

const EVENT_BUFFER_MAX = 5000;

const env = process.env;
const port = Number(env.SESSIONBOXER_DAEMON_PORT ?? DAEMON_PORT);
const home = env.HOME ?? "/home/agent";
const workspace = env.SESSIONBOXER_WORKSPACE ?? "/workspace";
const log = (msg: string): void => {
  process.stderr.write(`[daemon ${new Date().toISOString()}] ${msg}\n`);
};

const epoch = randomUUID();
let seq = 0;
const buffer: DaemonEvent[] = [];
const clients = new Set<WebSocket>();

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function notify(method: string, params: object): void {
  for (const ws of clients) send(ws, { jsonrpc: "2.0", method, params });
}

function emit(body: DaemonEvent["body"]): void {
  const event: DaemonEvent = { epoch, seq: ++seq, ts: new Date().toISOString(), body };
  buffer.push(event);
  if (buffer.length > EVENT_BUFFER_MAX) buffer.splice(0, buffer.length - EVENT_BUFFER_MAX);
  for (const ws of clients) send(ws, { jsonrpc: "2.0", method: DAEMON_METHODS.event, params: event });
}


const provider = Provider.catch("claude-code").parse(env.SESSIONBOXER_PROVIDER);
const [acpCommand = "claude-agent-acp", ...acpArgs] =
  env.SESSIONBOXER_ACP_COMMAND?.split(" ") ?? ACP_COMMANDS[provider];
const mcpCommand = env.SESSIONBOXER_MCP_COMMAND ?? "sessionboxer-computer-use-mcp";
const agentMcpCommand = env.SESSIONBOXER_AGENT_MCP_COMMAND ?? "sessionboxer-mcp";
/** Whether the `sessionboxer` MCP goes to the Agent; the Control Plane says with each `mcp/set` (the `off` policy, ADR-0062). */
let sessionboxerTools = true;
/** The image's own MCP servers, as they run on this side (`BuiltinMcp`). */
const builtinMcps = (): BuiltinMcp[] => [
  { name: BRIDGE_SERVICE_DESKTOP, command: mcpCommand },
  ...(sessionboxerTools ? [{ name: BRIDGE_SERVICE_SESSIONBOXER, command: agentMcpCommand }] : []),
];
const tmpfsDir = env.SESSIONBOXER_TMPFS ?? "/dev/shm/sessionboxer";
/**
 * A `qemu-windows` (ADR-0057, ADR-0060) or `qemu-macos` (ADR-0059, ADR-0061) Session: the Agent, its
 * MCP servers, the repositories and the Terminal run inside the VM next to this Sandbox, reached over
 * SSH; this side keeps the desktop (RDP/VNC view, screenshots, input), the Control Plane connection
 * and a mirror of the Workspace. The macOS base authorizes an SSH key the Control Plane hands over
 * (`SESSIONBOXER_MACOS_SSH_KEY`); it is written to tmpfs and taken out of the environment here.
 */
const guest: Guest | null =
  (env.SESSIONBOXER_WINDOWS_HOST ?? "") !== ""
    ? new WindowsGuest({
        host: env.SESSIONBOXER_WINDOWS_HOST!,
        sshPort: Number(env.SESSIONBOXER_WINDOWS_SSH_PORT ?? 22),
        user: env.SESSIONBOXER_WINDOWS_USER ?? WINDOWS_GUEST_USER,
        password: env.SESSIONBOXER_WINDOWS_PASSWORD ?? "",
        workspace: WINDOWS_GUEST_WORKSPACE,
        localWorkspace: workspace,
        spoolDir: `${tmpfsDir}/guest`,
        log,
      })
    : (env.SESSIONBOXER_MACOS_HOST ?? "") !== ""
      ? new MacGuest({
          host: env.SESSIONBOXER_MACOS_HOST!,
          sshPort: Number(env.SESSIONBOXER_MACOS_SSH_PORT ?? 22),
          user: env.SESSIONBOXER_MACOS_USER ?? MACOS_GUEST_USER,
          password: env.SESSIONBOXER_MACOS_PASSWORD ?? "",
          identityFile: guestIdentityFile(env.SESSIONBOXER_MACOS_SSH_KEY ?? "", `${tmpfsDir}/guest`),
          workspace: MACOS_GUEST_WORKSPACE,
          localWorkspace: workspace,
          spoolDir: `${tmpfsDir}/guest`,
          log,
        })
      : null;
delete env.SESSIONBOXER_MACOS_SSH_KEY;

/** Writes the guest's private key (PEM text) to a mode-600 file on tmpfs for `ssh -i`; `undefined` when there is none (password login then). */
function guestIdentityFile(key: string, dir: string): string | undefined {
  if (key.trim() === "") return undefined;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${dir}/id_ed25519`;
  writeFileSync(file, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
  return file;
}
/** Where the Agent's working directory is: in the VM for a Windows or macOS Session. */
const agentWorkspace = guest ? guest.workspace : workspace;

/** Mistral Vibe's login (ADR-0085): `~/.vibe/.env` on tmpfs behind that path, see `vibe.ts`. */
const vibeHome = `${home}/.vibe`;
const vibeLogin = provider === "vibe" ? new VibeLogin(vibeHome, tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.vibeAuthChanged, { authJson }), agentWorkspace) : null;
/**
 * The user's MCP servers are reached through the tee (ADR-0079), which mirrors the exchange to this
 * Daemon for MCP Apps. In a Windows/macOS VM the Agent starts the servers itself, as before.
 */
const mcpTee: McpTee | undefined = guest ? undefined : { command: env.SESSIONBOXER_MCP_TEE ?? "sessionboxer-mcp-tee", port };
/** Devin reads MCP servers from its config file; kept on tmpfs so Snapshots never carry MCP secrets. */
const devinMcpConfig =
  provider === "devin"
    ? new DevinMcpConfig(
        `${home}/.config/devin/mcp_config.json`,
        tmpfsDir,
        () => (guest ? builtinMcps().map((b) => ({ name: b.name, ...guest.bridgeMcp(b.name) })) : builtinMcps()),
        mcpTee,
      )
    : null;
/**
 * pi reads its MCP servers from `~/.pi/agent/mcp.json` (its ACP adapter does not pass the ACP ones on);
 * kept on tmpfs like Devin's (ADR-0075).
 */
const piAgentDir = env.PI_CODING_AGENT_DIR ?? `${home}/.pi/agent`;
const piMcpConfig =
  provider === "pi"
    ? new PiMcpConfig(
        `${piAgentDir}/mcp.json`,
        tmpfsDir,
        () => (guest ? builtinMcps().map((b) => ({ name: b.name, ...guest.bridgeMcp(b.name) })) : builtinMcps()),
        log,
        mcpTee,
      )
    : null;
/**
 * Copilot refuses stdio MCP servers from the ACP client ("Rejecting non-http/sse MCP server") and reads
 * its own `~/.copilot/mcp-config.json` instead (ADR-0082); kept on tmpfs like Devin's and pi's.
 */
const copilotHome = env.COPILOT_HOME ?? `${home}/.copilot`;
const copilotMcpConfig =
  provider === "copilot"
    ? new CopilotMcpConfig(
        `${copilotHome}/mcp-config.json`,
        tmpfsDir,
        () => (guest ? builtinMcps().map((b) => ({ name: b.name, ...guest.bridgeMcp(b.name) })) : builtinMcps()),
        log,
        mcpTee,
      )
    : null;
/** `gh`/git logins for the Sandbox; the image points `GH_CONFIG_DIR` at this tmpfs dir. */
const ghCredentials = new GhCredentials(env.GH_CONFIG_DIR ?? `${tmpfsDir}/gh`, log);
/** `bb`/git logins for Bitbucket hosts; the image points `BB_CONFIG_DIR` at this tmpfs dir. */
const bbCredentials = new BbCredentials(env.BB_CONFIG_DIR ?? `${tmpfsDir}/bb`, log);
/** Claude's model allowlist lives in its settings file; the Control Plane sends the list before the Agent starts. */
const claudeSettings = provider === "claude-code" ? new ClaudeSettings(`${home}/.claude/settings.json`, log) : null;
const kimiAuth = provider === "kimi" ? new KimiAuth(home, tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.kimiAuthChanged, { authJson })) : null;
/** Codex's ChatGPT login: `~/.codex/auth.json` on tmpfs, refreshed tokens reported back (ADR-0046). */
const codexHome = env.CODEX_HOME ?? `${home}/.codex`;
const codexAuth =
  provider === "codex"
    ? new AuthFile("codex", `${codexHome}/auth.json`, tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.codexAuthChanged, { authJson }))
    : null;
/** The Sandbox is the isolation: Codex runs without approvals or its own sandbox, like the other Providers. */
const CODEX_AGENT_ENV = { CODEX_HOME: codexHome, INITIAL_AGENT_MODE: "agent-full-access" };
/**
 * Cursor's login (ADR-0054): the `auth.json` its CLI writes with `agent login`, on tmpfs at the
 * path Cursor reads it from, or an API key handed over in the process environment. Cursor reads
 * the file once at start, so the Agent restarts in place when the login arrives or changes.
 */
const cursorAuthPath = `${env.XDG_CONFIG_HOME ?? `${home}/.config`}/cursor/auth.json`;
const cursorAuth =
  provider === "cursor"
    ? new AuthFile("cursor", cursorAuthPath, tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.cursorAuthChanged, { authJson }))
    : null;
/**
 * pi's login (ADR-0075): the `auth.json` its `/login` writes, on tmpfs at the path pi reads it from
 * (OAuth refreshes are written back through the symlink and reported), and/or API keys handed to the
 * Agent process as environment (`ANTHROPIC_API_KEY`, ...). pi reads both at start, so the Agent
 * restarts in place when the login arrives or changes.
 */
const piAuth =
  provider === "pi"
    ? new AuthFile("pi", `${piAgentDir}/auth.json`, tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.piAuthChanged, { authJson }))
    : null;
/** No version check against pi.dev and no install telemetry from the box; its agent dir is the image's. */
const PI_AGENT_ENV = { PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
/**
 * OpenCode's login (ADR-0076): the `auth.json` its CLI writes with `opencode auth login` (OAuth
 * logins and API keys of its model providers), on tmpfs at the path OpenCode reads it from; the
 * rest of `~/.local/share/opencode` (sessions, storage) stays on disk for `session/load`. OpenCode
 * lists its providers when its server starts, so the Agent restarts in place when the login arrives
 * or goes; refreshed OAuth tokens it writes into the file are reported back.
 */
const opencodeAuthPath = `${env.XDG_DATA_HOME ?? `${home}/.local/share`}/opencode/auth.json`;
const opencodeAuth =
  provider === "opencode"
    ? new AuthFile("opencode", opencodeAuthPath, tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.opencodeAuthChanged, { authJson }))
    : null;
/** The image pins OpenCode; no update check at start (also `autoupdate: false` in its config, for the guests). */
const OPENCODE_AGENT_ENV = { OPENCODE_DISABLE_AUTOUPDATE: "1" };

/**
 * fx's login (ADR-0077): the file an `fx login` wrote, on tmpfs behind the path fx reads it from —
 * `~/.fx/auth.json` (Vercel account), `~/.fx/chatgpt-auth.json` (ChatGPT) or `~/.fx/grok-auth.json`
 * (Grok), one of the three by the file's shape — or an AI Gateway API key handed over in the process
 * environment as `AI_GATEWAY_API_KEY`. fx refreshes the tokens of a login file in place and the
 * rewritten file is reported back. The rest of `~/.fx` (settings, saved sessions) stays on disk so
 * `session/load` finds the conversation after Stop/Resume.
 */
const fxHome = `${home}/.fx`;
const fxAuthPaths: Record<FxLoginKind, string> = { vercel: `${fxHome}/auth.json`, codex: `${fxHome}/chatgpt-auth.json`, grok: `${fxHome}/grok-auth.json` } as const;
const fxAuth: Record<FxLoginKind, AuthFile> | null =
  provider === "fx"
    ? Object.fromEntries(
        (Object.keys(fxAuthPaths) as FxLoginKind[]).map((kind) => [
          kind,
          new AuthFile(`fx-${kind}`, fxAuthPaths[kind], tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.fxAuthChanged, { authJson }), true),
        ]),
      ) as Record<FxLoginKind, AuthFile>
    : null;
/**
 * The Sandbox is the isolation: fx runs in its `full-access` permission mode (ADR-0077; the Daemon
 * still answers any permission request it sends). Auto-upgrade is off: the image pins the version.
 */
/**
 * Qwen Code's login (ADR-0083): `oauth_creds.json` on tmpfs behind the path it reads (a refresh rewrites it and is
 * reported back) and/or an OpenAI-compatible endpoint in the Agent's environment; the rest of `~/.qwen` stays on disk for `session/load`.
 */
const qwenHome = env.QWEN_HOME ?? `${home}/.qwen`;
const qwenAuthPath = `${qwenHome}/oauth_creds.json`;
const qwenAuth =
  provider === "qwen"
    ? new AuthFile("qwen", qwenAuthPath, tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.qwenAuthChanged, { authJson }))
    : null;
/** Where Qwen Code sends OpenAI-compatible requests when the stored keys name no `OPENAI_BASE_URL` (it refuses to start without one). */
const QWEN_DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

const FX_AGENT_ENV = { FX_PERMISSION_MODE: "full-access", FX_AUTO_UPGRADE: "0", FX_NO_OPEN_BROWSER: "1" };

/** Copilot's login (ADR-0082): the token into the Agent's environment, a pasted `config.json` on tmpfs as well. */
const copilotLogin = provider === "copilot" ? new CopilotLogin(copilotHome, tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.copilotAuthChanged, { authJson })) : null;

const grokHome = env.GROK_HOME ?? `${home}/.grok`;
const grokLogin = provider === "grok" ? new GrokLogin(grokHome, tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.grokAuthChanged, { authJson })) : null;

const geminiLogin = provider === "gemini" ? new GeminiLogin(`${home}/.gemini`, tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.geminiAuthChanged, { authJson })) : null;

const guestProviderFilesList = guestProviderFiles(provider, guest, home, { codexHome, cursorAuthPath, piAgentDir, fxAuthPaths, qwenHome, qwenAuthPath, vibeHome, grokHome, opencodeAuthPath, copilotHome });
/** The Provider's environment the Control Plane set on this Sandbox, for the Agent in the VM. */
const guestProviderEnv: Record<string, string> = Object.fromEntries(
  PROVIDER_ENV_KEYS[provider].flatMap((k) => (env[k] !== undefined && env[k] !== "" ? [[k, env[k]]] : [])),
);
const transport = guest
  ? new GuestAgentTransport({ guest, env: guestProviderEnv, files: guestProviderFilesList, builtinMcps, log })
  : null;
// Both services stay registered whatever the policy: only the Agent's MCP list changes.
if (guest) registerBridgeServices(guest, [{ name: BRIDGE_SERVICE_DESKTOP, command: mcpCommand }, { name: BRIDGE_SERVICE_SESSIONBOXER, command: agentMcpCommand }], log);

function setCursorLogin(login: string): boolean {
  if (!cursorAuth) throw new DaemonError("invalid_params", "this Sandbox does not run Cursor");
  if (login.trimStart().startsWith("{")) {
    cursorAuth.set(login);
    return agent.setAgentEnv({ SESSIONBOXER_CURSOR_LOGIN: "auth-json" });
  }
  cursorAuth.set("");
  if (login === "") return agent.setAgentEnv({});
  log("cursor login is an API key; handed to the Agent process as CURSOR_API_KEY");
  return agent.setAgentEnv({ CURSOR_API_KEY: login });
}

function setPiLogin(authJson: string, apiKeys: Record<string, string>): boolean {
  if (!piAuth) throw new DaemonError("invalid_params", "this Sandbox does not run pi");
  piAuth.set(authJson);
  const names = Object.keys(apiKeys);
  if (names.length > 0) log(`pi API keys handed to the Agent process as ${names.join(", ")}`);
  // The marker makes the arrival or removal of the file a change of the Agent's environment, so it restarts (as for Cursor).
  return agent.setAgentEnv({ ...apiKeys, ...(authJson === "" ? {} : { SESSIONBOXER_PI_LOGIN: "auth-json" }) });
}

/** Puts the OpenCode `auth.json` on tmpfs (or removes it) and restarts the Agent so its server sees the providers. */
function setOpenCodeLogin(authJson: string): boolean {
  if (!opencodeAuth) throw new DaemonError("invalid_params", "this Sandbox does not run OpenCode");
  opencodeAuth.set(authJson);
  return agent.setAgentEnv(authJson === "" ? {} : { SESSIONBOXER_OPENCODE_LOGIN: "auth-json" });
}

/**
 * Puts a Qwen Code login in place: the OAuth file on tmpfs and/or the endpoint variables in the Agent's
 * environment. Qwen Code picks its auth type from that environment — `QWEN_OAUTH` for the login file,
 * the three `OPENAI_*` for an endpoint — and the login file wins when both are there.
 */
function setQwenLogin(authJson: string, apiKeys: Record<string, string>): boolean {
  if (!qwenAuth) throw new DaemonError("invalid_params", "this Sandbox does not run Qwen Code");
  qwenAuth.set(authJson);
  const names = Object.keys(apiKeys);
  if (names.length > 0) log(`Qwen Code endpoint handed to the Agent process as ${names.join(", ")}`);
  const endpoint = names.length > 0 ? { OPENAI_BASE_URL: QWEN_DEFAULT_OPENAI_BASE_URL, ...apiKeys } : {};
  return agent.setAgentEnv({ ...endpoint, ...(authJson === "" ? {} : { QWEN_OAUTH: "1" }) });
}

/** Puts an fx login in place: one login file on tmpfs (the other two removed) or the API key in the Agent's environment (on top of `FX_AGENT_ENV`). */
function setFxLogin(login: string): boolean {
  if (!fxAuth) throw new DaemonError("invalid_params", "this Sandbox does not run fx");
  const kind = login.trimStart().startsWith("{") ? fxLoginKind(login) : null;
  for (const k of Object.keys(fxAuth) as FxLoginKind[]) fxAuth[k].set(k === kind ? login : "");
  if (kind === "codex" || kind === "grok") {
    // `fx login codex`/`grok` also record the choice in settings.json; a pasted file needs it said per process.
    return agent.setAgentEnv({ FX_PROVIDER: kind });
  }
  // A Vercel login leaves the provider to fx: the AI Gateway by default, or a custom model connection in ~/.fx/settings.json.
  if (kind === "vercel") return agent.setAgentEnv({});
  if (login === "") return agent.setAgentEnv({});
  log("fx login is an API key; handed to the Agent process as AI_GATEWAY_API_KEY");
  return agent.setAgentEnv({ AI_GATEWAY_API_KEY: login });
}

/** The Session's standing instructions, set by the Control Plane on the container. */
const instructions = env.SESSIONBOXER_INSTRUCTIONS ?? "";

/**
 * Claude Code's model API calls can go through a loopback proxy that keeps the exact bodies
 * (ADR-0032). Its upstream is the `ANTHROPIC_BASE_URL` the Sandbox was given (a company proxy) or
 * Anthropic; the Daemon's own environment keeps that value, only the Agent process sees the loopback.
 */
const llmUpstream = env.ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_DEFAULT_BASE_URL;

/**
 * The Provider's usage meters (ADR-0053): Anthropic's `anthropic-ratelimit-unified-*` response
 * headers seen by the inspector, Codex's `/status` after each turn. Devin reports none.
 */
let usage: DaemonStatus["usage"] = null;
/** Anthropic's last refusal for lack of credit, to mark the Agent error that follows it. */
let lastRejected: { resetsAt: string | null; at: number } | null = null;
const REJECTED_TO_ERROR_MS = 60_000;

function reportUsage(windows: UsageWindow[]): void {
  if (windows.length === 0) return;
  usage = { windows: mergeUsageWindows(usage?.windows ?? [], windows), updatedAt: new Date().toISOString() };
  broadcastStatus();
}

/** The Agent's error as the event carries it, marked when it is the Provider refusing for lack of credit. */
function agentError(message: string): Extract<DaemonEvent["body"], { type: "agent_error" }> {
  const hit = classifyUsageLimit(provider, message);
  const rejected = agent.turnActive && lastRejected && Date.now() - lastRejected.at < REJECTED_TO_ERROR_MS ? lastRejected : null;
  if (!hit && !rejected) return { type: "agent_error", message };
  lastRejected = null;
  return { type: "agent_error", message, limit: { resetsAt: rejected?.resetsAt ?? hit?.resetsAt ?? null } };
}

/** Where the Agent reaches the inspector: loopback here, this Sandbox's Session-network address from the VM. */
const llmInspectorHost = guest ? sandboxAddress() : "127.0.0.1";
const llmInspector =
  provider === "claude-code"
    ? new LlmInspector({
        port: LLM_INSPECTOR_PORT,
        ...(guest ? { host: "0.0.0.0" } : {}),
        upstream: llmUpstream,
        dir: `${tmpfsDir}/llm`,
        log,
        onCall: (call) => emit({ type: "llm_call", call }),
        onResponse: (status, headers) => {
          reportUsage(claudeUsageWindows(headers));
          const rejected = claudeRejectedReset(status, headers);
          if (rejected) {
            lastRejected = { ...rejected, at: Date.now() };
            log(`Anthropic refused a call for lack of usage credit (resets ${rejected.resetsAt ?? "unknown"})`);
          }
        },
      })
    : null;
/**
 * Claude Code takes any `ANTHROPIC_BASE_URL` other than Anthropic's own for a third-party backend
 * and then caps the 1M-native models (Fable, Opus 5) at a 200k window: wrong size on the gauge and
 * compaction at a fifth of the real window. When the loopback only forwards to Anthropic, this
 * flag tells it so.
 */
const LLM_INSPECTOR_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: `http://${llmInspectorHost}:${LLM_INSPECTOR_PORT}`,
  ...(isAnthropicApi(llmUpstream) ? { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" } : {}),
};

function isAnthropicApi(url: string): boolean {
  try {
    return new URL(url).host === new URL(ANTHROPIC_DEFAULT_BASE_URL).host;
  } catch {
    return false;
  }
}
let llmInspectRequested = env.SESSIONBOXER_INSPECT_LLM === "1" && llmInspector !== null;

/**
 * Points the Agent process at the inspector (or back at the upstream); the Agent restarts in place
 * when idle, after the turn otherwise. Turning it off keeps the inspector and the recorded bodies.
 */
async function setLlmInspect(enabled: boolean): Promise<DaemonLlmInspectSetResult> {
  if (!llmInspector) return { applied: true, supported: false };
  llmInspectRequested = enabled;
  if (enabled && !llmInspector.listening) await llmInspector.start();
  return { applied: agent.setAgentEnv(enabled ? LLM_INSPECTOR_ENV : {}), supported: true };
}

const repos = guest ? new Repos(workspace, log, new GuestRepoHost(guest)) : new Repos(workspace, log);
const sessionInfo = new SessionInfoFile(
  workspace,
  log,
  guest
    ? {
        path: guest.guestPath(SESSION_INFO_PATH),
        write: async (content) => {
          await guest.waitReady();
          await guest.writeFile(guest.guestPath(SESSION_INFO_PATH), content);
        },
      }
    : undefined,
);

/** The Session's Utilities (ADR-0073): credentials on tmpfs, the manifest in the Workspace, procedures as skills. */
const utilities = new UtilitiesFiles(
  workspace,
  `${home}/.claude/skills`,
  tmpfsDir,
  log,
  (names) => emit({ type: "utilities_changed", utilities: names }),
  guest
    ? {
        manifestPath: guest.guestPath(UTILITIES_MANIFEST_PATH),
        skillsDir: `${guest.homeDir()}/.claude/skills`,
        write: async (path, content) => {
          await guest.waitReady();
          await guest.writeFile(path, content);
        },
        remove: async (path) => {
          await guest.waitReady();
          await guest.run(guest.rmDirScript(path));
        },
      }
    : undefined,
);

const toolTelemetry = new ToolTelemetry();
let activeTurnId: string | undefined;
/** The Session's user MCP servers as last set, which the tees ask for when they start. */
let mcpServers: McpServerSpec[] = [];
const mcpTeeHub = new McpTeeHub(() => mcpServers, {
  emit,
  exact: (toolCallId, info) => toolTelemetry.attachExact(toolCallId, info),
  log,
});

const agent = new AgentManager(
  {
    command: acpCommand,
    legacyModels: provider === "kimi" || provider === "gemini",
    args: acpArgs,
    cwd: agentWorkspace,
    localWorkspace: workspace,
    ...(transport ? { transport } : {}),
    // In the VM, Codex keeps its default home (`%USERPROFILE%\.codex`, where its files are copied to).
    ...(provider === "codex" ? { env: guest ? { INITIAL_AGENT_MODE: CODEX_AGENT_ENV.INITIAL_AGENT_MODE } : CODEX_AGENT_ENV } : {}),
    ...(provider === "pi" ? { env: PI_AGENT_ENV } : {}),
    ...(provider === "opencode" && !guest ? { env: OPENCODE_AGENT_ENV } : {}),
    ...(provider === "fx" ? { env: FX_AGENT_ENV } : {}),
    ...(provider === "kimi" ? { env: KIMI_AGENT_ENV } : {}),
    ...(provider === "copilot" ? { env: COPILOT_AGENT_ENV } : {}),
    // Vibe's "Auto Approve" mode runs every tool without asking (ADR-0085); permission requests are still answered.
    ...(provider === "vibe" ? { env: VIBE_AGENT_ENV, fullAccessModeIds: ["auto-approve"] } : {}),
    ...(provider === "grok" ? { env: GROK_AGENT_ENV } : {}),
    ...(provider === "gemini" ? { env: GEMINI_AGENT_ENV, fullAccessModeIds: ["yolo"] } : {}),
    // Qwen Code starts in `yolo` (its flag in `ACP_COMMANDS`); the mode is pinned so a settings file cannot move it back.
    ...(provider === "qwen" ? { fullAccessModeIds: ["yolo"] } : {}),
    builtinMcps,
    ...(mcpTee ? { mcpTee } : {}),
    stateFile: `${home}/.sessionboxer/daemon-state.json`,
    sessionId: env.SESSIONBOXER_SESSION_ID ?? "",
    newConversation: env.SESSIONBOXER_NEW_CONVERSATION === "1",
    instructions,
    instructionsDelivery: instructionsDelivery(provider),
    workspaceBriefing: () => [sessionInfo.briefing(), repos.briefing(), utilities.briefing(), windowsBriefing(guest), macosBriefing(guest)].filter((s) => s !== "").join("\n\n"),
    writeMcpConfig: devinMcpConfig
      ? (servers) => devinMcpConfig.write(servers)
      : piMcpConfig
        ? (servers) => piMcpConfig.write(servers)
        : copilotMcpConfig
          ? (servers) => copilotMcpConfig.write(servers)
          : undefined,
    writeModelAllowlist: claudeSettings ? (models) => claudeSettings.setAvailableModels(models) : undefined,
    ...(provider === "codex" ? { usageCommand: "/status" } : {}),
    ...(provider === "cursor" ? { extensions: (app) => registerCursorExtensions(app, log), fullAccessModeIds: ["agent"] } : {}),
    // fx's ACP modes are `ask` and `code` (its `auto` mode, which reviews calls with a model); neither is
    // "approve everything", so the mode is left alone and `FX_PERMISSION_MODE` (above) opens the Sandbox up.
    ...(provider === "fx"
      ? { fullAccessModeIds: [], systemPromptMeta: (text: string) => ({ fx: { systemPrompt: [{ type: "text", text }] } }), mcpCommandPath: guest ? undefined : onPath }
      : {}),
    // Copilot's ACP modes are its own `mode` config option (agent/plan/autopilot), none of them a permission mode: `--allow-all` opens the Sandbox up.
    ...(provider === "copilot" ? { fullAccessModeIds: [], mcpCommandPath: guest ? undefined : onPath } : {}),
    // Grok Build advertises no ACP modes; `--always-approve` (above) opens the Sandbox up. Instructions go as `_meta.rules`, its AGENTS.md-like rules section.
    ...(provider === "grok" ? { fullAccessModeIds: [], systemPromptMeta: (text: string) => ({ rules: text }), mcpCommandPath: guest ? undefined : onPath } : {}),
    log,
  },
  {
    onPromptStarted: (context) => {
      if (activeTurnId) emit({ type: "turn_context", context: { ...context, version: 1, turnId: activeTurnId, provider } });
    },
    onUpdate: (update) => {
      emit({ type: "update", update });
      mcpTeeHub.observeAcp(update);
      const execution = toolTelemetry.observe(update);
      if (execution) emit({ type: "tool_execution", execution });
    },
    onTurnEnded: (stopReason, usage) => {
      llmInspector?.flush();
      emit({ type: "turn_ended", stopReason, ...(usage ? { usage } : {}), turnId: activeTurnId });
      toolTelemetry.end();
      activeTurnId = undefined;
      transport?.pullFiles().catch((e: unknown) => log(`copying the Provider's files back from the VM failed: ${String(e)}`));
    },
    onError: (message) => {
      emit({ ...agentError(message), turnId: activeTurnId });
      toolTelemetry.end();
      activeTurnId = undefined;
    },
    onUsageReport: (text) => reportUsage(codexStatusWindows(text)),
    onMcpChanged: (servers) => emit({ type: "mcp_changed", servers }),
    onModelChanged: (model) => emit({ type: "model_changed", model: model.value, name: model.name }),
    onOptionChanged: (option, choice) =>
      emit({ type: "option_changed", id: option.id, name: option.name, value: choice.value, valueName: choice.name }),
    onStateChange: () => broadcastStatus(),
  },
);

function broadcastStatus(): void {
  const params = status();
  for (const ws of clients) send(ws, { jsonrpc: "2.0", method: DAEMON_METHODS.status, params });
}

/** Raw files of a VM Session come from the guest: the mirror copy is refreshed before it is served. */
const workspaceFs = new WorkspaceFs(
  workspace,
  guest ? (rel, abs) => guest.getFile(guest.guestPath(rel), abs).catch((e: unknown) => log(`could not copy ${rel} from the VM: ${String(e)}`)) : undefined,
);

const fsWatches = new FsWatches(workspace, (change) => notify(DAEMON_METHODS.fsChanged, change), log);

const terminals = new Terminals(
  workspace,
  {
    onOutput: (id, data) => notify(DAEMON_METHODS.ptyOutput, { id, data: data.toString("base64") }),
    onExit: (id, exitCode) => notify(DAEMON_METHODS.ptyExit, { id, exitCode }),
  },
  log,
  guest?.terminalCommand(),
);

const codeServer = new CodeServer(workspace, log, env.SESSIONBOXER_SESSION_ID ?? "");
const uploads = new Uploads(workspace, log, guest ? (rel, abs) => guest.putFile(abs, guest.guestPath(rel)) : undefined);
const ghApi = new GhApi(log);
const docs = new Docs(env.SESSIONBOXER_GUIDE_PATH ?? GUIDE_PATH, log);
const bridge = new ControlPlaneBridge(
  () => clients,
  log,
  (tool, args) => (tool === "docs" ? docs.lookup(AgentDocsArgs.parse(args).query) : undefined),
);

function status(): DaemonStatus {
  return {
    epoch,
    lastSeq: seq,
    acpSessionId: agent.acpSessionId,
    turnActive: agent.turnActive,
    agentInfo: agent.agentInfo,
    ready: agent.ready,
    error: agent.error,
    mcpServers: agent.mcpServerNames,
    mcpPending: agent.mcpPending,
    models: agent.models,
    model: agent.modelValue,
    modelPending: agent.modelPending,
    options: agent.options,
    optionValues: agent.optionValues,
    optionsPending: agent.optionsPending,
    llmInspect: agent.startedAgentEnv.ANTHROPIC_BASE_URL === LLM_INSPECTOR_ENV.ANTHROPIC_BASE_URL,
    llmInspectPending: agent.agentEnvPendingChange,
    usage,
  };
}

async function handle(ws: WebSocket, method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case DAEMON_METHODS.hello: {
      const p = DaemonHelloParams.parse(params ?? {});
      if (p.epoch === epoch && p.lastSeq !== undefined) {
        for (const ev of buffer) {
          if (ev.seq > p.lastSeq) send(ws, { jsonrpc: "2.0", method: DAEMON_METHODS.event, params: ev });
        }
      }
      return status();
    }
    case DAEMON_METHODS.status:
      return status();
    case DAEMON_METHODS.prompt: {
      const p = DaemonPromptParams.parse(params);
      if (agent.turnActive) throw new DaemonError("conflict", "a turn is already active");
      if (agent.reporting) throw new DaemonError("conflict", "the Agent is reporting its context usage; retry in a moment");
      activeTurnId = randomUUID();
      toolTelemetry.begin(activeTurnId);
      emit({
        type: "user_prompt",
        turnId: activeTurnId,
        text: p.text,
        ...(p.attachments?.length ? { attachments: p.attachments } : {}),
      });
      void agent.prompt(p.note ? `${p.note}\n\n${p.text}` : p.text, p.attachments ?? []);
      return { accepted: true };
    }
    case DAEMON_METHODS.ask: {
      const p = DaemonAskParams.parse(params);
      return { text: await agent.ask(p.text) };
    }
    case DAEMON_METHODS.contextReport:
      return { text: await agent.contextReport() };
    case DAEMON_METHODS.compactionDetails: {
      const p = DaemonCompactionDetailsParams.parse(params);
      if (!agent.acpSessionId) throw new DaemonError("not_found", "the Agent has no session yet");
      const result: DaemonCompactionDetailsResult = readCompactionDetails({ provider, home, cwd: workspace }, agent.acpSessionId, p);
      return result;
    }
    case DAEMON_METHODS.codexAuthSet: {
      if (!codexAuth) throw new DaemonError("invalid_params", "this Sandbox does not run Codex");
      codexAuth.set(DaemonCodexAuthParams.parse(params).authJson);
      return {};
    }
    case DAEMON_METHODS.cursorAuthSet:
      return { applied: setCursorLogin(DaemonCursorAuthParams.parse(params).login) };
    case DAEMON_METHODS.piAuthSet: {
      const p = DaemonPiAuthParams.parse(params);
      return { applied: setPiLogin(p.authJson, p.apiKeys) };
    }
    case DAEMON_METHODS.opencodeAuthSet:
      return { applied: setOpenCodeLogin(DaemonOpenCodeAuthParams.parse(params).authJson) };
    case DAEMON_METHODS.kimiAuthSet: {
      if (!kimiAuth) throw new DaemonError("invalid_params", "this Sandbox does not run Kimi CLI");
      return { applied: agent.setAgentEnv(kimiAuth.set(DaemonKimiAuthParams.parse(params).login)) };
    }
    case DAEMON_METHODS.fxAuthSet:
      return { applied: setFxLogin(DaemonFxAuthParams.parse(params).login) };
    case DAEMON_METHODS.copilotAuthSet: {
      if (!copilotLogin) throw new DaemonError("invalid_params", "this Sandbox does not run GitHub Copilot");
      return { applied: agent.setAgentEnv(copilotLogin.apply(DaemonCopilotAuthParams.parse(params).login)) };
    }
    case DAEMON_METHODS.qwenAuthSet: {
      const p = DaemonQwenAuthParams.parse(params);
      return { applied: setQwenLogin(p.authJson, p.apiKeys) };
    }
    case DAEMON_METHODS.vibeAuthSet: {
      if (!vibeLogin) throw new DaemonError("invalid_params", "this Sandbox does not run Mistral Vibe");
      return { applied: agent.setAgentEnv(vibeLogin.apply(DaemonVibeAuthParams.parse(params).login)) };
    }
    case DAEMON_METHODS.grokAuthSet: {
      if (!grokLogin) throw new DaemonError("invalid_params", "this Sandbox does not run Grok Build");
      return { applied: agent.setAgentEnv(grokLogin.set(DaemonGrokAuthParams.parse(params).login)) };
    }
    case DAEMON_METHODS.geminiAuthSet:
      if (!geminiLogin) throw new DaemonError("invalid_params", "this Sandbox does not run Gemini CLI");
      return { applied: agent.setAgentEnv(geminiLogin.apply(DaemonGeminiAuthParams.parse(params).login)) };
    case DAEMON_METHODS.mcpSet: {
      const p = DaemonMcpSetParams.parse(params);
      ghCredentials.apply(p.credentials);
      bbCredentials.apply(p.credentials);
      sessionboxerTools = p.sessionboxerTools;
      mcpServers = p.servers;
      return { applied: agent.setMcpServers(p.servers) };
    }
    case DAEMON_METHODS.mcpAppsResource: {
      const p = DaemonMcpAppsResourceParams.parse(params);
      return mcpTeeHub.resource(p.server, p.uri);
    }
    case DAEMON_METHODS.mcpAppsToolResult:
      return mcpTeeHub.toolResult(DaemonMcpAppsToolResultParams.parse(params).toolCallId);
    case DAEMON_METHODS.mcpAppsCallTool:
      return mcpTeeHub.callTool(DaemonMcpAppsCallToolParams.parse(params));
    case DAEMON_METHODS.mcpAppsReadResource:
      return mcpTeeHub.readResource(DaemonMcpAppsReadResourceParams.parse(params));
    case DAEMON_METHODS.mcpAppsTools:
      return { tools: await mcpTeeHub.tools(DaemonMcpAppsToolsParams.parse(params).server) };
    case DAEMON_METHODS.modelSet: {
      const p = DaemonModelSetParams.parse(params);
      return { applied: agent.setModel(p.model) };
    }
    case DAEMON_METHODS.optionSet: {
      const p = DaemonOptionSetParams.parse(params);
      return { applied: agent.setOptions(p.options, !p.lenient) };
    }
    case DAEMON_METHODS.claudeModelsSet: {
      const p = DaemonClaudeModelsSetParams.parse(params);
      return { applied: agent.setModelAllowlist(p.models) };
    }
    case DAEMON_METHODS.llmInspectSet: {
      const p = DaemonLlmInspectSetParams.parse(params);
      return setLlmInspect(p.enabled);
    }
    case DAEMON_METHODS.llmCalls: {
      const result: DaemonLlmCallsResult = llmInspector?.list() ?? { calls: [], withBodies: [] };
      return result;
    }
    case DAEMON_METHODS.llmCallBody: {
      const p = DaemonLlmCallBodyParams.parse(params);
      const result: DaemonLlmCallBodyResult = llmInspector?.body(p.id) ?? { call: null, request: null, response: null };
      return result;
    }
    case DAEMON_METHODS.recordingPrefsSet: {
      const p = DaemonRecordingPrefsSetParams.parse(params);
      // Read by the computer-use MCP at stop_recording; tmpfs, so Snapshots carry no preferences.
      mkdirSync(tmpfsDir, { recursive: true });
      writeFileSync(`${tmpfsDir}/recording-prefs.json`, JSON.stringify(p.narration));
      const result: DaemonRecordingPrefsSetResult = { ok: true };
      return result;
    }
    case DAEMON_METHODS.sessionFork: {
      const p = DaemonSessionForkParams.parse(params);
      const result: DaemonSessionForkResult = await agent.forkSession(p);
      return result;
    }
    case DAEMON_METHODS.sessionSwitch: {
      const p = DaemonSessionSwitchParams.parse(params);
      const result: DaemonSessionSwitchResult = { acpSessionId: await agent.switchSession(p.acpSessionId) };
      return result;
    }
    case DAEMON_METHODS.cancel:
      await agent.cancel();
      return { ok: true };
    case DAEMON_METHODS.fsManifest: {
      const dir = FsManifestParams.parse(params ?? {}).dir;
      // A VM Session's files are in the guest: the mirror is brought up to date first (the tar that follows reads it).
      if (guest) await guest.pullDir(guest.guestPath(dir), workspaceDir(workspace, dir));
      return workspaceManifest(workspaceDir(workspace, dir));
    }
    case DAEMON_METHODS.fsWatch:
      await fsWatches.watch(FsWatchParams.parse(params).path);
      return {};
    case DAEMON_METHODS.reposSet:
      await repos.set(DaemonReposSetParams.parse(params));
      return { ok: true };
    case DAEMON_METHODS.reposInspect:
      return repos.inspect(DaemonReposInspectParams.parse(params).dirs);
    case DAEMON_METHODS.reposRemove: {
      const p = DaemonReposRemoveParams.parse(params);
      return repos.remove(p.dir, p.force);
    }
    case DAEMON_METHODS.sessionInfoSet:
      await sessionInfo.set(SessionInfo.parse(params));
      return { ok: true };
    case DAEMON_METHODS.utilitiesSet:
      await utilities.set(DaemonUtilitiesSetParams.parse(params));
      return { ok: true };
    case DAEMON_METHODS.reposSeed: {
      const p = DaemonReposSeedParams.parse(params);
      // The clones in the VM ask this side for credentials (through the bridge): the accounts go first.
      ghCredentials.apply(p.credentials);
      bbCredentials.apply(p.credentials);
      return repos.seed(p);
    }
    case DAEMON_METHODS.ptyList:
      return { terminals: terminals.list() };
    case DAEMON_METHODS.ptyOpen: {
      const p = PtyOpenParams.parse(params);
      return terminals.open(p.cols, p.rows);
    }
    case DAEMON_METHODS.ptyAttach:
      return terminals.attach(PtyIdParams.parse(params).id);
    case DAEMON_METHODS.ptyRead: {
      const p = PtyReadParams.parse(params);
      return terminals.read(p.id, p.lines);
    }
    case DAEMON_METHODS.ptyInput: {
      const p = PtyInputParams.parse(params);
      terminals.input(p.id, p.data);
      return {};
    }
    case DAEMON_METHODS.ptyResize: {
      const p = PtyResizeParams.parse(params);
      terminals.resize(p.id, p.cols, p.rows);
      return {};
    }
    case DAEMON_METHODS.ptyClose:
      terminals.close(PtyIdParams.parse(params).id);
      return {};
    case DAEMON_METHODS.codeStart:
      return codeServer.start(CodeStartParams.parse(params ?? {}));
    case DAEMON_METHODS.codeStatus:
      return codeServer.status();
    case DAEMON_METHODS.codeStop:
      return codeServer.stop();
    case DAEMON_METHODS.codeOpen:
      await codeServer.open(CodeOpenParams.parse(params));
      return {};
    case DAEMON_METHODS.codeTheme:
      codeServer.setTheme(CodeThemeParams.parse(params).theme);
      return {};
    case DAEMON_METHODS.ghApi:
      return ghApi.request(DaemonGhApiParams.parse(params));
    case DAEMON_METHODS.ghLogins:
      return ghApi.logins();
    default:
      throw new DaemonError("method_not_found", `method not found: ${method}`);
  }
}

// One port: JSON-RPC over WebSocket for the Control Plane, plain HTTP for raw Workspace
// files (single ones and tar bundles), and both kinds of traffic under /code for the VS Code server.
const http = createServer((req, res) => {
  if (handleToolTelemetry(req, res, (execution) => emit({ type: "mcp_execution", execution }))) return;
  if (codeServer.handleHttp(req, res)) return;
  if (serveTar(workspace, req, res, log)) return;
  if (uploads.handle(req, res)) return;
  if (bridge.handle(req, res)) return;
  serveRawFile(workspaceFs, req, res).catch((e: unknown) => {
    log(`raw file error: ${String(e)}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
const wss = new WebSocketServer({ noServer: true });
http.on("upgrade", (req, socket, head) => {
  if (codeServer.handleUpgrade(req, socket, head)) return;
  if (mcpTeeHub.handleUpgrade(req, socket, head)) return;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
http.listen(port, "0.0.0.0");
wss.on("connection", (ws) => {
  clients.add(ws);
  log(`control plane connected (${clients.size})`);
  ws.on("close", () => {
    clients.delete(ws);
    log(`control plane disconnected (${clients.size})`);
  });
  ws.on("message", (raw) => {
    let id: JsonRpcId | null = null;
    try {
      const msg = parseJsonRpc(raw.toString());
      if (isJsonRpcResponse(msg)) {
        bridge.onResponse(msg);
        return;
      }
      if (!isJsonRpcRequest(msg)) return;
      id = msg.id;
      handle(ws, msg.method, msg.params)
        .then((result) => send(ws, { jsonrpc: "2.0", id, result }))
        .catch((e: unknown) => send(ws, { jsonrpc: "2.0", id, error: jsonRpcError(e) }));
    } catch (e) {
      send(ws, { jsonrpc: "2.0", id, error: { code: -32700, message: String(e) } });
    }
  });
});

log(`listening on :${port}, epoch ${epoch}`);
if (llmInspectRequested) {
  // The container was created with inspection on: have it in place before the Agent's first start
  // (the Agent waits for the MCP set, which the Control Plane sends after the inspection state).
  setLlmInspect(true).catch((e: unknown) => {
    log(`llm inspector start failed, the Agent talks to the upstream directly: ${String(e)}`);
    agent.setAgentEnv({});
  });
}
// The Control Plane sends the MCP server set right after connecting, which warms the Agent up.
// Should it never come (older Control Plane), start without user servers so prompts still work.
// Not when the Agent runs in a VM: the set waits for the repositories to be put there first.
if (!guest) {
  setTimeout(() => {
    if (agent.mcpServerNames === null) agent.setMcpServers([]);
  }, 30_000).unref();
}

const shutdown = (): void => {
  log("shutting down");
  agent.kill();
  kimiAuth?.set("");
  // fx's login files are regular files in its volume (ADR-0077); the Control Plane puts them back on the next connection.
  if (fxAuth) for (const f of Object.values(fxAuth)) f.set("");
  terminals.closeAll();
  fsWatches.close();
  codeServer.stop();
  wss.close();
  http.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
