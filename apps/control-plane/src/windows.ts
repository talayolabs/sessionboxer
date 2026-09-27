import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Docker from "dockerode";
import { pack } from "tar-fs";
import { WINDOWS_GUEST_USER, WINDOWS_VERSIONS, type EnvironmentAvailability, type Settings, type WindowsBaseStatus } from "@sessionboxer/protocol";
import { DATA_DIR, ROOT_DIR } from "./config.js";
import { LABEL_SESSION } from "./docker.js";
import { HttpError } from "./http-error.js";
import { log } from "./log.js";
import { type GuestVms, VM_LOG_LINES, VmHost, demux, isStatus } from "./vm-host.js";

/**
 * Windows VMs for `qemu-windows` Sessions (ADR-0057). Each such Session gets, next to its Linux
 * Sandbox, a sidecar container on dockur/windows running one QEMU/KVM Windows guest. The guest
 * disk is a qcow2 overlay over a shared, read-only *base disk*: a Windows installed once,
 * unattended, from Microsoft's media into the `sbx-windows-base` volume, with the OEM script in
 * images/windows/oem run at the end of setup. The Sandbox reaches the VM by container name on
 * the Sandbox network: RDP for the desktop (drawn full-screen on the Sandbox's own X display,
 * so noVNC and the desktop MCP work unchanged) and SSH for the `win` command.
 */
export const WINDOWS_IMAGE = process.env.SESSIONBOXER_WINDOWS_IMAGE?.trim() || "dockurr/windows:6.05";
export const WINDOWS_RDP_PORT = 3389;
export const WINDOWS_SSH_PORT = 22;
export const LABEL_WINDOWS = "sessionboxer.windows";
const BASE_VOLUME = "sbx-windows-base";
const INSTALL_CONTAINER = "sbx-windows-install";
const BASE_FILE = join(DATA_DIR, "windows-base.json");
const OEM_DIR = join(ROOT_DIR, "images/windows/oem");
const BASE_DISK = "data.img";
const SESSION_DISK = "data.qcow2";
const BASE_MOUNT = "/base";

interface BaseRecord {
  version: string;
  diskGb: number;
  installedAt: string;
  sizeBytes: number;
}

export function windowsVmName(sessionId: string): string {
  return `sbx-win-${sessionId}`;
}

export function windowsVolumeName(sessionId: string): string {
  return `sbx-win-${sessionId}`;
}

export class WindowsVms implements GuestVms {
  readonly guestLabel = "Windows VM";
  private readonly docker: Docker;
  private readonly host: VmHost;
  private base: BaseRecord | null = null;
  private installing: { startedAt: string; version: string; diskGb: number; log: string[]; container: Docker.Container } | null = null;
  private lastError: string | null = null;
  private errorLog: string[] = [];

  constructor(
    docker: Docker,
    private readonly settings: () => Settings,
    private readonly saveSettings: (next: Settings) => void,
    private readonly countSessions: () => number,
    private readonly onStatus: (status: WindowsBaseStatus) => void,
  ) {
    this.docker = docker;
    this.host = new VmHost(docker, "win", WINDOWS_IMAGE, LABEL_WINDOWS, "Windows VMs");
    if (existsSync(BASE_FILE)) {
      try {
        this.base = JSON.parse(readFileSync(BASE_FILE, "utf8")) as BaseRecord;
      } catch {
        this.base = null;
      }
    }
  }

  /** Re-attaches to an install left running by a previous Control Plane; drops a base record whose volume is gone. */
  async init(): Promise<void> {
    if (this.base && !(await this.host.volumeExists(BASE_VOLUME))) {
      log(`windows: base volume ${BASE_VOLUME} is gone; forgetting the installed base`);
      this.setBase(null);
    }
    let container: Docker.ContainerInspectInfo;
    try {
      container = await this.docker.getContainer(INSTALL_CONTAINER).inspect();
    } catch (e) {
      if (isStatus(e, 404)) return;
      throw e;
    }
    const env = (name: string): string | undefined => container.Config.Env.find((kv) => kv.startsWith(`${name}=`))?.slice(name.length + 1);
    const version = env("VERSION") ?? this.settings().windows.version;
    const diskGb = Number.parseInt(env("DISK_SIZE") ?? "", 10) || this.settings().windows.diskGb;
    if (container.State.Running) {
      log("windows: a base install is still running; following it");
      this.installing = { startedAt: container.State.StartedAt, version, diskGb, log: [], container: this.docker.getContainer(container.Id) };
      void this.follow();
    } else {
      await this.finishInstall(this.docker.getContainer(container.Id), version, diskGb, container.State.ExitCode);
    }
  }

