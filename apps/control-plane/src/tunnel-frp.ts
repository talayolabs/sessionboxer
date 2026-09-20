import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { arch, hostname, platform } from "node:os";
import { join } from "node:path";
import { TUNNEL_NAME_RE, TunnelNameCheck, TunnelServerInfo, type TunnelSettings, type TunnelStatus } from "@sessionboxer/protocol";
import { DATA_DIR } from "./config.js";
import { BIN_DIR, download, findBinary, probeVersion, SupervisedTunnel, untarFile, type Binary } from "./tunnel-base.js";

/**
 * frp release downloaded when the machine has no `frpc`. Pinned with the SHA-256 of each asset we
 * use (from `frp_sha256_checksums.txt` of that release); `SESSIONBOXER_FRP_VERSION` overrides, in
 * which case the checksums file of that release is fetched.
 */
export const FRP_VERSION = process.env.SESSIONBOXER_FRP_VERSION ?? "0.71.0";
const PINNED_SHA256: Record<string, string> = {
  "frp_0.71.0_linux_amd64.tar.gz": "84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716",
  "frp_0.71.0_linux_arm64.tar.gz": "f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266",
  "frp_0.71.0_darwin_amd64.tar.gz": "1b1b4e2f1836e21e8733f1dddaacd4ed9ae67d7dbee39046b9d7b7eda6253637",
  "frp_0.71.0_darwin_arm64.tar.gz": "45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6",
};
const RELEASES = "https://github.com/fatedier/frp/releases/download";
/** Where the generated frpc configuration (holds the secret) is written; 0600. */
const FRPC_CONFIG = join(DATA_DIR, "frpc.toml");
/** How long the server has to answer `/api/v1/info`. */
const INFO_TIMEOUT_MS = 10_000;

export type Frpc = Binary;
export type FrpSettings = TunnelSettings["sessionboxer"];

const frpcVersion = (path: string) => probeVersion(path, ["--version"], (out) => /^\s*v?(\d+\.\d+\.\d+\S*)/m.exec(out)?.[1] ?? null);

export async function findFrpc(): Promise<Frpc | null> {
  return findBinary("frpc", frpcVersion);
}

/** `findFrpc()`, downloading the pinned release into `~/.sessionboxer/bin` when needed. */
export async function ensureFrpc(log: (msg: string) => void): Promise<Frpc> {
  const found = await findFrpc();
  if (found) return found;
  const asset = releaseAsset();
  log(`frpc not found; downloading frp ${FRP_VERSION} (${asset})`);
  mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
  const [data, expected] = await Promise.all([download(`${RELEASES}/v${FRP_VERSION}/${asset}`), expectedSha256(asset)]);
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}`);
  const target = join(BIN_DIR, "frpc");
  writeFileSync(`${target}.part`, await untarFile(data, "frpc"));
  renameSync(`${target}.part`, target);
  chmodSync(target, 0o755);
  const version = await frpcVersion(target);
  if (version === null) throw new Error("the downloaded frpc does not run on this machine");
  log(`frpc ${version} installed at ${target}`);
  return { path: target, version };
}

async function expectedSha256(asset: string): Promise<string> {
  const pinned = PINNED_SHA256[asset];
  if (pinned && FRP_VERSION === "0.71.0") return pinned;
  const text = (await download(`${RELEASES}/v${FRP_VERSION}/frp_sha256_checksums.txt`)).toString("utf8");
  const m = new RegExp(`^([0-9a-f]{64})\\s+${asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").exec(text);
  if (!m) throw new Error(`no checksum listed for ${asset} in frp ${FRP_VERSION}`);
  return m[1]!;
}

function releaseAsset(): string {
  const os = platform();
  const cpu = arch();
  const archName = cpu === "x64" ? "amd64" : cpu === "arm64" ? "arm64" : null;
  if (archName !== null && (os === "linux" || os === "darwin")) return `frp_${FRP_VERSION}_${os}_${archName}.tar.gz`;
  throw new Error(`frp is not downloaded automatically for ${os}/${cpu}; install frpc yourself (https://github.com/fatedier/frp/releases).`);
}

/** A tunnel name from the machine's hostname: lowercase, `-` for anything else, 3–40 characters. */
export function defaultTunnelName(): string {
  const base = hostname()
    .toLowerCase()
    .split(".")[0]!
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return TUNNEL_NAME_RE.test(base) ? base : "sessionboxer";
}

/** The name a laptop uses: the configured one, else `defaultTunnelName()`. */
export function tunnelName(settings: FrpSettings): string {
  return settings.name.trim() !== "" ? settings.name.trim() : defaultTunnelName();
}

function serverUrl(server: string): string {
  const s = server.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(s)) throw new Error("the tunnel server must be an http(s) URL");
  return s;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "sessionboxer" }, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** What the server says about itself (`/api/v1/info`). */
export async function tunnelServerInfo(server: string): Promise<TunnelServerInfo> {
  const parsed = TunnelServerInfo.safeParse(await fetchJson(`${serverUrl(server)}/api/v1/info`));
  if (!parsed.success) throw new Error("that address is not a Sessionboxer tunnel server (unexpected /api/v1/info)");
  return parsed.data;
}

