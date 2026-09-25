import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { z } from "zod";
import type { Session, SessionEventBody, SessionUsb, UsbDevice, UsbHost } from "@sessionboxer/protocol";
import type { Db, SessionPatch } from "./db.js";
import { usbNodePath, type SandboxDocker, type UsbNode } from "./docker.js";
import { HttpError } from "./http-error.js";

/**
 * USB devices for Sandboxes (ADR-0055).
 *
 * The devices are the ones the Docker host's kernel has: read from sysfs, which is the machine's
 * own on Linux and the WSL2 VM's when the Control Plane runs in WSL2 (the same kernel Docker
 * Engine runs on there; a Control Plane in a compose container sees the host's sysfs too). On
 * WSL2 with usbipd-win installed the Windows side is listed as well and "connect" attaches the
 * device to WSL2 first (`usbipd.exe attach --wsl --auto-attach`, run through WSL interop, kept
 * running so the device comes back after every reset); sharing it (`usbipd bind`) needs
 * administrator rights once per device, asked for through a UAC prompt.
 *
 * One Session per device: connecting a device to a Session takes it from the one that had it.
 * A Session's device is a claim on the stable device identity; the reconciler follows the
 * kernel's numbering (`/dev/bus/usb/BBB/DDD` changes on every re-plug, reset or mode switch)
 * and has the Sandbox's node replaced (see `SandboxDocker.setUsbNode`).
 */

const SYSFS_USB = "/sys/bus/usb/devices";
const HUB_CLASS = "09";
const RECONCILE_MS = 2000;
const ATTACH_TIMEOUT_MS = 25_000;
const REATTACH_MIN_MS = 15_000;
const USBIPD_TIMEOUT_MS = 20_000;
const BUS_ID = /^\d+-\d+(\.\d+)*$/;

/** A device the Docker host's kernel has (from sysfs). */
export interface KernelUsbDevice {
  id: string;
  /** sysfs name, the bus-port path (`1-4`, `2-1.3`). */
  sysName: string;
  name: string;
  vendorId: string;
  productId: string;
  serial: string | null;
  node: UsbNode;
}

/** A device Windows has, from `usbipd.exe state`. */
interface WindowsUsbDevice {
  busId: string;
  description: string;
  vendorId: string;
  productId: string;
  serial: string | null;
  bound: boolean;
  attached: boolean;
}

const UsbipdState = z.object({
  Devices: z.array(
    z.object({
      BusId: z.string().nullable().optional(),
      ClientIPAddress: z.string().nullable().optional(),
      Description: z.string().nullable().optional(),
      InstanceId: z.string(),
      PersistedGuid: z.string().nullable().optional(),
    }),
  ),
});

function readAttr(dir: string, name: string): string | null {
  try {
    return readFileSync(`${dir}/${name}`, "utf8").trim();
  } catch {
    return null;
  }
}

function deviceId(vendorId: string, productId: string, serial: string | null, fallback: string): string {
  return serial ? `${vendorId}:${productId}:${serial}` : `${vendorId}:${productId}@${fallback}`;
}

/** The USB devices in this kernel's sysfs: everything but root hubs, hubs and interfaces. */
export function listKernelUsbDevices(): KernelUsbDevice[] {
  let names: string[];
  try {
    names = readdirSync(SYSFS_USB);
  } catch {
    return [];
  }
  const devices: KernelUsbDevice[] = [];
  for (const sysName of names) {
    if (/^usb\d+$/.test(sysName) || sysName.includes(":")) continue;
    const dir = `${SYSFS_USB}/${sysName}`;
    const vendorId = readAttr(dir, "idVendor");
    const productId = readAttr(dir, "idProduct");
    const bus = Number(readAttr(dir, "busnum"));
    const dev = Number(readAttr(dir, "devnum"));
    if (!vendorId || !productId || !Number.isInteger(bus) || !Number.isInteger(dev) || bus < 1 || dev < 1) continue;
    if (readAttr(dir, "bDeviceClass") === HUB_CLASS) continue;
    const serial = readAttr(dir, "serial") || null;
    const name = [readAttr(dir, "manufacturer"), readAttr(dir, "product")].filter(Boolean).join(" ") || `USB device ${vendorId}:${productId}`;
    devices.push({ id: deviceId(vendorId, productId, serial, sysName), sysName, name, vendorId, productId, serial, node: { bus, dev } });
  }
  return devices.sort((a, b) => a.sysName.localeCompare(b.sysName, undefined, { numeric: true }));
}

