import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { PtyInfo, Session, TerminalClientMessage, TerminalServerMessage } from "@sessionboxer/protocol";
import { api, terminalSocketUrl } from "./api";
import "@xterm/xterm/css/xterm.css";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";

function isLive(session: Session): boolean {
  return session.status === "idle" || session.status === "running";
}

/** Puts `text` on the clipboard; falls back to the copy command (which xterm answers with its selection) where the async API is unavailable. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // blocked (insecure context, permission); try the command route below
  }
  return document.execCommand("copy");
}

/** Reading the clipboard needs a secure context (localhost, https) and the user's permission. */
function canReadClipboard(): boolean {
  return typeof navigator.clipboard?.readText === "function";
}

async function readClipboard(): Promise<string | null> {
  try {
    return canReadClipboard() ? await navigator.clipboard.readText() : null;
  } catch {
    return null;
  }
}

/**
 * Copy and paste keys, as in the usual terminals: Ctrl+C with a selection, Ctrl+Shift+C and
 * Ctrl+Insert copy (Ctrl+C without a selection still interrupts); Ctrl+V, Ctrl+Shift+V and
 * Shift+Insert paste. Returns false when xterm must not treat the key itself.
 */
function copyPasteKeys(term: XTerm, e: KeyboardEvent): boolean {
  if (e.altKey || e.metaKey) return true;
  const copy =
    (e.ctrlKey && e.code === "KeyC" && (e.shiftKey || term.hasSelection())) || (e.ctrlKey && !e.shiftKey && e.code === "Insert");
  const paste = (e.ctrlKey && e.code === "KeyV") || (e.shiftKey && !e.ctrlKey && e.code === "Insert");
  if (!copy && !paste) return true;
  if (e.type !== "keydown") return false;
  if (copy) {
    e.preventDefault();
    if (term.hasSelection()) {
      void writeClipboard(term.getSelection()).then((ok) => {
        if (ok) term.clearSelection();
      });
    }
    return false;
  }
  // Paste: the browser's default fires a paste event on xterm's textarea. Shift+Insert has no
  // default in every browser, so where the page may read the clipboard, paste it ourselves.
  if (e.code === "Insert" && canReadClipboard()) {
    e.preventDefault();
    void readClipboard().then((text) => {
      if (text) term.paste(text);
    });
  }
  return false;
}

type MenuState = { x: number; y: number } | null;
const MENU_WIDTH = 220;
const MENU_HEIGHT = 150;

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
  const termRef = useRef<XTerm | null>(null);
  const [state, setState] = useState<ViewState>({ kind: "connecting" });
  const [menu, setMenu] = useState<MenuState>(null);
  const [menuNote, setMenuNote] = useState<string | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const note = (text: string) => {
    setMenuNote(text);
    setTimeout(() => setMenuNote((n) => (n === text ? null : n)), 3000);
  };

  const copySelection = async () => {
    const term = termRef.current;
    setMenu(null);
    if (!term?.hasSelection()) return;
    const text = term.getSelection();
    term.focus();
    if (await writeClipboard(text)) term.clearSelection();
    else note("Copy blocked by the browser; select and use the keyboard.");
  };

  const pasteClipboard = async () => {
    const term = termRef.current;
    setMenu(null);
    if (!term) return;
    term.focus();
    const text = await readClipboard();
    if (text === null) note(`This page may not read the clipboard; paste with ${MOD}+V.`);
    else if (text !== "") term.paste(text);
  };

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
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.attachCustomKeyEventHandler((e) => copyPasteKeys(term, e));
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
      termRef.current = null;
    };
  }, [sessionId, pty.id]);

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const bounds = e.currentTarget.getBoundingClientRect();
    setMenu({
      x: Math.max(0, Math.min(e.clientX - bounds.left, bounds.width - MENU_WIDTH)),
      y: Math.max(0, Math.min(e.clientY - bounds.top, bounds.height - MENU_HEIGHT)),
    });
  };

  const hasSelection = menu !== null && (termRef.current?.hasSelection() ?? false);

  return (
    <>
      <div className="terminal-screen" ref={hostRef} onContextMenu={onContextMenu} />
      {menu && (
        <div className="menu terminal-menu" style={{ left: menu.x, top: menu.y }} role="menu" onMouseDown={(e) => e.stopPropagation()}>
          <button className="menu-item" role="menuitem" disabled={!hasSelection} onClick={() => void copySelection()}>
            <span className="menu-row">
              Copy <kbd>{IS_MAC ? "⌘C" : "Ctrl+Shift+C"}</kbd>
            </span>
          </button>
          <button className="menu-item" role="menuitem" onClick={() => void pasteClipboard()}>
            <span className="menu-row">
              Paste <kbd>{MOD}+V</kbd>
            </span>
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              termRef.current?.selectAll();
            }}
          >
            <span className="menu-row">Select all</span>
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              termRef.current?.clear();
              termRef.current?.focus();
            }}
          >
            <span className="menu-row">Clear</span>
          </button>
        </div>
      )}
      {menuNote && <div className="terminal-note">{menuNote}</div>}
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
