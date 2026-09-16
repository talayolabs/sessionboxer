import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DOCKER_MODE_LABELS,
  PROVIDERS,
  PROVIDER_LABELS,
  ROOT_BRANCH_ID,
  branchScope,
  inBranchScope,
  type Branch,
  type ModelOption,
  type Provider,
  type ProviderModels,
  type PublicMcpServerDef,
  type PublicSettings,
  type SavedMessage,
  type Session,
  type SessionEvent,
  type Snapshot,
  type WorkspaceSource,
} from "@sessionboxer/protocol";
import { api, emitFsChanged, subscribe } from "./api";
import { COMPOSER_MAX_FRAC, COMPOSER_MIN_FRAC, Composer, type ComposerMode } from "./Composer";
import { Desktop } from "./Desktop";
import { Files } from "./Files";
import { FolderDialog } from "./FolderDialog";
import { ForkDialog } from "./ForkDialog";
import { formatMb } from "./format";
import { McpDialog, McpPicker } from "./McpDialog";
import { McpServersEditor } from "./McpServersEditor";
import { ModelSelect } from "./ModelSelect";
import { ProviderIcon } from "./ProviderIcon";
import { SavedMessages } from "./SavedMessages";
import { SnapshotsDialog } from "./SnapshotsDialog";
import { TerminalPane } from "./Terminal";
import { Transcript } from "./Transcript";
import { buildTranscript } from "./transcript-model";

function translationPrompt(text: string): string {
  return `translate the following text to english, only answer with the text translated to english and nothing else: '${text}'`;
}

