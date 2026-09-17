import { useEffect, useRef, useState } from "react";
import { CONNECTORS, MCP_NAME_PATTERN, type ConnectorFlow, type ConnectorKind, type PublicMcpServerDef } from "@sessionboxer/protocol";
import { api } from "./api";
import { ConnectorIcon } from "./ConnectorIcon";

const POLL_MS = 2500;

/**
 * Logs a Connector entry in with OAuth. A new entry is created on the Control Plane when
 * the login starts (so the token has somewhere to land), an existing one is re-connected
 * in place. Device flow: show the code and a link; redirect flow: open the provider's
 * page in a new tab. Either way we poll the flow until `done` / `error`.
 */
export function ConnectorDialog({
  kind,
  server,
  takenNames,
  onClose,
  onServer,
}: {
  kind: ConnectorKind;
  /** Entry to re-connect, or `null` to add a new one. */
  server: PublicMcpServerDef | null;
  takenNames: string[];
  onClose: () => void;
  /** The entry as stored by the Control Plane, on creation and again once connected. */
  onServer: (server: PublicMcpServerDef) => void;
}) {
  const preset = CONNECTORS[kind];
  const [name, setName] = useState(() => server?.name ?? freeName(kind, takenNames));
  const [flow, setFlow] = useState<ConnectorFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const onServerRef = useRef(onServer);
  onServerRef.current = onServer;

  const nameOk = MCP_NAME_PATTERN.test(name) && (server !== null || !takenNames.includes(name));

  useEffect(() => {
    if (!flow || flow.status !== "pending") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await api.connectorFlow(flow.id);
        if (cancelled) return;
        setFlow(next);
        if (next.status === "done") onServerRef.current(next.server);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [flow]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const f = await api.connectorStart(kind, { serverId: server?.id ?? null, name });
      onServerRef.current(f.server);
      setFlow(f);
      if (f.mode === "redirect" && f.url) window.open(f.url, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!flow?.userCode) return;
    try {
      await navigator.clipboard.writeText(flow.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked; the code is selectable anyway
    }
  };

  const title = server ? `Reconnect ${preset.label}` : `Add ${preset.label} MCP`;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel connector-dialog" role="dialog" aria-modal="true" aria-labelledby="connector-title">
        <h2 id="connector-title" className="connector-title">
          <ConnectorIcon kind={kind} size={22} /> {title}
        </h2>
        {!flow && (
          <>
            <p className="muted">
              Adds GitHub's remote MCP server (<code>{preset.url}</code>) and logs it in with your GitHub account. Add it more than once, under
              different names, to use several accounts.
            </p>
            <label>
              Name (tool prefix; letters, digits, - and _)
              <input
                value={name}
                autoFocus={!server}
                disabled={server !== null}
                pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,63}"
                placeholder="github-work"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {!nameOk && name !== "" && (
              <p className="muted">{takenNames.includes(name) && !server ? "That name is already used by another MCP server." : "Letters, digits, - and _ only."}</p>
            )}
          </>
        )}
        {flow?.status === "pending" && flow.mode === "device" && (
          <div className="connector-device">
            <p>
              Enter this code at{" "}
              <a href={flow.verificationUri ?? undefined} target="_blank" rel="noopener noreferrer">
                {flow.verificationUri?.replace(/^https?:\/\//, "")}
              </a>{" "}
              and authorize <strong>Sessionboxer</strong> as the GitHub account you want <code>{flow.server.name}</code> to use:
            </p>
            <div className="connector-code-row">
              <code className="connector-code">{flow.userCode}</code>
              <button type="button" className="small" onClick={() => void copyCode()}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  void copyCode();
                  window.open(flow.verificationUri ?? undefined, "_blank", "noopener");
                }}
              >
                Copy &amp; open GitHub
              </button>
            </div>
            <p className="muted">
              Waiting for the authorization… (code valid until {new Date(flow.expiresAt).toLocaleTimeString()}). If you are logged in to
              GitHub as another account, log out there first or use a private window.
            </p>
          </div>
        )}
        {flow?.status === "pending" && flow.mode === "redirect" && (
          <div className="connector-device">
            <p>
              Authorize <strong>Sessionboxer</strong> in the GitHub tab that just opened, as the account you want <code>{flow.server.name}</code>{" "}
              to use.{" "}
              <a href={flow.url ?? undefined} target="_blank" rel="noopener noreferrer">
                Open it again
              </a>{" "}
              if it did not appear.
            </p>
            <p className="muted">Waiting for the authorization…</p>
          </div>
        )}
        {flow?.status === "done" && (
          <p className="connector-done">
            Connected <code>{flow.server.name}</code> as <strong>@{flow.server.connector?.account}</strong>.
            {flow.server.connector?.expiresAt && (
              <span className="muted"> The token expires {new Date(flow.server.connector.expiresAt).toLocaleString()}; reconnect then.</span>
            )}
          </p>
        )}
        {(error || flow?.status === "error") && (
          <div className="banner banner-error dialog-banner" role="alert">
            {error ?? flow?.error}
          </div>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            {flow?.status === "done" ? "Close" : "Cancel"}
          </button>
          {(!flow || flow.status === "error") && (
            <button type="button" className="primary" disabled={busy || !nameOk} onClick={() => void start()}>
              {busy ? "Starting…" : flow ? "Try again" : `Log in with ${preset.label}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function freeName(kind: ConnectorKind, taken: string[]): string {
  const base = kind;
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}
