import { useState } from "react";
import {
  CONNECTOR_KINDS,
  CONNECTORS,
  type ConnectorKind,
  type PublicMcpServerDef,
  type PublicSettings,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { ConnectorDialog } from "./ConnectorDialog";
import { ConnectorIcon } from "./ConnectorIcon";
import { Modal } from "./ui";

/**
 * "Git accounts" in Settings: the entry point for connecting GitHub and Bitbucket, one row
 * per connected account. The accounts are Connector entries of the MCP registry underneath
 * (GitHub's also carries its MCP server), so this edits the same `servers` list as
 * `McpServersEditor`; the registry keeps showing them with their default checkbox.
 */
export function GitAccounts({
  servers,
  onChange,
  onStored,
}: {
  servers: PublicMcpServerDef[];
  onChange: (next: PublicMcpServerDef[]) => void;
  /** Logins are saved by the Control Plane right away (no Save needed); reports the stored Settings. */
  onStored?: (settings: PublicSettings) => void;
}) {
  const [connecting, setConnecting] = useState<{
    kind: ConnectorKind;
    server: PublicMcpServerDef | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accounts = servers.filter((s) => s.connector !== null);

  const upsert = (server: PublicMcpServerDef) =>
    onChange(
      servers.some((s) => s.id === server.id)
        ? servers.map((s) => (s.id === server.id ? server : s))
        : [...servers, server],
    );
  const stored = (server: PublicMcpServerDef) => {
    upsert(server);
    if (onStored) void api.settings().then(onStored, () => undefined);
  };
  const disconnect = async (id: string) => {
    setError(null);
    try {
      const saved = await api.connectorDisconnect(id);
      const server = saved.mcpServers.find((s) => s.id === id);
      if (server) upsert(server);
      onStored?.(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <fieldset className="choice" id="settings-git">
      <legend>Git accounts</legend>
      <p className="muted">
        Connect the account Sessions use to clone, push and open pull requests.
        GitHub offers three logins: GitHub CLI (everything your account sees),
        the Sessionboxer OAuth App (you grant organizations one by one on
        GitHub's page) and a personal access token (the one that can be limited
        to a single organization); the dialog explains each. A GitHub account
        also adds GitHub's MCP server to the list below.
      </p>
      {accounts.length === 0 && (
        <p className="muted empty-inline">No Git account connected yet.</p>
      )}
      {accounts.length > 0 && (
        <ul className="mcp-list">
          {accounts.map((s) => {
            const c = s.connector;
            if (!c) return null;
            return (
              <li key={s.id} className="mcp-card connector">
                <ConnectorIcon kind={c.kind} />
                <span className="mcp-name">{CONNECTORS[c.kind].label}</span>
                {c.account ? (
                  <span
                    className="mcp-summary connector-status"
                    title={`Connected ${new Date(c.connectedAt ?? 0).toLocaleString()}`}
                  >
                    Connected as <strong>@{c.account}</strong>
                    {c.host && <span className="muted"> on {c.host}</span>}
                    {c.expiresAt && Date.parse(c.expiresAt) < Date.now() && (
                      <span className="connector-expired">
                        {" "}
                        (token expired)
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="muted mcp-summary">Not connected</span>
                )}
                <span className="spacer" />
                <button
                  type="button"
                  className="small"
                  onClick={() => setConnecting({ kind: c.kind, server: s })}
                >
                  {c.account ? "Reconnect" : "Connect"}
                </button>
                {c.account && (
                  <button
                    type="button"
                    className="small"
                    title="Forget the token; the entry stays"
                    onClick={() => void disconnect(s.id)}
                  >
                    Disconnect
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mcp-actions">
        {CONNECTOR_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="connector-button"
            onClick={() => setConnecting({ kind, server: null })}
          >
            <ConnectorIcon kind={kind} /> Connect {CONNECTORS[kind].label}
          </button>
        ))}
      </div>
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {connecting && (
        <ConnectorDialog
          kind={connecting.kind}
          server={connecting.server}
          takenNames={servers.map((s) => s.name)}
          onClose={() => setConnecting(null)}
          onServer={stored}
        />
      )}
    </fieldset>
  );
}

const GIT_BLURB: Record<ConnectorKind, string> = {
  github:
    "github.com: GitHub CLI, the Sessionboxer OAuth App or a personal access token",
  bitbucket:
    "Self-hosted Bitbucket (Data Center / Server) with an HTTP access token",
};

/**
 * "Connect a Git account" from the first screen and the sidebar checklist: pick GitHub or
 * Bitbucket, then the same `ConnectorDialog` Settings → Git accounts uses. Logins are stored by
 * the Control Plane right away; `onStored` gets the Settings afterwards.
 */
export function GitConnectDialog({
  servers,
  initial,
  onClose,
  onStored,
}: {
  servers: PublicMcpServerDef[];
  initial: ConnectorKind | null;
  onClose: () => void;
  onStored: (settings: PublicSettings) => void;
}) {
  const [kind, setKind] = useState<ConnectorKind | null>(initial);
  if (kind) {
    return (
      <ConnectorDialog
        kind={kind}
        server={null}
        takenNames={servers.map((s) => s.name)}
        onClose={onClose}
        onServer={() => void api.settings().then(onStored, () => undefined)}
      />
    );
  }
  return (
    <Modal
      className="git-connect"
      titleClassName="large"
      title={
        <>
          <span>Connect a Git account</span>
          <span className="spacer" />
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        </>
      }
      onClose={onClose}
    >
      <p className="muted">
        The account Sessions clone private repositories with, push as, and
        open pull requests from. Public repositories need none. Optional now:
        Global settings → Git accounts has this too.
      </p>
      <div className="provider-logos git-logos">
        {CONNECTOR_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className="provider-logo"
            onClick={() => setKind(k)}
          >
            <ConnectorIcon kind={k} size={40} />
            <span className="provider-logo-name">{CONNECTORS[k].label}</span>
            <span className="provider-logo-state muted">{GIT_BLURB[k]}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
