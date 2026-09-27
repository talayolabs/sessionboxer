import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import { SANDBOX_IMAGE, SANDBOX_NETWORK } from "./config.js";
import { log } from "./log.js";

/**
 * What the Windows (ADR-0057) and macOS (ADR-0059) VM sidecars share: the KVM probe, the
 * dockur images and their QEMU/KVM container shape, throwaway helper containers on those
 * images (they carry qemu-img), volumes and their real size, and Docker's log framing.
 */
export const VM_LOG_LINES = 40;
/** A guest shutdown request must get through before the container is killed (guests take their time). */
export const VM_STOP_SECONDS = 120;

export class VmHost {
  private kvm: string | null | undefined;

  constructor(
    readonly docker: Docker,
    /** Prefix of the helper containers' names and the log lines, e.g. `win`. */
    private readonly tag: string,
    /** The dockur image the guests run on; pulled when first needed. */
    private readonly image: string,
    /** Label every container this host makes carries, with its role as value. */
    private readonly label: string,
    /** How the guests are called in messages, e.g. `Windows VMs`. */
    private readonly guests: string,
  ) {}

  /**
   * Whether this Docker host can run KVM guests: a throwaway container is given `/dev/kvm`
   * and looks for it, which covers a missing module, Docker Desktop's VM (no nested KVM) and
   * a Control Plane running in a container that cannot see the host's `/dev`. Cached; `null`
   * when it can, the reason otherwise.
   */
  async kvmUnavailable(refresh = false): Promise<string | null> {
    if (this.kvm !== undefined && !refresh) return this.kvm;
    const info = (await this.docker.info()) as { OSType?: string; OperatingSystem?: string };
    if (info.OSType && info.OSType !== "linux") {
      return (this.kvm = `${this.guests} need a Linux Docker host with KVM (this one runs ${info.OSType}).`);
    }
    const desktop = /docker desktop/i.test(info.OperatingSystem ?? "");
    let container: Docker.Container | null = null;
    try {
      // The Sandbox image is always local; the VM image is only pulled when a base gets installed.
      container = await this.docker.createContainer({
        name: `sbx-kvm-probe-${Date.now().toString(36)}`,
        Image: SANDBOX_IMAGE,
        Entrypoint: ["/bin/sh", "-c", "test -c /dev/kvm && test -w /dev/kvm"],
        Cmd: [],
        User: "0:0",
        Labels: { [this.label]: "probe" },
        HostConfig: { NetworkMode: "none", Devices: [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" }] },
      });
      await container.start();
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      this.kvm = StatusCode === 0 ? null : "/dev/kvm is not usable inside containers on this Docker host.";
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/kvm|no such file/i.test(message)) {
        this.kvm = `The Docker host has no /dev/kvm${desktop ? " (Docker Desktop's VM has no KVM)" : ""}; ${this.guests} need a Linux host with KVM.`;
      } else {
        // Anything else (the image not pulled yet, Docker hiccup) is transient: try again next time.
        return `Cannot check for KVM: ${message}`;
      }
    } finally {
      await container?.remove({ force: true }).catch(() => undefined);
    }
    return this.kvm;
  }

  /** The container shape of a QEMU/KVM guest on the Sandbox network. */
  vmHostConfig(binds: string[], ramGb: number): Docker.HostConfig {
    return {
      Binds: binds,
      NetworkMode: SANDBOX_NETWORK,
      Devices: [
        { PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" },
        { PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun", CgroupPermissions: "rwm" },
      ],
      CapAdd: ["NET_ADMIN"],
      // The guest's RAM plus QEMU's own; the container must not be OOM-killed under the guest.
      Memory: Math.round((ramGb + 1.5) * 1024 ** 3),
      RestartPolicy: { Name: "no" },
      PublishAllPorts: false,
    };
  }

  async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(this.image).inspect();
      return;
    } catch (e) {
      if (!isStatus(e, 404)) throw e;
    }
    log(`${this.tag}: pulling ${this.image}`);
    const stream = (await this.docker.pull(this.image)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Runs `script` as root in a throwaway container on the VM image (it has qemu-img) with `binds`; throws with the output on failure. */
  async helper(script: string, binds: string[]): Promise<string> {
    await this.ensureImage();
    const container = await this.docker.createContainer({
      name: `sbx-${this.tag}-helper-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`,
      Image: this.image,
      Entrypoint: ["/bin/sh", "-c", script],
      Cmd: [],
      User: "0:0",
      Labels: { [this.label]: "helper" },
      HostConfig: { Binds: binds, NetworkMode: "none", CapDrop: ["ALL"], CapAdd: ["CHOWN", "FOWNER", "DAC_OVERRIDE"] },
    });
    try {
      await container.start();
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      const logs = (await container.logs({ stdout: true, stderr: true })) as unknown as Buffer;
      const output = demux(logs).join("\n");
      if (StatusCode !== 0) throw new Error(`${this.guests} disk helper exited ${StatusCode}: ${output.slice(-500)}`);
      return output;
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  async tailLogs(container: Docker.Container): Promise<string[]> {
    try {
      const logs = (await container.logs({ stdout: true, stderr: true, tail: VM_LOG_LINES })) as unknown as Buffer;
      return demux(logs);
    } catch {
      return [];
    }
  }

  async start(vmId: string): Promise<void> {
    await this.docker.getContainer(vmId).start();
  }

  /** Asks the guest to shut down (dockur turns SIGTERM into an ACPI power button) and waits for it. */
  async stop(vmId: string): Promise<void> {
    try {
      await this.docker.getContainer(vmId).stop({ t: VM_STOP_SECONDS });
    } catch (e) {
      if (!isStatus(e, 304)) throw e;
    }
  }

  async state(vmId: string): Promise<"running" | "stopped" | "missing"> {
    try {
      const info = await this.docker.getContainer(vmId).inspect();
      return info.State.Running ? "running" : "stopped";
    } catch (e) {
      if (isStatus(e, 404)) return "missing";
      throw e;
    }
  }

  async volumeExists(name: string): Promise<boolean> {
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch (e) {
      if (isStatus(e, 404)) return false;
      throw e;
    }
  }

  /** Blocks actually used (the disk images are sparse; their apparent size is the full disk). */
  async volumeSize(name: string): Promise<number> {
    const out = await this.helper("du -sk /storage | cut -f1", [`${name}:/storage:ro`]);
    const n = Number(out.trim().split("\n").pop());
    return Number.isFinite(n) ? n * 1024 : 0;
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).remove();
    } catch (e) {
      if (!isStatus(e, 404)) throw e;
    }
  }

  async removeContainer(nameOrId: string): Promise<void> {
    try {
      await this.docker.getContainer(nameOrId).remove({ force: true, v: true });
    } catch (e) {
      if (!isStatus(e, 404)) throw e;
    }
  }
}

/** Docker's multiplexed log stream (8-byte frame headers) or plain bytes, as clean lines. */
export function demux(buf: Buffer): string[] {
  const lines: string[] = [];
  let text = "";
  let offset = 0;
  if (buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      text += buf.subarray(offset + 8, offset + 8 + size).toString("utf8");
      offset += 8 + size;
    }
  } else {
    text = buf.toString("utf8");
  }
  for (const raw of text.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/^❯\s*/, "").trim();
    if (line) lines.push(line);
  }
  return lines;
}

export function isStatus(e: unknown, status: number): boolean {
  return typeof e === "object" && e !== null && (e as { statusCode?: unknown }).statusCode === status;
}

/** The lifecycle sessions.ts drives for any VM Environment (ADR-0057/0058). */
export interface GuestVms {
  vmName(sessionId: string): string;
  /** The reason the Session's VM exited unexpectedly, for the Session's error. */
  readonly guestLabel: string;
  /** Whether the Agent, its MCP servers and the repositories live in the VM (the Sandbox only shows its desktop and bridges the desktop tools). */
  readonly agentInGuest: boolean;
  /** Where a repository named `name` lives in the VM, the way the guest spells it (`C:\\workspace\\x`, `/Users/agent/workspace/x`). */
  repoPath(name: string): string;
  availability(): Promise<import("@sessionboxer/protocol").EnvironmentAvailability>;
  /** Creates the Session's VM container (stopped) with its own disk; returns the container id. */
  create(sessionId: string): Promise<string>;
  start(vmId: string): Promise<void>;
  stop(vmId: string): Promise<void>;
  state(vmId: string): Promise<"running" | "stopped" | "missing">;
  remove(sessionId: string): Promise<void>;
  diskUsage(sessionId: string): Promise<number | null>;
  /** What the Sandbox's entrypoint needs to draw and drive the guest. */
  sandboxEnv(sessionId: string): Record<string, string>;
}
