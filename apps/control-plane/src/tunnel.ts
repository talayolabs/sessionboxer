import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type { TunnelStatus } from "@sessionboxer/protocol";
import { BIN_DIR, download, findBinary, probeVersion, SupervisedTunnel, untarFile, type Binary } from "./tunnel-base.js";

export { BIN_DIR } from "./tunnel-base.js";

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

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/** A quick tunnel that has not printed its URL by then is stuck (no network, Cloudflare down). */
const START_TIMEOUT_MS = 45_000;

export type Cloudflared = Binary;

const cloudflaredVersion = (path: string) => probeVersion(path, ["--version"], (out) => /cloudflared version (\S+)/.exec(out)?.[1] ?? null);

/** `cloudflared` from PATH, or the copy Sessionboxer downloaded earlier; `null` when neither exists. */
export async function findCloudflared(): Promise<Cloudflared | null> {
  return findBinary("cloudflared", cloudflaredVersion);
}

/** `findCloudflared()`, downloading the pinned release into `~/.sessionboxer/bin` when needed. */
export async function ensureCloudflared(log: (msg: string) => void): Promise<Cloudflared> {
  const found = await findCloudflared();
  if (found) return found;
  const asset = releaseAsset();
  log(`cloudflared not found; downloading ${CLOUDFLARED_VERSION} (${asset.name})`);
  mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
  const [data, expected] = await Promise.all([download(`${RELEASES}/${CLOUDFLARED_VERSION}/${asset.name}`), expectedSha256(asset.name)]);
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset.name}`);
  const target = join(BIN_DIR, asset.binary);
  writeFileSync(`${target}.part`, asset.name.endsWith(".tgz") ? await untarFile(data, asset.binary) : data);
  renameSync(`${target}.part`, target);
  if (platform() !== "win32") chmodSync(target, 0o755);
  const version = await cloudflaredVersion(target);
  if (version === null) throw new Error("the downloaded cloudflared does not run on this machine");
  log(`cloudflared ${version} installed at ${target}`);
  return { path: target, version };
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

/**
 * Runs `cloudflared tunnel --url <origin>` while enabled and keeps it running: a Cloudflare quick
 * tunnel (no account) that gives this Control Plane a random public `https://….trycloudflare.com`.
 * Cloudflare terminates TLS, so the browser sees a real certificate; requests arrive here from
 * 127.0.0.1 with the tunnel's hostname as `Host` and the visitor in `X-Forwarded-For`.
 */
export class QuickTunnel extends SupervisedTunnel {
  constructor(
    /** What cloudflared connects to: the Control Plane's own listener. */
    private readonly origin: string,
    onChange: (status: TunnelStatus) => void,
    log: (msg: string) => void,
  ) {
    super("quick tunnel", onChange, log);
  }

  protected async spawnOnce(): Promise<void> {
    if (!this.enabled || this.child) return;
    this.update({ state: "starting", url: null });
    let bin: Cloudflared;
    try {
      bin = await ensureCloudflared(this.log);
    } catch (e) {
      this.failed(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!this.enabled) return;
    this.update({ version: bin.version });
    const args = ["tunnel", "--url", this.origin, "--no-autoupdate", "--metrics", "127.0.0.1:0"];
    if (this.origin.startsWith("https:")) args.push("--no-tls-verify");
    const child = spawn(bin.path, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let output = "";
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_384);
      if (this.child === child && this.status.state !== "up") {
        const url = URL_RE.exec(output)?.[0];
        if (url) this.up(url);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      this.log(`quick tunnel: cloudflared could not start: ${e.message}`);
      output += `\n${e.message}`;
    });
    this.watch(child, () => lastError(output), START_TIMEOUT_MS);
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
