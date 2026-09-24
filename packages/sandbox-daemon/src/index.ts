#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  CodeOpenParams,
  CodeStartParams,
  CodeThemeParams,
  DAEMON_METHODS,
  DAEMON_PORT,
  LLM_INSPECTOR_PORT,
  DaemonLlmCallBodyParams,
  type DaemonLlmCallBodyResult,
  type DaemonLlmCallsResult,
  DaemonLlmInspectSetParams,
  type DaemonLlmInspectSetResult,
  DaemonAskParams,
  DaemonClaudeModelsSetParams,
  DaemonCodexAuthParams,
  DaemonCompactionDetailsParams,
  type DaemonCompactionDetailsResult,
  DaemonGhApiParams,
  DaemonHelloParams,
  DaemonMcpSetParams,
  DaemonModelSetParams,
  DaemonOptionSetParams,
  DaemonPromptParams,
  DaemonRecordingPrefsSetParams,
  type DaemonRecordingPrefsSetResult,
  DaemonReposInspectParams,
  DaemonReposRemoveParams,
  DaemonReposSetParams,
  FsManifestParams,
  DaemonSessionForkParams,
  type DaemonSessionForkResult,
  DaemonSessionSwitchParams,
  type DaemonSessionSwitchResult,
  Provider,
  PtyIdParams,
  PtyInputParams,
  PtyOpenParams,
  PtyResizeParams,
  instructionsDelivery,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseJsonRpc,
  type DaemonEvent,
  type DaemonStatus,
  type JsonRpcId,
} from "@sessionboxer/protocol";
import { AgentManager } from "./agent.js";
import { ClaudeSettings } from "./claude-settings.js";
import { CodeServer } from "./code-server.js";
import { CodexAuth } from "./codex-auth.js";
import { readCompactionDetails } from "./compactions.js";
import { E2eBridge } from "./e2e-bridge.js";
import { GhApi } from "./gh-api.js";
import { BbCredentials } from "./bb-credentials.js";
import { GhCredentials } from "./gh-credentials.js";
import { LlmInspector } from "./llm-inspector.js";
import { DevinMcpConfig } from "./mcp-config.js";
import { serveRawFile } from "./raw-files.js";
import { Repos } from "./repos.js";
import { Uploads } from "./uploads.js";
import { Terminals } from "./terminals.js";
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

/** ACP adapter per Provider; `SESSIONBOXER_ACP_COMMAND` overrides (space-separated) for experiments. */
const ACP_COMMANDS: Record<Provider, string[]> = {
  "claude-code": ["claude-agent-acp"],
  devin: ["devin", "acp"],
  codex: ["codex-acp"],
};
const provider = Provider.catch("claude-code").parse(env.SESSIONBOXER_PROVIDER);
const [acpCommand = "claude-agent-acp", ...acpArgs] =
  env.SESSIONBOXER_ACP_COMMAND?.split(" ") ?? ACP_COMMANDS[provider];
const mcpCommand = env.SESSIONBOXER_MCP_COMMAND ?? "sessionboxer-computer-use-mcp";
const tmpfsDir = env.SESSIONBOXER_TMPFS ?? "/dev/shm/sessionboxer";
/** Devin reads MCP servers from its config file; kept on tmpfs so Snapshots never carry MCP secrets. */
const devinMcpConfig = provider === "devin" ? new DevinMcpConfig(`${home}/.config/devin/mcp_config.json`, tmpfsDir, mcpCommand) : null;
/** `gh`/git logins for the Sandbox; the image points `GH_CONFIG_DIR` at this tmpfs dir. */
const ghCredentials = new GhCredentials(env.GH_CONFIG_DIR ?? `${tmpfsDir}/gh`, log);
/** `bb`/git logins for Bitbucket hosts; the image points `BB_CONFIG_DIR` at this tmpfs dir. */
const bbCredentials = new BbCredentials(env.BB_CONFIG_DIR ?? `${tmpfsDir}/bb`, log);
/** Claude's model allowlist lives in its settings file; the Control Plane sends the list before the Agent starts. */
const claudeSettings = provider === "claude-code" ? new ClaudeSettings(`${home}/.claude/settings.json`, log) : null;
/** Codex's ChatGPT login: `~/.codex/auth.json` on tmpfs, refreshed tokens reported back (ADR-0046). */
const codexHome = env.CODEX_HOME ?? `${home}/.codex`;
const codexAuth =
  provider === "codex"
    ? new CodexAuth(codexHome, tmpfsDir, log, (authJson) => notify(DAEMON_METHODS.codexAuthChanged, { authJson }))
    : null;