/** Whether this Linux is a WSL2 distribution (Windows binaries reachable through interop). */
function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** Hardware ids from a Windows device instance id: `USB\VID_18D1&PID_4EE7\<serial or generated id>`. */
function parseInstanceId(instanceId: string): { vendorId: string; productId: string; serial: string | null } | null {
  const m = /^USB\\VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})(?:&[^\\]*)?\\(.*)$/.exec(instanceId);
  if (!m) return null;
  // Windows makes up an instance id with `&` in it for devices without a serial number.
  const tail = m[3] ?? "";
  return { vendorId: m[1]!.toLowerCase(), productId: m[2]!.toLowerCase(), serial: tail && !tail.includes("&") ? tail : null };
}

/** The kernel device a Windows one is (once attached), by serial number or, without one, as the only device with its ids. */
function matchKernel(win: WindowsUsbDevice, kernel: KernelUsbDevice[]): KernelUsbDevice | null {
  const same = kernel.filter((k) => k.vendorId === win.vendorId && k.productId === win.productId);
  if (win.serial) return same.find((k) => k.serial === win.serial) ?? (same.length === 1 && same[0]!.serial === null ? same[0]! : null);
  return same.length === 1 ? same[0]! : null;
}

interface Deps {
  db: Db;
  docker: SandboxDocker;
  update: (id: string, patch: SessionPatch) => Session;
  appendEvent: (id: string, body: SessionEventBody) => void;
  /** Told to the Agent at its next prompt. */
  note: (id: string, text: string) => void;
  log: (msg: string) => void;
}

export class UsbDevices {
  /** Serializes connect/disconnect/reconcile so two never edit a Session's volume at once. */
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** `usbipd.exe attach --auto-attach` processes by bus id (WSL2 only). */
  private readonly attaching = new Map<string, { child: ChildProcess; stderr: string; startedAt: number }>();
  private kind: UsbHost["kind"] | null = null;
  private kindNote: string | null = null;

