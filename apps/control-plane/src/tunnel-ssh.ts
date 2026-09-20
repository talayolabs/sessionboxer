import { spawn } from "node:child_process";
import type { TunnelSettings, TunnelStatus } from "@sessionboxer/protocol";
import { findBinary, probeVersion, SupervisedTunnel, type Binary } from "./tunnel-base.js";

export type SshSettings = TunnelSettings["ssh"];

/** Authentication plus the forward must be done by then; a hung TCP connect is caught by `ConnectTimeout` before. */
const START_TIMEOUT_MS = 45_000;

const sshVersion = (path: string) => probeVersion(path, ["-V"], (out) => /OpenSSH[_ ]([\w.]+)/.exec(out)?.[1] ?? out.trim().split("\n")[0] ?? null);

export async function findSsh(): Promise<Binary | null> {
  return findBinary("ssh", sshVersion, process.platform === "win32" ? [`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\OpenSSH`] : []);
}

/** The URL a phone opens for an SSH transport: the configured one, else `http://<host>:<remotePort>`. */
export function sshPublicUrl(settings: SshSettings): string | null {
  const configured = settings.publicUrl.trim().replace(/\/+$/, "");
  if (configured !== "") return /^https?:\/\//.test(configured) ? configured : null;
  const host = settings.host.trim();
  if (host === "" || settings.remoteBind === "localhost") return null;
  return `http://${host.includes(":") ? `[${host}]` : host}:${settings.remotePort}`;
}

/**
 * Runs `ssh -N -R <remotePort>:<control plane>` to a server of yours while enabled: sshd there
 * listens on `remotePort` (every interface with `GatewayPorts yes`, or localhost for a reverse
 * proxy you run on it) and forwards each connection back here. Key authentication only
 * (`BatchMode`); the host key is pinned in `known_hosts` on first use and refused when it changes.
 * `ServerAliveInterval` notices a dead connection; an exit restarts ssh with back-off.
 */
export class SshTunnel extends SupervisedTunnel {
  private settings: SshSettings;

  constructor(
    /** The Control Plane's own listener. */
    private readonly origin: string,
    settings: SshSettings,
    onChange: (status: TunnelStatus) => void,
    log: (msg: string) => void,
  ) {
    super("ssh tunnel", onChange, log);
    this.settings = settings;
  }

  async configure(settings: SshSettings): Promise<void> {
    const changed = JSON.stringify({ ...settings, enabled: false }) !== JSON.stringify({ ...this.settings, enabled: false });
    this.settings = settings;
    if (changed && this.enabled && settings.enabled) await this.restart();
    await this.set(settings.enabled);
  }

  protected async spawnOnce(): Promise<void> {
    if (!this.enabled || this.child) return;
    this.update({ state: "starting", url: null });
    const s = this.settings;
    const host = s.host.trim();
    if (host === "") {
      this.failed("no server host set");
      return;
    }
    const url = sshPublicUrl(s);
    if (url === null) {
      this.failed(
        s.publicUrl.trim() !== ""
          ? "the public URL must start with http:// or https://"
          : "binding on localhost only makes sense behind a reverse proxy on the server: set the public URL it serves",
      );
      return;
    }
    const bin = await findSsh();
    if (bin === null) {
      this.failed("no ssh client found on this machine");
      return;
    }
    if (!this.enabled || this.child) return;
    this.update({ version: bin.version });
    const local = new URL(this.origin);
    const bind = s.remoteBind === "localhost" ? "localhost" : "*";
    const args = [
      "-N",
      "-v",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "ConnectTimeout=20",
      "-p", String(s.port),
      ...(s.identityFile.trim() !== "" ? ["-o", "IdentitiesOnly=yes", "-i", s.identityFile.trim()] : []),
      "-R", `${bind}:${s.remotePort}:${local.hostname.replace(/^\[|\]$/g, "")}:${local.port || (local.protocol === "https:" ? 443 : 80)}`,
      "--",
      s.user.trim() !== "" ? `${s.user.trim()}@${host}` : host,
    ];
    const child = spawn(bin.path, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
    let lastError = "";
    let pending = "";
    const onLine = (raw: string) => {
      const line = raw.trim();
      if (this.child !== child || line === "") return;
      if (/remote forward success for:/.test(line)) {
        this.up(url);
        return;
      }
      if (/^debug\d:/.test(line)) {
        if (/^debug1: (Connection to .* closed|Exit status)/.test(line) && this.status.state === "up") lastError = "connection to the server closed";
        return;
      }
      // Outside its debug lines ssh prints its banner, host-key notes, and complaints: refused keys, host key changes, failed forwards.
      if (/^(OpenSSH_|Warning: Permanently added|Adding new key)/.test(line)) return;
      lastError = line.replace(/^(ssh: |Error: |Warning: )/, "").slice(0, 300);
      if (this.status.state === "up" && /closed|fail|refused|denied|timed out|error|reset|broken pipe/i.test(line)) this.update({ state: "error", url: null, error: lastError });
      else if (this.status.state !== "up") this.update({ error: lastError });
    };
    const onData = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      this.log(`ssh tunnel: ssh could not start: ${e.message}`);
      lastError = e.message;
    });
    this.watch(child, () => lastError, START_TIMEOUT_MS);
  }
}
