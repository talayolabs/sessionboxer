import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { PtyInfo, Session, TerminalClientMessage, TerminalServerMessage } from "@sessionboxer/protocol";
import { api, terminalSocketUrl } from "./api";
import "@xterm/xterm/css/xterm.css";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function isLive(session: Session): boolean {
  return session.status === "idle" || session.status === "running";
}

/** Shells inside the Sandbox's Workspace, one xterm.js tab per Daemon PTY. */
export function TerminalPane({ session }: { session: Session }) {
  const live = isLive(session);
  const [terminals, setTerminals] = useState<PtyInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useCallback(async () => {
    setBusy(true);
    try {
      const pty = await api.openTerminal(session.id, DEFAULT_COLS, DEFAULT_ROWS);
      setTerminals((prev) => [...prev, pty]);
      setActive(pty.id);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [session.id]);

  // Whenever the Sandbox is (back) up, pick up the Daemon's terminals; open one if there are none.
  useEffect(() => {
    setTerminals([]);
    setActive(null);
    setError(null);
    if (!live) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.terminals(session.id);
        if (cancelled) return;
        const alive = res.terminals.filter((t) => t.exitCode === null);
        if (alive.length === 0) {
          await open();
          return;
        }
        setTerminals(alive);
        setActive(alive[0]?.id ?? null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.id, live, open]);

  const close = async (ptyId: string) => {
    const next = terminals.filter((t) => t.id !== ptyId);
    setTerminals(next);
    if (active === ptyId) setActive(next[next.length - 1]?.id ?? null);
    try {
      await api.closeTerminal(session.id, ptyId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const activeTerminal = terminals.find((t) => t.id === active) ?? null;

  return (
    <div className="terminal">
      <div className="terminal-toolbar">
        {terminals.map((t, i) => (
          <button
            key={t.id}
            className={`tab${t.id === active ? " active" : ""}`}
            onClick={() => setActive(t.id)}
            title={t.id}
          >
            Terminal {i + 1}
          </button>
        ))}
        <button className="small" onClick={() => void open()} disabled={!live || busy} title="New terminal">
          +
        </button>
        <span className="spacer" />
        {activeTerminal && (
          <button className="small" onClick={() => void close(activeTerminal.id)} title="Close terminal">
            Close
          </button>
        )}
      </div>
      {error && (
        <div className="banner banner-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <div className="terminal-body">
        {!live && <div className="desktop-overlay">Sandbox is {session.status}; terminals are available while it runs.</div>}
        {live && !activeTerminal && !error && <div className="desktop-overlay muted">{busy ? "Opening terminal…" : "No terminal open."}</div>}
        {live && activeTerminal && (
          <TerminalView key={activeTerminal.id} sessionId={session.id} pty={activeTerminal} onClose={() => void close(activeTerminal.id)} />
        )}
      </div>
    </div>
  );
}

type ViewState = { kind: "connecting" } | { kind: "attached" } | { kind: "exited"; exitCode: number } | { kind: "closed"; reason: string };

function TerminalView({ sessionId, pty, onClose }: { sessionId: string; pty: PtyInfo; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ViewState>({ kind: "connecting" });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      scrollback: 5000,
      theme: { background: "#0b0d11" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    fit.fit();

    const ws = new WebSocket(terminalSocketUrl(sessionId, pty.id));
    ws.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    let attached = false;
    let exited = false;

    const send = (msg: TerminalClientMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const sendSize = (): void => {
      if (attached) send({ type: "resize", cols: term.cols, rows: term.rows });
    };

    ws.onmessage = (evt: MessageEvent<ArrayBuffer | string>) => {
      if (evt.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(evt.data));
        return;
      }
      const msg = JSON.parse(evt.data) as TerminalServerMessage;
      if (msg.type === "attached") {
        attached = true;
        setState({ kind: "attached" });
        sendSize();
        term.focus();
      } else if (msg.type === "exit") {
        exited = true;
        setState({ kind: "exited", exitCode: msg.exitCode });
      } else if (msg.type === "error") {
        setState({ kind: "closed", reason: msg.message });
      }
    };
    ws.onclose = (evt) => {
      if (!exited) setState((prev) => (prev.kind === "closed" ? prev : { kind: "closed", reason: evt.reason || "connection closed" }));
    };

    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN && !exited) ws.send(encoder.encode(data));
    });
    const binarySub = term.onBinary((data) => {
      if (ws.readyState === WebSocket.OPEN && !exited) ws.send(Uint8Array.from(data, (c) => c.charCodeAt(0)));
    });
    const resizeSub = term.onResize(() => sendSize());
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      binarySub.dispose();
      resizeSub.dispose();
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
      term.dispose();
    };
  }, [sessionId, pty.id]);

  return (
    <>
      <div className="terminal-screen" ref={hostRef} />
      {state.kind === "connecting" && <div className="terminal-status muted">Connecting…</div>}
      {state.kind === "exited" && (
        <div className="terminal-status">
          Shell exited with code {state.exitCode}.
          <button className="small" onClick={onClose}>
            Close
          </button>
        </div>
      )}
      {state.kind === "closed" && <div className="terminal-status warn">Disconnected: {state.reason}</div>}
    </>
  );
}