/** Agents tend to echo the quoting of the prompt; drop quotes the original didn't have. */
function cleanTranslation(answer: string, original: string): string {
  let out = answer.trim();
  for (const q of ["'", '"', "`"]) {
    if (out.length >= 2 && out.startsWith(q) && out.endsWith(q) && !(original.startsWith(q) && original.endsWith(q))) {
      out = out.slice(1, -1);
    }
  }
  if (!out) throw new Error("The Provider returned an empty translation");
  return out;
}

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
  const [saved, setSaved] = useState<SavedMessage[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotting, setSnapshotting] = useState<Set<string>>(() => new Set());
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [models, setModels] = useState<ProviderModels | null>(null);
  // Snapshots popup opened from the sidebar; it can be for a Session other than the selected one.
  const [snapshotsFor, setSnapshotsFor] = useState<string | null>(null);
  const [dialogSnapshots, setDialogSnapshots] = useState<Snapshot[] | null>(null);
  const snapshotsForRef = useRef<string | null>(null);
  snapshotsForRef.current = snapshotsFor;
  const [forkRequest, setForkRequest] = useState<{ sessionId: string; snapshotId: string } | null>(null);
  const clearForkRequest = useCallback(() => setForkRequest(null), []);
  const { error, setError, run } = useErrorBanner();

  const selectedId = route.view === "session" ? route.id : null;
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const snapshotsSession = sessions.find((s) => s.id === snapshotsFor) ?? null;

  const reloadSessions = useCallback(() => run(async () => setSessions(await api.sessions())), [run]);

  useEffect(() => {
    void reloadSessions();
    void run(async () => setSettings(await api.settings()));
    void run(async () => setModels(await api.models()));
  }, [reloadSessions, run]);

  // Load events and saved messages when the selected session (or its active branch) changes; the WS keeps them current.
  const activeBranchId = selected?.activeBranchId ?? ROOT_BRANCH_ID;
  useEffect(() => {
    if (!selectedId) {
      setEvents([]);
      setSaved([]);
      setSnapshots([]);
      return;
    }
    let cancelled = false;
    void run(async () => {
      const [evs, msgs, snaps] = await Promise.all([
        api.events(selectedId),
        api.savedMessages(selectedId),
        api.snapshots(selectedId),
      ]);
      if (cancelled) return;
      setEvents(evs);
      setSaved(msgs);
      setSnapshots(snaps);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, activeBranchId, run]);

  useEffect(() => {
    setDialogSnapshots(null);
    if (!snapshotsFor) return;
    let cancelled = false;
    void run(async () => {
      const snaps = await api.snapshots(snapshotsFor);
      if (!cancelled) setDialogSnapshots(snaps);
    });
    return () => {
      cancelled = true;
    };
  }, [snapshotsFor, run]);

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
            if (snapshotsForRef.current === msg.id) setSnapshotsFor(null);
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
          case "saved_messages":
            if (msg.sessionId === selectedId) setSaved(msg.messages);
            break;
          case "snapshots":
            if (msg.sessionId === selectedId) setSnapshots(msg.snapshots);
            if (msg.sessionId === snapshotsForRef.current) setDialogSnapshots(msg.snapshots);
            break;
          case "snapshotting":
            setSnapshotting((prev) => {
              const next = new Set(prev);
              if (msg.active) next.add(msg.sessionId);
              else next.delete(msg.sessionId);
              return next;
            });
            break;
          case "models":
            setModels((prev) => ({ ...(prev ?? EMPTY_MODELS), [msg.provider]: msg.models }));
            break;
        }
      },
      () => {
        // Reconnected: refetch to fill any gap.
        void reloadSessions();
        void run(async () => setModels(await api.models()));
        setSnapshotting(new Set());
        if (selectedId) {
          void run(async () => setEvents(await api.events(selectedId)));
          void run(async () => setSaved(await api.savedMessages(selectedId)));
          void run(async () => setSnapshots(await api.snapshots(selectedId)));
        }
        const dialogId = snapshotsForRef.current;
        if (dialogId) void run(async () => setDialogSnapshots(await api.snapshots(dialogId)));
      },
    );
  }, [selectedId, reloadSessions, run, setRoute]);

  const branches = selected?.branches ?? EMPTY_BRANCHES;
  const visibleSnapshots = useMemo(() => {
    const scope = branchScope(branches, activeBranchId);
    return snapshots.filter((s) => inBranchScope(scope, s.branchId, s.eventSeq));
  }, [snapshots, branches, activeBranchId]);
  const items = useMemo(() => buildTranscript(events, visibleSnapshots), [events, visibleSnapshots]);
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
              <div className="session-row">
                <span className={`dot dot-${s.status}`} title={s.status} />
                <span className="session-title">{s.title}</span>
                <span className="session-provider">
                  {s.queueRunning && <span title="Playing the saved-message queue">{"\u25b6"}</span>}
                  {s.dockerMode !== "none" && (
                    <span
                      className={s.dockerMode === "privileged" ? "warn" : undefined}
                      title={DOCKER_MODE_LABELS[s.dockerMode]}
                    >
                      {s.dockerMode === "privileged" ? "\u26a0 " : ""}docker
                    </span>
                  )}
                  <span title={PROVIDER_LABELS[s.provider]}>
                    <ProviderIcon provider={s.provider} />
                  </span>
                </span>
              </div>
              <SessionSizes
                session={s}
                snapshotting={snapshotting.has(s.id)}
                autoSnapshot={s.autoSnapshot ?? settings?.autoSnapshot ?? true}
                onClick={() => setSnapshotsFor(s.id)}
              />
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

      {snapshotsSession && (
        <SnapshotsDialog
          session={snapshotsSession}
          snapshots={dialogSnapshots}
          globalAutoSnapshot={settings?.autoSnapshot ?? true}
          snapshotting={snapshotting.has(snapshotsSession.id)}
          notice={error}
          onDismissNotice={() => setError(null)}
          onAutoSnapshotChange={(value) => void run(() => api.updateSession(snapshotsSession.id, { autoSnapshot: value }))}
          onSnapshotNow={() => void run(() => api.createSnapshot(snapshotsSession.id))}
          onFork={(s) => {
            setSnapshotsFor(null);
            setRoute({ view: "session", id: snapshotsSession.id });
            setForkRequest({ sessionId: snapshotsSession.id, snapshotId: s.id });
          }}
          onDelete={(s) => {
            if (confirm(`Delete snapshot #${s.ordinal} (${formatMb(s.sizeBytes)})?`)) {
              void run(() => api.deleteSnapshot(snapshotsSession.id, s.id));
            }
          }}
          onDeleteAll={() => {
            const n = snapshotsSession.snapshotCount;
            if (!confirm(`Delete all ${n} snapshot${n === 1 ? "" : "s"} of "${snapshotsSession.title}" (${formatMb(snapshotsSession.snapshotBytes)})?`)) return;
            void run(async () => {
              const res = await api.deleteAllSnapshots(snapshotsSession.id);
              if (res.kept > 0) {
                setError(`${res.kept} snapshot${res.kept === 1 ? " was" : "s were"} kept: a fork was started from ${res.kept === 1 ? "it" : "them"}.`);
              }
            });
          }}
          onClose={() => setSnapshotsFor(null)}
        />
      )}

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
            models={models ?? EMPTY_MODELS}
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
          <SessionView
            session={selected}
            mcpServers={settings?.mcpServers ?? []}
            models={models?.[selected.provider] ?? []}
            items={items}
            saved={saved}
            snapshots={visibleSnapshots}
            snapshotting={snapshotting.has(selected.id)}
            forkRequest={forkRequest?.sessionId === selected.id ? forkRequest.snapshotId : null}
            onForkRequestHandled={clearForkRequest}
            run={run}
            onForked={(s) => setRoute({ view: "session", id: s.id })}
          />
        )}
      </main>
    </div>
  );
}

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

