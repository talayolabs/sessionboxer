import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CODE_PATH, type CodeOpenParams, type CodeServerStatus } from "@sessionboxer/protocol";
import { caEnv } from "./ca-env.js";

const env = process.env;
const COMMAND = env.SESSIONBOXER_CODE_COMMAND ?? "openvscode-server";
/** Loopback only: the Daemon's reverse proxy is the sole way in. */
const PORT = Number(env.SESSIONBOXER_CODE_PORT ?? 7100);
/** Where the built-in Sessionboxer extension (in the remote extension host) takes open requests. */
const OPEN_PORT = Number(env.SESSIONBOXER_CODE_OPEN_PORT ?? 7101);
const START_TIMEOUT_MS = 90_000;
/** A window has to connect and start its extension host before an open request can land. */
const OPEN_TIMEOUT_MS = 45_000;
const STOP_GRACE_MS = 5_000;
const STDERR_TAIL_LINES = 20;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The launcher is a shell script around node, so signal the whole process group. */
function signalTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (proc.pid) process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    proc.kill(signal);
  }
}

/**
 * VS Code for the Code pane: `openvscode-server` on the loopback interface, started on the
 * first request and kept until the Sandbox stops. Requests under `CODE_PATH` on the Daemon's
 * HTTP port (plain and WebSocket upgrades) are forwarded to it with the prefix stripped; the
 * `X-Forwarded-Prefix` the Control Plane sets tells the server the path the browser sees.
 */
export class CodeServer {
  private proc: ChildProcess | null = null;
  private state: CodeServerStatus["state"] = "stopped";
  private error: string | null = null;
  private startedAt: string | null = null;
  private starting: Promise<CodeServerStatus> | null = null;
  /** Resolves once the last stopped process has released the port. */
  private stopping: Promise<void> = Promise.resolve();
  private stderrTail: string[] = [];
  private readonly version = readVersion();

  constructor(
    private readonly workspace: string,
    private readonly log: (msg: string) => void,
  ) {}

  status(): CodeServerStatus {
    return { state: this.state, version: this.version, error: this.error, startedAt: this.startedAt };
  }

