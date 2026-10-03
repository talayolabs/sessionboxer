import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Docker from "dockerode";
import type { Settings } from "@sessionboxer/protocol";
import { HttpError } from "./http-error.js";
import { type GuestVms, VmHost } from "./vm-host.js";

/** The names and places one platform's VMs use (ADR-0057 for Windows, ADR-0059 for macOS). */
export interface QemuPlatform {
  /** How the guest is called in messages: `Windows`, `macOS`. */
  readonly name: string;
  /** The label every container and volume of this platform carries. */
  readonly label: string;
  /** The volume holding the shared base disk, and the container that installs it. */
  readonly baseVolume: string;
  readonly installContainer: string;
  /** Where the base record is kept between Control Plane runs. */
  readonly baseFile: string;
  /** A Session's VM container and its volume. */
  readonly vmName: (sessionId: string) => string;
  readonly volumeName: (sessionId: string) => string;
}

/** What every platform's base record says; the platforms add their own fields. */
export interface QemuBaseRecord {
  version: string;
  diskGb: number;
  sizeBytes: number;
}

/**
 * What the Windows (ADR-0057) and macOS (ADR-0059) VMs share once the VmHost has done the Docker
 * work: a Session's VM is a container on a per-Session volume (an overlay over the shared base
 * disk, mounted read-only), the base disk is a record on disk next to its volume, and no Session
 * may build on a base that is being replaced or deleted. How the base gets installed, what the
 * guest's container looks like and what the Sandbox needs to reach it stay with the platform.
 */
export abstract class QemuVms<Base extends QemuBaseRecord, Status> implements GuestVms {
  abstract readonly guestLabel: string;
  readonly agentInGuest = true;
  protected readonly host: VmHost;
  protected base: Base | null = null;
  /** The base install that is running, with whatever the platform tracks about it; null when none is. */
  /** Whether a base install is running (the subclass keeps its own record of it). */
  protected abstract isInstalling(): boolean;
  protected lastError: string | null = null;
  protected errorLog: string[] = [];

  constructor(
    protected readonly docker: Docker,
    protected readonly platform: QemuPlatform,
    protected readonly settings: () => Settings,
    protected readonly saveSettings: (next: Settings) => void,
    protected readonly countSessions: () => number,
    protected readonly onStatus: (status: Status) => void,
    host: VmHost,
  ) {
    this.host = host;
    if (existsSync(platform.baseFile)) {
      try {
        this.base = JSON.parse(readFileSync(platform.baseFile, "utf8")) as Base;
      } catch {
        this.base = null;
      }
    }
  }

  abstract repoPath(name: string): string;
  abstract availability(): Promise<import("@sessionboxer/protocol").EnvironmentAvailability>;
  abstract status(): Status;
  abstract create(sessionId: string): Promise<string>;
  abstract sandboxEnv(sessionId: string): Record<string, string>;

  vmName(sessionId: string): string {
    return this.platform.vmName(sessionId);
  }

  kvmUnavailable(refresh = false): Promise<string | null> {
    return this.host.kvmUnavailable(refresh);
  }

  /** Deletes the base disk (no Session may build on it). */
  async removeBase(): Promise<Status> {
    if (this.isInstalling()) throw new HttpError(409, `The ${this.platform.name} base disk is installing; cancel that first.`);
    this.assertBaseUnused("first");
    await this.host.removeContainer(this.platform.installContainer);
    await this.host.removeVolume(this.platform.baseVolume);
    this.setBase(null);
    this.lastError = null;
    this.onStatus(this.status());
    return this.status();
  }

  /** Sessions whose VM disk builds on the base keep it in use; `then` is what the user has to delete them before (`first`, `before reinstalling it`). */
  protected assertBaseUnused(then: string): void {
    const sessions = this.countSessions();
    if (sessions > 0) throw new HttpError(409, `${sessions} ${this.platform.name} Session${sessions === 1 ? " still uses" : "s still use"} the base disk; delete ${sessions === 1 ? "it" : "them"} ${then}.`);
  }

  /**
   * The Session's volume, fresh (leftovers of an earlier VM of the same Session go first), with
   * what `build` puts on it and the VM container it creates; the volume goes again when `build`
   * throws. Returns the container id.
   */
  protected async createOnVolume(sessionId: string, build: (volume: string) => Promise<Docker.Container>): Promise<string> {
    const volume = this.platform.volumeName(sessionId);
    await this.host.removeContainer(this.platform.vmName(sessionId));
    await this.host.removeVolume(volume).catch(() => undefined);
    await this.docker.createVolume({ Name: volume, Labels: { [this.platform.label]: sessionId } });
    try {
      const container = await build(volume);
      return container.id;
    } catch (e) {
      await this.host.removeVolume(volume).catch(() => undefined);
      throw e;
    }
  }

  start(vmId: string): Promise<void> {
    return this.host.start(vmId);
  }

  stop(vmId: string): Promise<void> {
    return this.host.stop(vmId);
  }

  state(vmId: string): Promise<"running" | "stopped" | "missing"> {
    return this.host.state(vmId);
  }

  /** Removes the VM container and the Session's disk. */
  async remove(sessionId: string): Promise<void> {
    await this.host.removeContainer(this.platform.vmName(sessionId));
    await this.host.removeVolume(this.platform.volumeName(sessionId));
  }

  /** Bytes the Session's overlay disk takes (what the VM wrote on top of the base). */
  async diskUsage(sessionId: string): Promise<number | null> {
    try {
      return await this.host.volumeSize(this.platform.volumeName(sessionId));
    } catch {
      return null;
    }
  }

  protected setBase(base: Base | null): void {
    this.base = base;
    if (base) writeFileSync(this.platform.baseFile, JSON.stringify(base, null, 2) + "\n");
    else rmSync(this.platform.baseFile, { force: true });
  }
}