  vmName(sessionId: string): string {
    return windowsVmName(sessionId);
  }

  kvmUnavailable(refresh = false): Promise<string | null> {
    return this.host.kvmUnavailable(refresh);
  }

  /** Whether a `qemu-windows` Session can be created now, for `PublicSettings.environments`. */
  async availability(): Promise<EnvironmentAvailability> {
    const kvm = await this.kvmUnavailable();
    if (kvm) return { available: false, reason: kvm };
    const status = this.status();
    if (status.state === "ready") return { available: true, reason: null };
    if (status.state === "installing") return { available: false, reason: "The Windows base disk is still installing." };
    return { available: false, reason: "Install the Windows base disk first (Global settings → Windows)." };
  }

  status(): WindowsBaseStatus {
    const sessions = this.countSessions();
    if (this.installing) {
      return { state: "installing", version: this.installing.version, sizeBytes: 0, startedAt: this.installing.startedAt, log: this.installing.log, error: null, sessions };
    }
    if (this.base) {
      return { state: "ready", version: this.base.version, sizeBytes: this.base.sizeBytes, startedAt: null, log: [], error: null, sessions };
    }
    if (this.lastError) {
      return { state: "error", version: null, sizeBytes: 0, startedAt: null, log: this.errorLog, error: this.lastError, sessions };
    }
    return { state: "missing", version: null, sizeBytes: 0, startedAt: null, log: [], error: null, sessions };
  }

  /** The guest password; generated (and saved) the first time it is needed. */
  password(): string {
    const settings = this.settings();
    if (settings.windows.password) return settings.windows.password;
    const password = randomBytes(12).toString("base64url");
    this.saveSettings({ ...settings, windows: { ...settings.windows, password } });
    return password;
  }

  /**
   * Installs the base disk: pulls dockur/windows, starts it on the base volume with the edition,
   * disk size and guest account from Settings and the OEM script copied in, and follows it until
   * the guest powers itself off at the end of the OEM script. Sessions that already build on a
   * base keep their overlays' backing file, so reinstalling needs them deleted first.
   */
  async install(): Promise<WindowsBaseStatus> {
    if (this.installing) throw new HttpError(409, "The Windows base disk is already installing.");
    const sessions = this.countSessions();
    if (sessions > 0) throw new HttpError(409, `${sessions} Windows Session${sessions === 1 ? " still uses" : "s still use"} the base disk; delete ${sessions === 1 ? "it" : "them"} before reinstalling it.`);
    const kvm = await this.kvmUnavailable(true);
    if (kvm) throw new HttpError(409, kvm);
    const settings = this.settings();
    const { version, diskGb, ramGb, cpus } = settings.windows;
    if (!WINDOWS_VERSIONS.some((v) => v.code === version)) throw new HttpError(400, `Unknown Windows edition "${version}".`);
    if (!existsSync(join(OEM_DIR, "install.bat"))) throw new HttpError(500, `${OEM_DIR}/install.bat is missing from this checkout.`);
    const password = this.password();

    await this.host.removeContainer(INSTALL_CONTAINER);
    if (this.base || (await this.host.volumeExists(BASE_VOLUME))) {
      await this.host.removeVolume(BASE_VOLUME);
      this.setBase(null);
    }
    await this.host.ensureImage();
    this.lastError = null;
    this.errorLog = [];
    const container = await this.docker.createContainer({
      name: INSTALL_CONTAINER,
      Image: WINDOWS_IMAGE,
      Env: [`VERSION=${version}`, `DISK_SIZE=${diskGb}G`, `RAM_SIZE=${ramGb}G`, `CPU_CORES=${cpus}`, `USERNAME=${WINDOWS_GUEST_USER}`, `PASSWORD=${password}`],
      Labels: { [LABEL_WINDOWS]: "base" },
      HostConfig: this.host.vmHostConfig([`${BASE_VOLUME}:/storage`], ramGb),
    });
    // dockur/windows takes the OEM folder from `/storage/oem` when no `/oem` is mounted: no host path needed.
    await container.putArchive(pack(OEM_DIR, { map: (h) => ({ ...h, name: `oem/${h.name}` }) }), { path: "/storage" });
    await container.start();
    this.installing = { startedAt: new Date().toISOString(), version, diskGb, log: [], container };
    log(`windows: installing the ${version} base disk (${diskGb} GB) in ${INSTALL_CONTAINER}`);
    this.onStatus(this.status());
    void this.follow();
    return this.status();
  }

