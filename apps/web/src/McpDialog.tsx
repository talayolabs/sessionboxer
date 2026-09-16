import { useEffect } from "react";
import type { PublicMcpServerDef, Session } from "@sessionboxer/protocol";
import { summarize } from "./mcp";

/**
 * Per-Session MCP switches, opened from the "MCP" button in the Session header. Toggling
 * restarts the Agent in place (history kept) when idle, or right after the current turn.
 */
export function McpDialog({
  session,
  servers,
  busy,
  onToggle,
  onClose,
}: {
  session: Session;
  servers: PublicMcpServerDef[];
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const enabled = new Set(session.mcpEnabled);
  const isLive = session.status === "idle" || session.status === "running";

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel mcp-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-title">
        <h2 id="mcp-title">MCP servers of "{session.title}"</h2>
        <p className="muted">
          The built-in <code>desktop</code> server (screen, mouse, keyboard) is always on. Switching a server{" "}
          {session.status === "running"
            ? "takes effect when the current turn ends"
            : isLive
              ? "restarts the Agent in place; the conversation is kept"
              : "applies when the Sandbox is next started"}
          .
        </p>
        {session.mcpPending && (
          <div className="banner banner-warn dialog-banner" role="status">
            Change pending: the Agent is busy, the new set applies after this turn.
          </div>
        )}
        <ul className="mcp-switches" aria-busy={busy}>
          {servers.length === 0 && (
            <li className="empty">
              No MCP servers registered. Add them in <a href="#/settings">Settings</a>.
            </li>
          )}
          {servers.map((s) => (
            <li key={s.id}>
              <label className="check switch">
                <input type="checkbox" checked={enabled.has(s.id)} disabled={busy} onChange={(e) => onToggle(s.id, e.target.checked)} />
                <span className="slider" aria-hidden="true" />
                <span className="mcp-name">{s.name}</span>
                <span className="muted mcp-transport">{s.transport}</span>
                <span className="muted mcp-summary" title={summarize(s)}>
                  {summarize(s)}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="actions">
          <a className="muted" href="#/settings">
            Manage servers in Settings
          </a>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Checkbox list for the New Session form; `enabled` holds ids. */
export function McpPicker({
  servers,
  enabled,
  onChange,
}: {
  servers: PublicMcpServerDef[];
  enabled: string[];
  onChange: (ids: string[]) => void;
}) {
  if (servers.length === 0) return null;
  const set = new Set(enabled);
  return (
    <fieldset className="choice">
      <legend>MCP servers (besides the built-in desktop; switchable later from the session header)</legend>
      {servers.map((s) => (
        <label key={s.id} className="check">
          <input
            type="checkbox"
            checked={set.has(s.id)}
            onChange={(e) => onChange(e.target.checked ? [...enabled, s.id] : enabled.filter((id) => id !== s.id))}
          />
          <span className="mcp-name">{s.name}</span>
          <span className="muted choice-text" title={summarize(s)}>
            {s.transport} · {summarize(s)}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
