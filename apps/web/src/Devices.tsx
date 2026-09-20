import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import {
  DEFAULT_TUNNEL_SERVER,
  PAIR_FRAGMENT_KEY,
  TUNNEL_NAME_RE,
  pairingOrigin,
  type AuthDevice,
  type AuthPairing,
  type PairingTransport,
  type PublicSettings,
  type PublicTunnelSettings,
  type RemoteAccess,
  type TunnelKind,
  type TunnelNameCheck,
  type TunnelSettingsUpdate,
  type TunnelStatus,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { disablePush, enablePush, pushState, pushSupport } from "./push";

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

const TRANSPORT_LABEL: Record<PairingTransport, string> = {
  local: "Local network",
  cloudflare: "Cloudflare quick tunnel",
  sessionboxer: "Sessionboxer tunnel",
  ssh: "Own server over SSH",
};

function pairLink(origin: string, pairing: AuthPairing): string {
  return `${origin.replace(/\/$/, "")}/#${PAIR_FRAGMENT_KEY}=${pairing.code}`;
}

function QrCode({ text, size }: { text: string; size: number }) {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const cells: string[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push(`M${c} ${r}h1v1h-1z`);
  return (
    <svg className="qr" viewBox={`-2 -2 ${n + 4} ${n + 4}`} width={size} height={size} shapeRendering="crispEdges" role="img" aria-label="Pairing QR code">
      <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="#fff" />
      <path d={cells.join("")} fill="#000" />
    </svg>
  );
}

function useCountdown(until: string | null): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!until) return;
    const end = new Date(until).getTime();
    const tick = () => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until]);
  return left;
}

