import WebSocket from "ws";
import {
  DAEMON_METHODS,
  DaemonStatus,
  FsChangedParams,
  PtyExitParams,
  PtyOutputParams,
  isJsonRpcResponse,
  parseJsonRpc,
  type DaemonEvent,
  type DaemonHelloParams,
  type FsChange,
  type JsonRpcId,
} from "@sessionboxer/protocol";

export interface DaemonClientHandlers {
  onEvent: (event: DaemonEvent) => void;
  onStatus: (status: DaemonStatus) => void;
  onFsChanged: (changes: FsChange[]) => void;
  onPtyOutput: (ptyId: string, data: Buffer) => void;
  onPtyExit: (ptyId: string, exitCode: number) => void;
  onConnected: (status: DaemonStatus) => void;
  onDisconnected: () => void;
  /** Cursor sent in `hello`, so the Daemon replays what we missed. */
  cursor: () => DaemonHelloParams;
  log: (msg: string) => void;
}

export class DaemonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
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
  private waiters: Array<() => void> = [];
  connected = false;

  constructor(
    private readonly url: string,
    private readonly handlers: DaemonClientHandlers,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this.wake();
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
      if ("error" in msg) p.reject(new DaemonRpcError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if ("method" in msg) {
      if (msg.method === DAEMON_METHODS.event) this.handlers.onEvent(msg.params as DaemonEvent);
      else if (msg.method === DAEMON_METHODS.status) this.handlers.onStatus(DaemonStatus.parse(msg.params));
      else if (msg.method === DAEMON_METHODS.fsChanged) this.handlers.onFsChanged(FsChangedParams.parse(msg.params).changes);
      else if (msg.method === DAEMON_METHODS.ptyOutput) {
        const p = PtyOutputParams.parse(msg.params);
        this.handlers.onPtyOutput(p.id, Buffer.from(p.data, "base64"));
      } else if (msg.method === DAEMON_METHODS.ptyExit) {
        const p = PtyExitParams.parse(msg.params);
        this.handlers.onPtyExit(p.id, p.exitCode);
      }
    }
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  /** Resolves once connected (true) or after `timeoutMs` / close (false). */
  waitConnected(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise((res) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((f) => f !== fn);
        res(false);
      }, timeoutMs);
      const fn = () => {
        clearTimeout(timer);
        res(this.connected);
      };
      this.waiters.push(fn);
    });
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