const EMPTY_MODELS: ProviderModels = Object.fromEntries(PROVIDERS.map((p): [Provider, ModelOption[]] => [p, []])) as ProviderModels;
const EMPTY_BRANCHES: Branch[] = [];

/** Total storage (machine + Snapshots) under a sidebar entry; click opens the Snapshots popup with the breakdown. */
function SessionSizes({
  session,
  snapshotting,
  autoSnapshot,
  onClick,
}: {
  session: Session;
  snapshotting: boolean;
  autoSnapshot: boolean;
  onClick: () => void;
}) {
  const total = (session.diskBytes ?? 0) + session.snapshotBytes;
  return (
    <button
      type="button"
      className="session-sizes"
      title="Disk used by the machine and its snapshots. Click for the breakdown, the snapshot list and the auto-snapshot switch."
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <span>{formatMb(total)}</span>
      {snapshotting ? (
        <span className="warn">{"\u{1F4F7} snapshotting\u2026"}</span>
      ) : (
        !autoSnapshot && <span title="Automatic snapshots are off for this session">{"\u{1F4F7}\u00d7"}</span>
      )}
    </button>
  );
}

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

function loadComposerMode(): ComposerMode {
  return localStorage.getItem("sessionboxer.composerMode") === "rich" ? "rich" : "raw";
}

function loadComposerHeight(): number | null {
  const v = Number(localStorage.getItem("sessionboxer.composerHeight"));
  return v >= COMPOSER_MIN_FRAC && v <= COMPOSER_MAX_FRAC ? v : null;
}

