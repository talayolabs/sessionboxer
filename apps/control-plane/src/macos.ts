import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Docker from "dockerode";
import { MACOS_GUEST_USER, MACOS_VERSIONS, type EnvironmentAvailability, type MacosBaseStatus, type Settings } from "@sessionboxer/protocol";
import { DATA_DIR, SANDBOX_IMAGE, SANDBOX_NETWORK } from "./config.js";
import { LABEL_SESSION, type SandboxDocker } from "./docker.js";
import { HttpError } from "./http-error.js";
import { log } from "./log.js";
import { type GuestVms, VM_LOG_LINES, VmHost, demux, isStatus } from "./vm-host.js";

/**
 * macOS VMs for `qemu-macos` Sessions (ADR-0059). The shape is the Windows one (ADR-0057): a
 * sidecar container on dockur/macos runs one QEMU/KVM guest booted by OpenCore, on a qcow2
 * overlay over a shared read-only *base disk* in the `sbx-macos-base` volume. What differs is
 * how the base gets there: Apple ships no unattended installer, so the base VM boots Apple's
 * Recovery and the user installs macOS and creates the `agent` account by hand in the VM's
 * screen (proxied from the install container's noVNC); once the guest answers on SSH the
 * Control Plane turns off sleep, sets auto-login, shuts it down and calls the base ready.
 * The Sandbox reaches a Session's VM by container name on the Sandbox network: QEMU's VNC
 * for the desktop (drawn full-screen on the Sandbox's X display) and SSH for `mac`.
 */
export const MACOS_IMAGE = process.env.SESSIONBOXER_MACOS_IMAGE?.trim() || "dockurr/macos:3.12";
export const MACOS_VNC_PORT = 5900;
export const MACOS_SSH_PORT = 22;
/** dockur's own noVNC (the page and its `/websockify`), kept out of the guest's port forwarding. */
const MACOS_WEB_PORT = 8006;
export const LABEL_MACOS = "sessionboxer.macos";
const BASE_VOLUME = "sbx-macos-base";
const INSTALL_CONTAINER = "sbx-macos-install";
const BASE_FILE = join(DATA_DIR, "macos-base.json");
const BASE_DISK = "data.img";
const SESSION_DISK = "data.qcow2";
const BASE_MOUNT = "/base";
/** The guest's screen; the Sandbox's display has the same size, so the VNC view fills it. */
const SCREEN = { width: 1024, height: 768 };
const SSH_POLL_MS = 20_000;
/** How long the guest gets to power off after the provisioning script asked it to. */
const SHUTDOWN_WAIT_MS = 5 * 60_000;

interface BaseRecord {
  version: string;
  diskGb: number;
  /** null while the disk holds an unfinished install that `install()` can continue. */
  installedAt: string | null;
  sizeBytes: number;
  /** What `sw_vers -productVersion` said, e.g. `15.6`. */
  productVersion: string | null;
}

type Phase = "installing" | "setup" | "finishing";

interface Install {
  startedAt: string;
  version: string;
  diskGb: number;
  log: string[];
  container: Docker.Container;
  phase: Phase;
  poll: NodeJS.Timeout | null;
  checking: boolean;
  provisioned: boolean;
}

export function macosVmName(sessionId: string): string {
  return `sbx-mac-${sessionId}`;
}

export function macosVolumeName(sessionId: string): string {
  return `sbx-mac-${sessionId}`;
}

export class MacosVms implements GuestVms {
  readonly guestLabel = "macOS VM";
  readonly agentInGuest = false;
  private readonly docker: Docker;
  private readonly host: VmHost;
  private base: BaseRecord | null = null;
  private installing: Install | null = null;
  private lastError: string | null = null;
  private errorLog: string[] = [];

