import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import type { TunnelStatus } from "@sessionboxer/protocol";
import { DATA_DIR } from "./config.js";

/**
 * cloudflared release downloaded when the machine has none. Pinned with the SHA-256 of each
 * asset we use (from the release notes); `SESSIONBOXER_CLOUDFLARED_VERSION` overrides, in which
 * case the checksums are read from that release's notes on GitHub.
 */
export const CLOUDFLARED_VERSION = process.env.SESSIONBOXER_CLOUDFLARED_VERSION ?? "2026.9.1";
const PINNED_SHA256: Record<string, string> = {
  "cloudflared-linux-amd64": "03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc",
  "cloudflared-linux-arm64": "3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3",
  "cloudflared-darwin-amd64.tgz": "1ea07ae775b03236bd6be18ca1848d6bdc4af2f4f3bce398823b5a36e5761b75",
  "cloudflared-darwin-arm64.tgz": "9a0b19f67dc7a3011bc6b972c7ce06a5fcea8784ac6bd599ffa382ea4aeb5a6e",
  "cloudflared-windows-amd64.exe": "2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712",
};
const RELEASES = "https://github.com/cloudflare/cloudflared/releases/download";
const RELEASE_API = "https://api.github.com/repos/cloudflare/cloudflared/releases/tags";
export const BIN_DIR = join(DATA_DIR, "bin");

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/** cloudflared reconnects by itself; only a process exit needs us. Back off so a broken network does not spin. */
const RESTART_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** A quick tunnel that has not printed its URL by then is stuck (no network, Cloudflare down). */
const START_TIMEOUT_MS = 45_000;

export interface Cloudflared {
  path: string;
  version: string;
}

/** `cloudflared` from PATH, or the copy Sessionboxer downloaded earlier; `null` when neither exists. */
export async function findCloudflared(): Promise<Cloudflared | null> {
  const names = platform() === "win32" ? ["cloudflared.exe", "cloudflared"] : ["cloudflared"];
  const dirs = [BIN_DIR, ...(process.env.PATH ?? "").split(delimiter).filter((d) => d !== "")];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      const version = await cloudflaredVersion(candidate);
      if (version !== null) return { path: candidate, version };
    }
  }
  return null;
}

/** `findCloudflared()`, downloading the pinned release into `~/.sessionboxer/bin` when needed. */
export async function ensureCloudflared(log: (msg: string) => void): Promise<Cloudflared> {
  const found = await findCloudflared();
  if (found) return found;
  const asset = releaseAsset();
  log(`cloudflared not found; downloading ${CLOUDFLARED_VERSION} (${asset.name})`);
  mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
  const stage = join(BIN_DIR, `.cloudflared-${CLOUDFLARED_VERSION}`);
  rmSync(stage, { recursive: true, force: true });
  try {
    const [data, expected] = await Promise.all([download(`${RELEASES}/${CLOUDFLARED_VERSION}/${asset.name}`), expectedSha256(asset.name)]);
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expected) throw new Error(`checksum mismatch for ${asset.name}`);
    const target = join(BIN_DIR, asset.binary);
    if (asset.name.endsWith(".tgz")) {
      mkdirSync(stage, { recursive: true });
      const staged = join(stage, asset.binary);
      await untarFile(data, asset.binary, staged);
      renameSync(staged, target);
    } else {
      writeFileSync(`${target}.part`, data);
      renameSync(`${target}.part`, target);
    }
    if (platform() !== "win32") chmodSync(target, 0o755);
    const version = await cloudflaredVersion(target);
    if (version === null) throw new Error("the downloaded cloudflared does not run on this machine");
    log(`cloudflared ${version} installed at ${target}`);
    return { path: target, version };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function expectedSha256(assetName: string): Promise<string> {
  const pinned = PINNED_SHA256[assetName];
  if (pinned && CLOUDFLARED_VERSION === "2026.9.1") return pinned;
  // Cloudflare lists the checksums in the release notes, not in a separate file.
  const res = await fetch(`${RELEASE_API}/${CLOUDFLARED_VERSION}`, { headers: { "user-agent": "sessionboxer", accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`could not read the cloudflared ${CLOUDFLARED_VERSION} release notes (${res.status})`);
  const body = ((await res.json()) as { body?: string }).body ?? "";
  const m = new RegExp(`^\\s*${assetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([0-9a-f]{64})\\s*$`, "m").exec(body);
  if (!m) throw new Error(`no checksum listed for ${assetName} in the ${CLOUDFLARED_VERSION} release notes`);
  return m[1]!;
}

async function untarFile(targz: Buffer, name: string, dest: string): Promise<void> {
  let found = false;
  const tar = extract();
  tar.on("entry", (header, stream, next) => {
    if (header.type === "file" && (header.name === name || header.name.endsWith(`/${name}`)) && !found) {
      found = true;
      const chunks: Buffer[] = [];
      stream.on("data", (c) => chunks.push(Buffer.from(c as Uint8Array)));
      stream.on("end", () => {
        writeFileSync(dest, Buffer.concat(chunks));
        next();
      });
    } else {
      stream.on("end", next);
      stream.resume();
    }
  });
  await pipeline(Readable.from([targz]), createGunzip(), tar);
  if (!found) throw new Error(`archive did not contain ${name}`);
}

function releaseAsset(): { name: string; binary: string } {
  const os = platform();
  const cpu = arch();
  const archName = cpu === "x64" ? "amd64" : cpu === "arm64" ? "arm64" : null;
  if (archName === null) throw new Error(`cloudflared has no release for ${os}/${cpu}; install cloudflared yourself.`);
  if (os === "linux") return { name: `cloudflared-linux-${archName}`, binary: "cloudflared" };
  if (os === "darwin") return { name: `cloudflared-darwin-${archName}.tgz`, binary: "cloudflared" };
  if (os === "win32" && archName === "amd64") return { name: "cloudflared-windows-amd64.exe", binary: "cloudflared.exe" };
  throw new Error(`cloudflared has no release for ${os}/${cpu}; install cloudflared yourself.`);
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "sessionboxer" } });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function cloudflaredVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(path, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
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
      resolve(code === 0 ? (/cloudflared version (\S+)/.exec(out)?.[1] ?? null) : null);
    });
  });
}

