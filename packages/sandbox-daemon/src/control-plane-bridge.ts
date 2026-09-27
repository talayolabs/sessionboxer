import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import {
  AGENT_BRIDGE_PATH,
  AgentBridgeRequest,
  E2E_BRIDGE_METHODS,
  E2E_PATH,
  E2eBridgeRequest,
  agentMethod,
  isAgentTool,
  type AgentTool,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcSuccess,
} from "@sessionboxer/protocol";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 256 * 1024;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The Agent's way to the Control Plane: the `sessionboxer` MCP's tools `POST /sessionboxer`
 * (`{ tool, args }`, ADR-0062) and older desktop MCPs `POST /e2e` (ADR-0044) on the Daemon's port;
 * each becomes a JSON-RPC request to the connected Control Plane over the same WebSocket it drives
 * the Daemon with (the Sandbox has no route to the Control Plane API, ADR-0005), and the Control
 * Plane's response is the HTTP response. Only the known tools are forwarded, and the Control Plane
 * answers for the Session this connection belongs to: nothing in the request names a Session.
 */
export class ControlPlaneBridge {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();

  constructor(
    private readonly controlPlanes: () => Iterable<WebSocket>,
    private readonly log: (msg: string) => void,
    /** Tools the Daemon answers itself (`docs`: the guide is in the image); `undefined` = forward. */
    private readonly local: (tool: AgentTool, args: unknown) => Promise<unknown> | undefined = () => undefined,
  ) {}

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://daemon");
    if (url.pathname !== E2E_PATH && url.pathname !== AGENT_BRIDGE_PATH) return false;
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return true;
    }
    readBody(req)
      .then((raw) => {
        const json: unknown = JSON.parse(raw);
        if (url.pathname === E2E_PATH) {
          const body = E2eBridgeRequest.parse(json);
          return this.request(E2E_BRIDGE_METHODS[body.method], body.params);
        }
        const body = AgentBridgeRequest.parse(json);
        if (!isAgentTool(body.tool)) throw new BridgeError(404, `unknown tool ${body.tool}`);
        const args = body.args ?? {};
        const local = this.local(body.tool, args);
        if (local) return local;
        // The `e2e_*` tools keep travelling as the e2e methods the Control Plane has always answered.
        const e2e = body.tool.startsWith("e2e_") ? E2E_BRIDGE_METHODS[body.tool.slice(4) as keyof typeof E2E_BRIDGE_METHODS] : undefined;
        return this.request(e2e ?? agentMethod(body.tool), args);
      })
      .then((result) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result ?? null)))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        const status = e instanceof BridgeError ? e.status : 502;
        if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(message);
      });
    return true;
  }

  /** A response from the Control Plane to one of our requests; `false` when the id is not ours. */
  onResponse(msg: JsonRpcSuccess | JsonRpcFailure): boolean {
    const p = this.pending.get(msg.id);
    if (!p) return false;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if ("error" in msg) p.reject(new BridgeError(409, msg.error.message));
    else p.resolve(msg.result);
    return true;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const targets = [...this.controlPlanes()].filter((ws) => ws.readyState === ws.OPEN);
    const ws = targets[targets.length - 1];
    if (!ws) return Promise.reject(new BridgeError(503, "The Control Plane is not connected to the Sandbox right now; retry in a moment."));
    const id = `agent-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(504, `The Control Plane did not answer ${method} in time.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      this.log(`agent → control plane ${method}`);
    });
  }
}

class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BridgeError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