  constructor(
    private readonly sandboxDocker: SandboxDocker,
    private readonly settings: () => Settings,
    private readonly saveSettings: (next: Settings) => void,
    private readonly countSessions: () => number,
    private readonly onStatus: (status: MacosBaseStatus) => void,
  ) {
    this.docker = sandboxDocker.docker;
    this.host = new VmHost(this.docker, "mac", MACOS_IMAGE, LABEL_MACOS, "macOS VMs");
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
      log(`macos: base volume ${BASE_VOLUME} is gone; forgetting the base`);
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
    const version = env("VERSION") ?? this.settings().macos.version;
    const diskGb = Number.parseInt(env("DISK_SIZE") ?? "", 10) || this.settings().macos.diskGb;
    if (container.State.Running) {
      log("macos: a base install is still running; following it");
      this.installing = {
        startedAt: container.State.StartedAt,
        version,
        diskGb,
        log: [],
        container: this.docker.getContainer(container.Id),
        phase: "installing",
        poll: null,
        checking: false,
        provisioned: false,
      };
      void this.follow();
    } else {
      await this.finishInstall(this.docker.getContainer(container.Id), version, diskGb, container.State.ExitCode, false);
    }
  }

  vmName(sessionId: string): string {
    return macosVmName(sessionId);
  }

  /** KVM, plus the AVX2 the macOS guest needs (dockur refuses to boot without it). */
  async kvmUnavailable(refresh = false): Promise<string | null> {
    const kvm = await this.host.kvmUnavailable(refresh);
    if (kvm) return kvm;
    return this.avx2Unavailable();
  }

  private avx2: string | null | undefined;
  private async avx2Unavailable(): Promise<string | null> {
    if (this.avx2 !== undefined) return this.avx2;
    try {
      const out = await this.host.helper("grep -m1 -o -w avx2 /proc/cpuinfo || echo none", []);
      this.avx2 = out.trim().endsWith("avx2") ? null : "The host CPU has no AVX2, which macOS needs.";
    } catch (e) {
      return `Cannot check the CPU for AVX2: ${e instanceof Error ? e.message : String(e)}`;
    }
    return this.avx2;
  }

  /** Whether a `qemu-macos` Session can be created now, for `PublicSettings.environments`. */
  async availability(): Promise<EnvironmentAvailability> {
    const kvm = await this.kvmUnavailable();
    if (kvm) return { available: false, reason: kvm };
    const status = this.status();
    if (status.state === "ready") return { available: true, reason: null };
    if (status.state === "installing" || status.state === "finishing") return { available: false, reason: "The macOS base disk is still installing." };
    if (status.state === "setup") return { available: false, reason: "The macOS base disk is waiting for you to finish setting it up (Global settings → macOS)." };
    return { available: false, reason: "Install the macOS base disk first (Global settings → macOS)." };
  }

  status(): MacosBaseStatus {
    const sessions = this.countSessions();
    const inst = this.installing;
    if (inst) {
      const setup = inst.phase === "installing" ? null : { user: MACOS_GUEST_USER, password: this.password(), steps: setupSteps(inst.version) };
      return { state: inst.phase, version: inst.version, sizeBytes: 0, startedAt: inst.startedAt, log: inst.log, error: null, sessions, setup };
    }
    if (this.base?.installedAt) {
      return { state: "ready", version: this.base.version, sizeBytes: this.base.sizeBytes, startedAt: null, log: [], error: null, sessions, setup: null };
    }
    if (this.lastError) {
      return { state: "error", version: this.base?.version ?? null, sizeBytes: 0, startedAt: null, log: this.errorLog, error: this.lastError, sessions, setup: null };
    }
    if (this.base) {
      // A half-installed disk from before this Control Plane started (it stopped, or was cancelled).
      const error = "An earlier install stopped before macOS was set up. Install again to continue with the disk as it is, or delete it.";
      return { state: "error", version: this.base.version, sizeBytes: 0, startedAt: null, log: [], error, sessions, setup: null };
    }
    return { state: "missing", version: null, sizeBytes: 0, startedAt: null, log: [], error: null, sessions, setup: null };
  }

  /** The guest password; generated (and saved) the first time it is needed. */
  password(): string {
    const settings = this.settings();
    if (settings.macos.password) return settings.macos.password;
    // Letters and digits only: it gets typed by hand into Setup Assistant.
    const password = randomBytes(16).toString("base64url").replace(/[-_]/g, "").slice(0, 12);
    this.saveSettings({ ...settings, macos: { ...settings.macos, password } });
    return password;
  }

  /** The VM's screen while it installs: a noVNC websocket on the install container. */
  async screenUrl(): Promise<string> {
    if (!this.installing) throw new HttpError(409, "No macOS base install is running.");
    const { host, port } = await this.sandboxDocker.endpoint(this.installing.container.id, MACOS_WEB_PORT);
    return `ws://${host}:${port}/websockify`;
  }