/**
 * Runs `cloudflared tunnel --url <origin>` while enabled and keeps it running: a Cloudflare quick
 * tunnel (no account) that gives this Control Plane a random public `https://….trycloudflare.com`.
 * Cloudflare terminates TLS, so the browser sees a real certificate; requests arrive here from
 * 127.0.0.1 with the tunnel's hostname as `Host` and the visitor in `X-Forwarded-For`.
 */
export class QuickTunnel {
  private status: TunnelStatus = { state: "off", url: null, error: null, version: null };
  private child: ChildProcess | null = null;
  private enabled = false;
  private attempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;

  constructor(
    /** What cloudflared connects to: the Control Plane's own listener. */
    private readonly origin: string,
    private readonly onChange: (status: TunnelStatus) => void,
    private readonly log: (msg: string) => void,
  ) {}

  current(): TunnelStatus {
    return this.status;
  }

  /** Hostname of the tunnel while it is up (what `Host` says on requests that came through it). */
  host(): string | null {
    return this.status.state === "up" && this.status.url ? new URL(this.status.url).host : null;
  }

  /** Turns the tunnel on or off; idempotent. Resolves once cloudflared is running or the start failed (state tells). */
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

  private async spawnOnce(): Promise<void> {
    if (!this.enabled || this.child) return;
    this.update({ state: "starting", url: null });
    let bin: Cloudflared;
    try {
      bin = await ensureCloudflared(this.log);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log(`quick tunnel: ${error}`);
      this.update({ state: "error", error });
      this.scheduleRestart();
      return;
    }
    if (!this.enabled) return;
    this.update({ version: bin.version });
    const args = ["tunnel", "--url", this.origin, "--no-autoupdate", "--metrics", "127.0.0.1:0"];
    if (this.origin.startsWith("https:")) args.push("--no-tls-verify");
    const child = spawn(bin.path, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    this.child = child;
    let output = "";
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_384);
      if (this.child === child && this.status.state !== "up") {
        const url = URL_RE.exec(output)?.[0];
        if (url) {
          this.clearStartTimer();
          this.attempt = 0;
          this.log(`quick tunnel up at ${url}`);
          this.update({ state: "up", url, error: null });
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      this.log(`quick tunnel: cloudflared could not start: ${e.message}`);
      output += `\n${e.message}`;
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearStartTimer();
      if (!this.enabled) return;
      const reason = lastError(output) || (signal === "SIGTERM" && this.status.error) || `cloudflared exited (${signal ?? code})`;
      this.log(`quick tunnel: ${reason}`);
      this.update({ state: "error", url: null, error: reason });
      this.scheduleRestart();
    });
    this.startTimer = setTimeout(() => {
      if (this.child === child && this.status.state !== "up") {
        this.log("quick tunnel: no URL after 45 s, restarting cloudflared");
        this.update({ error: lastError(output) || "cloudflared did not get a tunnel URL in time" });
        child.kill("SIGTERM");
      }
    }, START_TIMEOUT_MS);
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

  private stop(): void {
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

  /** Same as `set(false)` but silent: for shutdown. */
  close(): void {
    this.enabled = false;
    this.stop();
  }

  private update(patch: Partial<TunnelStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onChange(this.status);
  }
}

/**
 * The last error cloudflared logged (`<time> ERR <message>` lines; its startup warnings such as the
 * UDP buffer size are WRN and not failures), or a bare last line when it printed no log lines at all
 * (e.g. a usage error), else "".
 */
function lastError(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const logged = lines.filter((l) => /^\S+\s+(INF|WRN|ERR)\s/.test(l));
  const err = [...logged].reverse().find((l) => /^\S+\s+ERR\s/.test(l));
  if (err) return err.replace(/^\S+\s+ERR\s+/, "").slice(0, 300);
  if (logged.length > 0) return "";
  return (lines.filter((l) => !/^\+-+\+$|^\|.*\|$/.test(l)).at(-1) ?? "").slice(0, 300);
}
