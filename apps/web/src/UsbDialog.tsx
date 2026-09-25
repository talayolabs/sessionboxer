import { useCallback, useEffect, useState } from "react";
import type { Session, UsbDevice, UsbHost } from "@sessionboxer/protocol";
import { api } from "./api";
import { Icon } from "./Icons";

const REFRESH_MS = 3000;

/** Pick a USB device of the host for the Session: one Session per device, so connecting takes it from the one that had it (ADR-0055). */
export function UsbDialog({ session, sessions, onClose }: { session: Session; sessions: Session[]; onClose: () => void }) {
  const [host, setHost] = useState<UsbHost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHost(await api.usbHost());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && busy === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const isLive = session.status === "idle" || session.status === "running";
  const ownerTitle = (d: UsbDevice): string | null => (d.sessionId ? (sessions.find((s) => s.id === d.sessionId)?.title ?? "another Session") : null);
  const current = session.usb;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && busy === null && onClose()}>
      <div className="modal panel usb-dialog" role="dialog" aria-modal="true" aria-labelledby="usb-title">
        <h2 id="usb-title">USB devices for "{session.title}"</h2>
        <p className="muted">
          A device of this machine (or, under WSL2, one attached to WSL) appears in the Sandbox as its <code>/dev/bus/usb/BBB/DDD</code> node,
          readable by the Agent and by nothing else on the box; each device belongs to one Session at a time. Nothing that talks to the device
          is preinstalled in the Sandbox (the Agent can <code>apt-get install</code> what it needs, e.g. <code>adb</code>).
        </p>
        {error && (
          <div className="banner banner-error dialog-banner" role="alert" onClick={() => setError(null)} title="Dismiss">
            {error}
          </div>
        )}
        {host?.note && <div className="banner dialog-banner">{host.note}</div>}
        {current && (
          <div className="usb-current">
            <Icon name="usb" />
            <span>
              Connected: <strong>{current.name}</strong> ({current.vendorId}:{current.productId}
              {current.serial ? `, ${current.serial}` : ""}) as <code>{current.node ?? "unplugged"}</code>
            </span>
            <button type="button" className="small" disabled={busy !== null} onClick={() => void act("disconnect", () => api.usbDisconnect(session.id))}>
              {busy === "disconnect" ? "Disconnecting\u2026" : "Disconnect"}
            </button>
          </div>
        )}
        {!isLive && <p className="muted">Connecting needs a running Sandbox (Resume first).</p>}
        <ul className="usb-list" aria-busy={busy !== null || host === null}>
          {host === null && !error && <li className="empty">Looking at the host's USB devices{"\u2026"}</li>}
          {host?.devices.length === 0 && <li className="empty">No USB devices (hubs are not listed).</li>}
          {host?.devices.map((d) => {
            const mine = d.sessionId === session.id;
            const owner = mine ? null : ownerTitle(d);
            const state = mine
              ? "connected here"
              : owner
                ? `connected to "${owner}"`
                : d.wsl && !d.node
                  ? d.wsl.bound
                    ? "on Windows (shared, not attached)"
                    : "on Windows (not shared: needs an administrator step)"
                  : "free";
            return (
              <li key={d.id} className={mine ? "usb-mine" : ""}>
                <span className="usb-name-cell">
                  <strong>{d.name}</strong>
                  <span className="muted">
                    {d.vendorId}:{d.productId}
                    {d.serial ? ` \u00b7 ${d.serial}` : ""}
                    {d.wsl ? ` \u00b7 bus ${d.wsl.busId}` : ""}
                    {d.node ? ` \u00b7 ${d.node}` : ""}
                  </span>
                </span>
                <span className="muted usb-state">{state}</span>
                {mine ? (
                  <button type="button" className="small" disabled={busy !== null} onClick={() => void act(d.id, () => api.usbDisconnect(session.id))}>
                    {busy === d.id ? "\u2026" : "Disconnect"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="small"
                    disabled={busy !== null || !isLive}
                    title={owner ? `Takes the device away from "${owner}"` : d.wsl && !d.node ? "Attaches it to WSL2 first (usbipd attach --wsl)" : undefined}
                    onClick={() => void act(d.id, () => api.usbConnect(session.id, d.id))}
                  >
                    {busy === d.id ? "Connecting\u2026" : owner ? "Take over" : "Connect"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy !== null}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
