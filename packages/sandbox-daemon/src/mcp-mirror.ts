/**
 * The Daemon's side of the MCP tee (ADR-0078). Every user MCP server the Agent talks to goes through
 * `sessionboxer-mcp-tee <name>`, which connects here (`ws://127.0.0.1:<port>/mcp-tee/<name>`,
 * loopback only), asks for the server's real definition, and then copies every JSON-RPC message
 * between the Agent and the server. From those copies the hub keeps, per server:
 *
 * - the tool list as the server advertised it (`_meta.ui.resourceUri` says which tools have a view);
 * - the exact result of every `tools/call` (`content`, `structuredContent`, `_meta`, `isError`), which
 *   ACP never carries, matched to the Agent's `tool_call` by server, tool, arguments and time;
 * - the `ui://` resources read (cached by uri, logged by sha256).
 *
 * It can also ask the server things itself, over the same connection (a view's `tools/call`, a
 * `resources/read` for its HTML, `tools/list` when the Agent has not listed yet): the tee gives those
 * ids of its own and routes the answers back here only.
 */
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  type DaemonEvent,
  type DaemonMcpAppsCallToolParams,
  type DaemonMcpAppsReadResourceParams,
  type DaemonMcpAppsReadResourceResult,
  type DaemonMcpAppsResourceResult,
  type DaemonMcpAppsToolResultResult,
  MCP_TEE_PATH,
  type McpAppCall,
  McpExecutionTelemetry,
  McpResourceUiMeta,
  type McpServerSpec,
  McpTeeToDaemon,
  type McpTeeFromDaemon,
  McpToolResult,
  McpToolUiMeta,
  type SessionUpdate,
} from "@sessionboxer/protocol";
import { classifyToolError, fingerprint } from "@sessionboxer/protocol/node-telemetry";

type Json = Record<string, unknown>;

const object = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** How far apart (ms) an ACP tool call and the MCP exchange it is matched to may be. */
const MATCH_WINDOW_MS = 120_000;
const MAX_CALLS = 500;
const MAX_ACP = 2000;
const REQUEST_TIMEOUT_MS = 60_000;
const RESULT_WAIT_MS = 15_000;

/** A JSON value with object keys sorted, for comparing tool arguments regardless of key order. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Json)
          .sort()
          .map((k) => [k, sort((v as Json)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value)) ?? "null";
}

interface CallRecord {
  seq: number;
  server: string;
  tool: string;
  arguments: Json | null;
  requestedAt: number;
  result: McpToolResult | null;
  completedAt: number | null;
  toolCallId: string | null;
  appEmitted: boolean;
}

/** What the ACP stream said about a tool call, as far as it helps find the MCP exchange behind it. */
interface AcpCall {
  toolCallId: string;
  server: string | null;
  tool: string | null;
  /** Names that may be the MCP tool's (the ACP `title`, Claude's `toolName`), when the server is not known. */
  hints: string[];
  rawInput: unknown;
  at: number;
  seq: number | null;
}

interface Waiter {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class ServerMirror {
  ws: WebSocket | null = null;
  tools: Json[] | null = null;
  toolsPromise: Promise<Json[]> | null = null;
  /** The Agent's requests in flight, by JSON-RPC id, so the responses can be read for what they answer. */
  pending = new Map<string, { method: string; params: unknown; at: number; seq: number | null }>();
  calls: CallRecord[] = [];
  resources = new Map<string, DaemonMcpAppsResourceResult>();
  waiting = new Map<string, Waiter>();
  nextId = 1;
  constructor(readonly name: string) {}
}

export interface McpTeeHubEvents {
  emit(body: DaemonEvent["body"]): void;
  /** The exact MCP result of an ACP tool call became known (for `tool-telemetry.ts`). */
  exact(toolCallId: string, info: { server: string; tool: string; isError: boolean }): void;
  log(msg: string): void;
}

export class McpTeeHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly servers = new Map<string, ServerMirror>();
  private readonly acp = new Map<string, AcpCall>();
  private readonly resultWaiters = new Map<string, Array<() => void>>();
  private seq = 0;