/** The Sandbox is the isolation: Codex runs without approvals or its own sandbox, like the other Providers. */
const CODEX_AGENT_ENV = { CODEX_HOME: codexHome, INITIAL_AGENT_MODE: "agent-full-access" };

/** The Session's standing instructions, set by the Control Plane on the container. */
const instructions = env.SESSIONBOXER_INSTRUCTIONS ?? "";

/**
 * Claude Code's model API calls can go through a loopback proxy that keeps the exact bodies
 * (ADR-0032). Its upstream is the `ANTHROPIC_BASE_URL` the Sandbox was given (a company proxy) or
 * Anthropic; the Daemon's own environment keeps that value, only the Agent process sees the loopback.
 */
const llmUpstream = env.ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_DEFAULT_BASE_URL;
const llmInspector =
  provider === "claude-code"
    ? new LlmInspector({
        port: LLM_INSPECTOR_PORT,
        upstream: llmUpstream,
        dir: `${tmpfsDir}/llm`,
        log,
        onCall: (call) => emit({ type: "llm_call", call }),
      })
    : null;
/**
 * Claude Code takes any `ANTHROPIC_BASE_URL` other than Anthropic's own for a third-party backend
 * and then caps the 1M-native models (Fable, Opus 5) at a 200k window: wrong size on the gauge and
 * compaction at a fifth of the real window. When the loopback only forwards to Anthropic, this
 * flag tells it so.
 */
