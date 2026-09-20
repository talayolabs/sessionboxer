import type { TunnelKind, TunnelSettings, TunnelStatus, TunnelStatuses } from "@sessionboxer/protocol";
import { QuickTunnel } from "./tunnel.js";
import { FrpTunnel } from "./tunnel-frp.js";
import { SshTunnel } from "./tunnel-ssh.js";

/**
 * The three transports side by side, driven by `Settings.tunnels`: each runs independently, so a
 * phone paired through one keeps working while another is tried. `onChange` fires with every
 * status change of any of them.
 */
export class Tunnels {
  private readonly cloudflare: QuickTunnel;
  private readonly sessionboxer: FrpTunnel;
  private readonly ssh: SshTunnel;

  constructor(origin: string, settings: TunnelSettings, onChange: (kind: TunnelKind, status: TunnelStatus, all: TunnelStatuses) => void, log: (msg: string) => void) {
    const changed = (kind: TunnelKind) => (status: TunnelStatus) => onChange(kind, status, this.statuses());
    this.cloudflare = new QuickTunnel(origin, changed("cloudflare"), log);
    this.sessionboxer = new FrpTunnel(origin, settings.sessionboxer, changed("sessionboxer"), log);
    this.ssh = new SshTunnel(origin, settings.ssh, changed("ssh"), log);
  }

  statuses(): TunnelStatuses {
    return { cloudflare: this.cloudflare.current(), sessionboxer: this.sessionboxer.current(), ssh: this.ssh.current() };
  }

  /** Hostnames of the transports that are up: requests carrying one of them as `Host` from 127.0.0.1 came through a tunnel. */
  hosts(): string[] {
    return [this.cloudflare.host(), this.sessionboxer.host(), this.ssh.host()].filter((h): h is string => h !== null);
  }

  /** Brings every transport in line with `settings` (start, stop, or restart with new parameters). */
  async apply(settings: TunnelSettings): Promise<void> {
    await Promise.all([this.cloudflare.set(settings.cloudflare.enabled), this.sessionboxer.configure(settings.sessionboxer), this.ssh.configure(settings.ssh)]);
  }

  close(): void {
    this.cloudflare.close();
    this.sessionboxer.close();
    this.ssh.close();
  }
}
