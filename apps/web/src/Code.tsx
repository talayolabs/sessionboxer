import { useCallback, useEffect, useState } from "react";
import type { CodeServerStatus, Session } from "@sessionboxer/protocol";
import { api, codeUrl } from "./api";

function isLive(session: Session): boolean {
  return session.status === "idle" || session.status === "running";
}

/**
 * VS Code on the Workspace, served by openvscode-server from inside the Sandbox and shown in
 * an iframe. The server is started the first time the pane opens and stays up until the
 * Sandbox stops; the iframe URL is same-origin (Control Plane proxy), so clipboard and
 * keyboard work as in any tab.
 */
export function CodePane({ session }: { session: Session }) {
  const live = isLive(session);
  const [status, setStatus] = useState<CodeServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.codeStart(session.id);
      setStatus(next);
      if (next.state === "failed") setError(next.error ?? "VS Code failed to start.");
      else setGeneration((g) => g + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [session.id]);

  // Whenever the Sandbox is (back) up, reuse a running server or start one.
  useEffect(() => {
    setStatus(null);
    setError(null);
    if (!live) return;
    let cancelled = false;
    void (async () => {
      try {
        const current = await api.codeStatus(session.id);
        if (cancelled) return;
        if (current.state === "running") {
          setStatus(current);
          setGeneration((g) => g + 1);
          return;
        }
        await start();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.id, live, start]);

  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.codeStop(session.id);
      setStatus(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    await start();
  };

  const running = live && status?.state === "running";
  const url = codeUrl(session.id);

  return (
    <div className="code">
      <div className="terminal-toolbar">
        <span className="muted" title="Running inside the Sandbox, not on your machine">
          Remote VS Code{status?.version ? ` ${status.version}` : ""}
        </span>
        <span className="spacer" />
        {running && (
          <button className="small" onClick={() => window.open(url, "_blank", "noopener")} title="Open VS Code in its own tab">
            Open in new tab ↗
          </button>
        )}
        <button className="small" onClick={() => void restart()} disabled={!live || busy} title="Stop and start the VS Code server again">
          Restart
        </button>
      </div>
      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
          <span className="spacer" />
          <button className="small" onClick={() => void start()} disabled={!live || busy}>
            Retry
          </button>
        </div>
      )}
      <div className="code-body">
        {!live && <div className="desktop-overlay">Sandbox is {session.status}; VS Code is available while it runs.</div>}
        {live && !running && !error && <div className="desktop-overlay muted">Starting VS Code in the Sandbox…</div>}
        {running && (
          <iframe
            key={generation}
            className="code-frame"
            src={url}
            title="VS Code"
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>
    </div>
  );
}