  constructor(
    private readonly specs: () => McpServerSpec[],
    private readonly events: McpTeeHubEvents,
  ) {}

  /** Takes `/mcp-tee/<name>` upgrades from loopback; `false` for anything else. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = req.url ?? "";
    if (!url.startsWith(`${MCP_TEE_PATH}/`)) return false;
    const remote = req.socket.remoteAddress ?? "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      socket.destroy();
      return true;
    }
    const name = decodeURIComponent(url.slice(MCP_TEE_PATH.length + 1).split("?")[0] ?? "");
    if (name === "") {
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connected(ws, name));
    return true;
  }

  private mirror(name: string): ServerMirror {
    let m = this.servers.get(name);
    if (!m) {
      m = new ServerMirror(name);
      this.servers.set(name, m);
    }
    return m;
  }

  private connected(ws: WebSocket, name: string) {
    const m = this.mirror(name);
    const send = (msg: McpTeeFromDaemon) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    ws.on("message", (raw) => {
      let parsed;
      try {
        parsed = McpTeeToDaemon.safeParse(JSON.parse(String(raw)));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const msg = parsed.data;
      switch (msg.type) {
        case "hello": {
          const spec = this.specs().find((s) => s.name === name);
          if (!spec) {
            this.events.log(`mcp-tee: ${name} asked for a server that is not configured`);
            send({ type: "error", message: `no MCP server named ${name} is configured for this Session` });
            ws.close();
            return;
          }
          if (m.ws && m.ws !== ws) m.ws.close();
          m.ws = ws;
          m.pending.clear();
          m.tools = null;
          m.toolsPromise = null;
          this.events.log(`mcp-tee: ${name} connected (${spec.transport}${msg.pid ? `, pid ${msg.pid}` : ""})`);
          send({ type: "spec", spec });
          break;
        }
        case "traffic":
          if (m.ws === ws) this.traffic(m, msg.from, msg.message, msg.at);
          break;
        case "response": {
          const w = m.waiting.get(msg.id);
          if (!w) return;
          m.waiting.delete(msg.id);
          clearTimeout(w.timer);
          if (msg.error !== undefined) {
            const e = object(msg.error);
            w.reject(Object.assign(new Error(str(e.message) ?? "MCP error"), { code: typeof e.code === "number" ? e.code : -32000, data: e.data }));
          } else w.resolve(msg.result);
          break;
        }
        case "log":
          this.events.log(`mcp-tee ${name}: ${msg.message}`);
          break;
      }
    });
    ws.on("close", () => {
      if (m.ws !== ws) return;
      m.ws = null;
      m.toolsPromise = null;
      for (const w of m.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(Object.assign(new Error(`the ${name} MCP server went away`), { code: -32003 }));
      }
      m.waiting.clear();
      this.events.log(`mcp-tee: ${name} disconnected`);
    });
  }

  // --- the mirror ---------------------------------------------------------------------------

  private traffic(m: ServerMirror, from: "agent" | "server", message: Json, at: number) {
    const method = str(message.method);
    const hasId = "id" in message && message.id !== null && message.id !== undefined;
    if (from === "agent") {
      if (!method || !hasId) return;
      let seq: number | null = null;
      if (method === "tools/call") {
        const params = object(message.params);
        const tool = str(params.name);
        if (tool) {
          const rec: CallRecord = {
            seq: ++this.seq,
            server: m.name,
            tool,
            arguments: params.arguments === undefined ? null : object(params.arguments),
            requestedAt: at,
            result: null,
            completedAt: null,
            toolCallId: null,
            appEmitted: false,
          };
          m.calls.push(rec);
          if (m.calls.length > MAX_CALLS) m.calls.splice(0, m.calls.length - MAX_CALLS);
          seq = rec.seq;
          this.matchRecord(m, rec);
        }
      }
      m.pending.set(JSON.stringify(message.id), { method, params: message.params, at, seq });
      if (m.pending.size > 1000) {
        const oldest = m.pending.keys().next().value;
        if (oldest !== undefined) m.pending.delete(oldest);
      }
      return;
    }
    if (method && !hasId) {
      if (method === "notifications/tools/list_changed") {
        m.tools = null;
        m.toolsPromise = null;
        this.events.log(`mcp-tee: ${m.name} tools changed`);
      } else if (method === "notifications/resources/list_changed" || method === "notifications/resources/updated") {
        m.resources.clear();
      }
      return;
    }
    if (method) return; // a server→Agent request (sampling, roots, elicitation, ping): the Agent answers it
    const p = m.pending.get(JSON.stringify(message.id));
    if (!p) return;
    m.pending.delete(JSON.stringify(message.id));
    const result = object(message.result);
    const error = message.error === undefined ? null : object(message.error);
    switch (p.method) {
      case "initialize": {
        const info = object(result.serverInfo);
        const ext = Object.keys(object(object(result.capabilities).extensions));
        this.events.log(`mcp-tee: ${m.name} is ${str(info.name) ?? "?"} ${str(info.version) ?? ""} (protocol ${str(result.protocolVersion) ?? "?"}${ext.length ? `, extensions ${ext.join(", ")}` : ""})`);
        break;
      }
      case "tools/list":
        if (Array.isArray(result.tools)) {
          m.tools = result.tools.map(object);
          const withViews = m.tools.filter((t) => McpToolUiMeta.safeParse(object(object(t._meta).ui)).data?.resourceUri).length;
          this.events.log(`mcp-tee: ${m.name} lists ${m.tools.length} tools${withViews ? `, ${withViews} with a view` : ""}`);
          for (const rec of m.calls) if (rec.toolCallId) this.maybeEmitApp(m, rec);
        }
        break;
      case "tools/call": {
        const rec = m.calls.find((r) => r.seq === p.seq);
        if (!rec) return;
        rec.result = error
          ? { content: [{ type: "text", text: str(error.message) ?? "MCP error" }], isError: true }
          : (McpToolResult.safeParse(result).data ?? { content: [], isError: false });
        rec.completedAt = at;
        this.recordExecution(m, rec);
        this.matchRecord(m, rec);
        if (rec.toolCallId) this.exactKnown(rec);
        break;
      }
      case "resources/read": {
        const uri = str(object(p.params).uri);
        if (uri && uri.startsWith("ui://") && !error) this.cacheResource(m, uri, result);
        break;
      }
    }
  }

  private recordExecution(m: ServerMirror, rec: CallRecord) {
    const result = rec.result;
    if (!result || rec.completedAt === null) return;
    const tool = m.tools?.find((t) => t.name === rec.tool);
    const isError = result.isError === true;
    const execution = McpExecutionTelemetry.safeParse({
      version: 1,
      executionId: randomUUID(),
      server: m.name,
      toolName: rec.tool,
      startedAt: new Date(rec.requestedAt).toISOString(),
      executionMs: Math.max(0, rec.completedAt - rec.requestedAt),
      toolSchemaHash: fingerprint(tool ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema } : { name: rec.tool }),
      errorCode: isError ? classifyToolError(JSON.stringify(result.content)) : null,
      errorSource: isError ? "structured" : null,
      exact: true,
      ...(rec.toolCallId ? { toolCallId: rec.toolCallId } : {}),
      resultIsError: isError,
    });
    if (execution.success) this.events.emit({ type: "mcp_execution", execution: execution.data });
  }

  private exactKnown(rec: CallRecord) {
    if (!rec.toolCallId || !rec.result) return;
    this.events.exact(rec.toolCallId, { server: rec.server, tool: rec.tool, isError: rec.result.isError === true });
    const waiters = this.resultWaiters.get(rec.toolCallId);
    if (waiters) {
      this.resultWaiters.delete(rec.toolCallId);
      for (const w of waiters) w();
    }
  }

  private cacheResource(m: ServerMirror, uri: string, result: Json): DaemonMcpAppsResourceResult | null {
    const contents = Array.isArray(result.contents) ? result.contents.map(object) : [];
    const first = contents.find((c) => c.uri === uri) ?? contents[0];
    if (!first) return null;
    const html = typeof first.text === "string" ? first.text : typeof first.blob === "string" ? Buffer.from(first.blob, "base64").toString("utf8") : null;
    if (html === null) return null;
    const meta = McpResourceUiMeta.safeParse(object(object(first._meta).ui)).data ?? McpResourceUiMeta.safeParse(object(object(result._meta).ui)).data ?? {};
    const sha256 = createHash("sha256").update(html).digest("hex");
    const res: DaemonMcpAppsResourceResult = { server: m.name, uri, mimeType: str(first.mimeType) ?? "text/html", html, meta, sha256 };
    m.resources.set(uri, res);
    this.events.log(`mcp-apps: ${m.name} ${uri} (${res.mimeType}, ${Buffer.byteLength(html)} bytes) sha256=${sha256}`);
    return res;
  }

  // --- matching the Agent's tool calls to the exact exchange -----------------------------------

  /** Reads what an ACP tool call says about itself and tries to bind it to a mirrored `tools/call`. */
  observeAcp(update: SessionUpdate): void {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    const id = update.toolCallId;
    let a = this.acp.get(id);
    if (!a) {
      if (this.acp.size >= MAX_ACP) {
        const cutoff = Date.now() - 10 * 60_000;
        for (const [k, v] of this.acp) if (v.at < cutoff) this.acp.delete(k);
        if (this.acp.size >= MAX_ACP) return;
      }
      a = { toolCallId: id, server: null, tool: null, hints: [], rawInput: undefined, at: Date.now(), seq: null };
      this.acp.set(id, a);
    }
    const meta = object(update._meta);
    const claude = object(meta.claudeCode);
    const serverName = str(object(claude.mcpServer).name);
    if (serverName) a.server = serverName;
    const names = [str(claude.toolName), str(object(update as unknown).name), update.sessionUpdate === "tool_call" ? update.title : str((update as { title?: unknown }).title)].filter((n): n is string => n !== null);
    for (const n of names) {
      const mcp = /^mcp__(.+)$/.exec(n);
      if (mcp) {
        const rest = mcp[1] ?? "";
        const server = a.server && rest.startsWith(`${a.server}__`) ? a.server : [...this.servers.keys()].find((s) => rest.startsWith(`${s}__`));
        if (server) {
          a.server = server;
          a.tool = rest.slice(server.length + 2);
          continue;
        }
      }
      if (!a.hints.includes(n)) a.hints.push(n);
    }
    if (update.rawInput !== undefined && update.rawInput !== null && Object.keys(object(update.rawInput)).length) a.rawInput = update.rawInput;
    if (a.seq === null) this.matchAcp(a);
  }

