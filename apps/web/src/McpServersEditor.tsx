import { useState } from "react";
import {
  CONNECTOR_KINDS,
  CONNECTORS,
  MCP_TRANSPORTS,
  type ConnectorKind,
  type PublicMcpKeyValue,
  type PublicMcpServerDef,
  type PublicSettings,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { ConnectorDialog } from "./ConnectorDialog";
import { ConnectorIcon } from "./ConnectorIcon";
import { TRANSPORT_LABELS, importMcpJson, joinArgs, newMcpServer, splitArgs, summarize } from "./mcp";

/**
 * The global MCP registry inside Settings: one card per server (collapsed summary or
 * the edit form), Add, Import JSON. Secret env vars / headers are write-only: the
 * Control Plane returns `null` for a set secret and keeps it when we send `null` back.
 */
export function McpServersEditor({
  servers,
  onChange,
  onStored,
}: {
  servers: PublicMcpServerDef[];
  onChange: (next: PublicMcpServerDef[]) => void;
  /** Connector logins are saved by the Control Plane right away (no Save needed); reports the stored Settings. */
  onStored?: (settings: PublicSettings) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [connecting, setConnecting] = useState<{ kind: ConnectorKind; server: PublicMcpServerDef | null } | null>(null);
  const [connectorError, setConnectorError] = useState<string | null>(null);

  const update = (id: string, patch: Partial<PublicMcpServerDef>) => onChange(servers.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  // Connector entries are stored by the Control Plane as soon as a login starts; mirror
  // them here so saving the form does not drop or stale them.
  const upsert = (server: PublicMcpServerDef) =>
    onChange(servers.some((s) => s.id === server.id) ? servers.map((s) => (s.id === server.id ? server : s)) : [...servers, server]);
  const stored = (server: PublicMcpServerDef) => {
    upsert(server);
    if (onStored) void api.settings().then(onStored, () => undefined);
  };
  const disconnect = async (id: string) => {
    setConnectorError(null);
    try {
      const saved = await api.connectorDisconnect(id);
      const server = saved.mcpServers.find((s) => s.id === id);
      if (server) upsert(server);
      onStored?.(saved);
    } catch (e) {
      setConnectorError(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = (id: string) => {
    onChange(servers.filter((s) => s.id !== id));
    if (editing === id) setEditing(null);
  };
  const add = () => {
    const s = newMcpServer();
    onChange([...servers, s]);
    setEditing(s.id);
  };

  return (
    <fieldset className="choice mcp-registry">
      <legend>MCP servers</legend>
      <p className="muted">
        Available to every Session; each Session picks which ones are on (new Sessions start with the ones marked default) and can
        switch them at any time. The built-in <code>desktop</code> server is always on. Servers on this machine are reachable as{" "}
        <code>host.docker.internal</code> (<code>localhost</code> URLs are rewritten). <code>npx</code>, <code>uvx</code>,{" "}
        <code>python3</code> and <code>node</code> are available in the Sandbox.
      </p>
      {servers.length === 0 && <p className="muted empty-inline">No MCP servers yet.</p>}
      <ul className="mcp-list">
        {servers.map((s) =>
          editing === s.id ? (
            <li key={s.id} className="mcp-card editing">
              <McpServerForm server={s} onChange={(patch) => update(s.id, patch)} onDone={() => setEditing(null)} onDelete={() => remove(s.id)} />
            </li>
          ) : (
            <li key={s.id} className={s.connector ? "mcp-card connector" : "mcp-card"}>
              <label className="check" title="New Sessions start with this server on">
                <input type="checkbox" checked={s.enabledByDefault} onChange={(e) => update(s.id, { enabledByDefault: e.target.checked })} />
              </label>
              {s.connector && <ConnectorIcon kind={s.connector.kind} />}
              <span className="mcp-name">{s.name || <em className="muted">unnamed</em>}</span>
              {s.connector ? (
                s.connector.account ? (
                  <span className="mcp-summary connector-status" title={`Connected ${new Date(s.connector.connectedAt ?? 0).toLocaleString()}`}>
                    Connected as <strong>@{s.connector.account}</strong>
                    {s.connector.expiresAt && Date.parse(s.connector.expiresAt) < Date.now() && <span className="connector-expired"> (token expired)</span>}
                  </span>
                ) : (
                  <span className="muted mcp-summary">Not connected</span>
                )
              ) : (
                <>
                  <span className="muted mcp-transport">{s.transport}</span>
                  <span className="muted mcp-summary" title={summarize(s)}>
                    {summarize(s)}
                  </span>
                </>
              )}
              {!s.connector && (s.env.length > 0 || s.headers.length > 0) && (
                <span className="muted" title="Environment variables / headers">
                  {s.env.length + s.headers.length} var{s.env.length + s.headers.length === 1 ? "" : "s"}
                </span>
              )}
              <span className="spacer" />
              {s.connector && (
                <button type="button" className="small" onClick={() => s.connector && setConnecting({ kind: s.connector.kind, server: s })}>
                  {s.connector.account ? "Reconnect" : "Connect"}
                </button>
              )}
              {s.connector?.account && (
                <button type="button" className="small" title="Forget the token; the entry stays" onClick={() => void disconnect(s.id)}>
                  Disconnect
                </button>
              )}
              <button type="button" className="small" onClick={() => setEditing(s.id)}>
                Edit
              </button>
              <button type="button" className="small danger" onClick={() => remove(s.id)}>
                Delete
              </button>
            </li>
          ),
        )}
      </ul>
      <div className="mcp-actions">
        <button type="button" onClick={add}>
          Add server
        </button>
        <button type="button" onClick={() => setImporting(true)} title='Paste a {"mcpServers": {...}} block (Claude Desktop, Cursor, VS Code style)'>
          Import JSON…
        </button>
        {CONNECTOR_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="connector-button"
            title={`Add ${CONNECTORS[kind].label}'s MCP server and log in with OAuth (no tokens to paste)`}
            onClick={() => setConnecting({ kind, server: null })}
          >
            <ConnectorIcon kind={kind} /> Add {CONNECTORS[kind].label}
          </button>
        ))}
        <span className="muted mcp-hint">Default column = on for new Sessions. Saved with the form below.</span>
      </div>
      {connectorError && (
        <div className="banner banner-error" role="alert">
          {connectorError}
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
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImport={(list) => {
            const taken = new Set(servers.map((s) => s.name));
            const renamed = list.map((s) => {
              let name = s.name;
              for (let i = 2; taken.has(name); i++) name = `${s.name}-${i}`;
              taken.add(name);
              return { ...s, name };
            });
            onChange([...servers, ...renamed]);
            setImporting(false);
          }}
        />
      )}
    </fieldset>
  );
}

function McpServerForm({
  server,
  onChange,
  onDone,
  onDelete,
}: {
  server: PublicMcpServerDef;
  onChange: (patch: Partial<PublicMcpServerDef>) => void;
  onDone: () => void;
  onDelete: () => void;
}) {
  const [argsText, setArgsText] = useState(joinArgs(server.args));
  const stdio = server.transport === "stdio";
  return (
    <div className="mcp-form">
      <div className="row">
        <label>
          Name (tool prefix; letters, digits, - and _)
          <input
            value={server.name}
            pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,63}"
            placeholder="github"
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>
        <label>
          Transport
          <select value={server.transport} onChange={(e) => onChange({ transport: e.target.value as PublicMcpServerDef["transport"] })}>
            {MCP_TRANSPORTS.map((t) => (
              <option key={t} value={t}>
                {TRANSPORT_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {stdio ? (
        <>
          <label>
            Command (runs inside the Sandbox)
            <input value={server.command} placeholder="npx" onChange={(e) => onChange({ command: e.target.value })} />
          </label>
          <label>
            Arguments (shell-style quoting)
            <input
              value={argsText}
              placeholder="-y @modelcontextprotocol/server-github"
              onChange={(e) => {
                setArgsText(e.target.value);
                onChange({ args: splitArgs(e.target.value) });
              }}
            />
          </label>
          <KeyValueList
            label="Environment variables"
            items={server.env}
            namePlaceholder="GITHUB_PERSONAL_ACCESS_TOKEN"
            onChange={(env) => onChange({ env })}
          />
        </>
      ) : (
        <>
          <label>
            URL
            <input
              type="url"
              value={server.url}
              placeholder={server.transport === "sse" ? "http://localhost:8000/sse" : "https://mcp.example.com/mcp"}
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </label>
          <KeyValueList label="Headers" items={server.headers} namePlaceholder="Authorization" onChange={(headers) => onChange({ headers })} />
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={server.enabledByDefault} onChange={(e) => onChange({ enabledByDefault: e.target.checked })} />
        On by default in new Sessions
      </label>
      <div className="mcp-actions">
        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
        <span className="spacer" />
        <button type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function KeyValueList({
  label,
  items,
  namePlaceholder,
  onChange,
}: {
  label: string;
  items: PublicMcpKeyValue[];
  namePlaceholder: string;
  onChange: (items: PublicMcpKeyValue[]) => void;
}) {
  const set = (i: number, patch: Partial<PublicMcpKeyValue>) => onChange(items.map((kv, j) => (j === i ? { ...kv, ...patch } : kv)));
  return (
    <div className="kv">
      <span className="muted">{label}</span>
      {items.map((kv, i) => {
        const stored = kv.secret && kv.value === null;
        return (
          <div key={i} className="kv-row">
            <input value={kv.name} placeholder={namePlaceholder} onChange={(e) => set(i, { name: e.target.value })} />
            <input
              type={kv.secret ? "password" : "text"}
              autoComplete="off"
              value={kv.value ?? ""}
              placeholder={stored ? "(set; leave empty to keep)" : "value"}
              onChange={(e) => set(i, { value: e.target.value === "" && kv.secret && stored ? null : e.target.value })}
            />
            <label className="check" title="Secret: stored in config.json, never shown again here, kept out of snapshots">
              <input
                type="checkbox"
                checked={kv.secret}
                onChange={(e) => set(i, { secret: e.target.checked, ...(e.target.checked ? {} : { value: kv.value ?? "" }) })}
              />
              secret
            </label>
            <button type="button" className="small danger" onClick={() => onChange(items.filter((_, j) => j !== i))} title="Remove">
              ×
            </button>
          </div>
        );
      })}
      <div>
        <button type="button" className="small" onClick={() => onChange([...items, { name: "", value: "", secret: false }])}>
          Add {label.toLowerCase().replace(/s$/, "")}
        </button>
      </div>
    </div>
  );
}

function ImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (servers: PublicMcpServerDef[]) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel" role="dialog" aria-modal="true" aria-labelledby="mcp-import-title">
        <h2 id="mcp-import-title">Import MCP servers from JSON</h2>
        <p className="muted">
          Paste the <code>{'{"mcpServers": {...}}'}</code> block from Claude Desktop, Cursor or a server's README. Env vars and headers whose
          names look like tokens are marked secret.
        </p>
        <textarea
          rows={12}
          autoFocus
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          placeholder={'{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"],\n      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." }\n    }\n  }\n}'}
        />
        {error && (
          <div className="banner banner-error dialog-banner" role="alert">
            {error}
          </div>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!text.trim()}
            onClick={() => {
              try {
                onImport(importMcpJson(text));
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
