import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import type { Session } from "@sessionboxer/protocol";
import { DESKTOP_HEIGHT, DESKTOP_WIDTH } from "@sessionboxer/protocol";

type ConnState = "connecting" | "connected" | "disconnected";

const RECONNECT_MS = 2000;

export function desktopUrl(sessionId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/sessions/${sessionId}/desktop`;
}

/**
 * Live view of the Sandbox Desktop over the Control Plane's noVNC proxy.
 * View-only while the Agent is running unless the user explicitly takes control.
 */
export function Desktop({ session }: { session: Session }) {
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [state, setState] = useState<ConnState>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [control, setControl] = useState(false);

  const live = session.status === "idle" || session.status === "running";
  const running = session.status === "running";
  const viewOnly = running && !control;

  // A new turn hands the Desktop back to the Agent.
  useEffect(() => {
    if (running) setControl(false);
  }, [running]);

  useEffect(() => {
    const target = screen.current;
    if (!live || !target) return;
    setState("connecting");
    const client = new RFB(target, desktopUrl(session.id), { shared: true });
    client.scaleViewport = true;
    client.background = "#0b0d11";
    client.viewOnly = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // noVNC emits `disconnect` asynchronously, also for the disconnect() below,
    // so events from a client this effect already tore down must be ignored.
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
    rfb.current = client;
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      rfb.current = null;
      if (!gone) client.disconnect();
    };
  }, [session.id, live, attempt]);

  useEffect(() => {
    if (rfb.current) rfb.current.viewOnly = viewOnly;
  }, [viewOnly, state]);

  return (
    <section className="desktop">
      <div className="desktop-toolbar">
        <span className="muted">
          Desktop {DESKTOP_WIDTH}x{DESKTOP_HEIGHT}
        </span>
        <span className={`badge ${state === "connected" ? "badge-idle" : "badge-creating"}`}>
          {!live ? session.status : state}
        </span>
        <span className="spacer" />
        {live && state === "connected" && running && (
          <button onClick={() => setControl((c) => !c)} title="The Agent keeps running; you share its mouse and keyboard">
            {control ? "Release control" : "Take control"}
          </button>
        )}
        {live && state === "connected" && !running && <span className="muted">interactive</span>}
        {live && state === "connected" && viewOnly && <span className="muted">view only</span>}
      </div>
      <div className="desktop-body">
        <div className="desktop-screen" ref={screen} />
        {!live && <div className="desktop-overlay">Sandbox is {session.status}; the Desktop is available while it runs.</div>}
      </div>
    </section>
  );
}
