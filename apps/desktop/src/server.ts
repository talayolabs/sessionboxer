import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, utilityProcess, type UtilityProcess } from "electron";

/** Same as the Control Plane and the CLI: `SESSIONBOXER_HOME`, else `~/.sessionboxer`. */
export const DATA_DIR = process.env.SESSIONBOXER_HOME ?? path.join(homedir(), ".sessionboxer");
export const SERVER_URL = (process.env.SESSIONBOXER_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
/** The child's stdout/stderr, under the app's log directory (`~/Library/Logs/Sessionboxer`, `~/.config/Sessionboxer/logs`, `%APPDATA%\Sessionboxer\logs`). */
export const logFile = (): string => path.join(app.getPath("logs"), "control-plane.log");

/** `#pair=<code>` — `PAIR_FRAGMENT_KEY` in `@sessionboxer/protocol`, spelled out here so the shell ships without the protocol package. */
const PAIR_FRAGMENT_KEY = "pair";

const HEALTH_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 20_000;

export type ServerState =
  | { kind: "starting" }
  | { kind: "running"; mode: "spawned" | "attached" }
  | { kind: "stopped"; code: number | null }
  | { kind: "failed"; message: string };

type Listener = (state: ServerState) => void;

export function isLoopback(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

/** `apps/control-plane/dist/index.js`: next to this package in the repo, else under `resources/server` in a packaged app. */
function controlPlaneEntry(): string {
  const packaged = path.join(process.resourcesPath, "server", "node_modules", "sessionboxer", "apps", "control-plane", "dist", "index.js");
  if (app.isPackaged) return packaged;
  const repo = fileURLToPath(new URL("../../control-plane/dist/index.js", import.meta.url));
  return existsSync(repo) ? repo : packaged;
}

/** GUI apps on macOS start with a bare PATH; the Control Plane looks for `docker`, `gh` or `whisper-cli` there too. */
function childPath(): string {
  const extra = process.platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", path.join(homedir(), ".local", "bin"), "/usr/bin", "/bin"];
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return [...current, ...extra.filter((p) => !current.includes(p))].join(path.delimiter);
}

export async function healthy(url = SERVER_URL): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The access token of the Control Plane on this machine, as the CLI reads it. */
export function accessToken(): string {
  const env = process.env.SESSIONBOXER_ACCESS_TOKEN?.trim();
  if (env) return env;
  try {
    const parsed = JSON.parse(readFileSync(path.join(DATA_DIR, "config.json"), "utf8")) as { accessToken?: unknown };
    return typeof parsed.accessToken === "string" ? parsed.accessToken : "";
  } catch {
    return "";
  }
}

/** A one-use login link for the window, minted with the local access token; the plain URL when there is none. */
export async function loginUrl(url = SERVER_URL): Promise<string> {
  const token = accessToken();
  if (token === "") return url;
  try {
    const res = await fetch(`${url}/api/auth/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return url;
    const pairing = (await res.json()) as { code: string };
    return `${url}/#${PAIR_FRAGMENT_KEY}=${pairing.code}`;
  } catch {
    return url;
  }
}

/**
 * The Control Plane behind the window. Attaches to one already answering at `SERVER_URL` (an
 * `npx sessionboxer serve` or Compose install), otherwise runs `apps/control-plane` as a child
 * with Electron's Node, and stops it with SIGTERM when the app quits.
 */
export class Server {
  private child: UtilityProcess | null = null;
  private log: WriteStream | null = null;
  private readonly listeners = new Set<Listener>();
  state: ServerState = { kind: "starting" };
  /** True once this app started the Control Plane itself (as opposed to attaching to one). */
  managed = false;

  constructor(readonly url = SERVER_URL) {}

  onChange(listener: Listener): void {
    this.listeners.add(listener);
  }

  private set(state: ServerState): void {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  async start(env: NodeJS.ProcessEnv = {}): Promise<void> {
    this.set({ kind: "starting" });
    if (await healthy(this.url)) return this.set({ kind: "running", mode: "attached" });
    if (!isLoopback(this.url)) return this.set({ kind: "failed", message: `Nothing answers at ${this.url} (SESSIONBOXER_URL). Start Sessionboxer there first.` });
    this.spawn(env);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.state.kind === "stopped") return this.set({ kind: "failed", message: `The Control Plane exited while starting. Its log is at ${logFile()}.` });
      if (await healthy(this.url)) return this.set({ kind: "running", mode: "spawned" });
      await new Promise((r) => setTimeout(r, 500));
    }
    this.set({ kind: "failed", message: `The Control Plane did not answer at ${this.url} within ${START_TIMEOUT_MS / 1000}s. Its log is at ${logFile()}.` });
  }

  private spawn(env: NodeJS.ProcessEnv): void {
    const { hostname, port } = new URL(this.url);
    mkdirSync(path.dirname(logFile()), { recursive: true });
    this.log ??= createWriteStream(logFile(), { flags: "a" });
    const child = utilityProcess.fork(controlPlaneEntry(), [], {
      serviceName: "sessionboxer-control-plane",
      stdio: "pipe",
      env: {
        ...process.env,
        ...env,
        PATH: childPath(),
        SESSIONBOXER_HOST: hostname,
        SESSIONBOXER_PORT: port === "" ? "4000" : port,
        SESSIONBOXER_HOME: DATA_DIR,
      },
    });
    this.child = child;
    this.managed = true;
    child.stdout?.on("data", (chunk: Buffer) => this.log?.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.log?.write(chunk));
    child.once("exit", (code) => {
      if (this.child === child) this.child = null;
      this.log?.write(`[desktop ${new Date().toISOString()}] control plane exited with code ${code}\n`);
      this.set({ kind: "stopped", code });
    });
  }

  /** Runs the Control Plane again after it exited (or after an attached one went away). */
  restart(env: NodeJS.ProcessEnv = {}): Promise<void> {
    if (this.child || this.state.kind === "starting") return Promise.resolve();
    return this.start(env);
  }

  /** SIGTERM, then waits for the Control Plane's own shutdown (Sessions, tunnels, SQLite). */
  stop(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
}
