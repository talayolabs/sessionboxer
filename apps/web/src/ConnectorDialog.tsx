import { useEffect, useRef, useState } from "react";
import {
  CONNECTORS,
  MCP_NAME_PATTERN,
  type ConnectorFlow,
  type ConnectorKind,
  type ConnectorVia,
  type GhCliStatus,
  type PublicMcpServerDef,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { ConnectorIcon } from "./ConnectorIcon";

const POLL_MS = 2500;

/**
 * Logs a Connector entry in. A new entry is created on the Control Plane when the login
 * starts (so the token has somewhere to land), an existing one is re-connected in place.
 * Default is GitHub CLI's own login (its app is exempt from organizations' third-party
 * app policies; `gh` gets downloaded if the machine has none), with a shortcut to reuse
 * an account `gh` is already logged in as, and the Sessionboxer OAuth App as fallback.
 * Device flow: show the code and a link; redirect flow: open the provider's page in a new
 * tab. Either way we poll the flow until `done` / `error`. Bitbucket (Data Center) has no
 * login an app can drive without its administrator, so its way is a guided token: open the
 * host's token page, paste the HTTP access token once; the Control Plane verifies it and
 * answers with the account, all in the start call.
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
  const [busy, setBusy] = useState<ConnectorVia | null>(null);
  const [copied, setCopied] = useState(false);
  const [gh, setGh] = useState<GhCliStatus | null>(null);
  const [host, setHost] = useState(() => server?.connector?.host ?? "");
  const [token, setToken] = useState("");
  const onServerRef = useRef(onServer);
  onServerRef.current = onServer;

  const nameOk = MCP_NAME_PATTERN.test(name) && (server !== null || !takenNames.includes(name));
  const hostName = host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const hostOk = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/.test(hostName);

  useEffect(() => {
    if (kind !== "github") return;
    let cancelled = false;
    api
      .connectorGh()
      .then((s) => !cancelled && setGh(s))
      .catch(() => !cancelled && setGh({ available: false, version: null, logins: [] }));
    return () => {
      cancelled = true;
    };
  }, [kind]);

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

  const start = async (via: ConnectorVia, account: string | null = null) => {
    setBusy(via);
    setError(null);
    try {
      const f = await api.connectorStart(kind, {
        serverId: server?.id ?? null,
        name,
        via,
        account,
        host: via === "token" ? hostName : null,
        token: via === "token" ? token : null,
      });
      if (via === "token" && f.status === "done") setToken("");
      onServerRef.current(f.server);
      setFlow(f);
      if (f.mode === "redirect" && f.url) window.open(f.url, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
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

  const viaGh = flow?.via === "gh";
  const canStart = (!flow || flow.status === "error") && busy === null && nameOk;
  const title = server ? `Reconnect ${preset.label}` : kind === "bitbucket" ? "Add Bitbucket" : `Add ${preset.label} MCP`;
  const tokenPage = hostOk ? `https://${hostName}/plugins/servlet/access-tokens/` : null;
  const tokenReady = canStart && hostOk && token.trim() !== "";
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel connector-dialog" role="dialog" aria-modal="true" aria-labelledby="connector-title">
        <h2 id="connector-title" className="connector-title">
          <ConnectorIcon kind={kind} size={22} /> {title}
        </h2>
        {(!flow || flow.status === "error") && (
          <>
            {kind === "github" ? (
              <p className="muted">
                Adds GitHub's remote MCP server (<code>{preset.url}</code>) and logs it in with your GitHub account. Sessions with this entry
                enabled can also run <code>gh</code> and <code>git push</code> to github.com as that account. Add it more than once, under
                different names, to use several accounts.
              </p>
            ) : (
              <p className="muted">
                Logs Sessions in to a self-hosted Bitbucket (Data Center / Server): with this entry enabled, <code>git clone</code>,{" "}
                <code>git push</code> and <code>bb pr create</code> / <code>bb pr view</code> work in the box as your account, and
                repositories of that host clone privately. No MCP server is added. Add it more than once, under different names, for several
                hosts or accounts.
              </p>
            )}
            <label>
              Name (letters, digits, - and _)
              <input
                value={name}
                autoFocus={!server && kind === "github"}
                disabled={server !== null}
                pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,63}"
                placeholder={kind === "github" ? "github-work" : "bitbucket-work"}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {!nameOk && name !== "" && (
              <p className="muted">{takenNames.includes(name) && !server ? "That name is already used by another MCP server." : "Letters, digits, - and _ only."}</p>
            )}
            {kind === "bitbucket" && (
              <div
                className="connector-token"
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.target instanceof HTMLButtonElement) return;
                  e.preventDefault();
                  if (tokenReady) void start("token");
                }}
              >
                <label>
                  Bitbucket host
                  <input
                    value={host}
                    autoFocus={!server}
                    placeholder="bitbucket.example.com"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setHost(e.target.value)}
                  />
                </label>
                <p className="muted">
                  1.{" "}
                  {tokenPage ? (
                    <a href={tokenPage} target="_blank" rel="noopener noreferrer">
                      Open {hostName}'s HTTP access tokens page
                    </a>
                  ) : (
                    "Enter the host to get a link to its HTTP access tokens page"
                  )}{" "}
                  (your profile → <em>Manage account</em> → <em>HTTP access tokens</em>) and click <em>Create token</em>: permissions{" "}
                  <strong>Project → Read</strong> and <strong>Repository → Write</strong>, expiry as you like.
                  <br />
                  2. Paste it here; Sessionboxer checks it against the host and keeps it as a secret header, never shown again.
                </p>
                <label>
                  HTTP access token
                  <input
                    type="password"
                    value={token}
                    autoComplete="off"
                    placeholder="paste the token"
                    onChange={(e) => setToken(e.target.value)}
                  />
                </label>
                <div className="connector-ways">
                  <button type="button" className="primary connector-way" disabled={!tokenReady} onClick={() => void start("token")}>
                    <span>{busy === "token" ? `Checking with ${hostName}…` : server ? "Reconnect" : "Connect"}</span>
                    <span className="muted">One paste; afterwards every Session with this entry is logged in without further steps.</span>
                  </button>
                </div>
              </div>
            )}
            {kind === "github" && (
            <div className="connector-ways">
              <button type="button" className="primary connector-way" disabled={!canStart} onClick={() => void start("gh")}>
                <span>{busy === "gh" ? (gh?.available ? "Starting GitHub CLI…" : "Downloading GitHub CLI…") : "Log in with GitHub"}</span>
                <span className="muted">
                  GitHub CLI's login: works with organizations that only allow GitHub's own apps.
                  {gh && !gh.available && " GitHub CLI is downloaded to ~/.sessionboxer on first use."}
                </span>
              </button>
              {gh?.logins.map((login) => (
                <button
                  key={login}
                  type="button"
                  className="connector-way"
                  disabled={!canStart}
                  onClick={() => void start("gh-existing", login)}
                >
                  <span>{busy === "gh-existing" ? "Connecting…" : `Use my gh login as @${login}`}</span>
                  <span className="muted">Reuses the token GitHub CLI already has on this machine; no browser step.</span>
                </button>
              ))}
              <button type="button" className="connector-way" disabled={!canStart} onClick={() => void start("app")}>
                <span>{busy === "app" ? "Starting…" : "Log in with the Sessionboxer OAuth App"}</span>
                <span className="muted">Organizations that restrict third-party OAuth Apps may hide their private repositories from it.</span>
              </button>
            </div>
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
              and authorize <strong>{viaGh ? "GitHub CLI" : "Sessionboxer"}</strong> as the GitHub account you want <code>{flow.server.name}</code>{" "}
              to use:
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
            Connected <code>{flow.server.name}</code> as <strong>@{flow.server.connector?.account}</strong>
            {flow.via === "token" && flow.server.connector?.host && <span className="muted"> on {flow.server.connector.host}</span>}
            {flow.via !== "app" && flow.via !== "token" && <span className="muted"> via GitHub CLI</span>}.
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
