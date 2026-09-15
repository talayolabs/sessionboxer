#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DAEMON_METHODS,
  DAEMON_PORT,
  DaemonHelloParams,
  DaemonPromptParams,
  FsPathParams,
  FsWriteParams,
  isJsonRpcRequest,
  parseJsonRpc,
  type DaemonEvent,
  type DaemonStatus,
  type JsonRpcId,
} from "@sessionboxer/protocol";
import { AgentManager } from "./agent.js";
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

function emit(body: DaemonEvent["body"]): void {
  const event: DaemonEvent = { epoch, seq: ++seq, ts: new Date().toISOString(), body };
  buffer.push(event);
  if (buffer.length > EVENT_BUFFER_MAX) buffer.splice(0, buffer.length - EVENT_BUFFER_MAX);
  for (const ws of clients) send(ws, { jsonrpc: "2.0", method: DAEMON_METHODS.event, params: event });
}

const agent = new AgentManager(
  {
    command: env.SESSIONBOXER_ACP_COMMAND ?? "claude-agent-acp",
    cwd: workspace,
    mcpCommand: env.SESSIONBOXER_MCP_COMMAND ?? "sessionboxer-computer-use-mcp",
    stateFile: `${home}/.sessionboxer/daemon-state.json`,
    log,
  },
  {
    onUpdate: (update) => emit({ type: "update", update }),
    onTurnEnded: (stopReason) => emit({ type: "turn_ended", stopReason }),
    onError: (message) => emit({ type: "agent_error", message }),
    onStateChange: () => {
      const params = status();
      for (const ws of clients) send(ws, { jsonrpc: "2.0", method: DAEMON_METHODS.status, params });
    },
  },
);

const workspaceFs = new WorkspaceFs(
  workspace,
  (changes) => {
    for (const ws of clients) send(ws, { jsonrpc: "2.0", method: DAEMON_METHODS.fsChanged, params: { changes } });
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
// Warm the Agent up so the first prompt does not pay the spawn + initialize cost.
agent.ensureStarted().catch((e: unknown) => log(`agent start failed: ${String(e)}`));

const shutdown = (): void => {
  log("shutting down");
  agent.kill();
  void workspaceFs.close();
  wss.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