  private candidates(a: AcpCall): ServerMirror[] {
    if (a.server) {
      const m = this.servers.get(a.server);
      return m ? [m] : [];
    }
    return [...this.servers.values()];
  }

  private fits(a: AcpCall, rec: CallRecord): boolean {
    if (rec.toolCallId !== null) return false;
    if (Math.abs(rec.requestedAt - a.at) > MATCH_WINDOW_MS) return false;
    if (a.server && a.server !== rec.server) return false;
    if (a.tool) {
      if (a.tool !== rec.tool) return false;
    } else if (!a.hints.some((h) => h === rec.tool || h.endsWith(`__${rec.tool}`) || h.endsWith(`/${rec.tool}`) || h.endsWith(`.${rec.tool}`) || h === `${rec.server}__${rec.tool}`)) {
      // A tool call whose name we cannot read: only its arguments can tell.
      if (a.rawInput === undefined) return false;
    }
    if (a.rawInput !== undefined && rec.arguments !== null) return canonical(a.rawInput) === canonical(rec.arguments);
    if (a.rawInput !== undefined && rec.arguments === null) return Object.keys(object(a.rawInput)).length === 0;
    return a.tool !== null; // no arguments to compare: the name from Claude's metadata is enough
  }

  private bind(m: ServerMirror, a: AcpCall, rec: CallRecord) {
    rec.toolCallId = a.toolCallId;
    a.seq = rec.seq;
    a.server = m.name;
    a.tool = rec.tool;
    this.maybeEmitApp(m, rec);
    if (rec.result) this.exactKnown(rec);
  }

