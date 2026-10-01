import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { MACOS_GUEST_USER, MACOS_GUEST_WORKSPACE, MACOS_VERSIONS, type EnvironmentAvailability, type MacosBaseStatus, type Settings } from "@sessionboxer/protocol";
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
 * Control Plane turns off sleep, sets auto-login, installs the Agent's toolchain (ADR-0061:
 * Node, git, uv and the Provider CLIs, the pins of the Windows base), authorizes an SSH key,
 * shuts it down and calls the base ready. "Reprovision" boots an installed base once more and
 * reruns only that SSH step, for bases that predate the toolchain or after a pin changes.
 * The Sandbox reaches a Session's VM by container name on the Sandbox network: QEMU's VNC
 * for the desktop (drawn full-screen on the Sandbox's X display) and SSH for the Agent, git,
 * the Terminal and `mac`.
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
/** How long the provisioning script may take (Apple's Command Line Tools alone can be 10+ minutes). */
const PROVISION_TIMEOUT_S = 60 * 60;

/**
 * The toolchain the base gets, the same pins as the Windows base (`images/windows/oem/install.bat`)
 * and the Sandbox image. Bump `TOOLCHAIN` when they change: bases with an older number show
 * "Reprovision" and cannot start Sessions until it ran.
 */
const TOOLCHAIN = 2;
const NODE_VERSION = "22.23.3";
const UV_VERSION = "0.12.13";
const CLAUDE_CODE_VERSION = "2.1.272";
const CLAUDE_AGENT_ACP_VERSION = "0.77.0";
const CODEX_ACP_VERSION = "1.1.9";
const DEVIN_CLI_VERSION = "3000.10.27";
const CURSOR_CLI_VERSION = "2026.09.23-86fc751";
const PI_VERSION = "0.99.2";
const PI_ACP_VERSION = "0.0.34";

interface BaseRecord {
  version: string;
  diskGb: number;
  /** null while the disk holds an unfinished install that `install()` can continue. */
  installedAt: string | null;
  sizeBytes: number;
  /** What `sw_vers -productVersion` said, e.g. `15.6`. */
  productVersion: string | null;
  /** The `TOOLCHAIN` the last provisioning installed; absent or older means the base needs a reprovision. */
  toolchain?: number;
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
  /** An installed base booted again for the SSH step only (no Recovery, no Setup Assistant). */
  reprovision: boolean;
}

export function macosVmName(sessionId: string): string {
  return `sbx-mac-${sessionId}`;
}

export function macosVolumeName(sessionId: string): string {
  return `sbx-mac-${sessionId}`;
}

export class MacosVms implements GuestVms {
  readonly guestLabel = "macOS VM";
  readonly agentInGuest = true;
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
    const reprovision = container.Config.Labels?.[LABEL_MACOS] === "reprovision";
    if (container.State.Running) {
      log(`macos: a base ${reprovision ? "reprovision" : "install"} is still running; following it`);
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
        reprovision,
      };
      void this.follow();
      // The boot line is likely past the tail `follow` reads: the whole log says whether QEMU is already up.
      const current = this.installing;
      const whole = (await this.docker.getContainer(container.Id).logs({ stdout: true, stderr: true }).catch(() => Buffer.alloc(0))) as Buffer;
      if (this.installing === current && current.phase === "installing" && demux(whole).some((line) => /Booting macOS/i.test(line))) this.enterSetup(current);
    } else {
      await this.finishInstall(this.docker.getContainer(container.Id), version, diskGb, container.State.ExitCode, false, undefined, reprovision);
    }
  }

  vmName(sessionId: string): string {
    return macosVmName(sessionId);
  }

  repoPath(name: string): string {
    return `${MACOS_GUEST_WORKSPACE}/${name}`;
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
    if (status.state === "ready") {
      return status.toolchain
        ? { available: true, reason: null }
        : { available: false, reason: "The macOS base disk has no agent toolchain yet; reprovision it (Global settings → Environment → macOS VMs)." };
    }
    if (status.reprovisioning) return { available: false, reason: "The macOS base disk is being reprovisioned." };
    if (status.state === "installing" || status.state === "finishing") return { available: false, reason: "The macOS base disk is still installing." };
    if (status.state === "setup") return { available: false, reason: "The macOS base disk is waiting for you to finish setting it up (Global settings → Environment → macOS VMs)." };
    return { available: false, reason: "Install the macOS base disk first (Global settings → Environment → macOS VMs)." };
  }

  status(): MacosBaseStatus {
    const sessions = this.countSessions();
    const inst = this.installing;
    const toolchain = this.base?.toolchain === TOOLCHAIN;
    if (inst) {
      const setup = inst.phase === "installing" || inst.reprovision ? null : { user: MACOS_GUEST_USER, password: this.password(), steps: setupSteps(inst.version) };
      return { state: inst.phase, toolchain, reprovisioning: inst.reprovision, version: inst.version, sizeBytes: 0, startedAt: inst.startedAt, log: inst.log, error: null, sessions, setup };
    }
    if (this.base?.installedAt) {
      // `error` here is a failed reprovision: the base is still usable as it was.
      return { state: "ready", toolchain, reprovisioning: false, version: this.base.version, sizeBytes: this.base.sizeBytes, startedAt: null, log: this.lastError ? this.errorLog : [], error: this.lastError, sessions, setup: null };
    }
    if (this.lastError) {
      return { state: "error", toolchain: false, reprovisioning: false, version: this.base?.version ?? null, sizeBytes: 0, startedAt: null, log: this.errorLog, error: this.lastError, sessions, setup: null };
    }
    if (this.base) {
      // A half-installed disk from before this Control Plane started (it stopped, or was cancelled).
      const error = "An earlier install stopped before macOS was set up. Install again to continue with the disk as it is, or delete it.";
      return { state: "error", toolchain: false, reprovisioning: false, version: this.base.version, sizeBytes: 0, startedAt: null, log: [], error, sessions, setup: null };
    }
    return { state: "missing", toolchain: false, reprovisioning: false, version: null, sizeBytes: 0, startedAt: null, log: [], error: null, sessions, setup: null };
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
    const container = await this.bootBase(version, diskGb, ramGb, cpus, false);
    this.installing = { startedAt: new Date().toISOString(), version, diskGb, log: [], container, phase: "installing", poll: null, checking: false, provisioned: false, reprovision: false };
    this.setBase({ version, diskGb, installedAt: null, sizeBytes: 0, productVersion: null });
    log(`macos: installing the macOS ${version} base disk (${diskGb} GB) in ${INSTALL_CONTAINER}${partial ? ", continuing on the existing disk" : ""}`);
    this.onStatus(this.status());
    void this.follow();
    return this.status();
  }

  /**
   * Boots an installed base once more, unattended (auto-login, Remote Login on), and reruns the
   * SSH provisioning: the toolchain for a base installed before ADR-0061, or new pins. The base
   * disk is written, so no Session overlay may build on it meanwhile.
   */
  async reprovision(): Promise<MacosBaseStatus> {
    if (this.installing) throw new HttpError(409, "The macOS base disk is already installing.");
    if (!this.base?.installedAt) throw new HttpError(409, "There is no installed macOS base disk to reprovision.");
    const sessions = this.countSessions();
    if (sessions > 0) throw new HttpError(409, `${sessions} macOS Session${sessions === 1 ? " still uses" : "s still use"} the base disk; delete ${sessions === 1 ? "it" : "them"} before reprovisioning it.`);
    const kvm = await this.kvmUnavailable(true);
    if (kvm) throw new HttpError(409, kvm);
    const { ramGb, cpus } = this.settings().macos;
    const { version, diskGb } = this.base;
    await this.host.removeContainer(INSTALL_CONTAINER);
    const container = await this.bootBase(version, diskGb, ramGb, cpus, true);
    this.installing = { startedAt: new Date().toISOString(), version, diskGb, log: [], container, phase: "installing", poll: null, checking: false, provisioned: false, reprovision: true };
    log(`macos: reprovisioning the macOS ${version} base disk in ${INSTALL_CONTAINER}`);
    this.onStatus(this.status());
    void this.follow();
    return this.status();
  }

  /** The install container on the base volume, started; its noVNC is what the settings page shows. */
  private async bootBase(version: string, diskGb: number, ramGb: number, cpus: number, reprovision: boolean): Promise<Docker.Container> {
    await this.host.ensureImage();
    this.lastError = null;
    this.errorLog = [];
    const container = await this.docker.createContainer({
      name: INSTALL_CONTAINER,
      Image: MACOS_IMAGE,
      Env: this.guestEnv(version, diskGb, ramGb, cpus),
      Labels: { [LABEL_MACOS]: reprovision ? "reprovision" : "base" },
      // The screen is proxied from the container's noVNC; a host port only where container addresses cannot be dialled.
      ExposedPorts: { [`${MACOS_WEB_PORT}/tcp`]: {} },
      HostConfig: {
        ...this.host.vmHostConfig([`${BASE_VOLUME}:/storage`], ramGb),
        PortBindings: this.sandboxDocker.reach === "localhost" ? { [`${MACOS_WEB_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }] } : {},
      },
    });
    await container.start();
    return container;
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
    if (current.reprovision) {
      // The base stays as it was (the toolchain may be half there; the next reprovision continues).
      this.lastError = "The reprovision was cancelled.";
    } else if (await this.baseComplete(current.version)) {
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
      `RAM_CHECK=N`,
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
      await this.finishInstall(container, version, diskGb, StatusCode, current.provisioned, current.log, current.reprovision);
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
    log(current.reprovision ? "macos: the base VM is booting; waiting for Remote Login" : "macos: the VM is booting; waiting for macOS to be installed and Remote Login turned on");
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
   * the Sandbox's SSH key in `authorized_keys`, the toolchain (`provisionScript`), then a clean
   * shutdown so the disk is consistent for the overlays. dockur exits with the guest, which ends
   * `follow()`. The script's progress lines go to the install log as they come.
   */
  private async finish(current: Install, productVersion: string): Promise<void> {
    let lastReport = 0;
    try {
      const key = await this.sshKey();
      // The password and the public key arrive on stdin, so neither the script nor the ssh container's arguments carry them.
      const out = await this.ssh(INSTALL_CONTAINER, `bash -c "$(echo ${Buffer.from(provisionScript()).toString("base64")} | base64 --decode)"`, PROVISION_TIMEOUT_S, {
        stdin: `${this.password()}\n${key.publicKey}\n`,
        onLine: (line) => {
          if (this.installing !== current) return;
          current.log.push(`❯ ${line}`);
          if (current.log.length > VM_LOG_LINES) current.log.splice(0, current.log.length - VM_LOG_LINES);
          if (Date.now() - lastReport > 1000) {
            lastReport = Date.now();
            this.onStatus(this.status());
          }
        },
      });
      if (!out.includes("SBX_PROVISIONED")) throw new Error(out.slice(-400));
      current.provisioned = true;
      if (this.base) this.setBase({ ...this.base, productVersion, toolchain: TOOLCHAIN });
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

  /**
   * The key pair the Sandboxes log in to the guest with; generated (by `ssh-keygen` in a
   * throwaway Sandbox container) and saved in Settings the first time a base is provisioned,
   * kept across reprovisions and reinstalls.
   */
  private async sshKey(): Promise<{ privateKey: string; publicKey: string }> {
    const settings = this.settings();
    if (settings.macos.sshKey && settings.macos.sshPublicKey) return { privateKey: settings.macos.sshKey, publicKey: settings.macos.sshPublicKey };
    const marker = "__SBX_PRIVATE_KEY__";
    const out = await this.sandboxRun(
      `ssh-keygen -q -t ed25519 -N '' -C sessionboxer-macos -f /tmp/k && cat /tmp/k.pub && echo ${marker} && cat /tmp/k`,
      [],
      60,
    );
    const lines = out.split("\n");
    const at = lines.indexOf(marker);
    const publicKey = lines.slice(0, at).join("\n").trim();
    const privateKey = lines.slice(at + 1).join("\n").trim() + "\n";
    if (at < 0 || !publicKey.startsWith("ssh-ed25519 ") || !privateKey.includes("PRIVATE KEY")) throw new Error("ssh-keygen produced no usable key pair");
    this.saveSettings({ ...settings, macos: { ...settings.macos, sshKey: privateKey, sshPublicKey: publicKey } });
    log("macos: generated the SSH key the Sandboxes log in to the guest with");
    return { privateKey, publicKey };
  }

  /** The installer container exited: a provisioned guest that powered itself off is a ready base. */
  private async finishInstall(container: Docker.Container, version: string, diskGb: number, exitCode: number, provisioned: boolean, tail?: string[], reprovision = false): Promise<void> {
    const current = this.installing;
    this.installing = null;
    if (current?.poll) clearInterval(current.poll);
    const lines = tail ?? (await this.host.tailLogs(container));
    const complete = provisioned && (await this.baseComplete(version));
    if (complete) {
      const sizeBytes = await this.host.volumeSize(BASE_VOLUME);
      this.setBase({ version, diskGb, installedAt: new Date().toISOString(), sizeBytes, productVersion: this.base?.productVersion ?? null, toolchain: this.base?.toolchain });
      this.lastError = null;
      this.errorLog = [];
      log(`macos: base disk ready (${(sizeBytes / 1024 ** 3).toFixed(1)} GB)`);
    } else if (reprovision && this.base?.installedAt) {
      // The base is as it was before (installed, toolchain unchanged); the error shows next to "ready".
      this.lastError = provisioned
        ? "The guest was set up but its disk is missing."
        : `The VM exited (code ${exitCode}) before the tools were installed. Reprovision again; the log below says how far it got.`;
      this.errorLog = lines;
      log(`macos: base reprovision failed: ${this.lastError}`);
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
   * answer or the command fails. `stdin` is fed to the remote command (the password, a key)
   * through the container's environment: nothing secret is on a command line. `onLine` gets
   * each output line as it is printed.
   */
  private async ssh(vmContainer: string, command: string, timeoutSeconds: number, opts: { stdin?: string; onLine?: (line: string) => void } = {}): Promise<string> {
    const ssh = `timeout ${timeoutSeconds} sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 -p ${MACOS_SSH_PORT} ${MACOS_GUEST_USER}@${vmContainer} "$0"`;
    return this.sandboxRun(opts.stdin === undefined ? `exec ${ssh}` : `printf '%s' "$SBX_STDIN" | ${ssh}`, [`SSHPASS=${this.password()}`, ...(opts.stdin === undefined ? [] : [`SBX_STDIN=${opts.stdin}`])], timeoutSeconds + 30, command, opts.onLine);
  }

  /**
   * Runs `sh -c script` (with `arg` as `$0`) in a throwaway Sandbox container; resolves with
   * everything it printed, rejects on a non-zero exit. Output is followed live for `onLine`.
   */
  private async sandboxRun(script: string, env: string[], timeoutSeconds: number, arg = "", onLine?: (line: string) => void): Promise<string> {
    const container = await this.docker.createContainer({
      name: `sbx-mac-ssh-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`,
      Image: SANDBOX_IMAGE,
      Entrypoint: ["/bin/sh", "-c", script, arg],
      Cmd: [],
      Env: env,
      Labels: { [LABEL_MACOS]: "ssh" },
      HostConfig: { NetworkMode: SANDBOX_NETWORK, CapDrop: ["ALL"] },
    });
    try {
      await container.start();
      const out = new PassThrough();
      const stream = (await container.logs({ follow: true, stdout: true, stderr: true })) as NodeJS.ReadableStream;
      this.docker.modem.demuxStream(stream, out, out);
      let text = "";
      let pending = "";
      const done = new Promise<void>((resolve) => {
        out.on("data", (chunk: Buffer) => {
          const piece = chunk.toString("utf8");
          text += piece;
          if (!onLine) return;
          pending += piece;
          const parts = pending.split(/\r?\n/);
          pending = parts.pop() ?? "";
          for (const raw of parts) {
            // eslint-disable-next-line no-control-regex
            const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
            if (line) onLine(line);
          }
        });
        stream.on("end", resolve);
        stream.on("error", () => resolve());
      });
      const killer = setTimeout(() => void container.kill().catch(() => undefined), (timeoutSeconds + 60) * 1000);
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      clearTimeout(killer);
      await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
      const output = text.replace(/\r/g, "").trim();
      if (StatusCode !== 0) throw new Error(`ssh exited ${StatusCode}: ${output.slice(-400)}`);
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
    if (!this.base?.installedAt) throw new HttpError(409, "The macOS base disk is not installed (Global settings → Environment → macOS VMs).");
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
      // The Daemon writes it to tmpfs for `ssh -i` and drops it from its environment (ADR-0061).
      ...(this.settings().macos.sshKey ? { SESSIONBOXER_MACOS_SSH_KEY: this.settings().macos.sshKey } : {}),
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
    "Sessionboxer then sees the VM on SSH, turns off sleep and the screen saver, sets auto-login, installs Node, git, uv and the agent CLIs (10–30 minutes; progress below), shuts the VM down and calls the base ready.",
  ];
}

/**
 * What runs in the guest over SSH, as `agent` (an administrator), with the password and the
 * Sandbox's public key as its first two lines of stdin (ADR-0061). Idempotent: every step checks
 * what is there and says what it does; `SBX_PROVISIONED` at the end is what `finish` looks for.
 *
 * - Sleep, screen saver and screen lock off, auto-login: a Session's VM boots to the desktop.
 *   `sysadminctl -autologin set` fails over SSH on macOS 15 (`SACSetAutoLoginPassword error:22`),
 *   so when it leaves auto-login off the classic `/etc/kcpassword` is written instead (the password
 *   XORed with Apple's 11-byte key, padded to 12 bytes) with `autoLoginUser` in the loginwindow prefs.
 * - `~/.ssh/authorized_keys` gets the Sandbox key; `~/.zprofile`, `~/.zshenv` and `~/.bash_profile`
 *   put `/usr/local/bin` and `~/.local/bin` first, so the Terminal (`zsh -l`) and an `ssh vm cmd`
 *   (zsh reads `.zshenv` for those) find the tools; the Daemon's own scripts set PATH themselves.
 * - git: Apple's Command Line Tools through `softwareupdate` (the label it lists), unless
 *   `xcode-select -p` already answers. Apple's bundled `/usr/bin/git` is only a stub that asks to
 *   install the CLT, so there is no lighter choice; Homebrew is not used (not deterministic).
 * - Node: the official tarball for `uname -m` unpacked into `/usr/local`, owned by the account so
 *   `npm install -g` needs no sudo; then the Provider CLIs with the same pins as Windows.
 * - uv: Astral's pinned installer into `~/.local/bin`. Devin: its pinned `setup.sh` (checksummed
 *   bundle under `~/.local/share/devin`, `~/.local/bin/devin`). Cursor: the pinned macOS package
 *   under `~/.local/share/cursor-agent`, `~/.local/bin/{cursor-agent,agent}`.
 */
/** Encodes stdin as `/etc/kcpassword`: XOR with Apple's key, NUL-terminated and padded to 12 bytes. */
const KCPASSWORD_PERL =
  'my $pw = do { local $/; <STDIN> }; my @k = (0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F); ' +
  'my @b = unpack("C*", $pw); my $len = (int(@b / 12) + 1) * 12; my $o = ""; ' +
  'for my $i (0 .. $len - 1) { my $c = $i < @b ? $b[$i] : 0; $o .= chr($c ^ $k[$i % 11]); } print $o;';

function provisionScript(): string {
  return [
    "set -u -o pipefail",
    "IFS= read -r SBX_PW",
    "IFS= read -r SBX_KEY",
    `sudo() { printf '%s\\n' "$SBX_PW" | command sudo -S -p '' "$@"; }`,
    `say() { printf '%s\\n' "$*"; }`,
    `fail() { say "FAILED: $*"; exit 1; }`,
    `export PATH="/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"`,
    `export HOMEBREW_NO_AUTO_UPDATE=1 npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false`,
    `ARCH=$(uname -m)`,
    `case "$ARCH" in arm64) NODE_ARCH=arm64; CURSOR_ARCH=arm64 ;; x86_64) NODE_ARCH=x64; CURSOR_ARCH=x64 ;; *) fail "unsupported architecture $ARCH" ;; esac`,
    `say "macOS $(sw_vers -productVersion) ($ARCH), setting up as $(id -un)"`,
    // Power and login.
    "sudo pmset -a sleep 0 displaysleep 0 disksleep 0 2>/dev/null || true",
    "defaults -currentHost write com.apple.screensaver idleTime 0 2>/dev/null || true",
    `sudo sysadminctl -autologin set -userName ${MACOS_GUEST_USER} -password "$SBX_PW" >/dev/null 2>&1 || true`,
    `if sudo sysadminctl -autologin status 2>&1 | grep -q "Automatic login user"; then AUTOLOGIN=sysadminctl; else`,
    `  mkdir -p "$HOME/.sessionboxer"`,
    `  printf '%s' "$SBX_PW" | perl -e '${KCPASSWORD_PERL}' > "$HOME/.sessionboxer/kcpassword" || fail "encoding /etc/kcpassword"`,
    `  sudo install -m 600 -o root -g wheel "$HOME/.sessionboxer/kcpassword" /etc/kcpassword || fail "writing /etc/kcpassword"`,
    `  rm -f "$HOME/.sessionboxer/kcpassword"`,
    `  sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser ${MACOS_GUEST_USER} || fail "setting autoLoginUser"`,
    "  AUTOLOGIN=kcpassword",
    "fi",
    "sudo defaults write /Library/Preferences/com.apple.loginwindow DisableScreenLockImmediate -bool true 2>/dev/null || true",
    `say "sleep and the screen saver off, auto-login set for $(id -un) ($AUTOLOGIN)"`,
    // SSH key, directories, PATH for login shells.
    `if [ -n "$SBX_KEY" ]; then`,
    `  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"`,
    `  touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"`,
    `  grep -qxF "$SBX_KEY" "$HOME/.ssh/authorized_keys" || printf '%s\\n' "$SBX_KEY" >> "$HOME/.ssh/authorized_keys"`,
    `  say "Sessionboxer's SSH key authorized"`,
    "fi",
    `mkdir -p "$HOME/workspace" "$HOME/.local/bin" "$HOME/.sessionboxer"`,
    `PATH_LINE='export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"'`,
    `for f in "$HOME/.zprofile" "$HOME/.zshenv" "$HOME/.bash_profile"; do touch "$f"; grep -qxF "$PATH_LINE" "$f" || printf '%s\\n' "$PATH_LINE" >> "$f"; done`,
    // git: Apple's Command Line Tools.
    `if xcode-select -p >/dev/null 2>&1 && [ -x "$(xcode-select -p)/usr/bin/git" ]; then`,
    `  say "git: $(git --version) (Command Line Tools present)"`,
    "else",
    `  say "installing Apple's Command Line Tools (git) with softwareupdate; this takes a while"`,
    `  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress`,
    `  LABEL=$(softwareupdate -l 2>/dev/null | grep -o 'Command Line Tools for Xcode-[0-9.]*' | awk -F- '{ print $NF " " $0 }' | sort -n | tail -1 | cut -d' ' -f2-)`,
    `  [ -n "$LABEL" ] || { rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress; fail "softwareupdate lists no Command Line Tools (is Apple's update server reachable?)"; }`,
    `  say "softwareupdate --install \"$LABEL\""`,
    `  sudo softwareupdate --install "$LABEL" --agree-to-license 2>&1 | grep -v '^$' | tail -5`,
    `  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress`,
    `  xcode-select -p >/dev/null 2>&1 || sudo xcode-select --switch /Library/Developer/CommandLineTools >/dev/null 2>&1 || true`,
    `  [ -x "$(xcode-select -p 2>/dev/null)/usr/bin/git" ] || fail "git is still missing after installing the Command Line Tools"`,
    `  say "git: $(git --version)"`,
    "fi",
    // Node.
    `if [ "$(/usr/local/bin/node -v 2>/dev/null)" = "v${NODE_VERSION}" ]; then`,
    `  say "node ${NODE_VERSION} present"`,
    "else",
    `  say "installing node ${NODE_VERSION} ($NODE_ARCH)"`,
    `  curl -fsSL --retry 5 --retry-all-errors -o /tmp/sbx-node.tar.gz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-$NODE_ARCH.tar.gz" || fail "downloading node"`,
    `  sudo mkdir -p /usr/local/bin /usr/local/lib /usr/local/include /usr/local/share`,
    `  sudo tar -xzf /tmp/sbx-node.tar.gz -C /usr/local --strip-components=1 || fail "unpacking node"`,
    `  sudo rm -f /usr/local/CHANGELOG.md /usr/local/LICENSE /usr/local/README.md /tmp/sbx-node.tar.gz`,
    "fi",
    `sudo chown -R "$(id -un):admin" /usr/local/bin /usr/local/lib /usr/local/include /usr/local/share 2>/dev/null || true`,
    `say "node $(node -v), npm $(npm -v)"`,
    // Provider CLIs from npm.
    `say "installing @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}, @agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}, @agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}"`,
    `npm install -g --no-fund --no-audit @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION} @agentclientprotocol/codex-acp@${CODEX_ACP_VERSION} 2>&1 | tail -3 || fail "npm install -g"`,
    `command -v claude-agent-acp >/dev/null && command -v codex-acp >/dev/null && command -v claude >/dev/null || fail "the npm CLIs are not on PATH after the install"`,
    // pi and its ACP adapter (ADR-0075).
    `say "installing @earendil-works/pi-coding-agent@${PI_VERSION}, pi-acp@${PI_ACP_VERSION}"`,
    `npm install -g --no-fund --no-audit @earendil-works/pi-coding-agent@${PI_VERSION} pi-acp@${PI_ACP_VERSION} 2>&1 | tail -3 || fail "npm install -g pi"`,
    `command -v pi >/dev/null && command -v pi-acp >/dev/null || fail "pi is not on PATH after the install"`,
    // uv.
    `if [ "$("$HOME/.local/bin/uv" --version 2>/dev/null | awk '{ print $2 }')" = "${UV_VERSION}" ]; then`,
    `  say "uv ${UV_VERSION} present"`,
    "else",
    `  say "installing uv ${UV_VERSION}"`,
    `  curl -fsSL --retry 5 --retry-all-errors "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_NO_MODIFY_PATH=1 UV_INSTALL_DIR="$HOME/.local/bin" sh >/dev/null 2>&1 || fail "installing uv"`,
    `  say "uv $("$HOME/.local/bin/uv" --version | awk '{ print $2 }')"`,
    "fi",
    // Devin CLI.
    `if [ -x "$HOME/.local/share/devin/cli/_versions/${DEVIN_CLI_VERSION}/bin/devin" ] && [ -x "$HOME/.local/bin/devin" ]; then`,
    `  say "devin ${DEVIN_CLI_VERSION} present"`,
    "else",
    `  say "installing the Devin CLI ${DEVIN_CLI_VERSION}"`,
    `  curl -fsSL --retry 5 --retry-all-errors "https://static.devin.ai/cli/${DEVIN_CLI_VERSION}/setup.sh" -o /tmp/sbx-devin-setup.sh || fail "downloading the Devin CLI installer"`,
    `  (bash /tmp/sbx-devin-setup.sh </dev/null >/tmp/sbx-devin-setup.log 2>&1 || true)`,
    `  rm -f /tmp/sbx-devin-setup.sh`,
    `  [ -x "$HOME/.local/bin/devin" ] || { tail -5 /tmp/sbx-devin-setup.log; fail "the Devin CLI did not install"; }`,
    `  rm -f /tmp/sbx-devin-setup.log`,
    `  say "devin $("$HOME/.local/bin/devin" --version 2>/dev/null | head -1)"`,
    "fi",
    // Cursor CLI.
    `CURSOR_DIR="$HOME/.local/share/cursor-agent/versions/${CURSOR_CLI_VERSION}"`,
    `if [ -x "$CURSOR_DIR/cursor-agent" ]; then`,
    `  say "cursor-agent ${CURSOR_CLI_VERSION} present"`,
    "else",
    `  say "installing the Cursor CLI ${CURSOR_CLI_VERSION} ($CURSOR_ARCH)"`,
    `  rm -rf "$CURSOR_DIR.tmp" && mkdir -p "$CURSOR_DIR.tmp"`,
    `  curl -fsSL --retry 5 --retry-all-errors "https://downloads.cursor.com/lab/${CURSOR_CLI_VERSION}/darwin/$CURSOR_ARCH/agent-cli-package.tar.gz" | tar -xzf - -C "$CURSOR_DIR.tmp" --strip-components=1 || fail "downloading the Cursor CLI"`,
    `  [ -x "$CURSOR_DIR.tmp/cursor-agent" ] || fail "the Cursor CLI package has no cursor-agent"`,
    `  rm -rf "$CURSOR_DIR" && mv "$CURSOR_DIR.tmp" "$CURSOR_DIR"`,
    "fi",
    `ln -sfn "$CURSOR_DIR/cursor-agent" "$HOME/.local/bin/cursor-agent" && ln -sfn "$CURSOR_DIR/cursor-agent" "$HOME/.local/bin/agent"`,
    `say "tools: $(node -v) npm $(npm -v) $(git --version) uv $("$HOME/.local/bin/uv" --version | awk '{ print $2 }') claude-agent-acp codex-acp pi-acp devin cursor-agent in $(dirname "$(command -v claude-agent-acp)") and $HOME/.local/bin"`,
    "echo SBX_PROVISIONED",
    // Detached, after this SSH session has returned: `nohup` could not run the `sudo` function above.
    `(sleep 3; printf '%s\\n' "$SBX_PW" | command sudo -S -p '' shutdown -h now) </dev/null >/dev/null 2>&1 &`,
  ].join("\n");
}