  /** Stops a running install and forgets the half-written base. */
  async cancelInstall(): Promise<WindowsBaseStatus> {
    if (!this.installing) throw new HttpError(409, "No Windows base install is running.");
    const { container } = this.installing;
    this.installing = null;
    await container.remove({ force: true, v: true }).catch(() => undefined);
    await this.host.removeVolume(BASE_VOLUME).catch(() => undefined);
    this.lastError = "The install was cancelled.";
    this.errorLog = [];
    this.onStatus(this.status());
    return this.status();
  }

  /** Deletes the base disk (no Session may build on it). */
  async removeBase(): Promise<WindowsBaseStatus> {
    if (this.installing) throw new HttpError(409, "The Windows base disk is installing; cancel that first.");
    const sessions = this.countSessions();
    if (sessions > 0) throw new HttpError(409, `${sessions} Windows Session${sessions === 1 ? " still uses" : "s still use"} the base disk; delete ${sessions === 1 ? "it" : "them"} first.`);
    await this.host.removeContainer(INSTALL_CONTAINER);
    await this.host.removeVolume(BASE_VOLUME);
    this.setBase(null);
    this.lastError = null;
    this.onStatus(this.status());
    return this.status();
  }

  private async follow(): Promise<void> {
    const current = this.installing;
    if (!current) return;
    const { container, version, diskGb } = current;
    let lastReport = 0;
    try {
      const stream = (await container.logs({ follow: true, stdout: true, stderr: true, tail: VM_LOG_LINES })) as NodeJS.ReadableStream;
      stream.on("data", (chunk: Buffer) => {
        if (this.installing !== current) return;
        for (const line of demux(chunk)) {
          current.log.push(line);
          if (current.log.length > VM_LOG_LINES) current.log.splice(0, current.log.length - VM_LOG_LINES);
        }
        if (Date.now() - lastReport > 2000) {
          lastReport = Date.now();
          this.onStatus(this.status());
        }
      });
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      if (this.installing !== current) return;
      await this.finishInstall(container, version, diskGb, StatusCode, current.log);
    } catch (e) {
      if (this.installing !== current) return;
      this.installing = null;
      this.lastError = `Following the install failed: ${e instanceof Error ? e.message : String(e)}`;
      this.errorLog = current.log;
      this.onStatus(this.status());
    }
  }

  /** The installer container exited: a clean guest power-off after the OEM marker means the base is ready. */
  private async finishInstall(container: Docker.Container, version: string, diskGb: number, exitCode: number, tail?: string[]): Promise<void> {
    this.installing = null;
    const lines = tail ?? (await this.host.tailLogs(container));
    const complete = exitCode === 0 && (await this.baseComplete());
    if (complete) {
      const sizeBytes = await this.host.volumeSize(BASE_VOLUME);
      this.setBase({ version, diskGb, installedAt: new Date().toISOString(), sizeBytes });
      this.lastError = null;
      this.errorLog = [];
      log(`windows: base disk ready (${(sizeBytes / 1024 ** 3).toFixed(1)} GB)`);
    } else {
      this.lastError =
        exitCode === 0
          ? "The installer stopped before Windows finished setting up (no boot marker or OEM marker on the disk)."
          : `The installer exited with code ${exitCode}.`;
      this.errorLog = lines;
      log(`windows: base install failed: ${this.lastError}`);
    }
    await container.remove({ force: true }).catch(() => undefined);
    if (!complete) await this.host.removeVolume(BASE_VOLUME).catch(() => undefined);
    this.onStatus(this.status());
  }