  constructor(private readonly deps: Deps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.enqueue(() => this.reconcile()), RECONCILE_MS);
    this.timer.unref();
    void this.enqueue(() => this.reconcile());
  }

  /** What the host has and who holds what (`GET /api/usb`). */
  async host(): Promise<UsbHost> {
    const kind = await this.hostKind();
    if (kind === "unsupported") return { kind, note: this.kindNote, devices: [] };
    const owners = new Map(this.claims().map((s) => [s.usb!.id, s.id]));
    const kernel = listKernelUsbDevices();
    const devices: UsbDevice[] = [];
    const matched = new Set<string>();
    if (kind === "wsl") {
      for (const win of await this.windowsDevices()) {
        const k = matchKernel(win, kernel);
        if (k) matched.add(k.id);
        const id = k?.id ?? deviceId(win.vendorId, win.productId, win.serial, `wsl:${win.busId}`);
        devices.push({
          id,
          name: k?.name ?? win.description,
          vendorId: win.vendorId,
          productId: win.productId,
          serial: k?.serial ?? win.serial,
          node: k ? usbNodePath(k.node) : null,
          wsl: { busId: win.busId, bound: win.bound },
          sessionId: owners.get(id) ?? null,
        });
      }
    }
    for (const k of kernel) {
      if (matched.has(k.id)) continue;
      devices.push({ id: k.id, name: k.name, vendorId: k.vendorId, productId: k.productId, serial: k.serial, node: usbNodePath(k.node), wsl: null, sessionId: owners.get(k.id) ?? null });
    }
    return { kind, note: this.kindNote, devices };
  }

  /** Gives `deviceId` to Session `id`, taking it from whichever Session had it. */
  connect(id: string, deviceId: string): Promise<Session> {
    return this.enqueue(async () => {
      const s = this.session(id);
      if (!s.containerId) throw new HttpError(409, "The Session has no Sandbox.");
      if (!(await this.deps.docker.supportsUsb(s.containerId))) {
        throw new HttpError(409, "This Sandbox was created before USB devices were supported; start a new Session (or fork this one) to connect a device.");
      }
      const host = await this.host();
      if (host.kind === "unsupported") throw new HttpError(409, host.note ?? "USB devices cannot be connected on this host.");
      const device = host.devices.find((d) => d.id === deviceId);
      if (!device) throw new HttpError(404, "That USB device is not plugged in anymore.");
      if (device.sessionId === id && s.usb?.id === device.id) return s;
      let kernel = device.node ? listKernelUsbDevices().find((k) => usbNodePath(k.node) === device.node) ?? null : null;
      if (!kernel) {
        if (!device.wsl) throw new HttpError(409, "That USB device is not plugged in anymore.");
        kernel = await this.attachToWsl(device.wsl.busId, device.wsl.bound, device.vendorId, device.productId, device.serial);
      }
      for (const other of this.claims()) {
        if (other.id !== id && other.usb?.id === kernel.id) await this.release(other, "it was connected to another Session", device.wsl !== null);
      }
      await this.deps.docker.setUsbNode(id, kernel.node);
      const usb: SessionUsb = {
        id: kernel.id,
        name: kernel.name,
        vendorId: kernel.vendorId,
        productId: kernel.productId,
        serial: kernel.serial,
        node: usbNodePath(kernel.node),
        wslBusId: device.wsl?.busId ?? null,
      };
      const next = this.deps.update(id, { usb });
      this.deps.appendEvent(id, { type: "usb_changed", action: "connected", name: usb.name, node: usb.node });
      this.deps.note(
        id,
        `The user connected the USB device "${usb.name}" (${usb.vendorId}:${usb.productId}${usb.serial ? `, serial ${usb.serial}` : ""}) to this Sandbox: it is ${usb.node}, ` +
          `owned by you; it is the only USB device you can reach. Nothing that talks to it is preinstalled (for an Android phone: sudo apt-get install -y adb, then adb devices). ` +
          `When it re-enumerates (unplug, reset, a USB mode or debugging-authorisation change) its number changes: look under /dev/bus/usb again.`,
      );
      this.deps.log(`usb: ${usb.name} (${usb.id}) -> session ${id} as ${usb.node}`);
      return next;
    });
  }

  /** Takes the Session's device away (`DELETE /api/sessions/:id/usb`). */
  disconnect(id: string): Promise<Session> {
    return this.enqueue(async () => {
      const s = this.session(id);
      if (!s.usb) return s;
      return this.release(s, "the user disconnected it");
    });
  }

  /** The Session was deleted (its record and container are gone): drops its WSL attachment and its `/dev/bus/usb` volume. */
  forget(s: Session): Promise<void> {
    return this.enqueue(async () => {
      if (s.usb?.wslBusId) await this.detachFromWsl(s.usb.wslBusId);
      await this.deps.docker.removeUsbVolume(s.id).catch((e: unknown) => this.deps.log(`usb: could not remove ${s.id}'s volume: ${String(e)}`));
    });
  }

  /** `keepWsl`: the device stays attached to WSL2 (another Session is about to take it). */
  private async release(s: Session, why: string, keepWsl = false): Promise<Session> {
    const usb = s.usb!;
    await this.deps.docker.setUsbNode(s.id, null).catch((e: unknown) => this.deps.log(`usb: could not clear ${s.id}'s node: ${String(e)}`));
    if (usb.wslBusId && !keepWsl) await this.detachFromWsl(usb.wslBusId);
    const next = this.deps.update(s.id, { usb: null });
    this.deps.appendEvent(s.id, { type: "usb_changed", action: "disconnected", name: usb.name, node: null });
    this.deps.note(s.id, `The USB device "${usb.name}" was disconnected from this Sandbox (${why}); ${usb.node ?? "its node"} is gone.`);
    this.deps.log(`usb: ${usb.name} (${usb.id}) released from session ${s.id} (${why})`);
    return next;
  }

  /** Follows each claimed device's current kernel numbering into its Sandbox. */
  private async reconcile(): Promise<void> {
    const claims = this.claims();
    if (claims.length === 0) return;
    const kernel = listKernelUsbDevices();
    for (const s of claims) {
      const usb = s.usb!;
      const k = this.findKernel(usb, kernel);
      const node = k ? usbNodePath(k.node) : null;
      if (node === usb.node) {
        if (!k && usb.wslBusId) this.maybeReattach(usb.wslBusId);
        continue;
      }
      try {
        await this.deps.docker.setUsbNode(s.id, k?.node ?? null);
      } catch (e) {
        this.deps.log(`usb: could not update ${s.id}'s node: ${String(e)}`);
        continue;
      }
      this.deps.update(s.id, { usb: { ...usb, node, ...(k ? { id: k.id, name: k.name } : {}) } });
      this.deps.note(
        s.id,
        node
          ? `The USB device "${usb.name}" re-enumerated: it is now ${node}${usb.node ? ` (was ${usb.node})` : ""}.`
          : `The USB device "${usb.name}" was unplugged (or reset); ${usb.node} is gone. It comes back under a new number under /dev/bus/usb when it is plugged in again.`,
      );
      this.deps.log(`usb: ${usb.name} for session ${s.id}: ${usb.node ?? "(none)"} -> ${node ?? "(unplugged)"}`);
    }
  }

  /** The claimed device as the kernel has it now; a device without a serial number is the only one with its ids. */
  private findKernel(usb: SessionUsb, kernel: KernelUsbDevice[]): KernelUsbDevice | null {
    const byId = kernel.find((k) => k.id === usb.id);
    if (byId || usb.serial) return byId ?? null;
    const same = kernel.filter((k) => k.vendorId === usb.vendorId && k.productId === usb.productId && k.serial === null);
    return same.length === 1 ? same[0]! : null;
  }

  private claims(): Session[] {
    return this.deps.db.listSessions().filter((s) => s.usb !== null);
  }

  private session(id: string): Session {
    const s = this.deps.db.getSession(id);
    if (!s) throw new HttpError(404, `session ${id} not found`);
    return s;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // --- host kind ---------------------------------------------------------------------------

  /**
   * Whether the Docker daemon's kernel is this one (its devices are what we can see and expose):
   * not on macOS/Windows (Docker in a VM), nor on a Linux whose daemon reports another kernel.
   */
  private async hostKind(): Promise<UsbHost["kind"]> {
    if (this.kind) return this.kind;
    if (process.platform !== "linux") {
      this.kindNote = "USB devices can be connected when Docker runs on this machine's kernel: Linux, or Docker Engine inside WSL2 on Windows. Docker Desktop runs in a VM this Control Plane cannot see into.";
      return (this.kind = "unsupported");
    }
    let daemonKernel = "";
    try {
      daemonKernel = ((await this.deps.docker.docker.info()) as { KernelVersion?: string }).KernelVersion ?? "";
    } catch {
      // no daemon: the listing is still this kernel's
    }
    if (daemonKernel && daemonKernel !== release()) {
      this.kindNote = `The Docker daemon runs on another kernel (${daemonKernel}, this machine: ${release()}), so its devices are not this machine's. Run Docker Engine on this kernel to connect USB devices.`;
      return (this.kind = "unsupported");
    }
    if (isWsl()) {
      try {
        await this.usbipd(["state"]);
        return (this.kind = "wsl");
      } catch (e) {
        this.kindNote = `WSL2 without usbipd-win: only devices already attached to WSL2 are listed. Install usbipd-win on Windows (winget install usbipd) to connect devices from here${/ENOENT/.test(String(e)) ? "" : ` (${String(e).slice(0, 200)})`}.`;
        this.deps.log(`usb: usbipd.exe not usable: ${String(e)}`);
        return (this.kind = "linux");
      }
    }
    return (this.kind = "linux");
  }

  // --- WSL2 / usbipd-win -------------------------------------------------------------------

  private async windowsDevices(): Promise<WindowsUsbDevice[]> {
    const out = await this.usbipd(["state"]);
    const state = UsbipdState.parse(JSON.parse(out));
    const devices: WindowsUsbDevice[] = [];
    for (const d of state.Devices) {
      const ids = parseInstanceId(d.InstanceId);
      if (!d.BusId || !ids) continue; // not plugged in (persisted bind only), or not a plain USB device
      devices.push({
        busId: d.BusId,
        description: d.Description || `USB device ${ids.vendorId}:${ids.productId}`,
        ...ids,
        bound: Boolean(d.PersistedGuid),
        attached: Boolean(d.ClientIPAddress),
      });
    }
    return devices;
  }

  /** Attaches the Windows device to WSL2 (sharing it first when needed) and waits for the kernel to have it. */
  private async attachToWsl(busId: string, bound: boolean, vendorId: string, productId: string, serial: string | null): Promise<KernelUsbDevice> {
    if (!BUS_ID.test(busId)) throw new HttpError(400, `unexpected usbipd bus id ${busId}`);
    if (!bound) {
      // `usbipd bind` needs administrator rights (once per device; it persists across reboots): ask Windows for them.
      await this.elevate(["bind", "--busid", busId]).catch((e: unknown) => this.deps.log(`usb: elevated bind failed: ${String(e)}`));
      const now = (await this.windowsDevices()).find((d) => d.busId === busId);
      if (!now?.bound) {
        throw new HttpError(
          409,
          `Sharing the device with WSL2 needs administrator rights once: approve the Windows prompt, or run \`usbipd bind --busid ${busId}\` in an administrator PowerShell, then connect again.`,
        );
      }
    }
    this.spawnAttach(busId);
    const deadline = Date.now() + ATTACH_TIMEOUT_MS;
    const probe: WindowsUsbDevice = { busId, description: "", vendorId, productId, serial, bound: true, attached: true };
    while (Date.now() < deadline) {
      const k = matchKernel(probe, listKernelUsbDevices());
      if (k) return k;
      const running = this.attaching.get(busId);
      if (running && running.child.exitCode !== null) {
        this.attaching.delete(busId);
        throw new HttpError(502, `usbipd attach --wsl --busid ${busId} exited ${running.child.exitCode}: ${running.stderr.trim().slice(-400) || "no output"}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.detachFromWsl(busId);
    throw new HttpError(504, `The device did not show up in WSL2 within ${ATTACH_TIMEOUT_MS / 1000}s of \`usbipd attach --wsl --busid ${busId}\`.`);
  }

  /** Keeps `usbipd attach --auto-attach` running for `busId` (it re-attaches the device after every reset or re-plug). */
  private spawnAttach(busId: string): void {
    const running = this.attaching.get(busId);
    if (running && running.child.exitCode === null) return;
    const child = spawn("usbipd.exe", ["attach", "--wsl", "--busid", busId, "--auto-attach"], { stdio: ["ignore", "ignore", "pipe"], cwd: interopCwd() });
    const entry = { child, stderr: "", startedAt: Date.now() };
    child.stderr?.on("data", (c: Buffer) => (entry.stderr = (entry.stderr + c.toString("utf8")).slice(-2000)));
    child.on("error", (e) => (entry.stderr += `\n${e.message}`));
    child.on("exit", (code) => this.deps.log(`usb: usbipd attach ${busId} exited ${code ?? "?"}${entry.stderr.trim() ? `: ${entry.stderr.trim().slice(-200)}` : ""}`));
    this.attaching.set(busId, entry);
  }

  /** The claimed device is not in the kernel and its attach process died: start it again (not more than every `REATTACH_MIN_MS`). */
  private maybeReattach(busId: string): void {
    if (this.kind !== "wsl") return;
    const running = this.attaching.get(busId);
    if (running && (running.child.exitCode === null || Date.now() - running.startedAt < REATTACH_MIN_MS)) return;
    this.spawnAttach(busId);
  }

  private async detachFromWsl(busId: string): Promise<void> {
    const running = this.attaching.get(busId);
    if (running) {
      this.attaching.delete(busId);
      if (running.child.exitCode === null) running.child.kill();
    }
    if (this.kind !== "wsl" || !BUS_ID.test(busId)) return;
    await this.usbipd(["detach", "--busid", busId]).catch((e: unknown) => this.deps.log(`usb: usbipd detach ${busId}: ${String(e)}`));
  }

  private usbipd(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("usbipd.exe", args, { timeout: USBIPD_TIMEOUT_MS, cwd: interopCwd(), windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(`usbipd ${args.join(" ")}: ${stderr.trim() || err.message}`));
        else resolve(stdout);
      });
    });
  }

  /** Runs `usbipd <args>` elevated through a UAC prompt on the Windows desktop; resolves when that process exits. */
  private elevate(args: string[]): Promise<void> {
    const list = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
    return new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath usbipd -ArgumentList ${list} -Verb RunAs -Wait`],
        { timeout: 120_000, cwd: interopCwd(), windowsHide: true },
        (err, _stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()),
      );
    });
  }
}

/** A Windows-visible working directory, so interop does not warn about UNC paths for every call. */
function interopCwd(): string | undefined {
  return existsSync("/mnt/c") ? "/mnt/c" : undefined;
}