  private matchAcp(a: AcpCall) {
    for (const m of this.candidates(a)) {
      const rec = m.calls.find((r) => this.fits(a, r));
      if (rec) {
        this.bind(m, a, rec);
        return;
      }
    }
  }

  private matchRecord(m: ServerMirror, rec: CallRecord) {
    if (rec.toolCallId !== null) return;
    for (const a of this.acp.values()) {
      if (a.seq !== null) continue;
      if (this.fits(a, rec)) {
        this.bind(m, a, rec);
        return;
      }
    }
  }

  private maybeEmitApp(m: ServerMirror, rec: CallRecord) {
    if (rec.appEmitted || !rec.toolCallId) return;
    if (!m.tools) {
      void this.toolList(m).then(() => this.maybeEmitApp(m, rec)).catch(() => {});
      return;
    }
    const tool = m.tools.find((t) => t.name === rec.tool);
    const ui = tool ? McpToolUiMeta.safeParse(object(object(tool._meta).ui)).data : undefined;
    if (!ui?.resourceUri) return;
    rec.appEmitted = true;
    const call: McpAppCall = { toolCallId: rec.toolCallId, server: m.name, tool: rec.tool, resourceUri: ui.resourceUri, arguments: rec.arguments };
    this.events.emit({ type: "mcp_app_call", call });
    void this.resource(m.name, ui.resourceUri).catch((e: unknown) => this.events.log(`mcp-apps: ${m.name} ${ui.resourceUri}: ${e instanceof Error ? e.message : String(e)}`));
  }

