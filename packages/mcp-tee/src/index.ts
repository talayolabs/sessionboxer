#!/usr/bin/env node
/**
 * The MCP tee (ADR-0079): the Agent is pointed at `sessionboxer-mcp-tee <server>` instead of a
 * user's MCP server. The tee asks the Sandbox Daemon what the server really is (command/args/env or
 * url/headers never reach the Agent's configuration), connects to it over stdio, streamable HTTP
 * or SSE, and forwards every JSON-RPC message unchanged in both directions: no renamed tools, no
 * altered schemas, no added tools. Two things on top, both for MCP Apps:
 *
 * - the Agent's `initialize` request gets the client capability
 *   `extensions["io.modelcontextprotocol/ui"]` merged in, so servers answer with app metadata;
 * - every message is copied to the Daemon, which mirrors `tools/list`, `tools/call` results
 *   (`structuredContent`, `_meta`, `isError`: what ACP drops) and `resources/read`; the Daemon can
 *   also send its own requests (a view's `tools/call`, a `ui://` `resources/read`) over the same
 *   server connection, under ids of its own (`sbx-tee:<n>`) that never meet the Agent's.
 *
 * Without a Daemon the tee still forwards (the Agent must not lose its server); the mirror is best effort.
 */
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  DAEMON_PORT,
  MCP_APPS_EXTENSION,
  MCP_TEE_ID_PREFIX,
  MCP_TEE_PATH,
  MCP_TEE_PORT_ENV,
  McpTeeFromDaemon,
  type McpServerSpec,
  type McpTeeToDaemon,
} from "@sessionboxer/protocol";

const name = process.argv[2] ?? "";
if (!name) {
  process.stderr.write("usage: sessionboxer-mcp-tee <server name>\n");
  process.exit(2);
}
const port = Number(process.env[MCP_TEE_PORT_ENV] ?? DAEMON_PORT);
const daemonUrl = `ws://127.0.0.1:${port}${MCP_TEE_PATH}/${encodeURIComponent(name)}`;
const log = (msg: string) => process.stderr.write(`[sessionboxer-mcp-tee ${name}] ${msg}\n`);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isTeeId = (id: unknown): id is string => typeof id === "string" && id.startsWith(MCP_TEE_ID_PREFIX);

/** The Daemon side: a WebSocket that answers `hello` with the server's spec and carries the mirror. */
class DaemonLink {
  private ws: WebSocket | null = null;
  private backlog: string[] = [];
  private closedForGood = false;
  onRequest: (id: string, method: string, params: unknown) => void = () => {};

  /** Connects and resolves with the spec; rejects when the Daemon cannot be reached (the tee then cannot start). */
  spec(): Promise<McpServerSpec> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(daemonUrl);
      const timer = setTimeout(() => {
        reject(new Error("the Daemon did not answer within 10 s"));
        ws.close();
      }, 10_000);
      ws.addEventListener("open", () => {
        this.attach(ws);
        this.send({ type: "hello", server: name, pid: process.pid });
      });
      ws.addEventListener("message", (ev) => {
        const parsed = McpTeeFromDaemon.safeParse(JSON.parse(String(ev.data)));
        if (!parsed.success) return;
        const m = parsed.data;
        if (m.type === "spec") {
          clearTimeout(timer);
          resolve(m.spec);
        } else if (m.type === "request") {
          this.onRequest(m.id, m.method, m.params);
        } else if (m.type === "error") {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`cannot reach the Sandbox Daemon at ${daemonUrl}`));
      });
    });
  }

  private attach(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("close", () => {
      this.ws = null;
      if (!this.closedForGood) {
        log("lost the Daemon; forwarding continues without the mirror, reconnecting");
        setTimeout(() => this.reconnect(), 2000);
      }
    });
    for (const line of this.backlog.splice(0)) ws.send(line);
  }

  private reconnect() {
    if (this.closedForGood) return;
    const ws = new WebSocket(daemonUrl);
    ws.addEventListener("open", () => {
      this.attach(ws);
      this.send({ type: "hello", server: name, pid: process.pid });
    });
    ws.addEventListener("message", (ev) => {
      const parsed = McpTeeFromDaemon.safeParse(JSON.parse(String(ev.data)));
      if (parsed.success && parsed.data.type === "request") this.onRequest(parsed.data.id, parsed.data.method, parsed.data.params);
    });
    ws.addEventListener("error", () => setTimeout(() => this.reconnect(), 5000));
  }

  send(msg: McpTeeToDaemon) {
    const line = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(line);
    else if (msg.type !== "hello" && this.backlog.length < 200) this.backlog.push(line);
  }

  close() {
    this.closedForGood = true;
    this.ws?.close();
  }
}