  /** dockur/windows creates `windows.boot` once Windows Setup has finished; the OEM script's own marker sits inside the guest disk, which only Windows reads. */
  private async baseComplete(): Promise<boolean> {
    return this.host.helper(`test -f /storage/windows.boot && test -s /storage/${BASE_DISK}`, [`${BASE_VOLUME}:/storage:ro`])
      .then(() => true)
      .catch(() => false);
  }

  /**
   * The VM container of a Session, created stopped. Its volume gets the base's small state files
   * (firmware variables, boot mode, markers) and a qcow2 overlay whose backing file is the base
   * disk, mounted read-only at the same path in every VM, so a Session's disk costs only what it
   * writes. Returns the container id.
   */
  async create(sessionId: string): Promise<string> {
    if (!this.base) throw new HttpError(409, "The Windows base disk is not installed (Global settings → Windows).");
    const { ramGb, cpus } = this.settings().windows;
    const volume = windowsVolumeName(sessionId);
    await this.host.removeContainer(windowsVmName(sessionId));
    await this.host.removeVolume(volume).catch(() => undefined);
    await this.docker.createVolume({ Name: volume, Labels: { [LABEL_WINDOWS]: sessionId } });
    try {
      await this.host.helper(
        [
          "set -e",
          `cd ${BASE_MOUNT}`,
          `for f in windows.* ; do case "$f" in *.iso|*.img|*.qcow2) ;; *) [ -f "$f" ] && cp -p "$f" /storage/ ;; esac; done`,
          `qemu-img create -q -f qcow2 -F raw -b ${BASE_MOUNT}/${BASE_DISK} /storage/${SESSION_DISK}`,
        ].join("\n"),
        [`${BASE_VOLUME}:${BASE_MOUNT}:ro`, `${volume}:/storage`],
      );
      const container = await this.docker.createContainer({
        name: windowsVmName(sessionId),
        Image: WINDOWS_IMAGE,
        Hostname: `win-${sessionId.slice(0, 12)}`,
        Env: [
          `VERSION=${this.base.version}`,
          `DISK_FMT=qcow2`,
          `DISK_SIZE=${this.base.diskGb}G`,
          `RAM_SIZE=${ramGb}G`,
          `CPU_CORES=${cpus}`,
          `USERNAME=${WINDOWS_GUEST_USER}`,
          `PASSWORD=${this.password()}`,
        ],
        // The Session label puts the VM on the same death watch as the Sandbox (`watchDeaths`).
        Labels: { [LABEL_WINDOWS]: "vm", [LABEL_SESSION]: sessionId },
        HostConfig: this.host.vmHostConfig([`${volume}:/storage`, `${BASE_VOLUME}:${BASE_MOUNT}:ro`], ramGb),
      });
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
    await this.host.removeContainer(windowsVmName(sessionId));
    await this.host.removeVolume(windowsVolumeName(sessionId));
  }

  /** Bytes the Session's overlay disk takes (what the VM wrote on top of the base). */
  async diskUsage(sessionId: string): Promise<number | null> {
    try {
      return await this.host.volumeSize(windowsVolumeName(sessionId));
    } catch {
      return null;
    }
  }

  /** What the Sandbox's entrypoint needs to draw and drive the guest. */
  sandboxEnv(sessionId: string): Record<string, string> {
    return {
      SESSIONBOXER_WINDOWS_HOST: windowsVmName(sessionId),
      SESSIONBOXER_WINDOWS_RDP_PORT: String(WINDOWS_RDP_PORT),
      SESSIONBOXER_WINDOWS_SSH_PORT: String(WINDOWS_SSH_PORT),
      SESSIONBOXER_WINDOWS_USER: WINDOWS_GUEST_USER,
      SESSIONBOXER_WINDOWS_PASSWORD: this.password(),
    };
  }

  private setBase(base: BaseRecord | null): void {
    this.base = base;
    if (base) writeFileSync(BASE_FILE, JSON.stringify(base, null, 2) + "\n");
    else rmSync(BASE_FILE, { force: true });
  }
}