const LLM_INSPECTOR_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${LLM_INSPECTOR_PORT}`,
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

const repos = new Repos(workspace, log);

const agent = new AgentManager(
  {
    command: acpCommand,
    args: acpArgs,
    cwd: workspace,
    ...(provider === "codex" ? { env: CODEX_AGENT_ENV } : {}),
    mcpCommand,
    stateFile: `${home}/.sessionboxer/daemon-state.json`,
    sessionId: env.SESSIONBOXER_SESSION_ID ?? "",
    newConversation: env.SESSIONBOXER_NEW_CONVERSATION === "1",
    instructions,
    instructionsDelivery: instructionsDelivery(provider),
    workspaceBriefing: () => repos.briefing(),
    writeMcpConfig: devinMcpConfig ? (servers) => devinMcpConfig.write(servers) : undefined,
    writeModelAllowlist: claudeSettings ? (models) => claudeSettings.setAvailableModels(models) : undefined,
    log,
  },
  {
    onUpdate: (update) => emit({ type: "update", update }),
    onTurnEnded: (stopReason, usage) => {
      llmInspector?.flush();
      emit(usage ? { type: "turn_ended", stopReason, usage } : { type: "turn_ended", stopReason });
    },
    onError: (message) => emit({ type: "agent_error", message }),
    onMcpChanged: (servers) => emit({ type: "mcp_changed", servers }),
    onModelChanged: (model) => emit({ type: "model_changed", model: model.value, name: model.name }),
    onOptionChanged: (option, choice) =>
      emit({ type: "option_changed", id: option.id, name: option.name, value: choice.value, valueName: choice.name }),
    onStateChange: () => {
      const params = status();
      for (const ws of clients) send(ws, { jsonrpc: "2.0", method: DAEMON_METHODS.status, params });
    },
  },
);

const workspaceFs = new WorkspaceFs(workspace);

const terminals = new Terminals(
  workspace,
  {
    onOutput: (id, data) => notify(DAEMON_METHODS.ptyOutput, { id, data: data.toString("base64") }),
    onExit: (id, exitCode) => notify(DAEMON_METHODS.ptyExit, { id, exitCode }),
  },
  log,
);

const codeServer = new CodeServer(workspace, log);
const uploads = new Uploads(workspace, log);
const ghApi = new GhApi(log);
const e2eBridge = new E2eBridge(() => clients, log);

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
      if (agent.turnActive) throw new Error("a turn is already active");
      if (agent.reporting) throw new Error("the Agent is reporting its context usage; retry in a moment");
      emit({
        type: "user_prompt",
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
      if (!agent.acpSessionId) throw new Error("the Agent has no session yet");
      const result: DaemonCompactionDetailsResult = readCompactionDetails({ provider, home, cwd: workspace }, agent.acpSessionId, p);
      return result;
    }
    case DAEMON_METHODS.codexAuthSet: {
      if (!codexAuth) throw new Error("this Sandbox does not run Codex");
      codexAuth.set(DaemonCodexAuthParams.parse(params).authJson);
      return {};
    }
    case DAEMON_METHODS.mcpSet: {
      const p = DaemonMcpSetParams.parse(params);
      ghCredentials.apply(p.credentials);
      bbCredentials.apply(p.credentials);
      return { applied: agent.setMcpServers(p.servers) };
    }
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
    case DAEMON_METHODS.fsManifest:
      return workspaceManifest(workspaceDir(workspace, FsManifestParams.parse(params ?? {}).dir));
    case DAEMON_METHODS.reposSet:
      await repos.set(DaemonReposSetParams.parse(params));
      return { ok: true };
    case DAEMON_METHODS.reposInspect:
      return repos.inspect(DaemonReposInspectParams.parse(params).dirs);
    case DAEMON_METHODS.reposRemove: {
      const p = DaemonReposRemoveParams.parse(params);
      return repos.remove(p.dir, p.force);
    }
    case DAEMON_METHODS.ptyList:
      return { terminals: terminals.list() };
    case DAEMON_METHODS.ptyOpen: {
      const p = PtyOpenParams.parse(params);
      return terminals.open(p.cols, p.rows);
    }
    case DAEMON_METHODS.ptyAttach:
      return terminals.attach(PtyIdParams.parse(params).id);
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
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

// One port: JSON-RPC over WebSocket for the Control Plane, plain HTTP for raw Workspace
// files (single ones and tar bundles), and both kinds of traffic under /code for the VS Code server.
const http = createServer((req, res) => {
  if (codeServer.handleHttp(req, res)) return;
  if (serveTar(workspace, req, res, log)) return;
  if (uploads.handle(req, res)) return;
  if (e2eBridge.handle(req, res)) return;
  serveRawFile(workspaceFs, req, res).catch((e: unknown) => {
    log(`raw file error: ${String(e)}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
const wss = new WebSocketServer({ noServer: true });
http.on("upgrade", (req, socket, head) => {
  if (codeServer.handleUpgrade(req, socket, head)) return;
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
        e2eBridge.onResponse(msg);
        return;
      }
      if (!isJsonRpcRequest(msg)) return;
      id = msg.id;
      handle(ws, msg.method, msg.params)
        .then((result) => send(ws, { jsonrpc: "2.0", id, result }))
        .catch((e: unknown) => {
          const code = typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : -32000;
          send(ws, { jsonrpc: "2.0", id, error: { code, message: e instanceof Error ? e.message : String(e) } });
        });
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
setTimeout(() => {
  if (agent.mcpServerNames === null) agent.setMcpServers([]);
}, 30_000).unref();

const shutdown = (): void => {
  log("shutting down");
  agent.kill();
  terminals.closeAll();
  codeServer.stop();
  wss.close();
  http.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
