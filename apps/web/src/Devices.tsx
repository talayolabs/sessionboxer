import { useCallback, useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import { PAIR_FRAGMENT_KEY, pairingOrigin, type AuthDevice, type AuthPairing, type PublicSettings, type RemoteAccess } from "@sessionboxer/protocol";
import { api } from "./api";

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

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

/**
 * Settings section: the browsers logged in, a QR code to log another one in, the quick tunnel that
 * makes that QR work from any phone, and the access token itself.
 */
export function Devices({
  remote,
  quickTunnel,
  onStored,
  run,
}: {
  remote: RemoteAccess;
  quickTunnel: boolean;
  /** The tunnel switch is stored at once, outside the form's Save. */
  onStored: (s: PublicSettings) => void;
  run: Runner;
}) {
  const [devices, setDevices] = useState<AuthDevice[] | null>(null);
  const [pairing, setPairing] = useState<AuthPairing | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const left = useCountdown(pairing?.expiresAt ?? null);
  const tunnel = remote.tunnel;

  const setTunnel = (on: boolean) => {
    setSwitching(true);
    void run(async () => onStored(await api.updateSettings({ quickTunnel: on }))).finally(() => setSwitching(false));
  };

  const reload = useCallback(() => run(async () => setDevices(await api.devices())), [run]);
  useEffect(() => {
    void reload();
  }, [reload]);

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

  const origin = pairingOrigin(remote);
  const link = pairing && left > 0 ? pairLink(origin, pairing) : null;

  return (
    <fieldset className="choice devices">
      <legend>Devices and remote access</legend>
      <p className="muted">
        Reached at <code>{remote.publicUrl}</code>
        {remote.tls ? " (HTTPS served by the Control Plane)" : ""}
        {remote.trustProxy ? ", behind a trusted proxy" : ""}. Every browser logs in once with the access token or a pairing code and keeps a
        cookie until it is revoked here. Set <code>SESSIONBOXER_PUBLIC_URL</code> when this address is not the one you use from outside.
      </p>
      <div className="tunnel">
        <label className="check">
          <input type="checkbox" checked={quickTunnel} disabled={switching} onChange={(e) => setTunnel(e.target.checked)} />
          Share over the internet (Cloudflare quick tunnel)
          {quickTunnel && tunnel.state === "starting" && <span className="muted"> — starting…</span>}
        </label>
        {quickTunnel && tunnel.state === "up" && tunnel.url && (
          <div className="actions-left tunnel-url">
            <span className="ok">Up at</span> <code>{tunnel.url}</code>
            <button type="button" className="small" onClick={() => void copy("tunnel", tunnel.url ?? "")}>
              {copied === "tunnel" ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        {quickTunnel && tunnel.error && tunnel.state !== "up" && (
          <p className="error small-text">
            {tunnel.state === "error" ? "Tunnel down, retrying: " : ""}
            {tunnel.error}
          </p>
        )}
        <p className="muted small-text">
          A public <code>https://….trycloudflare.com</code> address for this Control Plane, made by running <code>cloudflared</code> here
          (downloaded on first use, checksum verified) — nothing to install on the phone, no account, no port forwarding; pairing codes below
          use it while it is up. Traffic passes through Cloudflare and the address changes every time the tunnel starts; the login is still
          required. Stays on across restarts until switched off.
        </p>
      </div>
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
            <button type="button" onClick={() => void run(async () => setPairing(await api.pair()))}>
              {link ? "New pairing code" : "Pair another device"}
            </button>
            {link && (
              <button type="button" onClick={() => void copy("link", link)}>
                {copied === "link" ? "Copied" : "Copy link"}
              </button>
            )}
          </div>
          <p className="muted small-text">
            Scan the code with the phone (or open the link) and it is logged in as its own device — the code works once and for{" "}
            {link ? `${left} more second${left === 1 ? "" : "s"}` : "5 minutes"}; the access token never leaves this browser.
            {quickTunnel && tunnel.state === "up" ? (
              <>
                {" "}
                The link points at the tunnel, so it works from anywhere.
              </>
            ) : (
              <>
                {" "}
                The link points at <code>{origin}</code>; a phone on another network needs the tunnel above (or a VPN / public URL).
              </>
            )}
          </p>
        </div>
        {link && <QrCode text={link} size={168} />}
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