  start(): Promise<CodeServerStatus> {
    if (this.state === "running") return Promise.resolve(this.status());
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  stop(): CodeServerStatus {
    const proc = this.proc;
    this.state = "stopped";
    this.error = null;
    this.startedAt = null;
    if (proc) {
      this.proc = null;
      this.stopping = new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(hardKill);
          resolve();
        };
        const hardKill = setTimeout(() => {
          signalTree(proc, "SIGKILL");
          setTimeout(done, 500).unref();
        }, STOP_GRACE_MS);
        hardKill.unref();
        proc.once("exit", done);
        signalTree(proc, "SIGTERM");
      });
      this.log("code server stopped");
    }
    return this.status();
  }

  /**
   * Shows a Workspace file (at a line) in the editor a window is connected to: starts the
   * server if needed, then hands the request to the Sessionboxer extension, waiting for an
   * extension host to appear (the Code pane may be loading right now).
   */
  async open(params: CodeOpenParams): Promise<void> {
    const path = this.resolvePath(params.path);
    const status = await this.start();
    if (status.state !== "running") throw new Error(status.error ?? "VS Code is not running in this Sandbox.");
    const body = JSON.stringify({ path, line: params.line, column: params.column });
    const deadline = Date.now() + OPEN_TIMEOUT_MS;
    let last = "";
    while (Date.now() < deadline) {
      const result = await postOpen(body);
      if (result.ok) {
        this.log(`opened ${path}${params.line ? `:${params.line}` : ""}`);
        return;
      }
      if (result.status === 400) throw new Error(result.error);
      last = result.error;
      await sleep(500);
    }
    throw new Error(`VS Code has no window connected to open the file in (${last}); open the Code pane and retry.`);
  }

  /** Absolute path inside the Workspace, whatever form the chat used. */
  private resolvePath(path: string): string {
    const abs = resolve(isAbsolute(path) ? path : join(this.workspace, path));
    const rel = relative(this.workspace, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside the Workspace`);
    return abs;
  }

  private async launch(): Promise<CodeServerStatus> {
    this.state = "starting";
    this.error = null;
    this.stderrTail = [];
    await this.stopping;
    if (this.state !== "starting") return this.status();
    const args = [
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--without-connection-token",
      "--accept-server-license-terms",
      "--disable-workspace-trust",
      "--telemetry-level",
      "off",
      "--default-folder",
      this.workspace,
    ];
    let proc: ChildProcess;
    try {
      proc = spawn(COMMAND, args, {
        cwd: this.workspace,
        env: { ...process.env, ...caEnv(), SESSIONBOXER_CODE_OPEN_PORT: String(OPEN_PORT) },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e));
    }
    this.proc = proc;
    proc.stdout?.on("data", (chunk: Buffer) => this.log(`code server: ${chunk.toString().trimEnd()}`));
    proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
        this.log(`code server: ${line}`);
      }
    });
    proc.on("error", (e: NodeJS.ErrnoException) => {
      const message =
        e.code === "ENOENT"
          ? `${COMMAND} is not installed in this Sandbox image; rebuild the image (npm run build:image) and Stop → Resume the Session.`
          : e.message;
      if (this.proc === proc) this.proc = null;
      this.fail(message);
    });
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      const detail = this.stderrTail.length ? `: ${this.stderrTail.slice(-3).join(" | ")}` : "";
      this.fail(`openvscode-server exited (${code ?? signal ?? "?"})${detail}`);
    });
    this.log(`code server starting (pid ${proc.pid ?? "?"}, 127.0.0.1:${PORT})`);

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.state !== "starting") return this.status();
      if (await this.probe()) {
        this.state = "running";
        this.startedAt = new Date().toISOString();
        this.log("code server ready");
        return this.status();
      }
      await sleep(250);
    }
    this.proc = null;
    signalTree(proc, "SIGKILL");
    return this.fail(`openvscode-server did not answer within ${START_TIMEOUT_MS / 1000} s`);
  }

  private fail(message: string): CodeServerStatus {
    this.state = "failed";
    this.error = message;
    this.startedAt = null;
    this.log(`code server failed: ${message}`);
    return this.status();
  }

  private probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port: PORT, path: "/version", method: "GET", timeout: 1000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  /** Forwards a plain HTTP request under `CODE_PATH`; `false` when the path is not ours. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    const target = stripPrefix(req.url ?? "/");
    if (target === null) return false;
    if (this.state !== "running") {
      res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: this.unavailableMessage() }));
      return true;
    }
    const upstream = httpRequest(
      { host: "127.0.0.1", port: PORT, method: req.method, path: target, headers: { ...req.headers, host: `127.0.0.1:${PORT}` } },
      (ures) => {
        res.writeHead(ures.statusCode ?? 502, ures.headers);
        ures.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`code server unreachable: ${e.message}`);
    });
    req.pipe(upstream);
    return true;
  }

  /** Splices a WebSocket upgrade under `CODE_PATH` straight through; `false` when not ours. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const target = stripPrefix(req.url ?? "/");
    if (target === null) return false;
    if (this.state !== "running") {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return true;
    }
    const upstream = connect(PORT, "127.0.0.1", () => {
      const lines = [`${req.method ?? "GET"} ${target} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i] ?? "";
        const value = name.toLowerCase() === "host" ? `127.0.0.1:${PORT}` : (req.rawHeaders[i + 1] ?? "");
        lines.push(`${name}: ${value}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", (e) => {
      this.log(`code server upgrade failed: ${e.message}`);
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    return true;
  }

  private unavailableMessage(): string {
    switch (this.state) {
      case "starting":
        return "VS Code is starting; retry in a moment.";
      case "failed":
        return this.error ?? "VS Code failed to start.";
      default:
        return "VS Code is not running in this Sandbox.";
    }
  }
}

type OpenResult = { ok: true } | { ok: false; status: number | null; error: string };

/** One attempt at the extension's `/open`; `status: null` when nothing is listening yet. */
function postOpen(body: string): Promise<OpenResult> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: OPEN_PORT,
        path: "/open",
        method: "POST",
        timeout: 10_000,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode === 200) return resolve({ ok: true });
          let error = `extension answered ${res.statusCode ?? "?"}`;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: unknown };
            if (typeof parsed.error === "string") error = parsed.error;
          } catch {
            // not JSON; keep the status text
          }
          resolve({ ok: false, status: res.statusCode ?? null, error });
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, status: null, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: null, error: "extension did not answer" });
    });
    req.end(body);
  });
}

/** `/code/x?y` → `/x?y`, `/code` → `/`, anything else → `null`. */
function stripPrefix(url: string): string | null {
  if (url === CODE_PATH) return "/";
  if (url.startsWith(`${CODE_PATH}/`)) return url.slice(CODE_PATH.length);
  if (url.startsWith(`${CODE_PATH}?`)) return `/${url.slice(CODE_PATH.length)}`;
  return null;
}

/** Version of the installed server from the package.json next to its launcher, if any. */
function readVersion(): string | null {
  try {
    const bin = realpathSync(
      (process.env.PATH ?? "")
        .split(":")
        .map((dir) => join(dir, COMMAND))
        .find((candidate) => {
          try {
            realpathSync(candidate);
            return true;
          } catch {
            return false;
          }
        }) ?? COMMAND,
    );
    const pkg = JSON.parse(readFileSync(join(dirname(bin), "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
