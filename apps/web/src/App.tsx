import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DOCKER_MODE_LABELS,
  PROVIDERS,
  PROVIDER_LABELS,
  type Provider,
  type PublicSettings,
  type Session,
  type SessionEvent,
  type WorkspaceSource,
} from "@sessionboxer/protocol";
import { api, emitFsChanged, subscribe } from "./api";
import { Desktop } from "./Desktop";
import { Files } from "./Files";
import { TerminalPane } from "./Terminal";
import { Transcript } from "./Transcript";
import { buildTranscript } from "./transcript";

type Route = { view: "session"; id: string | null } | { view: "new" } | { view: "settings" };

// Routes live in the URL hash so a reload (or a shared link) lands on the same Session.
function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "new") return { view: "new" };
  if (path === "settings") return { view: "settings" };
  const m = /^sessions\/([^/]+)$/.exec(path);
  return { view: "session", id: m?.[1] ?? null };
}

function routeToHash(route: Route): string {
  if (route.view === "new") return "#/new";
  if (route.view === "settings") return "#/settings";
  return route.id ? `#/sessions/${route.id}` : "#/";
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRouteState] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRouteState(parseRoute(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const setRoute = useCallback((r: Route) => {
    const hash = routeToHash(r);
    if (location.hash !== hash) location.hash = hash;
    else setRouteState(r);
  }, []);
  return [route, setRoute];
}

function useErrorBanner() {
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  return { error, setError, run };
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [route, setRoute] = useRoute();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const { error, setError, run } = useErrorBanner();

  const selectedId = route.view === "session" ? route.id : null;
  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  const reloadSessions = useCallback(() => run(async () => setSessions(await api.sessions())), [run]);

  useEffect(() => {
    void reloadSessions();
    void run(async () => setSettings(await api.settings()));
  }, [reloadSessions, run]);

  // Load events when the selected session changes; the WS keeps them current.
  useEffect(() => {
    if (!selectedId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    void run(async () => {
      const evs = await api.events(selectedId);
      if (!cancelled) setEvents(evs);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, run]);

  useEffect(() => {
    return subscribe(
      (msg) => {
        switch (msg.type) {
          case "session":
            setSessions((prev) => {
              const i = prev.findIndex((s) => s.id === msg.session.id);
              if (i < 0) return [msg.session, ...prev];
              const next = [...prev];
              next[i] = msg.session;
              return next;
            });
            break;
          case "session_deleted":
            setSessions((prev) => prev.filter((s) => s.id !== msg.id));
            if (selectedId === msg.id) setRoute({ view: "session", id: null });
            break;
          case "event":
            setEvents((prev) => {
              if (msg.event.sessionId !== selectedId) return prev;
              const last = prev[prev.length - 1];
              if (last && msg.event.seq <= last.seq) return prev;
              return [...prev, msg.event];
            });
            break;
          case "fs_changed":
            emitFsChanged(msg.sessionId, msg.changes);
            break;
        }
      },
      () => {
        // Reconnected: refetch to fill any gap.
        void reloadSessions();
        if (selectedId) {
          void run(async () => setEvents(await api.events(selectedId)));
        }
      },
    );
  }, [selectedId, reloadSessions, run, setRoute]);

  const items = useMemo(() => buildTranscript(events), [events]);
  const anyTokenSet = settings
    ? settings.providerSecretsSet["claude-code"].CLAUDE_CODE_OAUTH_TOKEN || settings.providerSecretsSet.devin.WINDSURF_API_KEY
    : true;
  const sysboxMissing = settings ? settings.dockerModeAvailable !== "sysbox" : false;
  const settingsWarning = !anyTokenSet ? "No Provider token configured" : sysboxMissing ? "Sysbox runtime not installed" : null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1 className="brand">
            <img src="/icon-192.png" alt="" />
            Sessionboxer
          </h1>
          <button onClick={() => setRoute({ view: "new" })}>+ New</button>
        </div>
        <ul className="session-list">
          {sessions.map((s) => (
            <li
              key={s.id}
              className={s.id === selectedId ? "active" : ""}
              onClick={() => setRoute({ view: "session", id: s.id })}
            >
              <span className={`dot dot-${s.status}`} title={s.status} />
              <span className="session-title">{s.title}</span>
              <span className="session-provider">
                {PROVIDER_LABELS[s.provider]}
                {s.dockerMode !== "none" && (
                  <span
                    className={s.dockerMode === "privileged" ? "warn" : undefined}
                    title={DOCKER_MODE_LABELS[s.dockerMode]}
                  >
                    {" \u00b7 "}
                    {s.dockerMode === "privileged" ? "\u26a0 " : ""}docker
                  </span>
                )}
              </span>
            </li>
          ))}
          {sessions.length === 0 && <li className="empty">No sessions yet</li>}
        </ul>
        <div className="sidebar-footer">
          <button onClick={() => setRoute({ view: "settings" })} title={settingsWarning ?? undefined}>
            Settings{settingsWarning && <span className="warn-sign" aria-label={settingsWarning}>⚠</span>}
          </button>
        </div>
      </aside>

      <main className="main">
        {error && (
          <div className="banner banner-error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {!anyTokenSet && route.view !== "settings" && (
          <div className="banner banner-warn" onClick={() => setRoute({ view: "settings" })}>
            No Provider token configured. Open Settings and add a Claude Code or Devin token.
          </div>
        )}
        {route.view === "new" && settings && (
          <NewSession
            settings={settings}
            onCreated={(s) => setRoute({ view: "session", id: s.id })}
            onCancel={() => setRoute({ view: "session", id: null })}
            run={run}
          />
        )}
        {route.view === "settings" && settings && (
          <SettingsView
            settings={settings}
            onSaved={(s) => {
              setSettings(s);
              setRoute({ view: "session", id: null });
            }}
            run={run}
          />
        )}
        {route.view === "session" && !selected && (
          <div className="placeholder">Select a session or create a new one.</div>
        )}
        {route.view === "session" && selected && (
          <SessionView session={selected} items={items} run={run} />
        )}
      </main>
    </div>
  );
}

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

type Pane = "desktop" | "files" | "terminal" | "hidden";
const PANES: Array<{ id: Exclude<Pane, "hidden">; label: string }> = [
  { id: "desktop", label: "Desktop" },
  { id: "files", label: "Files" },
  { id: "terminal", label: "Terminal" },
];

function loadPane(): Pane {
  const v = localStorage.getItem("sessionboxer.pane");
  return v === "desktop" || v === "files" || v === "terminal" || v === "hidden" ? v : "desktop";
}

function SessionView({ session, items, run }: { session: Session; items: ReturnType<typeof buildTranscript>; run: Runner }) {
  const [text, setText] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [pane, setPane] = useState<Pane>(loadPane);
  useEffect(() => setTitle(session.title), [session.title]);
  useEffect(() => localStorage.setItem("sessionboxer.pane", pane), [pane]);

  const canPrompt = session.status === "idle" || session.status === "running";
  const send = () => {
    const t = text.trim();
    if (!t || !canPrompt) return;
    setText("");
    void run(() => api.prompt(session.id, t));
  };

  const source = session.workspaceSource;
  const sourceLabel =
    source.type === "git" ? `${source.url}${source.ref ? `@${source.ref}` : ""}` : source.type === "copy" ? source.path : "empty workspace";

  return (
    <div className="session">
      <header className="session-header">
        {editingTitle ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setEditingTitle(false);
              if (title.trim() && title !== session.title) void run(() => api.renameSession(session.id, title.trim()));
            }}
          >
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setEditingTitle(false)} />
          </form>
        ) : (
          <h2 onDoubleClick={() => setEditingTitle(true)} title="Double-click to rename">
            {session.title}
          </h2>
        )}
        <span className={`badge badge-${session.status}`}>{session.status}</span>
        <span className="muted">{PROVIDER_LABELS[session.provider]}</span>
        {session.dockerMode !== "none" && (
          <span
            className={session.dockerMode === "privileged" ? "warn" : "muted"}
            title={session.dockerMode === "privileged" ? PRIVILEGED_WARNING : "Private Docker daemon under the Sysbox runtime"}
          >
            {DOCKER_MODE_LABELS[session.dockerMode]}
          </span>
        )}
        <span className="muted" title={sourceLabel}>
          {sourceLabel}
        </span>
        <span className="spacer" />
        <div className="segmented" role="tablist" aria-label="Side pane">
          {PANES.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={pane === p.id}
              className={pane === p.id ? "active" : ""}
              title={pane === p.id ? `Hide ${p.label.toLowerCase()}` : `Show ${p.label.toLowerCase()}`}
              onClick={() => setPane((cur) => (cur === p.id ? "hidden" : p.id))}
            >
              {p.label}
            </button>
          ))}
        </div>
        {session.status === "running" && <button onClick={() => void run(() => api.cancel(session.id))}>Cancel turn</button>}
        {(session.status === "idle" || session.status === "running" || session.status === "error") && session.containerId && (
          <button onClick={() => void run(() => api.stop(session.id))}>Stop</button>
        )}
        {(session.status === "stopped" || session.status === "error") && (
          <button onClick={() => void run(() => api.resume(session.id))}>Resume</button>
        )}
        <button
          className="danger"
          onClick={() => {
            if (confirm(`Delete "${session.title}" and its Sandbox?`)) void run(() => api.deleteSession(session.id));
          }}
        >
          Delete
        </button>
      </header>
      {session.error && <div className="banner banner-error">{session.error}</div>}
      <div className="session-body">
        <div className="chat">
          <Transcript items={items} />
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              value={text}
              placeholder={canPrompt ? "Message the agent… (Enter to send, Shift+Enter for newline)" : `Session is ${session.status}`}
              disabled={!canPrompt}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={3}
            />
            <button type="submit" disabled={!canPrompt || !text.trim()}>
              Send
            </button>
          </form>
        </div>
        {pane === "desktop" && <Desktop session={session} />}
        {pane === "files" && <Files session={session} />}
        {pane === "terminal" && <TerminalPane session={session} />}
      </div>
    </div>
  );
}

