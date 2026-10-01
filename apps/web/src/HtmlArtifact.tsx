import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { HTML_APP_AUTORUN_BYTES, type Session } from "@sessionboxer/protocol";
import { api } from "./api";
import { appFileUrl } from "./attachment-paths";
import { FileLink, OpenFile } from "./FileLink";
import { formatBytes } from "./format";

/** Shows a Workspace HTML file in the Session's App pane; null where there is no Session page. */
export const OpenApp = createContext<((path: string) => void) | null>(null);

/** A Workspace file the Daemon reported as changed (`fs_changed`), with a nonce so equal reports still differ. */
export interface FsChange {
  sessionId: string;
  path: string;
  exists: boolean;
  nonce: number;
}

const SANDBOX = "allow-scripts allow-pointer-lock";

function toggleFullscreen(el: HTMLElement | null): void {
  if (!el) return;
  if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
  else void el.requestFullscreen().catch(() => undefined);
}

/**
 * The body of an HTML Artifact's card in the chat (ADR-0078): the file runs in an iframe with no
 * origin of its own, from the `fs/app` route whose CSP keeps it that way wherever it is opened. Small
 * files run on sight; above `HTML_APP_AUTORUN_BYTES` the user presses Run.
 */
export function HtmlArtifact({ sessionId, path, name, bytes }: { sessionId: string; path: string; name: string; bytes: number | null }) {
  const big = bytes !== null && bytes > HTML_APP_AUTORUN_BYTES;
  const [running, setRunning] = useState(!big);
  const [nonce, setNonce] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const openApp = useContext(OpenApp);
  const openFile = useContext(OpenFile);
  const src = appFileUrl(sessionId, path, nonce);

  return (
    <div className="artifact">
      <div className="artifact-bar">
        <button type="button" className="small" onClick={() => setRunning((r) => !r)} title={running ? "Stop the app (unload the frame)" : "Run the app"}>
          {running ? "Stop" : "Run"}
        </button>
        <button type="button" className="small" disabled={!running} onClick={() => setNonce(Date.now())} title="Load the file again">
          Reload
        </button>
        {openApp && (
          <button type="button" className="small" onClick={() => openApp(path)} title="Show it in the App pane, where it follows the file's changes">
            Open in App pane
          </button>
        )}
        <button type="button" className="small" disabled={!running} onClick={() => toggleFullscreen(frameRef.current)} title="Fill the screen (Esc to leave)">
          Fullscreen
        </button>
        {openFile && (
          <button type="button" className="small" onClick={() => openFile({ path })} title="Open the HTML source in the Code pane">
            Source
          </button>
        )}
        <span className="spacer" />
        {big && !running && <span className="muted">{formatBytes(bytes)}: press Run to load it</span>}
      </div>
      <div ref={frameRef} className="artifact-frame">
        {running ? (
          <iframe key={nonce} sandbox={SANDBOX} referrerPolicy="no-referrer" src={src} title={name} />
        ) : (
          <div className="artifact-stopped muted">{big ? "Not loaded: a large app runs when you press Run." : "Stopped."}</div>
        )}
      </div>
    </div>
  );
}

/**
 * The App pane: the HTML Artifact last opened from the chat, reloaded when the Daemon reports the
 * file changed (`fs/watch`, no polling). Which file it shows is kept per Session by the page.
 */
export function AppPane({ session, path, change }: { session: Session; path: string | null; change: FsChange | null }) {
  const live = session.status === "idle" || session.status === "running";
  const [nonce, setNonce] = useState(0);
  const [gone, setGone] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const openFile = useContext(OpenFile);
  const reload = useCallback(() => {
    setGone(false);
    setNonce(Date.now());
  }, []);

  useEffect(() => {
    setGone(false);
    setNonce(0);
    if (!path || !live) return;
    api.fsWatch(session.id, { path }).catch(() => undefined);
  }, [session.id, path, live]);

  useEffect(() => {
    if (!change || !path || change.sessionId !== session.id || change.path !== path) return;
    if (change.exists) reload();
    else setGone(true);
  }, [change, session.id, path, reload]);

  const src = path ? appFileUrl(session.id, path, nonce) : null;
  return (
    <div className="pane app-pane">
      <div className="pane-toolbar">
        {path ? (
          <FileLink fileRef={{ path }} className="app-pane-path">
            <span title={`/workspace/${path}`}>{path}</span>
          </FileLink>
        ) : (
          <span className="muted">No app open</span>
        )}
        <span className="spacer" />
        {src && live && (
          <>
            <button className="small" onClick={reload} title="Load the file again">
              Reload
            </button>
            <button className="small" onClick={() => toggleFullscreen(frameRef.current)} title="Fill the screen (Esc to leave)">
              Fullscreen
            </button>
            {openFile && path && (
              <button className="small" onClick={() => openFile({ path })} title="Open the HTML source in the Code pane">
                Source
              </button>
            )}
            <button className="small" onClick={() => window.open(src, "_blank", "noopener,noreferrer")} title="Open the app in its own tab (it keeps its sandbox there)">
              Open in new tab ↗
            </button>
          </>
        )}
      </div>
      <div ref={frameRef} className="app-body">
        {!path && <div className="pane-overlay">Mention an .html file of the Workspace in the chat and choose “Open in App pane” on its card.</div>}
        {path && !live && <div className="pane-overlay">Sandbox is {session.status}; the app is available while it runs.</div>}
        {path && live && gone && <div className="pane-overlay">{path} is no longer in the Workspace.</div>}
        {src && live && !gone && <iframe key={nonce} className="app-frame" sandbox={SANDBOX} referrerPolicy="no-referrer" src={src} title={path ?? "app"} />}
      </div>
    </div>
  );
}
