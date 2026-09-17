#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DAEMON_METHODS,
  DAEMON_PORT,
  DaemonAskParams,
  DaemonClaudeModelsSetParams,
  DaemonHelloParams,
  DaemonMcpSetParams,
  DaemonModelSetParams,
  DaemonOptionSetParams,
  DaemonPromptParams,
  DaemonSessionForkParams,
  type DaemonSessionForkResult,
  DaemonSessionSwitchParams,
  type DaemonSessionSwitchResult,
  FsPathParams,
  FsWriteParams,
  Provider,
  PtyIdParams,
  PtyInputParams,
  PtyOpenParams,
  PtyResizeParams,
  isJsonRpcRequest,
  parseJsonRpc,
  type DaemonEvent,
  type DaemonStatus,
  type JsonRpcId,
} from "@sessionboxer/protocol";
import { AgentManager } from "./agent.js";
import { ClaudeSettings } from "./claude-settings.js";
import { GhCredentials } from "./gh-credentials.js";
import { DevinMcpConfig } from "./mcp-config.js";
import { Terminals } from "./terminals.js";
import { WorkspaceFs } from "./workspace-fs.js";

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
/** Claude's model allowlist lives in its settings file; the Control Plane sends the list before the Agent starts. */
const claudeSettings = provider === "claude-code" ? new ClaudeSettings(`${home}/.claude/settings.json`, log) : null;

const agent = new AgentManager(
  {
    command: acpCommand,
    args: acpArgs,
    cwd: workspace,
    mcpCommand,
    stateFile: `${home}/.sessionboxer/daemon-state.json`,
    writeMcpConfig: devinMcpConfig ? (servers) => devinMcpConfig.write(servers) : undefined,
    writeModelAllowlist: claudeSettings ? (models) => claudeSettings.setAvailableModels(models) : undefined,
    log,
  },
  {
    onUpdate: (update) => emit({ type: "update", update }),
    onTurnEnded: (stopReason) => emit({ type: "turn_ended", stopReason }),
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

const workspaceFs = new WorkspaceFs(workspace, (changes) => notify(DAEMON_METHODS.fsChanged, { changes }), log);

const terminals = new Terminals(
  workspace,
  {
    onOutput: (id, data) => notify(DAEMON_METHODS.ptyOutput, { id, data: data.toString("base64") }),
    onExit: (id, exitCode) => notify(DAEMON_METHODS.ptyExit, { id, exitCode }),
  },
  log,
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
      emit({ type: "user_prompt", text: p.text });
      void agent.prompt(p.text);
      return { accepted: true };
    }
    case DAEMON_METHODS.ask: {
      const p = DaemonAskParams.parse(params);
      return { text: await agent.ask(p.text) };
    }
    case DAEMON_METHODS.mcpSet: {
      const p = DaemonMcpSetParams.parse(params);
      ghCredentials.apply(p.credentials);
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
    case DAEMON_METHODS.fsList:
      return workspaceFs.list(FsPathParams.parse(params).path);
    case DAEMON_METHODS.fsRead:
      return workspaceFs.read(FsPathParams.parse(params).path);
    case DAEMON_METHODS.fsWrite: {
      const p = FsWriteParams.parse(params);
      return workspaceFs.write(p.path, p.content);
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
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

const wss = new WebSocketServer({ host: "0.0.0.0", port });
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
workspaceFs.startWatching();
// The Control Plane sends the MCP server set right after connecting, which warms the Agent up.
// Should it never come (older Control Plane), start without user servers so prompts still work.
setTimeout(() => {
  if (agent.mcpServerNames === null) agent.setMcpServers([]);
}, 30_000).unref();

const shutdown = (): void => {
  log("shutting down");
  agent.kill();
  terminals.closeAll();
  void workspaceFs.close();
  wss.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