  // --- Daemon-originated requests ----------------------------------------------------------------

  private request(m: ServerMirror, method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const ws = m.ws;
    if (!ws || ws.readyState !== ws.OPEN) {
      return Promise.reject(Object.assign(new Error(`the ${m.name} MCP server is not connected (is it enabled for this Session, and did the Agent start it?)`), { code: -32003 }));
    }
    const id = String(m.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        m.waiting.delete(id);
        reject(Object.assign(new Error(`${m.name}: ${method} timed out`), { code: -32002 }));
      }, timeoutMs);
      m.waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "request", id, method, params } satisfies McpTeeFromDaemon));
    });
  }

  private toolList(m: ServerMirror): Promise<Json[]> {
    if (m.tools) return Promise.resolve(m.tools);
    if (!m.toolsPromise) {
      m.toolsPromise = this.request(m, "tools/list", {})
        .then((r) => {
          const tools = Array.isArray(object(r).tools) ? (object(r).tools as unknown[]).map(object) : [];
          m.tools = tools;
          return tools;
        })
        .finally(() => {
          m.toolsPromise = null;
        });
    }
    return m.toolsPromise;
  }

  private known(server: string): ServerMirror {
    const m = this.servers.get(server);
    if (!m) throw Object.assign(new Error(`no MCP server named ${server} has connected through the tee`), { code: -32001 });
    return m;
  }

  private bound(toolCallId: string, server: string): CallRecord {
    for (const m of this.servers.values()) {
      const rec = m.calls.find((r) => r.toolCallId === toolCallId);
      if (rec) {
        if (rec.server !== server) throw Object.assign(new Error(`tool call ${toolCallId} belongs to ${rec.server}, not ${server}: views only reach their own server`), { code: -32602 });
        return rec;
      }
    }
    throw Object.assign(new Error(`no MCP tool call ${toolCallId} was seen through the tee`), { code: -32001 });
  }

  /** A `ui://` resource, from the cache or read through the tee. */
  async resource(server: string, uri: string): Promise<DaemonMcpAppsResourceResult> {
    const m = this.known(server);
    const cached = m.resources.get(uri);
    if (cached) return cached;
    const result = object(await this.request(m, "resources/read", { uri }));
    const res = this.cacheResource(m, uri, result);
    if (!res) throw Object.assign(new Error(`${server} returned no text for ${uri}`), { code: -32001 });
    return res;
  }

  /** The exact result of an Agent tool call, waiting a little if the server has not answered yet. */
  async toolResult(toolCallId: string): Promise<DaemonMcpAppsToolResultResult> {
    let rec: CallRecord | undefined;
    let m: ServerMirror | undefined;
    for (const s of this.servers.values()) {
      rec = s.calls.find((r) => r.toolCallId === toolCallId);
      if (rec) {
        m = s;
        break;
      }
    }
    if (!rec || !m) throw Object.assign(new Error(`no MCP tool call ${toolCallId} was seen through the tee`), { code: -32001 });
    if (!rec.result) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, RESULT_WAIT_MS);
        const list = this.resultWaiters.get(toolCallId) ?? [];
        list.push(() => {
          clearTimeout(timer);
          resolve();
        });
        this.resultWaiters.set(toolCallId, list);
      });
    }
    const tools = await this.toolList(m).catch(() => m.tools ?? []);
    const tool = tools.find((t) => t.name === rec.tool) ?? null;
    const call: McpAppCall = {
      toolCallId,
      server: m.name,
      tool: rec.tool,
      resourceUri: str(McpToolUiMeta.safeParse(object(object(tool?._meta).ui)).data?.resourceUri) ?? "",
      arguments: rec.arguments,
    };
    return { call, result: rec.result, tool };
  }

  /** A view's `tools/call`: its own server only, and only tools the server lets apps call. */
  async callTool(p: DaemonMcpAppsCallToolParams): Promise<McpToolResult> {
    const m = this.known(p.server);
    this.bound(p.toolCallId, p.server);
    const tools = await this.toolList(m);
    const tool = tools.find((t) => t.name === p.name);
    if (!tool) throw Object.assign(new Error(`${p.server} has no tool named ${p.name}`), { code: -32602 });
    const ui = McpToolUiMeta.safeParse(object(object(tool._meta).ui)).data;
    if (ui?.visibility && !ui.visibility.includes("app")) {
      throw Object.assign(new Error(`${p.server}'s ${p.name} is not callable from a view (visibility ${ui.visibility.join(", ")})`), { code: -32602 });
    }
    const started = Date.now();
    let result: McpToolResult;
    try {
      result = McpToolResult.safeParse(await this.request(m, "tools/call", { name: p.name, arguments: p.arguments })).data ?? { content: [] };
    } catch (e) {
      if (e instanceof Error && "code" in e && (e as { code: unknown }).code === -32003) throw e;
      result = { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
    const rec: CallRecord = { seq: ++this.seq, server: m.name, tool: p.name, arguments: p.arguments, requestedAt: started, result, completedAt: Date.now(), toolCallId: null, appEmitted: true };
    this.recordExecution(m, rec);
    this.events.log(`mcp-apps: view of ${p.toolCallId} called ${p.server}/${p.name}${result.isError ? " (error)" : ""}`);
    return result;
  }

  /** A view's `resources/read`, on its own server. */
  async readResource(p: DaemonMcpAppsReadResourceParams): Promise<DaemonMcpAppsReadResourceResult> {
    const m = this.known(p.server);
    this.bound(p.toolCallId, p.server);
    const result = object(await this.request(m, "resources/read", { uri: p.uri }));
    return { ...result, contents: Array.isArray(result.contents) ? result.contents : [] };
  }

  async tools(server: string): Promise<Json[]> {
    return this.toolList(this.known(server));
  }
}