function relative(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** One line on a transport's state: starting, the address it is up at, or its last error. */
function TunnelState({ status, enabled, copied, onCopy }: { status: TunnelStatus; enabled: boolean; copied: boolean; onCopy: (url: string) => void }) {
  if (!enabled) return null;
  return (
    <>
      {status.state === "up" && status.url && (
        <div className="actions-left tunnel-url">
          <span className="ok">Up at</span> <code>{status.url}</code>
          <button type="button" className="small" onClick={() => onCopy(status.url ?? "")}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {status.error && status.state !== "up" && (
        <p className="error small-text">
          {status.state === "error" ? "Down, retrying: " : ""}
          {status.error}
        </p>
      )}
    </>
  );
}

/** A transport card: switch in the heading, its fields below, then the state line and a description. */
function Transport({
  title,
  enabled,
  busy,
  status,
  onToggle,
  children,
  description,
}: {
  title: string;
  enabled: boolean;
  busy: boolean;
  status: TunnelStatus;
  onToggle: (on: boolean) => void;
  children?: ReactNode;
  description: ReactNode;
}) {
  return (
    <div className="tunnel">
      <label className="check switch">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => onToggle(e.target.checked)} />
        <span className="slider" aria-hidden="true" />
        <strong>{title}</strong>
        {enabled && status.state === "starting" && <span className="muted"> — starting…</span>}
        {status.version && enabled && <span className="muted small-text">{status.version}</span>}
      </label>
      {children}
      {description}
    </div>
  );
}

/** A small menu under its button: the choices of a click, closed by a choice, a click elsewhere or Escape. */
function Menu({ label, disabled, items }: { label: string; disabled?: boolean; items: { key: string; title: string; detail: ReactNode; onPick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu-anchor" ref={ref}>
      <button type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label} ▾
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                it.onPick();
              }}
            >
              <span className="menu-title">{it.title}</span>
              <span className="muted small-text menu-detail">{it.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Settings section: the browsers logged in, a QR code to log another one in through the transport
 * of your choice, the three transports themselves, and the access token.
 */
export function Devices({
  remote,
  tunnels,
  onStored,
  run,
}: {
  remote: RemoteAccess;
  tunnels: PublicTunnelSettings;
  /** Transport switches and fields are stored at once, outside the form's Save. */
  onStored: (s: PublicSettings) => void;
  run: Runner;
}) {
  const [devices, setDevices] = useState<AuthDevice[] | null>(null);
  const [pairing, setPairing] = useState<AuthPairing | null>(null);
  const [via, setVia] = useState<PairingTransport>("local");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [switching, setSwitching] = useState<TunnelKind | null>(null);
  const [push, setPush] = useState<{ subscribed: boolean; permission: NotificationPermission } | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const left = useCountdown(pairing?.expiresAt ?? null);
  const support = pushSupport();
  const statuses = remote.tunnels;

  // Drafts of the two transports with fields; stored with Save or when the switch is turned on.
  const [sb, setSb] = useState({ name: tunnels.sessionboxer.name, server: tunnels.sessionboxer.server });
  const [ssh, setSsh] = useState({ ...tunnels.ssh });
  const [nameCheck, setNameCheck] = useState<(TunnelNameCheck & { forName: string }) | null>(null);
  const [defaultName, setDefaultName] = useState<string | null>(null);
  useEffect(() => setSb({ name: tunnels.sessionboxer.name, server: tunnels.sessionboxer.server }), [tunnels.sessionboxer.name, tunnels.sessionboxer.server]);
  useEffect(() => setSsh({ ...tunnels.ssh }), [tunnels.ssh]);
  useEffect(() => {
    void api.tunnelServer().then((r) => setDefaultName(r.name), () => setDefaultName(null));
  }, []);
  const sbDirty = sb.name !== tunnels.sessionboxer.name || sb.server !== tunnels.sessionboxer.server;
  const sshDirty = JSON.stringify(ssh) !== JSON.stringify(tunnels.ssh);
  const sbName = sb.name.trim().toLowerCase();
  const sbNameOk = sbName === "" || TUNNEL_NAME_RE.test(sbName);

  useEffect(() => {
    if (sbName === "" || !TUNNEL_NAME_RE.test(sbName)) {
      setNameCheck(null);
      return;
    }
    const t = setTimeout(() => {
      void api.tunnelName(sbName, sb.server).then(
        (r) => setNameCheck({ ...r, forName: sbName }),
        () => setNameCheck(null),
      );
    }, 400);
    return () => clearTimeout(t);
  }, [sbName, sb.server]);

  const store = (update: TunnelSettingsUpdate, kind: TunnelKind) => {
    setSwitching(kind);
    return run(async () => onStored(await api.updateSettings({ tunnels: update }))).finally(() => setSwitching(null));
  };
  const sbUpdate = (enabled?: boolean): TunnelSettingsUpdate => ({ sessionboxer: { name: sbName, server: sb.server.trim(), ...(enabled === undefined ? {} : { enabled }) } });
  const sshUpdate = (enabled?: boolean): TunnelSettingsUpdate => ({ ssh: { ...ssh, ...(enabled === undefined ? {} : { enabled }) } });
  const toggle = (kind: TunnelKind, on: boolean) => {
    if (kind === "cloudflare") return store({ cloudflare: { enabled: on } }, kind);
    if (kind === "sessionboxer") return store(sbUpdate(on), kind);
    return store(sshUpdate(on), kind);
  };

  const reload = useCallback(() => run(async () => setDevices(await api.devices())), [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    void pushState().then(setPush, () => setPush({ subscribed: false, permission: "default" }));
  }, []);

  const setNotifications = (on: boolean) => {
    setPushBusy(true);
    setPushNote(null);
    void run(async () => {
      const status = on ? await enablePush() : await disablePush();
      setPush({ subscribed: status.subscribed, permission: typeof Notification === "undefined" ? "denied" : Notification.permission });
      await reload();
    }).finally(() => setPushBusy(false));
  };

  const testPush = () => {
    setPushBusy(true);
    void run(async () => {
      await api.pushTest();
      setPushNote("Sent — it shows up when this page is in the background or the phone is locked.");
    }).finally(() => setPushBusy(false));
  };

  const copy = (what: string, text: string) =>
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(what);
        setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
      },
      () => undefined,
    );

  const revoke = (d: AuthDevice) => {
    if (d.current && !confirm("Log this browser out? You will need the access token or a pairing code to get back in.")) return;
    void run(async () => {
      if (d.current) {
        await api.logout();
        location.reload();
      } else {
        await api.revokeDevice(d.id);
        await reload();
      }
    });
  };

  const rotate = () => {
    if (!confirm("Make a new access token? Every other logged-in browser and every CLI using the old token is logged out; this browser stays in.")) return;
    void run(async () => {
      const res = await api.rotateAccessToken();
      setToken(res.token);
      await reload();
    });
  };

  /** Picks the transport for the next pairing code: turns it on when it is off, then makes the code. */
  const pairVia = (transport: PairingTransport) => {
    setVia(transport);
    void run(async () => {
      if (transport !== "local" && !tunnels[transport].enabled) {
        if (transport === "ssh" && ssh.host.trim() === "") throw new Error("Fill in the SSH server below first.");
        await toggle(transport, true);
      }
      setPairing(await api.pair());
    });
  };

  const origin = pairingOrigin(remote, via);
  const link = pairing && left > 0 && origin ? pairLink(origin, pairing) : null;
  const viaStatus = via === "local" ? null : statuses[via];
  const menuDetail = (t: PairingTransport): ReactNode => {
    if (t === "local") return <code>{remote.publicUrl}</code>;
    const s = statuses[t];
    if (s.state === "up" && s.url) return <code>{s.url}</code>;
    if (!tunnels[t].enabled) return t === "ssh" && ssh.host.trim() === "" ? "off — fill in the server below first" : "off — starts when chosen";
    if (s.state === "starting") return "starting…";
    return s.error ? `down: ${s.error}` : "off";
  };

  const sshDirectHttp = ssh.publicUrl.trim() === "" && ssh.host.trim() !== "" && ssh.remoteBind === "all";

  return (
    <fieldset className="choice devices">
      <legend>Devices and remote access</legend>
      <p className="muted">
        Reached at <code>{remote.publicUrl}</code>
        {remote.tls ? " (HTTPS served by the Control Plane)" : ""}
        {remote.trustProxy ? ", behind a trusted proxy" : ""}. Every browser logs in once with the access token or a pairing code and keeps a
        cookie until it is revoked here. Set <code>SESSIONBOXER_PUBLIC_URL</code> when this address is not the one you use from outside.
      </p>
      <table className="prs-table devices-table">
        <thead>
          <tr>
            <th>Device</th>
            <th>Last seen</th>
            <th>From</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {devices === null ? (
            <tr>
              <td colSpan={4} className="muted">
                Loading…
              </td>
            </tr>
          ) : devices.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                No browser is logged in.
              </td>
            </tr>
          ) : (
            devices.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.name} {d.current && <span className="ok small-text">(this browser)</span>}
                  <div className="muted small-text" title={d.userAgent}>
                    logged in {relative(d.createdAt)}
                    {d.push ? " · notifications on" : ""}
                  </div>
                </td>
                <td className="nowrap" title={d.lastSeenAt}>
                  {relative(d.lastSeenAt)}
                </td>
                <td className="nowrap">{d.lastIp}</td>
                <td className="nowrap">
                  <button type="button" className={`small${d.current ? "" : " danger"}`} onClick={() => revoke(d)}>
                    {d.current ? "Log out" : "Revoke"}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="row devices-pair">
        <div className="devices-pair-text">
          <div className="actions-left">
            <Menu
              label={link ? "New pairing code" : "Pair another device"}
              items={(["local", "cloudflare", "sessionboxer", "ssh"] as const).map((t) => ({
                key: t,
                title: TRANSPORT_LABEL[t],
                detail: menuDetail(t),
                onPick: () => pairVia(t),
              }))}
            />
            {link && (
              <button type="button" onClick={() => void copy("link", link)}>
                {copied === "link" ? "Copied" : "Copy link"}
              </button>
            )}
          </div>
          <p className="muted small-text">
            Pick how the phone reaches this machine, then scan the code (or open the link) and it is logged in as its own device — the code works
            once and for {pairing && left > 0 ? `${left} more second${left === 1 ? "" : "s"}` : "5 minutes"}; the access token never leaves this
            browser.
            {pairing && left > 0 && (
              <>
                {" "}
                Via <strong>{TRANSPORT_LABEL[via]}</strong>
                {origin ? (
                  <>
                    : <code>{origin}</code>
                    {via === "local" ? "; a phone on another network needs one of the tunnels." : "."}
                  </>
                ) : viaStatus?.error ? (
                  <>
                    {" "}
                    — <span className="error">{viaStatus.error}</span>
                  </>
                ) : (
                  " — starting, the code appears when it is up…"
                )}
              </>
            )}
          </p>
        </div>
        {link && <QrCode text={link} size={168} />}
      </div>

      <Transport
        title="Cloudflare quick tunnel"
        enabled={tunnels.cloudflare.enabled}
        busy={switching === "cloudflare"}
        status={statuses.cloudflare}
        onToggle={(on) => void toggle("cloudflare", on)}
        description={
          <p className="muted small-text">
            A public <code>https://….trycloudflare.com</code> address made by running <code>cloudflared</code> here (downloaded on first use,
            checksum verified) — nothing to install on the phone, no account, no port forwarding. Traffic passes through Cloudflare and the
            address changes every time the tunnel starts; the login is still required.
          </p>
        }
      >
        <TunnelState status={statuses.cloudflare} enabled={tunnels.cloudflare.enabled} copied={copied === "cloudflare"} onCopy={(u) => void copy("cloudflare", u)} />
      </Transport>

      <Transport
        title="Sessionboxer tunnel"
        enabled={tunnels.sessionboxer.enabled}
        busy={switching === "sessionboxer" || !sbNameOk}
        status={statuses.sessionboxer}
        onToggle={(on) => void toggle("sessionboxer", on)}
        description={
          <p className="muted small-text">
            A stable <code>https://&lt;name&gt;.{tunnels.sessionboxer.server.replace(/^https?:\/\//, "")}</code> address: <code>frpc</code> here
            (downloaded on first use, checksum verified) keeps an outbound connection to the tunnel server, which takes the name for this machine
            at first login and keeps it bound to a secret generated here{tunnels.sessionboxer.secretSet ? "" : " (missing — restart the Control Plane)"}.
            TLS ends at that server, so it sees the traffic it forwards; nothing to install on the phone; the login is still required.
          </p>
        }
      >
        <div className="row">
          <label>
            Name
            <input
              value={sb.name}
              placeholder={defaultName ?? "this machine's hostname"}
              spellCheck={false}
              onChange={(e) => setSb({ ...sb, name: e.target.value })}
            />
            <span className={`small-text ${sbNameOk ? "muted" : "error"}`}>
              {!sbNameOk
                ? "3–40 lowercase letters, digits and dashes, not starting or ending with a dash"
                : nameCheck && nameCheck.forName === sbName
                  ? nameCheck.reserved
                    ? "reserved on the server"
                    : nameCheck.available
                      ? "free on the server"
                      : "registered on the server — connects only if it is this machine's from before"
                  : sbName === ""
                    ? "empty means the hostname"
                    : " "}
            </span>
          </label>
          <label>
            Server
            <input value={sb.server} placeholder={DEFAULT_TUNNEL_SERVER} spellCheck={false} onChange={(e) => setSb({ ...sb, server: e.target.value })} />
            <span className="muted small-text">A Sessionboxer tunnel server (frps + registry); the default is talayolabs'.</span>
          </label>
        </div>
        {sbDirty && (
          <div className="actions-left">
            <button type="button" className="small" disabled={switching === "sessionboxer" || !sbNameOk} onClick={() => void store(sbUpdate(), "sessionboxer")}>
              Save
            </button>
            <button type="button" className="small" onClick={() => setSb({ name: tunnels.sessionboxer.name, server: tunnels.sessionboxer.server })}>
              Discard
            </button>
            {tunnels.sessionboxer.enabled && <span className="muted small-text">Saving restarts the tunnel with the new name or server.</span>}
          </div>
        )}
        <TunnelState status={statuses.sessionboxer} enabled={tunnels.sessionboxer.enabled} copied={copied === "sessionboxer"} onCopy={(u) => void copy("sessionboxer", u)} />
      </Transport>

      <Transport
        title="Own server over SSH"
        enabled={tunnels.ssh.enabled}
        busy={switching === "ssh"}
        status={statuses.ssh}
        onToggle={(on) => void toggle("ssh", on)}
        description={
          <p className="muted small-text">
            <code>ssh -R</code> from here to a server of yours (the system <code>ssh</code>, key authentication, host key pinned on first use):
            sshd there listens on the remote port and hands every connection back to this machine. Binding all interfaces needs{" "}
            <code>GatewayPorts yes</code> in its <code>sshd_config</code>; with a reverse proxy on the server (Caddy, nginx) bind localhost and
            give its HTTPS address as the public URL. Without HTTPS the phone gets a plain <code>http://</code> address: it works, but the browser
            withholds clipboard, notifications and VS Code webviews.
          </p>
        }
      >
        <div className="row">
          <label>
            Server host
            <input value={ssh.host} placeholder="vps.example.com" spellCheck={false} onChange={(e) => setSsh({ ...ssh, host: e.target.value })} />
          </label>
          <label>
            SSH port
            <input type="number" min={1} max={65535} value={ssh.port} onChange={(e) => setSsh({ ...ssh, port: Number(e.target.value) || 22 })} />
          </label>
          <label>
            User
            <input value={ssh.user} placeholder="(current user)" spellCheck={false} onChange={(e) => setSsh({ ...ssh, user: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <label>
            Key file
            <input value={ssh.identityFile} placeholder="(default keys and agent)" spellCheck={false} onChange={(e) => setSsh({ ...ssh, identityFile: e.target.value })} />
          </label>
          <label>
            Remote port
            <input type="number" min={1} max={65535} value={ssh.remotePort} onChange={(e) => setSsh({ ...ssh, remotePort: Number(e.target.value) || 4000 })} />
          </label>
          <label>
            Bind on the server
            <select value={ssh.remoteBind} onChange={(e) => setSsh({ ...ssh, remoteBind: e.target.value as "all" | "localhost" })}>
              <option value="all">all interfaces (GatewayPorts yes)</option>
              <option value="localhost">localhost (behind a reverse proxy there)</option>
            </select>
          </label>
        </div>
        <label>
          Public URL the phone opens
          <input
            value={ssh.publicUrl}
            placeholder={sshDirectHttp ? `http://${ssh.host.trim()}:${ssh.remotePort}` : "https://box.example.com"}
            spellCheck={false}
            onChange={(e) => setSsh({ ...ssh, publicUrl: e.target.value })}
          />
          <span className="muted small-text">
            {ssh.remoteBind === "localhost" ? "Required with a localhost bind: the address your reverse proxy serves." : "Empty means http://<host>:<remote port>."}
          </span>
        </label>
        {sshDirty && (
          <div className="actions-left">
            <button type="button" className="small" disabled={switching === "ssh"} onClick={() => void store(sshUpdate(), "ssh")}>
              Save
            </button>
            <button type="button" className="small" onClick={() => setSsh({ ...tunnels.ssh })}>
              Discard
            </button>
            {tunnels.ssh.enabled && <span className="muted small-text">Saving reconnects with the new settings.</span>}
          </div>
        )}
        <TunnelState status={statuses.ssh} enabled={tunnels.ssh.enabled} copied={copied === "ssh"} onCopy={(u) => void copy("ssh", u)} />
      </Transport>

      <div className="tunnel">
        <label className="check">
          <input
            type="checkbox"
            checked={push?.subscribed ?? false}
            disabled={push === null || pushBusy || support !== "ok" || (push.permission === "denied" && !push.subscribed)}
            onChange={(e) => setNotifications(e.target.checked)}
          />
          Notify this device when a turn ends or a pull request gets feedback
          {pushBusy && <span className="muted"> — working…</span>}
        </label>
        {push?.subscribed && (
          <div className="actions-left">
            <button type="button" className="small" disabled={pushBusy} onClick={testPush}>
              Send a test notification
            </button>
            {pushNote && <span className="muted small-text">{pushNote}</span>}
          </div>
        )}
        <p className="muted small-text">
          {support === "insecure"
            ? "Needs HTTPS: open Sessionboxer through a tunnel (or a TLS address) to turn this on."
            : support === "unsupported"
              ? "This browser has no Web Push. On iPhone, add Sessionboxer to the Home Screen (Share → Add to Home Screen) and open it from there."
              : push?.permission === "denied" && !push.subscribed
                ? "Notifications are blocked for this site in the browser's settings."
                : "Web Push through the browser's push service: the phone hears about it while the app is closed or the screen is off. A device that is watching the page gets nothing extra. Per browser; revoking a device drops its subscription."}
        </p>
      </div>
      <div className="actions-left">
        {token === null ? (
          <button type="button" onClick={() => void run(async () => setToken((await api.accessToken()).token))}>
            Show access token
          </button>
        ) : (
          <>
            <code className="token">{token}</code>
            <button type="button" onClick={() => void copy("token", token)}>
              {copied === "token" ? "Copied" : "Copy"}
            </button>
            <button type="button" onClick={() => setToken(null)}>
              Hide
            </button>
          </>
        )}
        <button type="button" className="danger" onClick={rotate} disabled={remote.accessTokenSource === "env"}>
          Rotate token
        </button>
      </div>
      <p className="muted small-text">
        The token logs a browser in on the login screen and authenticates the CLI (<code>SESSIONBOXER_TOKEN</code>, or the config file on the
        machine that runs the Control Plane).{" "}
        {remote.accessTokenSource === "env"
          ? "It comes from SESSIONBOXER_ACCESS_TOKEN in the Control Plane's environment; change it there."
          : "Rotating it logs every other device out."}
      </p>
    </fieldset>
  );
}