const PRIVILEGED_WARNING =
  "This Sandbox runs with --privileged: the Agent can escape to the host (root-equivalent). Install Sysbox for isolated nested Docker.";

/** Explains what "Docker inside Sandboxes" means on this host (ADR-0008). */
function DockerModeNote({ settings, enabled }: { settings: PublicSettings; enabled: boolean }) {
  if (settings.dockerModeAvailable === "sysbox") {
    return <p className="muted">Sysbox runtime detected: Docker-enabled Sandboxes get a private, unprivileged Docker daemon.</p>;
  }
  return (
    <div className="banner banner-warn" role="alert">
      <strong>Sysbox runtime not installed on this host.</strong>{" "}
      {enabled
        ? "Docker-enabled Sandboxes fall back to --privileged: the Agent can escape to your host (root-equivalent), so only run code you trust."
        : "Enabling Docker would fall back to --privileged, which lets the Agent escape to your host (root-equivalent)."}{" "}
      Install Sysbox (Linux, <code>sysbox-ce</code> .deb from github.com/nestybox/sysbox), then reload this page.
    </div>
  );
}

function NewSession({
  settings,
  onCreated,
  onCancel,
  run,
}: {
  settings: PublicSettings;
  onCreated: (s: Session) => void;
  onCancel: () => void;
  run: Runner;
}) {
  const [provider, setProvider] = useState<Provider>("claude-code");
  const [docker, setDocker] = useState(settings.dockerInSandbox);
  const [sourceType, setSourceType] = useState<WorkspaceSource["type"]>("empty");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [copyPath, setCopyPath] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const workspaceSource: WorkspaceSource =
      sourceType === "git"
        ? { type: "git", url: gitUrl.trim(), ...(gitRef.trim() ? { ref: gitRef.trim() } : {}) }
        : sourceType === "copy"
          ? { type: "copy", path: copyPath.trim() }
          : { type: "empty" };
    setBusy(true);
    void run(async () => {
      const s = await api.createSession({
        provider,
        workspaceSource,
        docker,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });
      onCreated(s);
    }).finally(() => setBusy(false));
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2>New session</h2>
      <label>
        Provider
        <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Workspace
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value as WorkspaceSource["type"])}>
          <option value="empty">Empty directory</option>
          <option value="git">Clone a git URL</option>
          <option value="copy">Copy a host directory</option>
        </select>
      </label>
      {sourceType === "git" && (
        <>
          <label>
            Repository URL
            <input required value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/org/repo.git" />
          </label>
          <label>
            Branch / tag (optional)
            <input value={gitRef} onChange={(e) => setGitRef(e.target.value)} placeholder="main" />
          </label>
        </>
      )}
      {sourceType === "copy" && (
        <label>
          Host path (absolute; git repos copy tracked + untracked-but-not-ignored files and .git)
          <input required value={copyPath} onChange={(e) => setCopyPath(e.target.value)} placeholder="/home/you/project" />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={docker} onChange={(e) => setDocker(e.target.checked)} />
        Docker inside the Sandbox ({DOCKER_MODE_LABELS[settings.dockerModeAvailable]})
      </label>
      {docker && <DockerModeNote settings={settings} enabled />}
      <label>
        Title (optional, defaults to the first prompt)
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        First prompt (optional, sent once the Sandbox is ready)
        <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div className="actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}

function SettingsView({ settings, onSaved, run }: { settings: PublicSettings; onSaved: (s: PublicSettings) => void; run: Runner }) {
  const [token, setToken] = useState("");
  const [devinToken, setDevinToken] = useState("");
  const [gitUserName, setGitUserName] = useState(settings.gitUserName);
  const [gitUserEmail, setGitUserEmail] = useState(settings.gitUserEmail);
  const [cpus, setCpus] = useState(String(settings.sandboxCpus));
  const [memory, setMemory] = useState(String(settings.sandboxMemoryGb));
  const [docker, setDocker] = useState(settings.dockerInSandbox);
  const tokenSet = settings.providerSecretsSet["claude-code"].CLAUDE_CODE_OAUTH_TOKEN;
  const devinTokenSet = settings.providerSecretsSet.devin.WINDSURF_API_KEY;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const saved = await api.updateSettings({
        gitUserName,
        gitUserEmail,
        sandboxCpus: Number(cpus),
        sandboxMemoryGb: Number(memory),
        dockerInSandbox: docker,
        providerSecrets: {
          ...(token.trim() ? { "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: token.trim() } } : {}),
          ...(devinToken.trim() ? { devin: { WINDSURF_API_KEY: devinToken.trim() } } : {}),
        },
      });
      setToken("");
      setDevinToken("");
      onSaved(saved);
    });
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Settings</h2>
      <p className="muted">Stored in ~/.sessionboxer/config.json (mode 0600). Applies to Sandboxes created afterwards.</p>
      <label>
        Claude Code OAuth token {tokenSet ? <span className="ok">(set)</span> : <span className="warn">(not set)</span>}
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={tokenSet ? "Leave empty to keep the current token" : "Run `claude setup-token` and paste the result"}
        />
      </label>
      <label>
        Devin token (WINDSURF_API_KEY) {devinTokenSet ? <span className="ok">(set)</span> : <span className="warn">(not set)</span>}
        <input
          type="password"
          autoComplete="off"
          value={devinToken}
          onChange={(e) => setDevinToken(e.target.value)}
          placeholder={
            devinTokenSet
              ? "Leave empty to keep the current token"
              : "Run `devin auth login`, then paste the token from ~/.local/share/devin/credentials.toml"
          }
        />
      </label>
      <label>
        Git user.name
        <input value={gitUserName} onChange={(e) => setGitUserName(e.target.value)} />
      </label>
      <label>
        Git user.email
        <input value={gitUserEmail} onChange={(e) => setGitUserEmail(e.target.value)} />
      </label>
      <div className="row">
        <label>
          Sandbox CPUs
          <input type="number" min={0.5} step={0.5} value={cpus} onChange={(e) => setCpus(e.target.value)} />
        </label>
        <label>
          Sandbox memory (GB)
          <input type="number" min={1} step={1} value={memory} onChange={(e) => setMemory(e.target.value)} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={docker} onChange={(e) => setDocker(e.target.checked)} />
        Docker inside Sandboxes by default (per-Session override in New session)
      </label>
      <DockerModeNote settings={settings} enabled={docker} />
      <div className="actions">
        <button type="submit">Save</button>
      </div>
    </form>
  );
}
