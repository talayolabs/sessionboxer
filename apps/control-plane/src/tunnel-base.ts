import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import type { TunnelStatus } from "@sessionboxer/protocol";
import { DATA_DIR } from "./config.js";

/** Where programs the Control Plane downloads for itself live (`cloudflared`, `frpc`). */
export const BIN_DIR = join(DATA_DIR, "bin");

/** The programs reconnect by themselves; only a process exit needs us. Back off so a broken network does not spin. */
export const RESTART_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export interface Binary {
  path: string;
  version: string;
}

/** `name` from `BIN_DIR` first, then the PATH; `null` when nowhere or not runnable. */
export async function findBinary(name: string, version: (path: string) => Promise<string | null>, extraDirs: string[] = []): Promise<Binary | null> {
  const names = platform() === "win32" ? [`${name}.exe`, name] : [name];
  const dirs = [BIN_DIR, ...extraDirs, ...(process.env.PATH ?? "").split(delimiter).filter((d) => d !== "")];
  for (const dir of dirs) {
    for (const file of names) {
      const candidate = join(dir, file);
      if (!existsSync(candidate)) continue;
      const v = await version(candidate);
      if (v !== null) return { path: candidate, version: v };
    }
  }
  return null;
}

/** `fetch` whose failure names the URL and the underlying error (`fetch failed` alone says neither). */
export async function fetchOrExplain(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e instanceof Error ? e : new Error(String(e));
    const code = (cause as NodeJS.ErrnoException).code;
    throw new Error(`cannot fetch ${url}: ${cause.message}${code && !cause.message.includes(code) ? ` (${code})` : ""}`);
  }
}

export async function download(url: string): Promise<Buffer> {
  const res = await fetchOrExplain(url, { redirect: "follow", headers: { "user-agent": "sessionboxer" } });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Extracts the single file `name` (by basename) from a gzipped tarball held in memory. */
export async function untarFile(targz: Buffer, name: string): Promise<Buffer> {
  let found: Buffer | null = null;
  const tar = extract();
  tar.on("entry", (header, stream, next) => {
    if (header.type === "file" && (header.name === name || header.name.endsWith(`/${name}`)) && found === null) {
      const chunks: Buffer[] = [];
      stream.on("data", (c) => chunks.push(Buffer.from(c as Uint8Array)));
      stream.on("end", () => {
        found = Buffer.concat(chunks);
        next();
      });
    } else {
      stream.on("end", next);
      stream.resume();
    }
  });
  await pipeline(Readable.from([targz]), createGunzip(), tar);
  if (found === null) throw new Error(`archive did not contain ${name}`);
  return found;
}

/** Runs `path args…` for up to 10 s and returns what `parse` makes of its output, `null` when it fails to run. */
export async function probeVersion(path: string, args: string[], parse: (out: string) => string | null): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(path, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? parse(out) : null);
    });
  });
}

/**
 * A transport kept running as a child process while enabled: state `off → starting → up`, or
 * `error` with the last failure; an exit while enabled restarts it with back-off. Subclasses spawn
 * the program and read its output to tell `up` from failures.
 */
export abstract class SupervisedTunnel {
  protected status: TunnelStatus = { state: "off", url: null, error: null, version: null };
  protected child: ChildProcess | null = null;
  protected enabled = false;
  private attempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;

  constructor(
    protected readonly label: string,
    private readonly onChange: (status: TunnelStatus) => void,
    protected readonly log: (msg: string) => void,
  ) {}

  current(): TunnelStatus {
    return this.status;
  }

  /** Hostname of the transport while it is up (what `Host` says on requests that came through it). */
  host(): string | null {
    return this.status.state === "up" && this.status.url ? new URL(this.status.url).host : null;
  }

  /** Turns the transport on or off; idempotent. Resolves once the program is running or the start failed (state tells). */
  async set(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.stop();
      this.update({ state: "off", url: null, error: null });
      return;
    }
    this.attempt = 0;
    await this.spawnOnce();
  }

  /** Stops the running program and starts it again with the current configuration (no-op while off). */
  protected async restart(): Promise<void> {
    if (!this.enabled) return;
    this.stop();
    this.attempt = 0;
    this.update({ state: "starting", url: null, error: null });
    await this.spawnOnce();
  }

  /** Same as `set(false)` but silent: for shutdown. */
  close(): void {
    this.enabled = false;
    this.stop();
  }

  protected abstract spawnOnce(): Promise<void>;

  /** Records a failure to start (nothing running) and arranges another attempt. */
  protected failed(error: string): void {
    this.log(`${this.label}: ${error}`);
    this.update({ state: "error", url: null, error });
    this.scheduleRestart();
  }

  /** The program is running and reachable. */
  protected up(url: string): void {
    this.clearStartTimer();
    this.attempt = 0;
    this.log(`${this.label} up at ${url}`);
    this.update({ state: "up", url, error: null });
  }

  /**
   * Adopts a spawned child: its exit while enabled is a failure that restarts it, using `reason()`
   * for the message; `startTimeoutMs` kills it when it has not come up by then.
   */
  protected watch(child: ChildProcess, reason: () => string, startTimeoutMs: number | null): void {
    this.child = child;
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearStartTimer();
      if (!this.enabled) return;
      this.failed(reason() || (signal === "SIGTERM" && this.status.error) || `${this.label}: exited (${signal ?? code})`);
    });
    if (startTimeoutMs !== null) {
      this.startTimer = setTimeout(() => {
        if (this.child === child && this.status.state !== "up") {
          this.log(`${this.label}: not up after ${Math.round(startTimeoutMs / 1000)} s, restarting`);
          this.update({ error: reason() || "did not come up in time" });
          child.kill("SIGTERM");
        }
      }, startTimeoutMs);
    }
  }

  private scheduleRestart(): void {
    if (!this.enabled || this.restartTimer) return;
    const delay = RESTART_MS[Math.min(this.attempt, RESTART_MS.length - 1)]!;
    this.attempt++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawnOnce();
    }, delay);
  }

  protected stop(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.clearStartTimer();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  protected update(patch: Partial<TunnelStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onChange(this.status);
  }
}