  /**
   * Starts the base install: pulls dockur/macos and boots it on the base volume with the
   * release, disk size, RAM and CPUs from Settings. dockur downloads Apple's Recovery for that
   * release; from there on the user works in the VM's screen (`setup`) until Remote Login
   * answers with the `agent` account, and `finish` takes over. A disk left by an install that
   * stopped half-way (the VM powered off) is continued rather than wiped.
   */
  async install(): Promise<MacosBaseStatus> {
    if (this.installing) throw new HttpError(409, "The macOS base disk is already installing.");
    const sessions = this.countSessions();
    if (sessions > 0) throw new HttpError(409, `${sessions} macOS Session${sessions === 1 ? " still uses" : "s still use"} the base disk; delete ${sessions === 1 ? "it" : "them"} before reinstalling it.`);
    const kvm = await this.kvmUnavailable(true);
    if (kvm) throw new HttpError(409, kvm);
    const settings = this.settings();
    const { version, diskGb, ramGb, cpus } = settings.macos;
    if (!MACOS_VERSIONS.some((v) => v.code === version)) throw new HttpError(400, `Unknown macOS release "${version}".`);
    this.password();

    await this.host.removeContainer(INSTALL_CONTAINER);
    const partial = this.base && !this.base.installedAt && this.base.version === version && this.base.diskGb === diskGb;
    if (!partial && (this.base || (await this.host.volumeExists(BASE_VOLUME)))) {
      await this.host.removeVolume(BASE_VOLUME);
      this.setBase(null);
    }
    await this.host.ensureImage();
    this.lastError = null;
    this.errorLog = [];
    const container = await this.docker.createContainer({
      name: INSTALL_CONTAINER,
      Image: MACOS_IMAGE,
      Env: this.guestEnv(version, diskGb, ramGb, cpus),
      Labels: { [LABEL_MACOS]: "base" },
      // The screen is proxied from the container's noVNC; a host port only where container addresses cannot be dialled.
      ExposedPorts: { [`${MACOS_WEB_PORT}/tcp`]: {} },
      HostConfig: {
        ...this.host.vmHostConfig([`${BASE_VOLUME}:/storage`], ramGb),
        PortBindings: this.sandboxDocker.reach === "localhost" ? { [`${MACOS_WEB_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }] } : {},
      },
    });
    await container.start();
    this.installing = { startedAt: new Date().toISOString(), version, diskGb, log: [], container, phase: "installing", poll: null, checking: false, provisioned: false };
    this.setBase({ version, diskGb, installedAt: null, sizeBytes: 0, productVersion: null });
    log(`macos: installing the macOS ${version} base disk (${diskGb} GB) in ${INSTALL_CONTAINER}${partial ? ", continuing on the existing disk" : ""}`);
    this.onStatus(this.status());
    void this.follow();
    return this.status();
  }

  /**
   * Stops a running install. A disk the guest already wrote (hours of Apple downloads) stays
   * for the next Install to continue on; Delete wipes it.
   */
  async cancelInstall(): Promise<MacosBaseStatus> {
    if (!this.installing) throw new HttpError(409, "No macOS base install is running.");
    const current = this.installing;
    this.installing = null;
    if (current.poll) clearInterval(current.poll);
    await current.container.remove({ force: true, v: true }).catch(() => undefined);
    if (await this.baseComplete(current.version)) {
      this.setBase({ version: current.version, diskGb: current.diskGb, installedAt: null, sizeBytes: 0, productVersion: null });
      this.lastError = "The install was cancelled. Install again to continue with the disk as it is, or delete it.";
    } else {
      await this.host.removeVolume(BASE_VOLUME).catch(() => undefined);
      this.setBase(null);
      this.lastError = "The install was cancelled.";
    }
    this.errorLog = [];
    this.onStatus(this.status());
    return this.status();
  }

  /** Deletes the base disk (no Session may build on it). */
  async removeBase(): Promise<MacosBaseStatus> {
    if (this.installing) throw new HttpError(409, "The macOS base disk is installing; cancel that first.");
    const sessions = this.countSessions();
    if (sessions > 0) throw new HttpError(409, `${sessions} macOS Session${sessions === 1 ? " still uses" : "s still use"} the base disk; delete ${sessions === 1 ? "it" : "them"} first.`);
    await this.host.removeContainer(INSTALL_CONTAINER);
    await this.host.removeVolume(BASE_VOLUME);
    this.setBase(null);
    this.lastError = null;
    this.onStatus(this.status());
    return this.status();
  }

  private guestEnv(version: string, diskGb: number, ramGb: number, cpus: number, extra: string[] = []): string[] {
    return [
      `VERSION=${version}`,
      `DISK_SIZE=${diskGb}G`,
      `RAM_SIZE=${ramGb}G`,
      `CPU_CORES=${cpus}`,
      `WIDTH=${SCREEN.width}`,
      `HEIGHT=${SCREEN.height}`,
      ...extra,
    ];
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
          if (current.phase === "installing" && /Booting macOS/i.test(line)) this.enterSetup(current);
        }
        if (Date.now() - lastReport > 2000) {
          lastReport = Date.now();
          this.onStatus(this.status());
        }
      });
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      if (this.installing !== current) return;
      await this.finishInstall(container, version, diskGb, StatusCode, current.provisioned, current.log);
    } catch (e) {
      if (this.installing !== current) return;
      this.installing = null;
      if (current.poll) clearInterval(current.poll);
      this.lastError = `Following the install failed: ${e instanceof Error ? e.message : String(e)}`;
      this.errorLog = current.log;
      this.onStatus(this.status());
    }
  }

  /** QEMU is up: the user takes over in the screen; from now on the guest's SSH is tried every few seconds. */
  private enterSetup(current: Install): void {
    current.phase = "setup";
    log("macos: the VM is booting; waiting for macOS to be installed and Remote Login turned on");
    current.poll = setInterval(() => void this.pollSsh(current), SSH_POLL_MS);
    this.onStatus(this.status());
  }

  private async pollSsh(current: Install): Promise<void> {
    if (this.installing !== current || current.phase !== "setup" || current.checking) return;
    current.checking = true;
    try {
      const productVersion = await this.ssh(INSTALL_CONTAINER, "sw_vers -productVersion", 25);
      if (this.installing !== current || current.phase !== "setup") return;
      if (current.poll) clearInterval(current.poll);
      current.poll = null;
      current.phase = "finishing";
      current.log.push(`❯ macOS ${productVersion.trim()} answered on SSH as ${MACOS_GUEST_USER}; finishing the base...`);
      this.onStatus(this.status());
      await this.finish(current, productVersion.trim());
    } catch {
      // Not yet: Recovery, the installer or Setup Assistant is still running, or Remote Login is off.
    } finally {
      current.checking = false;
    }
  }

  /**
   * The guest is installed and reachable: no sleep or screen saver (the VNC view would go
   * black), auto-login for the `agent` account (a Session's VM boots straight to the desktop),
   * then a clean shutdown so the disk is consistent for the overlays. dockur exits with the
   * guest, which ends `follow()`.
   */
  private async finish(current: Install, productVersion: string): Promise<void> {
    // The password arrives on stdin (`feedPassword`), so neither the script nor the ssh container's arguments carry it.
    const script = [
      "set -u",
      "IFS= read -r SBX_PW",
      `sudo() { printf '%s\\n' "$SBX_PW" | command sudo -S -p '' "$@"; }`,
      "sudo pmset -a sleep 0 displaysleep 0 disksleep 0 2>/dev/null || true",
      "defaults -currentHost write com.apple.screensaver idleTime 0 2>/dev/null || true",
      `sudo sysadminctl -autologin set -userName ${MACOS_GUEST_USER} -password "$SBX_PW" 2>&1 || true`,
      "sudo defaults write /Library/Preferences/com.apple.loginwindow DisableScreenLockImmediate -bool true 2>/dev/null || true",
      "echo SBX_PROVISIONED",
      "nohup sudo shutdown -h now >/dev/null 2>&1 &",
    ].join("\n");
    try {
      const out = await this.ssh(INSTALL_CONTAINER, `bash -c "$(echo ${Buffer.from(script).toString("base64")} | base64 -d)"`, 90, true);
      if (!out.includes("SBX_PROVISIONED")) throw new Error(out.slice(-300));
      current.provisioned = true;
      if (this.base) this.setBase({ ...this.base, productVersion });
      log(`macos: the base (macOS ${productVersion}) is provisioned; waiting for it to power off`);
    } catch (e) {
      if (this.installing !== current) return;
      current.log.push(`❯ Setting the guest up over SSH failed: ${e instanceof Error ? e.message : String(e)}`);
      current.phase = "setup";
      current.poll = setInterval(() => void this.pollSsh(current), SSH_POLL_MS);
      this.onStatus(this.status());
      return;
    }
    // The container ends with the guest; if macOS does not power off, ask QEMU to (ACPI).
    setTimeout(() => {
      if (this.installing === current) void this.host.stop(current.container.id).catch(() => undefined);
    }, SHUTDOWN_WAIT_MS).unref();
  }

  /** The installer container exited: a provisioned guest that powered itself off is a ready base. */
  private async finishInstall(container: Docker.Container, version: string, diskGb: number, exitCode: number, provisioned: boolean, tail?: string[]): Promise<void> {
    const current = this.installing;
    this.installing = null;
    if (current?.poll) clearInterval(current.poll);
    const lines = tail ?? (await this.host.tailLogs(container));
    const complete = provisioned && (await this.baseComplete(version));
    if (complete) {
      const sizeBytes = await this.host.volumeSize(BASE_VOLUME);
      this.setBase({ version, diskGb, installedAt: new Date().toISOString(), sizeBytes, productVersion: this.base?.productVersion ?? null });
      this.lastError = null;
      this.errorLog = [];
      log(`macos: base disk ready (${(sizeBytes / 1024 ** 3).toFixed(1)} GB)`);
    } else {
      const hasDisk = await this.baseComplete(version);
      this.lastError = provisioned
        ? "The guest was set up but its disk is missing."
        : exitCode === 0 && hasDisk
          ? "The VM powered off before macOS was set up and Remote Login answered. Install again to continue with the disk as it is."
          : `The VM exited with code ${exitCode}.`;
      this.errorLog = lines;
      if (!(exitCode === 0 && hasDisk)) {
        await this.host.removeVolume(BASE_VOLUME).catch(() => undefined);
        this.setBase(null);
      } else {
        this.setBase({ version, diskGb, installedAt: null, sizeBytes: 0, productVersion: null });
      }
      log(`macos: base install failed: ${this.lastError}`);
    }
    await container.remove({ force: true }).catch(() => undefined);
    this.onStatus(this.status());
  }

  /** dockur/macos keeps a release's files under `/storage/<version>/`; the data disk is the guest's. */
  private async baseComplete(version: string): Promise<boolean> {
    return this.host.helper(`test -s /storage/${version}/${BASE_DISK}`, [`${BASE_VOLUME}:/storage:ro`])
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Runs `command` in the guest of `vmContainer` over SSH as the `agent` account, from a
   * throwaway Sandbox container on the Sandbox network (it has sshpass; the Control Plane
   * itself may be on another network). Resolves with the output, rejects when SSH does not
   * answer or the command fails.
   */
  private async ssh(vmContainer: string, command: string, timeoutSeconds: number, feedPassword = false): Promise<string> {
    const ssh = `timeout ${timeoutSeconds} sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 -p ${MACOS_SSH_PORT} ${MACOS_GUEST_USER}@${vmContainer} "$0"`;
    const container = await this.docker.createContainer({
      name: `sbx-mac-ssh-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`,
      Image: SANDBOX_IMAGE,
      // With `feedPassword` the remote command reads the password as its first line of stdin.
      Entrypoint: ["/bin/sh", "-c", feedPassword ? `printf '%s\\n' "$SSHPASS" | ${ssh}` : `exec ${ssh}`, command],
      Cmd: [],
      Env: [`SSHPASS=${this.password()}`],
      Labels: { [LABEL_MACOS]: "ssh" },
      HostConfig: { NetworkMode: SANDBOX_NETWORK, CapDrop: ["ALL"] },
    });
    try {
      await container.start();
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      const logs = (await container.logs({ stdout: true, stderr: true })) as unknown as Buffer;
      const output = demux(logs).join("\n");
      if (StatusCode !== 0) throw new Error(`ssh exited ${StatusCode}: ${output.slice(-300)}`);
      return output;
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  /**
   * The VM container of a Session, created stopped. Its volume gets the base's small files
   * (OpenCore image, firmware variables, machine identity) and a qcow2 overlay whose backing
   * file is the base disk, mounted read-only at the same path in every VM. Returns the id.
   */
  async create(sessionId: string): Promise<string> {
    if (!this.base?.installedAt) throw new HttpError(409, "The macOS base disk is not installed (Global settings → macOS).");
    const { ramGb, cpus } = this.settings().macos;
    const { version, diskGb } = this.base;
    const volume = macosVolumeName(sessionId);
    await this.host.removeContainer(macosVmName(sessionId));
    await this.host.removeVolume(volume).catch(() => undefined);
    await this.docker.createVolume({ Name: volume, Labels: { [LABEL_MACOS]: sessionId } });
    try {
      // The release folder is only used while there is no disk; a Session's files sit at the volume's root.
      await this.host.helper(
        [
          "set -e",
          `cd ${BASE_MOUNT}/${version}`,
          `for f in * ; do case "$f" in data.*|*.dmg) ;; *) [ -f "$f" ] && cp -p "$f" /storage/ ;; esac; done`,
          `qemu-img create -q -f qcow2 -F raw -b ${BASE_MOUNT}/${version}/${BASE_DISK} /storage/${SESSION_DISK}`,
        ].join("\n"),
        [`${BASE_VOLUME}:${BASE_MOUNT}:ro`, `${volume}:/storage`],
      );
      const container = await this.docker.createContainer({
        name: macosVmName(sessionId),
        Image: MACOS_IMAGE,
        Hostname: `mac-${sessionId.slice(0, 12)}`,
        Env: this.guestEnv(version, diskGb, ramGb, cpus, ["DISK_FMT=qcow2"]),
        // The Session label puts the VM on the same death watch as the Sandbox (`watchDeaths`).
        Labels: { [LABEL_MACOS]: "vm", [LABEL_SESSION]: sessionId },
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
    await this.host.removeContainer(macosVmName(sessionId));
    await this.host.removeVolume(macosVolumeName(sessionId));
  }

  /** Bytes the Session's overlay disk takes (what the VM wrote on top of the base). */
  async diskUsage(sessionId: string): Promise<number | null> {
    try {
      return await this.host.volumeSize(macosVolumeName(sessionId));
    } catch {
      return null;
    }
  }

  /** What the Sandbox's entrypoint needs to draw and drive the guest. */
  sandboxEnv(sessionId: string): Record<string, string> {
    return {
      SESSIONBOXER_MACOS_HOST: macosVmName(sessionId),
      SESSIONBOXER_MACOS_VNC_PORT: String(MACOS_VNC_PORT),
      SESSIONBOXER_MACOS_SSH_PORT: String(MACOS_SSH_PORT),
      SESSIONBOXER_MACOS_USER: MACOS_GUEST_USER,
      SESSIONBOXER_MACOS_PASSWORD: this.password(),
    };
  }

  private setBase(base: BaseRecord | null): void {
    this.base = base;
    if (base) writeFileSync(BASE_FILE, JSON.stringify(base, null, 2) + "\n");
    else rmSync(BASE_FILE, { force: true });
  }
}

/** What the user does in the VM's screen, in order (Global settings shows them). */
function setupSteps(version: string): string[] {
  const name = MACOS_VERSIONS.find((v) => v.code === version)?.label.replace(/^macOS \d+ /, "") ?? `macOS ${version}`;
  return [
    "Wait for Recovery (the Apple logo, then a window with four options; a few minutes).",
    "Disk Utility: pick the largest “VirtIO Block Media” disk, Erase it as “Macintosh HD”, APFS, GUID Partition Map; quit Disk Utility.",
    `Reinstall macOS ${name}: agree, pick “Macintosh HD”, wait (the VM restarts a few times; up to an hour).`,
    `Setup Assistant: skip Migration, Apple Account (“Set Up Later”) and the rest; create the account with full name and account name “${MACOS_GUEST_USER}” and the password shown here; turn Location Services and analytics off.`,
    "System Settings → General → Sharing: turn Remote Login on.",
    "Sessionboxer then sees the VM on SSH, turns off sleep and the screen saver, sets auto-login, shuts the VM down and calls the base ready.",
  ];
}