/** Whether `name` is free on the server (it cannot tell whose a taken name is). */
export async function checkTunnelName(server: string, name: string): Promise<TunnelNameCheck> {
  if (!TUNNEL_NAME_RE.test(name)) return { name, available: false, reserved: false };
  return TunnelNameCheck.parse(await fetchJson(`${serverUrl(server)}/api/v1/names/${encodeURIComponent(name)}`));
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

/**
 * Runs `frpc` against a Sessionboxer tunnel server while enabled: the laptop dials out to frps
 * (port from `/api/v1/info`), presents its name and secret (the server's registry binds the name to
 * the secret at first login and refuses other secrets afterwards), and exposes the Control Plane as
 * `https://<name>.<domain>`. TLS ends at the server, which forwards `X-Forwarded-For/Proto`; requests
 * arrive here from 127.0.0.1 with that hostname as `Host`. frpc reconnects by itself; only its exit,
 * or a changed configuration, restarts it.
 */
export class FrpTunnel extends SupervisedTunnel {
  private settings: FrpSettings;

  constructor(
    /** The Control Plane's own listener (`http://127.0.0.1:4000`); frp's `http` proxy needs plain HTTP. */
    private readonly origin: string,
    settings: FrpSettings,
    onChange: (status: TunnelStatus) => void,
    log: (msg: string) => void,
  ) {
    super("sessionboxer tunnel", onChange, log);
    this.settings = settings;
  }

  /** Applies new settings: restarts frpc when something it uses changed, then follows `enabled`. */
  async configure(settings: FrpSettings): Promise<void> {
    const changed = settings.server !== this.settings.server || settings.name !== this.settings.name || settings.secret !== this.settings.secret;
    this.settings = settings;
    if (changed && this.enabled && settings.enabled) await this.restart();
    await this.set(settings.enabled);
  }

  protected async spawnOnce(): Promise<void> {
    if (!this.enabled || this.child) return;
    this.update({ state: "starting", url: null });
    const local = new URL(this.origin);
    if (local.protocol !== "http:") {
      this.failed("the Sessionboxer tunnel needs the Control Plane on plain HTTP (unset SESSIONBOXER_TLS_CERT/KEY); TLS is added by the server");
      return;
    }
    if (this.settings.secret === "") {
      this.failed("no tunnel secret in the settings");
      return;
    }
    const name = tunnelName(this.settings);
    if (!TUNNEL_NAME_RE.test(name)) {
      this.failed(`"${name}" is not a valid tunnel name: 3–40 lowercase letters, digits and dashes, not starting or ending with a dash`);
      return;
    }
    let bin: Frpc;
    let info: TunnelServerInfo;
    try {
      [bin, info] = await Promise.all([ensureFrpc(this.log), tunnelServerInfo(this.settings.server)]);
    } catch (e) {
      this.failed(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!this.enabled || this.child) return;
    this.update({ version: bin.version });
    const url = `https://${name}.${info.domain}`;
    const config = [
      `serverAddr = ${tomlString(info.frps.host)}`,
      `serverPort = ${info.frps.port}`,
      `user = ${tomlString(name)}`,
      `metadatas.secret = ${tomlString(this.settings.secret)}`,
      `metadatas.client = ${tomlString("sessionboxer")}`,
      `loginFailExit = false`,
      `log.disablePrintColor = true`,
      `transport.tls.enable = ${info.frps.tls}`,
      `transport.poolCount = 4`,
      ...(info.frps.token ? [`auth.token = ${tomlString(info.frps.token)}`] : []),
      ``,
      `[[proxies]]`,
      `name = "web"`,
      `type = "http"`,
      `localIP = ${tomlString(local.hostname.replace(/^\[|\]$/g, ""))}`,
      `localPort = ${local.port || 80}`,
      `subdomain = ${tomlString(name)}`,
      ``,
    ].join("\n");
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(FRPC_CONFIG, config, { mode: 0o600 });
    chmodSync(FRPC_CONFIG, 0o600);
    const child = spawn(bin.path, ["-c", FRPC_CONFIG], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let output = "";
    let lastError = "";
    let pending = "";
    const onLine = (line: string) => {
      if (this.child !== child) return;
      if (/\bstart proxy success\b/.test(line)) {
        this.up(url);
        return;
      }
      const m = /(?:connect to server error|start error|login to server failed|reconnect to server error|work connection closed|connection to server is closed)[:\s]*(.*)$/i.exec(line);
      if (m) {
        lastError = (m[1] || line.replace(/^.*?\]\s*/, "")).trim().slice(0, 300) || "connection to the tunnel server lost";
        if (this.status.state === "up") this.log(`sessionboxer tunnel: ${lastError}`);
        this.update({ state: this.status.state === "up" ? "error" : this.status.state, url: null, error: lastError });
      }
    };
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_384);
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      this.log(`sessionboxer tunnel: frpc could not start: ${e.message}`);
      lastError = e.message;
    });
    this.watch(child, () => lastError || output.trim().split("\n").at(-1)?.replace(/^.*?\]\s*/, "").slice(0, 300) || "", null);
  }
}