function serverTransport(spec: McpServerSpec): Transport {
  if (spec.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    for (const { name: k, value } of spec.env) env[k] = value;
    return new StdioClientTransport({ command: spec.command, args: spec.args, env, stderr: "inherit", cwd: process.cwd() });
  }
  const headers: Record<string, string> = {};
  for (const { name: k, value } of spec.headers) headers[k] = value;
  const url = new URL(spec.url);
  if (spec.transport === "sse") return new SSEClientTransport(url, { requestInit: { headers } });
  return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

/** Adds the MCP Apps client capability to the Agent's `initialize` request, keeping what it declared. */
function withUiCapability(msg: JSONRPCMessage): JSONRPCMessage {
  if (!("method" in msg) || msg.method !== "initialize" || !("id" in msg)) return msg;
  const params = isObject(msg.params) ? msg.params : {};
  const capabilities = isObject(params.capabilities) ? params.capabilities : {};
  const extensions = isObject(capabilities.extensions) ? capabilities.extensions : {};
  if (isObject(extensions[MCP_APPS_EXTENSION])) return msg;
  return {
    ...msg,
    params: { ...params, capabilities: { ...capabilities, extensions: { ...extensions, [MCP_APPS_EXTENSION]: {} } } },
  } as JSONRPCMessage;
}

async function main() {
  const daemon = new DaemonLink();
  let spec: McpServerSpec;
  try {
    spec = await daemon.spec();
  } catch (e) {
    log(`cannot start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const upstream = serverTransport(spec);
  const stdin = new ReadBuffer({ maxBufferSize: 64 * 1024 * 1024 });
  let agentInitializeId: unknown = undefined;
  let stdinDone = false;

  const toAgent = (msg: JSONRPCMessage) => {
    process.stdout.write(serializeMessage(msg));
  };
  const toServer = (msg: JSONRPCMessage) => {
    upstream.send(msg).catch((e) => log(`send to server failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  const copy = (from: "agent" | "server", message: JSONRPCMessage) => {
    daemon.send({ type: "traffic", from, message: message as unknown as Json, at: Date.now() });
  };

  upstream.onmessage = (raw) => {
    const msg = raw as JSONRPCMessage;
    if ("id" in msg && !("method" in msg) && isTeeId(msg.id)) {
      const id = msg.id.slice(MCP_TEE_ID_PREFIX.length);
      if ("error" in msg) daemon.send({ type: "response", id, error: msg.error });
      else daemon.send({ type: "response", id, result: msg.result });
      return;
    }
    if ("id" in msg && !("method" in msg) && agentInitializeId !== undefined && msg.id === agentInitializeId && "result" in msg) {
      const result = msg.result;
      const version = isObject(result) && typeof result.protocolVersion === "string" ? result.protocolVersion : null;
      if (version && "setProtocolVersion" in upstream && typeof upstream.setProtocolVersion === "function") upstream.setProtocolVersion(version);
    }
    toAgent(msg);
    copy("server", msg);
  };
  upstream.onerror = (e) => log(`server transport: ${e.message}`);
  upstream.onclose = () => {
    log("server connection closed");
    daemon.close();
    process.exit(stdinDone ? 0 : 1);
  };

  daemon.onRequest = (id, method, params) => {
    const msg = { jsonrpc: "2.0", id: `${MCP_TEE_ID_PREFIX}${id}`, method, params } as unknown as JSONRPCMessage;
    toServer(msg);
  };

  await upstream.start();

  process.stdin.on("data", (chunk: Buffer) => {
    stdin.append(chunk);
    for (;;) {
      let msg: JSONRPCMessage | null;
      try {
        msg = stdin.readMessage();
      } catch (e) {
        log(`unparseable line from the Agent: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!msg) break;
      if ("method" in msg && msg.method === "initialize" && "id" in msg) agentInitializeId = msg.id;
      const out = withUiCapability(msg);
      toServer(out);
      copy("agent", out);
    }
  });
  process.stdin.on("end", () => {
    stdinDone = true;
    upstream.close().catch(() => {});
    setTimeout(() => process.exit(0), 500).unref();
  });
  process.stdin.on("error", () => {
    stdinDone = true;
    upstream.close().catch(() => {});
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stdinDone = true;
      upstream.close().catch(() => {});
      daemon.close();
      setTimeout(() => process.exit(0), 300).unref();
    });
  }
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