function SessionView({
  session,
  mcpServers,
  models,
  items,
  saved,
  snapshots,
  snapshotting,
  forkRequest,
  onForkRequestHandled,
  run,
  onForked,
}: {
  session: Session;
  mcpServers: PublicMcpServerDef[];
  models: ModelOption[];
  items: ReturnType<typeof buildTranscript>;
  saved: SavedMessage[];
  snapshots: Snapshot[];
  snapshotting: boolean;
  /** Snapshot id to open the fork dialog on (from the Snapshots popup). */
  forkRequest: string | null;
  onForkRequestHandled: () => void;
  run: Runner;
  onForked: (s: Session) => void;
}) {
  const [text, setText] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [forkFrom, setForkFrom] = useState<string | null>(null);
  const [forking, setForking] = useState(false);
  const [branching, setBranching] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [pane, setPane] = useState<Pane>(loadPane);
  const [composerMode, setComposerMode] = useState<ComposerMode>(loadComposerMode);
  const [composerHeight, setComposerHeight] = useState<number | null>(loadComposerHeight);
  const [zen, setZen] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => setTitle(session.title), [session.title]);
  useEffect(() => {
    if (!forkRequest) return;
    setForkFrom(forkRequest);
    onForkRequestHandled();
  }, [forkRequest, onForkRequestHandled]);
  useEffect(() => localStorage.setItem("sessionboxer.pane", pane), [pane]);
  useEffect(() => localStorage.setItem("sessionboxer.composerMode", composerMode), [composerMode]);
  useEffect(() => {
    if (composerHeight === null) localStorage.removeItem("sessionboxer.composerHeight");
    else localStorage.setItem("sessionboxer.composerHeight", String(composerHeight));
  }, [composerHeight]);

  const canPrompt = session.status === "idle" || session.status === "running";
  const send = () => {
    const t = text.trim();
    if (!t || !canPrompt) return;
    setText("");
    void run(() => api.prompt(session.id, t));
  };
  const saveForLater = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    void run(() => api.saveMessage(session.id, t));
  };
  const translateToEnglish = useCallback(
    async (selected: string) => cleanTranslation((await api.ask(session.id, translationPrompt(selected))).text, selected),
    [session.id],
  );

  const source = session.workspaceSource;
  const sourceLabel =
    source.type === "git"
      ? `${source.url}${source.ref ? `@${source.ref}` : ""}`
      : source.type === "copy"
        ? source.path
        : source.type === "fork"
          ? `fork of ${source.label}`
          : "empty workspace";
  const isLive = session.status === "idle" || session.status === "running";
  const latestSnapshot = snapshots[snapshots.length - 1];
  const mcpActive = mcpServers.filter((s) => session.mcpEnabled.includes(s.id));
  const toggleMcp = (id: string, enabled: boolean) => {
    const next = enabled ? [...session.mcpEnabled, id] : session.mcpEnabled.filter((x) => x !== id);
    setMcpBusy(true);
    void run(() => api.updateSession(session.id, { mcpEnabled: next })).finally(() => setMcpBusy(false));
  };
  const changeModel = (model: string | null) => {
    if (!model || model === session.model) return;
    setModelBusy(true);
    void run(() => api.updateSession(session.id, { model })).finally(() => setModelBusy(false));
  };
  const showModelSelect = models.length > 0 || session.model !== null;
  const snapshotActions = {
    onFork: (s: Snapshot) => setForkFrom(s.id),
    onDelete: (s: Snapshot) => {
      if (confirm(`Delete snapshot #${s.ordinal} (${formatMb(s.sizeBytes)})?`)) void run(() => api.deleteSnapshot(session.id, s.id));
    },
  };
  const branchActions = {
    onRevert: (seq: number) => {
      setBranching(true);
      void run(() => api.revert(session.id, { seq })).finally(() => setBranching(false));
    },
    onSwitch: (branchId: string) => {
      if (branchId === session.activeBranchId) return;
      setBranching(true);
      void run(() => api.switchBranch(session.id, { branchId })).finally(() => setBranching(false));
    },
  };

  return (
    <div className="session">
      <header className="session-header">
        {editingTitle ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setEditingTitle(false);
              if (title.trim() && title !== session.title) void run(() => api.updateSession(session.id, { title: title.trim() }));
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
        {session.branches.length > 1 && (
          <label className="branch-select" title="Conversation branch (from “Revert to here”); only the active one talks to the Agent">
            {"\u2387"}
            <select
              value={session.activeBranchId}
              disabled={branching || session.status !== "idle"}
              onChange={(e) => branchActions.onSwitch(e.target.value)}
            >
              {session.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.forkedAtSeq !== null ? ` (from ${session.branches.find((p) => p.id === b.parentId)?.name ?? "?"})` : ""}
                </option>
              ))}
            </select>
            {branching && <span className="muted">switching…</span>}
          </label>
        )}
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
        <button
          disabled={!isLive || snapshotting}
          title={isLive ? "docker commit the Sandbox now (a fork point)" : "Snapshots need a running Sandbox"}
          onClick={() => void run(() => api.createSnapshot(session.id))}
        >
          {snapshotting ? "Snapshotting\u2026" : "Snapshot"}
        </button>
        <button
          disabled={!latestSnapshot}
          title={latestSnapshot ? "New Session and Sandbox from a snapshot of this one" : "Take a snapshot first"}
          onClick={() => latestSnapshot && setForkFrom(latestSnapshot.id)}
        >
          Fork…
        </button>
        <button
          className={session.mcpPending ? "pending" : ""}
          title={
            (mcpActive.length === 0 ? "MCP servers: desktop only" : `MCP servers: desktop, ${mcpActive.map((s) => s.name).join(", ")}`) +
            (session.mcpPending ? " (change applies after this turn)" : "")
          }
          onClick={() => setMcpOpen(true)}
        >
          MCP {mcpActive.length > 0 && <span className="count">{mcpActive.length}</span>}
          {session.mcpPending && <span className="warn-sign">pending</span>}
        </button>
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
      {mcpOpen && <McpDialog session={session} servers={mcpServers} busy={mcpBusy} onToggle={toggleMcp} onClose={() => setMcpOpen(false)} />}
      {forkFrom && (
        <ForkDialog
          session={session}
          snapshots={snapshots}
          saved={saved}
          initialSnapshotId={forkFrom}
          busy={forking}
          onClose={() => setForkFrom(null)}
          onSubmit={(req) => {
            setForking(true);
            void run(async () => {
              const fork = await api.forkSession(session.id, req);
              setForkFrom(null);
              onForked(fork);
            }).finally(() => setForking(false));
          }}
        />
      )}
      <div className="session-body">
        <div className="chat" ref={chatRef}>
          <Transcript
            items={items}
            actions={snapshotActions}
            branchActions={branchActions}
            branches={session.branches}
            activeBranchId={session.activeBranchId}
            canBranch={session.status === "idle"}
            branchBusy={branching}
          />
          <Composer
            value={text}
            onChange={setText}
            onSend={send}
            onSave={saveForLater}
            running={session.status === "running"}
            onStop={() => void run(() => api.cancel(session.id))}
            above={
              <SavedMessages
                messages={saved}
                queueRunning={session.queueRunning}
                canSend={canPrompt}
                onLoad={(m) => setText(m.text)}
                onSend={(m) => void run(() => api.sendSavedMessage(session.id, m.id))}
                onDelete={(m) => void run(() => api.deleteSavedMessage(session.id, m.id))}
                onMove={(m, position) => void run(() => api.updateSavedMessage(session.id, m.id, { position }))}
                onQueueToggle={(running) => void run(() => api.setQueueRunning(session.id, running))}
              />
            }
            footerStart={
              showModelSelect && (
                <ModelSelect compact models={models} value={session.model} onChange={changeModel} disabled={modelBusy} pending={session.modelPending} />
              )
            }
            disabled={!canPrompt}
            placeholder={canPrompt ? "Message the agent\u2026" : `Session is ${session.status}`}
            mode={composerMode}
            onModeChange={setComposerMode}
            zen={zen}
            onZenChange={setZen}
            heightFrac={composerHeight}
            onHeightFracChange={setComposerHeight}
            chatRef={chatRef}
            onTranslate={translateToEnglish}
          />
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
  models,
  onCreated,
  onCancel,
  run,
}: {
  settings: PublicSettings;
  models: ProviderModels;
  onCreated: (s: Session) => void;
  onCancel: () => void;
  run: Runner;
}) {
  const [provider, setProvider] = useState<Provider>("claude-code");
  const [model, setModel] = useState<string | null>(null);
  const [docker, setDocker] = useState(settings.dockerInSandbox);
  const [sourceType, setSourceType] = useState<WorkspaceSource["type"]>("empty");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [copyPath, setCopyPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mcpEnabled, setMcpEnabled] = useState<string[]>(() => settings.mcpServers.filter((s) => s.enabledByDefault).map((s) => s.id));
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
        mcpEnabled,
        ...(model ? { model } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });
      onCreated(s);
    }).finally(() => setBusy(false));
  };

  return (
    <>
    <form className="panel" onSubmit={submit}>
      <h2>New session</h2>
      <label>
        Provider
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as Provider);
            setModel(null);
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      {models[provider].length > 0 ? (
        <ModelSelect models={models[provider]} value={model} onChange={setModel} allowDefault />
      ) : (
        <p className="muted">
          Model: {PROVIDER_LABELS[provider]}&apos;s default. The list of models appears here once a {PROVIDER_LABELS[provider]} session has started; you can
          switch the model from the chat afterwards.
        </p>
      )}
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
          <div className="input-row">
            <input required value={copyPath} onChange={(e) => setCopyPath(e.target.value)} placeholder="/home/you/project" />
            <button type="button" onClick={() => setBrowsing(true)}>
              Browse…
            </button>
          </div>
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={docker} onChange={(e) => setDocker(e.target.checked)} />
        Docker inside the Sandbox ({DOCKER_MODE_LABELS[settings.dockerModeAvailable]})
      </label>
      {docker && <DockerModeNote settings={settings} enabled />}
      <McpPicker servers={settings.mcpServers} enabled={mcpEnabled} onChange={setMcpEnabled} />
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
    {browsing && (
      <FolderDialog
        initialPath={copyPath}
        onSelect={(p) => {
          setCopyPath(p);
          setBrowsing(false);
        }}
        onClose={() => setBrowsing(false)}
      />
    )}
    </>
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
  const [autoSnapshot, setAutoSnapshot] = useState(settings.autoSnapshot);
  const [snapshotKeep, setSnapshotKeep] = useState(String(settings.snapshotKeep));
  const [mcpServers, setMcpServers] = useState<PublicMcpServerDef[]>(settings.mcpServers);
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
        autoSnapshot,
        snapshotKeep: Math.max(0, Math.floor(Number(snapshotKeep) || 0)),
        mcpServers,
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
      <p className="muted">Stored in ~/.sessionboxer/config.json (mode 0600). Tokens, resources and Docker apply to Sandboxes created afterwards; snapshot settings apply immediately.</p>
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
      <label className="check">
        <input type="checkbox" checked={autoSnapshot} onChange={(e) => setAutoSnapshot(e.target.checked)} />
        Snapshot the Sandbox after every completed turn (docker commit; each snapshot is a fork point). Default for new Sessions; each Session can override it from its size line in the sidebar.
      </label>
      <label>
        Automatic snapshots to keep per Session (0 = all; manual snapshots and fork origins are always kept)
        <input type="number" min={0} step={1} value={snapshotKeep} onChange={(e) => setSnapshotKeep(e.target.value)} />
      </label>
      <p className="muted">
        A snapshot pauses the Sandbox for a few seconds and stores only what changed since the previous image, so
        turns that touch few files cost a few MB. Sizes in the sidebar are what Docker reports per layer.
      </p>
      <McpServersEditor servers={mcpServers} onChange={setMcpServers} />
      <div className="actions">
        <button type="submit">Save</button>
      </div>
    </form>
  );
}
