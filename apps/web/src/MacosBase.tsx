import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { MACOS_VERSIONS, type MacosBaseStatus, type PublicSettings } from "@sessionboxer/protocol";
import { api } from "./api";
import { formatMb } from "./format";
import { currentTheme } from "./theme";

/** The VM's screen while the base is installed by hand (ADR-0059): `GET /api/macos/screen`, a noVNC websocket. */
export function screenUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/macos/screen`;
}

const RECONNECT_MS = 3000;

/** The install VM's screen, driven by the user: Recovery, the installer, Setup Assistant. */
function MacosScreen() {
  const screen = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const target = screen.current;
    if (!target) return;
    setState("connecting");
    const client = new RFB(target, screenUrl(), { shared: true });
    client.scaleViewport = true;
    client.background = currentTheme().colors.sunken;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let gone = false;
    client.addEventListener("connect", () => {
      if (!disposed) setState("connected");
    });
    client.addEventListener("disconnect", () => {
      gone = true;
      if (disposed) return;
      setState("disconnected");
      timer = setTimeout(() => setAttempt((a) => a + 1), RECONNECT_MS);
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (!gone) client.disconnect();
    };
  }, [attempt]);
  return (
    <div className="macos-screen">
      <div ref={screen} className="macos-screen-view" tabIndex={0} />
      {state !== "connected" && <p className="muted">{state === "connecting" ? "Connecting to the VM's screen…" : "The VM's screen is not there; trying again…"}</p>}
    </div>
  );
}

/** The shared macOS base disk (ADR-0059): its state, the interactive install, the Install / Cancel / Delete buttons. */
export function MacosBase({
  settings,
  status,
  onStatus,
  dirty,
}: {
  settings: PublicSettings;
  status: MacosBaseStatus | null;
  onStatus: (status: MacosBaseStatus) => void;
  /** Release or disk size changed in the form but not saved yet: installing now would use the saved ones. */
  dirty: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const availability = settings.environments["qemu-macos"];
  const act = async (call: () => Promise<MacosBaseStatus>) => {
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
  const release = MACOS_VERSIONS.find((v) => v.code === status.version)?.label ?? status.version;
  const started = status.startedAt ? new Date(status.startedAt) : null;
  const since = started ? `, started ${started.toLocaleTimeString()}` : "";
  const busy = status.state === "installing" || status.state === "setup" || status.state === "finishing";
  const line =
    status.state === "ready"
      ? `Base disk ready: ${release} (${formatMb(status.sizeBytes)} MB on disk)${status.sessions > 0 ? `, ${status.sessions} Session${status.sessions === 1 ? "" : "s"} built on it` : ""}.`
      : status.state === "installing"
        ? `Starting ${release}${since}… the VM downloads Apple's Recovery image and boots it; a few minutes.`
        : status.state === "setup"
          ? `${release} is yours to install${since}: follow the steps below in the VM's screen.`
          : status.state === "finishing"
            ? `Finishing the base${since}… the VM answered on SSH; it is being set up for Sessions and shut down.`
            : status.state === "error"
              ? `Installing ${release ?? "the base"} failed: ${status.error ?? "unknown error"}`
              : "No base disk yet: no macOS Session can be created until it is installed.";
  return (
    <div className="windows-base macos-base">
      <p className={status.state === "error" ? "error" : "muted"}>{line}</p>
      {!availability.available && availability.reason && !busy && <p className="muted">QEMU · macOS cannot be picked yet: {availability.reason}</p>}
      {status.state === "setup" && status.setup && (
        <div className="macos-setup">
          <ol>
            {status.setup.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <p className="muted macos-credentials">
            Account to create: user <code>{status.setup.user}</code>, password{" "}
            <code>{showPassword ? status.setup.password : "•".repeat(status.setup.password.length)}</code>{" "}
            <button type="button" className="small" onClick={() => setShowPassword((v) => !v)}>
              {showPassword ? "Hide" : "Show"}
            </button>{" "}
            <button type="button" className="small" onClick={() => void navigator.clipboard.writeText(status.setup?.password ?? "")}>
              Copy
            </button>
            . Type them exactly: the Sandbox logs in with them.
          </p>
        </div>
      )}
      {(status.state === "installing" || status.state === "setup") && <MacosScreen />}
      {(busy || status.state === "error") && status.log.length > 0 && <pre className="windows-base-log">{status.log.join("\n")}</pre>}
      <div className="row">
        {(status.state === "missing" || status.state === "error") && (
          <button type="button" className="small" disabled={working || dirty} title={dirty ? "Save the settings first" : undefined} onClick={() => void act(api.macosInstall)}>
            {status.state === "error" ? "Install again" : "Install the base disk"}
          </button>
        )}
        {busy && (
          <button type="button" className="small" disabled={working} onClick={() => void act(api.macosCancel)}>
            Cancel the install
          </button>
        )}
        {(status.state === "ready" || status.state === "error") &&
          (confirmDelete ? (
            <>
              <span className="muted">Delete the base disk{status.sessions > 0 ? " (not while Sessions are built on it)" : ""}?</span>
              <button type="button" className="small danger" disabled={working || status.sessions > 0} onClick={() => void act(api.macosRemove)}>
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
        {dirty && <span className="muted">Save to apply the release / disk size before installing.</span>}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
