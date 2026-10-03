import { useState } from "react";
import {
  DEFAULT_DOCKER_ADDRESS_POOL,
  DOCKER_ADDRESS_POOL_PATTERN,
  type PublicSettings,
  type WindowsBaseStatus,
  WINDOWS_VERSIONS,
  WINDOWS_GUEST_USER,
  type MacosBaseStatus,
  MACOS_VERSIONS,
  MACOS_GUEST_USER,
} from "@sessionboxer/protocol";
import { api } from "../api";
import { formatMb } from "../format";
import { MacosBase } from "../MacosBase";
import { DockerModeNote } from "../SessionSettingsForm";
import { Caption, Select } from "../ui";
import type { Setter } from "./shared";

/** The shared Windows base disk (ADR-0057): its state and the Install / Cancel / Delete buttons. */
function WindowsBase({
  settings,
  status,
  onStatus,
  dirty,
}: {
  settings: PublicSettings;
  status: WindowsBaseStatus | null;
  onStatus: (status: WindowsBaseStatus) => void;
  /** Edition or disk size changed in the form but not saved yet: installing now would use the saved ones. */
  dirty: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const availability = settings.environments["qemu-windows"];
  const act = async (call: () => Promise<WindowsBaseStatus>) => {
    setWorking(true);
    setError(null);
    try {
      onStatus(await call());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      setConfirmDelete(false);
    }
  };
  if (!status) return <p className="muted">Checking the base disk…</p>;
  const edition = WINDOWS_VERSIONS.find((v) => v.code === status.version)?.label ?? status.version;
  const started = status.startedAt ? new Date(status.startedAt) : null;
  const line =
    status.state === "ready"
      ? `Base disk ready: ${edition} (${formatMb(status.sizeBytes)} on disk)${status.sessions > 0 ? `, ${status.sessions} Session${status.sessions === 1 ? "" : "s"} built on it` : ""}.`
      : status.state === "installing"
        ? `Installing ${edition}${started ? `, started ${started.toLocaleTimeString()}` : ""}… Windows downloads and installs itself; this takes 20–40 minutes.`
        : status.state === "error"
          ? `Installing ${edition ?? "the base"} failed: ${status.error ?? "unknown error"}`
          : "No base disk yet: no Windows Session can be created until it is installed.";
  return (
    <div className="windows-base">
      <p className={status.state === "error" ? "error" : "muted"}>{line}</p>
      {!availability.available && availability.reason && status.state !== "installing" && (
        <p className="muted">QEMU · Windows cannot be picked yet: {availability.reason}</p>
      )}
      {(status.state === "installing" || status.state === "error") && status.log.length > 0 && (
        <pre className="windows-base-log">{status.log.join("\n")}</pre>
      )}
      <div className="row">
        {(status.state === "missing" || status.state === "error") && (
          <button type="button" className="small" disabled={working || dirty} title={dirty ? "Save the settings first" : undefined} onClick={() => void act(api.windowsInstall)}>
            {status.state === "error" ? "Install again" : "Install the base disk"}
          </button>
        )}
        {status.state === "installing" && (
          <button type="button" className="small" disabled={working} onClick={() => void act(api.windowsCancel)}>
            Cancel the install
          </button>
        )}
        {(status.state === "ready" || status.state === "error") &&
          (confirmDelete ? (
            <>
              <span className="muted">Delete the base disk{status.sessions > 0 ? " (not while Sessions are built on it)" : ""}?</span>
              <button type="button" className="small danger" disabled={working || status.sessions > 0} onClick={() => void act(api.windowsRemove)}>
                Delete
              </button>
              <button type="button" className="small" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="small" disabled={working} onClick={() => setConfirmDelete(true)}>
              Delete the base disk
            </button>
          ))}
        {dirty && <span className="muted">Save to apply the edition / disk size before installing.</span>}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Blocks rarely used by home routers (192.168.0–1.x), office LANs (10.0–10.10.x), WSL2 (172.16–31.x) or Kubernetes (10.96/10.244). */
const DOCKER_POOL_SUGGESTIONS = [
  { block: DEFAULT_DOCKER_ADDRESS_POOL, why: "Default — top of 192.168.x: clear of home routers (192.168.0–1.x) and Docker Desktop (192.168.65.x)" },
  { block: "10.213.0.0/16", why: "High 10.x: clear of the 10.0–10.10.x office LANs and the 10.96/10.244 Kubernetes ranges" },
  { block: "100.64.0.0/16", why: "Carrier-grade NAT range, unused on most LANs; not if you run Tailscale or WARP (100.64–127.x)" },
];

/** Global settings → Machine: Sandbox limits, Docker, snapshots, the Windows and macOS bases and TLS certificates. */
export function EnvironmentSettings({
  settings,
  cpus,
  setCpus,
  memory,
  setMemory,
  docker,
  setDocker,
  dockerPool,
  setDockerPool,
  autoSnapshot,
  setAutoSnapshot,
  snapshotKeep,
  setSnapshotKeep,
  windowsVersion,
  setWindowsVersion,
  windowsDisk,
  setWindowsDisk,
  windowsRam,
  setWindowsRam,
  windowsCpus,
  setWindowsCpus,
  macosVersion,
  setMacosVersion,
  macosDisk,
  setMacosDisk,
  macosRam,
  setMacosRam,
  macosCpus,
  setMacosCpus,
  trustHostCaCerts,
  setTrustHostCaCerts,
  extraCaCerts,
  setExtraCaCerts,
  windowsBase,
  onWindowsBase,
  macosBase,
  onMacosBase,
}: {
  settings: PublicSettings;
  cpus: string;
  setCpus: Setter<string>;
  memory: string;
  setMemory: Setter<string>;
  docker: boolean;
  setDocker: Setter<boolean>;
  dockerPool: string;
  setDockerPool: Setter<string>;
  autoSnapshot: boolean;
  setAutoSnapshot: Setter<boolean>;
  snapshotKeep: string;
  setSnapshotKeep: Setter<string>;
  windowsVersion: string;
  setWindowsVersion: Setter<string>;
  windowsDisk: string;
  setWindowsDisk: Setter<string>;
  windowsRam: string;
  setWindowsRam: Setter<string>;
  windowsCpus: string;
  setWindowsCpus: Setter<string>;
  macosVersion: string;
  setMacosVersion: Setter<string>;
  macosDisk: string;
  setMacosDisk: Setter<string>;
  macosRam: string;
  setMacosRam: Setter<string>;
  macosCpus: string;
  setMacosCpus: Setter<string>;
  trustHostCaCerts: boolean;
  setTrustHostCaCerts: Setter<boolean>;
  extraCaCerts: string;
  setExtraCaCerts: Setter<string>;
  /** The shared Windows base disk (ADR-0057), kept current by the `windows_base` broadcast. */
  windowsBase: WindowsBaseStatus | null;
  onWindowsBase: (status: WindowsBaseStatus) => void;
  /** The shared macOS base disk (ADR-0059), kept current by the `macos_base` broadcast. */
  macosBase: MacosBaseStatus | null;
  onMacosBase: (status: MacosBaseStatus) => void;
}) {
  return (
    <section className="ss-section">
      <h3>
        <Caption
          help={
            <p>
              Defaults for the box every Session runs in: the Linux Sandbox container, and the Windows or macOS VM a QEMU Session boots next to
              it. A Session can override the limits and snapshots in its own settings. Resources and Docker apply to Sandboxes created
              afterwards; snapshot settings apply immediately.
            </p>
          }
        >
          Environment
        </Caption>
      </h3>

      <h4 className="ss-sub" id="settings-sandbox">
        <Caption help={<p>Limits of each Sandbox container (Docker · Linux, and the Linux side of a VM Session). Applies to Sandboxes created afterwards.</p>}>
          Limits
        </Caption>
      </h4>
      <div className="row">
        <label>
          CPUs
          <input type="number" min={0.5} step={0.5} value={cpus} onChange={(e) => setCpus(e.target.value)} />
        </label>
        <label>
          Memory (GB)
          <input type="number" min={1} step={1} value={memory} onChange={(e) => setMemory(e.target.value)} />
        </label>
      </div>
      <label className="check switch">
        <input type="checkbox" checked={docker} onChange={(e) => setDocker(e.target.checked)} />
        <span className="slider" aria-hidden="true" />
        <Caption help={<DockerModeNote settings={settings} enabled={docker} />}>Docker inside Sandboxes (per-Session override in its settings)</Caption>
      </label>
      <label>
        <Caption
          help={
            <p>
              The dockerd inside a Docker-enabled Sandbox carves its own networks out of this block. Hosts of your company network or VPN that
              fall in the block are unreachable from such a Sandbox (“No route to host”), so pick one nothing you need to reach lives in — the
              default <code>{DEFAULT_DOCKER_ADDRESS_POOL}</code> keeps clear of home routers, Docker Desktop, WSL2, company 10.x networks and
              Kubernetes; the field suggests alternatives. Empty = Docker&apos;s default (172.17.0.0/16 and up). Applies to Sandboxes created
              afterwards.
            </p>
          }
        >
          Addresses for Docker inside Sandboxes
        </Caption>
        <input
          value={dockerPool}
          autoComplete="off"
          spellCheck={false}
          pattern={DOCKER_ADDRESS_POOL_PATTERN.source}
          title="An IPv4 block like 192.168.240.0/20 (/8 to /24)"
          onChange={(e) => setDockerPool(e.target.value)}
          placeholder="Docker's default (172.17.0.0/16 and up)"
          list="docker-pool-suggestions"
        />
        <datalist id="docker-pool-suggestions">
          {DOCKER_POOL_SUGGESTIONS.map((s) => (
            <option key={s.block} value={s.block}>
              {s.why}
            </option>
          ))}
        </datalist>
      </label>

      <h4 className="ss-sub" id="settings-snapshots">
        <Caption
          help={
            <p>
              A snapshot is an image of the whole box (files, installed tools, the Agent&apos;s conversation) you can fork from or go back to: a
              docker commit that pauses the Sandbox for a few seconds and stores only what changed since the previous image, so turns that touch
              few files cost a few MB. Sizes in the sidebar are what Docker reports per layer. Manual snapshots and fork origins are always
              kept. Defaults for new Sessions; each Session can override them in its settings or from its size line in the sidebar.
            </p>
          }
        >
          Snapshots
        </Caption>
      </h4>
      <label className="check switch">
        <input type="checkbox" checked={autoSnapshot} onChange={(e) => setAutoSnapshot(e.target.checked)} />
        <span className="slider" aria-hidden="true" />
        Snapshot automatically after every completed turn
      </label>
      <label>
        Automatic snapshots to keep per Session (0 = all)
        <input type="number" min={0} step={1} value={snapshotKeep} onChange={(e) => setSnapshotKeep(e.target.value)} />
      </label>

      <h4 className="ss-sub" id="settings-windows">
        <Caption
          help={
            <>
              <p>
                A <strong>QEMU · Windows</strong> Session runs a Windows VM (QEMU/KVM) next to its Linux Sandbox: the Desktop shows Windows
                over RDP, the Agent runs inside Windows and drives it with the same screenshot, mouse and keyboard tools, and{" "}
                <code>win &lt;command&gt;</code> runs PowerShell in it over SSH as <code>{WINDOWS_GUEST_USER}</code>. Every VM starts from
                one shared base disk, installed here once from Microsoft&apos;s installation media (unattended, 20–40 minutes; a licence is
                yours to bring). Needs a Linux host with <code>/dev/kvm</code>; Docker Desktop on macOS or Windows cannot run it.
              </p>
              <p>
                Memory and CPUs are on top of the Session&apos;s Sandbox and apply to VMs started afterwards; edition and disk size are those
                of the base, so changing them means deleting and installing the base again. Save first, then install.
              </p>
            </>
          }
        >
          Windows VMs
        </Caption>
      </h4>
      <div className="row">
        <label>
          Edition of the base disk
          <Select<string> value={windowsVersion} onChange={setWindowsVersion} aria-label="Edition of the base disk" options={WINDOWS_VERSIONS.map((v) => ({ value: v.code, label: v.label }))} />
        </label>
        <label>
          Base disk size (GB)
          <input type="number" min={16} step={1} value={windowsDisk} onChange={(e) => setWindowsDisk(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <label>
          VM memory (GB)
          <input type="number" min={1} step={1} value={windowsRam} onChange={(e) => setWindowsRam(e.target.value)} />
        </label>
        <label>
          VM CPUs
          <input type="number" min={1} step={1} value={windowsCpus} onChange={(e) => setWindowsCpus(e.target.value)} />
        </label>
      </div>
      <WindowsBase
        settings={settings}
        status={windowsBase}
        onStatus={onWindowsBase}
        dirty={windowsVersion !== settings.windows.version || Number(windowsDisk) !== settings.windows.diskGb}
      />

      <h4 className="ss-sub" id="settings-macos">
        <Caption
          help={
            <>
              <p>
                A <strong>QEMU · macOS</strong> Session runs a macOS VM (QEMU/KVM booted by OpenCore, the dockur/macos way) next to its Linux
                Sandbox: the Desktop shows macOS over VNC, the Agent runs inside macOS and drives it with the same screenshot, mouse and keyboard
                tools, and <code>mac &lt;command&gt;</code> runs a shell command in it over SSH as <code>{MACOS_GUEST_USER}</code>. Every VM
                starts from one shared base disk, installed here once from Apple&apos;s Recovery image. There is no unattended installer: you
                install macOS and create the <code>{MACOS_GUEST_USER}</code> account by hand in the VM&apos;s screen (about an hour, mostly
                waiting), then Sessionboxer finishes the base by itself.
              </p>
              <p>
                Needs a Linux host with <code>/dev/kvm</code> and a CPU with AVX2; Docker Desktop on macOS or Windows cannot run it. Apple&apos;s
                software licence allows macOS to run in a VM only on Apple hardware: running this on other hardware is on you.
              </p>
              <p>
                Memory and CPUs are on top of the Session&apos;s Sandbox and apply to VMs started afterwards; release and disk size are those
                of the base, so changing them means deleting and installing the base again. Save first, then install.
              </p>
            </>
          }
        >
          macOS VMs
        </Caption>
      </h4>
      <div className="row">
        <label>
          Release of the base disk
          <Select<string> value={macosVersion} onChange={setMacosVersion} aria-label="Release of the base disk" options={MACOS_VERSIONS.map((v) => ({ value: v.code, label: v.label }))} />
        </label>
        <label>
          Base disk size (GB)
          <input type="number" min={32} step={1} value={macosDisk} onChange={(e) => setMacosDisk(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <label>
          VM memory (GB)
          <input type="number" min={2} step={1} value={macosRam} onChange={(e) => setMacosRam(e.target.value)} />
        </label>
        <label>
          VM CPUs
          <input type="number" min={1} step={1} value={macosCpus} onChange={(e) => setMacosCpus(e.target.value)} />
        </label>
      </div>
      <MacosBase
        settings={settings}
        status={macosBase}
        onStatus={onMacosBase}
        dirty={macosVersion !== settings.macos.version || Number(macosDisk) !== settings.macos.diskGb}
      />

      <h4 className="ss-sub" id="settings-tls">
        <Caption
          help={
            <p>
              Sandboxes trust the public CAs only. If this machine goes through a proxy that re-signs HTTPS (Cloudflare WARP, Zscaler, a
              corporate gateway, mitmproxy…), the Agent and MCP servers inside see “self signed certificate in certificate chain” unless its CA
              is trusted there too. Installed at Sandbox start: Stop → Resume running Sessions to apply.
            </p>
          }
        >
          TLS certificates
        </Caption>
      </h4>
      <label className="check switch">
        <input type="checkbox" checked={trustHostCaCerts} onChange={(e) => setTrustHostCaCerts(e.target.checked)} />
        <span className="slider" aria-hidden="true" />
        Trust the CA certificates this machine trusts beyond the public ones{" "}
        {settings.hostCaCerts.length === 0 ? (
          <span className="muted">(none found in the system trust store)</span>
        ) : (
          <span className="muted">
            ({settings.hostCaCerts.length} found: {settings.hostCaCerts.map((s) => s.replace(/^CN=/, "")).join(", ")})
          </span>
        )}
      </label>
      <label>
        Additional CA certificates (PEM; for CAs not installed on this machine)
        <textarea
          className="pem"
          rows={4}
          spellCheck={false}
          value={extraCaCerts}
          onChange={(e) => setExtraCaCerts(e.target.value)}
          placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
        />
      </label>
    </section>
  );
}
