import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import { E2E_BRIDGE_METHODS, E2E_PATH, E2eBridgeRequest, type JsonRpcFailure, type JsonRpcId, type JsonRpcSuccess } from "@sessionboxer/protocol";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 256 * 1024;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The Agent's `e2e_*` tools (desktop MCP) reach the Control Plane through here: `POST /e2e` on
 * the Daemon's port becomes a JSON-RPC request to the connected Control Plane over the same
 * WebSocket it drives the Daemon with (the Sandbox has no route to the Control Plane API,
 * ADR-0005), and the Control Plane's response is the HTTP response. See ADR-0044.
 */
export class E2eBridge {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();

  constructor(
    private readonly controlPlanes: () => Iterable<WebSocket>,
    private readonly log: (msg: string) => void,
  ) {}

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://daemon");
    if (url.pathname !== E2E_PATH) return false;
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return true;
    }
    readBody(req)
      .then((raw) => {
        const body = E2eBridgeRequest.parse(JSON.parse(raw));
        return this.request(E2E_BRIDGE_METHODS[body.method], body.params);
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
    const id = `e2e-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(504, `The Control Plane did not answer ${method} in time.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      this.log(`e2e → control plane ${method}`);
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
