import { useCallback, useEffect, useRef, useState } from "react";
import { currentTheme, useTheme } from "./theme";
import RFB, { type ClipboardEventDetail } from "@novnc/novnc";
import type { Session } from "@sessionboxer/protocol";
import { DESKTOP_HEIGHT, DESKTOP_WIDTH } from "@sessionboxer/protocol";
import { DesktopKeyboard } from "./DesktopKeyboard";

type ConnState = "connecting" | "connected" | "disconnected";

const RECONNECT_MS = 2000;
const XK_Control_L = 0xffe3;
const XK_v = 0x0076;

async function readBrowserClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

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
  const theme = useTheme();

  useEffect(() => {
    const client = rfb.current;
    if (client) client.background = theme.colors.sunken;
  }, [theme]);
  const [attempt, setAttempt] = useState(0);
  const [control, setControl] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [clipText, setClipText] = useState("");
  const [clipNote, setClipNote] = useState<string | null>(null);
  const [kbOpen, setKbOpen] = useState(false);
  const getRfb = useCallback(() => rfb.current, []);

  const live = session.status === "idle" || session.status === "running";
  const running = session.status === "running";
  const viewOnly = running && !control;
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;

  const note = useCallback((text: string) => {
    setClipNote(text);
    setTimeout(() => setClipNote((n) => (n === text ? null : n)), 2500);
  }, []);

  const sendToBox = useCallback(
    (text: string) => {
      const client = rfb.current;
      if (!client || viewOnlyRef.current) return false;
      client.clipboardPasteFrom(text);
      setClipText(text);
      return true;
    },
    []
  );

  // Ctrl+V (Cmd+V on macOS) inside the Desktop: push the browser clipboard to the
  // box first, then deliver the paste keystroke, so the box pastes what the user
  // copied outside. Runs in the capture phase, ahead of noVNC's own key handler.
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    const client = rfb.current;
    if (!client || viewOnlyRef.current || e.code !== "KeyV" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    void readBrowserClipboard().then((text) => {
      if (rfb.current !== client) return;
      if (text !== null && text.length > 0) sendToBox(text);
      else if (text === null) note("Clipboard read blocked by the browser; use the Clipboard panel");
      // Ctrl is sent explicitly: the clipboard read may have blurred the canvas
      // (permission prompt), which makes noVNC release the user's held Ctrl.
      client.sendKey(XK_Control_L, "ControlLeft", true);
      client.sendKey(XK_v, "KeyV", true);
      client.sendKey(XK_v, "KeyV", false);
      client.sendKey(XK_Control_L, "ControlLeft", false);
    });
  };

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
    client.background = currentTheme().colors.sunken;
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
    // Text copied inside the box lands in the browser clipboard, but only while
    // the user is driving the Desktop (not what the Agent copies in the background).
    client.addEventListener("clipboard", (ev) => {
      if (disposed) return;
      const { text } = (ev as CustomEvent<ClipboardEventDetail>).detail;
      setClipText(text);
      if (viewOnlyRef.current || !document.hasFocus() || !target.contains(document.activeElement)) return;
      navigator.clipboard.writeText(text).then(
        () => note("Copied from the box"),
        () => note("Copied in the box; open the Clipboard panel to get the text")
      );
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
  // While the on-screen keyboard is up, a tap on the screen must not move the focus away from its input.
  useEffect(() => {
    if (rfb.current) rfb.current.focusOnClick = !kbOpen;
  }, [kbOpen, state]);

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
        {live && state === "connected" && (
          <span
            className={`badge ${viewOnly ? "badge-creating" : "badge-idle"}`}
            title={
              viewOnly
                ? "Clicks and keys here are dropped while the Agent works. Take control to share its mouse and keyboard."
                : "Clicks and keys here go to the box."
            }
          >
            {viewOnly ? "view only" : "interactive"}
          </span>
        )}
        {clipNote && <span className="muted clip-note">{clipNote}</span>}
        {live && state === "connected" && (
          <button
            className={kbOpen ? "active" : ""}
            aria-pressed={kbOpen}
            onClick={() => setKbOpen((o) => !o)}
            title="Type into the box from a phone: brings up the keyboard and the keys it lacks (Ctrl, Alt, Esc, Tab, arrows)"
          >
            Keyboard
          </button>
        )}
        {live && state === "connected" && (
          <button className={clipOpen ? "active" : ""} onClick={() => setClipOpen((o) => !o)} title="Text clipboard shared with the box">
            Clipboard
          </button>
        )}
      </div>
      <div className="desktop-body">
        <div
          className="desktop-screen"
          ref={screen}
          onKeyDownCapture={onKeyDownCapture}
          onPointerDownCapture={() => viewOnly && note("View only: press Take control to use the box's mouse and keyboard")}
        />
        {!live && <div className="desktop-overlay">Sandbox is {session.status}; the Desktop is available while it runs.</div>}
        {clipOpen && live && (
          <div className="clip-panel">
            <div className="clip-panel-header">
              <span>Box clipboard</span>
              <span className="spacer" />
              <button className="small" onClick={() => setClipOpen(false)} aria-label="Close clipboard panel">
                {"\u00d7"}
              </button>
            </div>
            <textarea
              value={clipText}
              onChange={(e) => setClipText(e.target.value)}
              rows={5}
              spellCheck={false}
              placeholder="Text copied in the box shows up here; type or paste here to send text to the box."
            />
            <div className="clip-panel-actions">
              <button
                className="small"
                onClick={() => navigator.clipboard.writeText(clipText).then(() => note("Copied"), () => note("Browser refused the clipboard write"))}
                disabled={!clipText}
              >
                Copy to my clipboard
              </button>
              <button
                className="small"
                onClick={() => void readBrowserClipboard().then((t) => (t === null ? note("Clipboard read blocked by the browser; paste into the box above") : setClipText(t)))}
              >
                Read my clipboard
              </button>
              <span className="spacer" />
              <button className="small primary" disabled={viewOnly || !clipText} onClick={() => sendToBox(clipText) && note("Sent to the box; paste there with Ctrl+V")}>
                Send to box
              </button>
            </div>
            <div className="muted clip-hint">
              Ctrl+C / Ctrl+V work directly in the Desktop while you have control. Text only (Latin-1; other characters become ?).
            </div>
          </div>
        )}
      </div>
      {kbOpen && live && state === "connected" && <DesktopKeyboard rfb={getRfb} disabled={viewOnly} onClose={() => setKbOpen(false)} />}
    </section>
  );
}
