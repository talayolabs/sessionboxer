import WebSocket from "ws";
import {
  DAEMON_METHODS,
  DAEMON_PORT,
  DaemonStatus,
  isJsonRpcResponse,
  parseJsonRpc,
  type DaemonEvent,
  type DaemonHelloParams,
  type JsonRpcId,
} from "@sessionboxer/protocol";

export interface DaemonClientHandlers {
  onEvent: (event: DaemonEvent) => void;
  onStatus: (status: DaemonStatus) => void;
  onConnected: (status: DaemonStatus) => void;
  onDisconnected: () => void;
  /** Cursor sent in `hello`, so the Daemon replays what we missed. */
  cursor: () => DaemonHelloParams;
  log: (msg: string) => void;
}

const RECONNECT_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One connection to a Sandbox Daemon. Reconnects until `close()` is called.
 */
export class DaemonClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  connected = false;

  constructor(
    private readonly host: string,
    private readonly handlers: DaemonClientHandlers,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(`ws://${this.host}:${DAEMON_PORT}`);
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this.request(DAEMON_METHODS.hello, this.handlers.cursor())
        .then((raw) => this.handlers.onConnected(DaemonStatus.parse(raw)))
        .catch((e: unknown) => this.handlers.log(`hello failed: ${String(e)}`));
    });
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("error", (e) => {
      if (this.connected) this.handlers.log(`ws error: ${e.message}`);
    });
    ws.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("daemon connection closed"));
      }
      this.pending.clear();
      if (wasConnected) this.handlers.onDisconnected();
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
    });
  }

  private onMessage(raw: string): void {
    let msg;
    try {
      msg = parseJsonRpc(raw);
    } catch (e) {
      this.handlers.log(`bad message from daemon: ${String(e)}`);
      return;
    }
    if (isJsonRpcResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if ("error" in msg) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if ("method" in msg) {
      if (msg.method === DAEMON_METHODS.event) this.handlers.onEvent(msg.params as DaemonEvent);
      else if (msg.method === DAEMON_METHODS.status) this.handlers.onStatus(DaemonStatus.parse(msg.params));
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("daemon not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
