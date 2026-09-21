import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  CONNECTORS,
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_INSTRUCTIONS,
  DOCKER_MODE_LABELS,
  PROVIDERS,
  PROVIDER_LABELS,
  ROOT_BRANCH_ID,
  branchScope,
  inBranchScope,
  sessionRoute,
  type AgentOption,
  type Branch,
  type LlmCall,
  type ModelOption,
  type NarrationMode,
  type PrActivity,
  type PrItem,
  type Provider,
  type ProviderModels,
  type ProviderOptions,
  type PublicMcpServerDef,
  type PublicSettings,
  type PullRequest,
  type SavedMessage,
  type Session,
  type SessionEvent,
  type Snapshot,
} from "@sessionboxer/protocol";
import { api, subscribe } from "./api";
import { AttachmentSession } from "./Attachments";
import { usePendingAttachments } from "./attachments-pending";
import { BranchTree, type DividerRef } from "./BranchTree";
import { COMPOSER_MAX_FRAC, COMPOSER_MIN_FRAC, Composer, type ComposerMode } from "./Composer";
import { Desktop } from "./Desktop";
import { Devices } from "./Devices";
import { ForkDialog } from "./ForkDialog";
import { formatMb } from "./format";
import { MOBILE_QUERY, useMediaQuery, useVisualViewportHeight } from "./mobile";
import { onServiceWorkerNavigate, registerServiceWorker } from "./push";
import { CompactionDialog } from "./CompactionDialog";
import { LlmCallDialog } from "./LlmCallDialog";
import { McpServersEditor } from "./McpServersEditor";
import { ModelSelect } from "./ModelSelect";
import { OptionSelects } from "./OptionSelect";
import { ProviderIcon } from "./ProviderIcon";
import { ContextGauge, ContextPane } from "./Context";
import { deriveContext, type Compaction, type ContextState } from "./context-model";
import { PrPane, PrsPane } from "./PullRequests";
import { SavedMessages } from "./SavedMessages";
import { SessionSettingsDialog } from "./SessionSettingsDialog";
import {
  DockerModeNote,
  PRIVILEGED_WARNING,
  SessionSettingsForm,
  deliveryNote,
  draftFromDefaults,
  draftToInput,
  type SessionSettingsDraft,
} from "./SessionSettingsForm";
import { SnapshotsDialog } from "./SnapshotsDialog";
import { RepoChips, RepoEditor, ReposDialog, draftsError, draftsToSpecs, type RepoDraft } from "./Repos";
import { SessionSourceIcon, sessionSourceLabel, sessionSourceTitle } from "./SourceIcon";
import { SyncDialog } from "./SyncDialog";
import { TerminalPane } from "./Terminal";
import { CodePane, type CodeTarget } from "./Code";
import { OpenFile } from "./FileLink";
import type { FileRef } from "./file-links";
import { Transcript } from "./Transcript";
import { buildTranscript, llmCallsOf } from "./transcript-model";

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

/** `pane` carries a deep link into a Session (`#/sessions/<id>/prs`, `…/pr/<prId>`, as notifications send them). */
type Route = { view: "session"; id: string | null; pane?: string } | { view: "new" } | { view: "settings" };

// Routes live in the URL hash so a reload (or a shared link) lands on the same Session.
function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "new") return { view: "new" };
  if (path === "settings") return { view: "settings" };
  const m = /^sessions\/([^/]+)(?:\/(prs)|\/pr\/([^/]+))?$/.exec(path);
  if (!m) return { view: "session", id: null };
  const pane = m[2] ? "prs" : m[3] ? `pr:${m[3]}` : undefined;
  return pane ? { view: "session", id: m[1]!, pane } : { view: "session", id: m[1]! };
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
  const [options, setOptions] = useState<ProviderOptions | null>(null);
  // Pull Requests attached per Session (all Sessions, for the sidebar badges) and the rows of the ones opened.
  const [prs, setPrs] = useState<Record<string, PullRequest[]>>({});
  const [prItems, setPrItems] = useState<Record<string, PrItem[]>>({});
  const [toasts, setToasts] = useState<Array<{ id: number; sessionId: string; sessionTitle: string; prs: PrActivity[] }>>([]);
  // Pane the selected Session should switch to (from a PR notification).
  const [paneRequest, setPaneRequest] = useState<{ sessionId: string; pane: string } | null>(null);
  const clearPaneRequest = useCallback(() => setPaneRequest(null), []);
  // Snapshots popup opened from the sidebar; it can be for a Session other than the selected one.
  const [snapshotsFor, setSnapshotsFor] = useState<string | null>(null);
  const [dialogSnapshots, setDialogSnapshots] = useState<Snapshot[] | null>(null);
  const snapshotsForRef = useRef<string | null>(null);
  snapshotsForRef.current = snapshotsFor;
  const [forkRequest, setForkRequest] = useState<{ sessionId: string; snapshotId: string } | null>(null);
  const clearForkRequest = useCallback(() => setForkRequest(null), []);
  // Sidebar entries whose branch tree is unfolded, and the Session whose branch is being switched from the tree.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [treeSwitching, setTreeSwitching] = useState<string | null>(null);
  // Turn divider the chat should scroll to (picked from a branch tree).
  const [focus, setFocus] = useState<(DividerRef & { sessionId: string }) | null>(null);
  const clearFocus = useCallback(() => setFocus(null), []);
  const { error, setError, run } = useErrorBanner();
  const mobile = useMediaQuery(MOBILE_QUERY);
  useVisualViewportHeight();
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => setDrawerOpen(false), [route]);
  // The service worker shows push notifications while the page is closed; a tap on one navigates here.
  useEffect(() => {
    void registerServiceWorker();
    return onServiceWorkerNavigate((hash) => {
      location.hash = hash;
    });
  }, []);
  // A deep link into a pane (from a notification) becomes a pane request and the plain Session route.
  useEffect(() => {
    if (route.view !== "session" || !route.id || !route.pane) return;
    setPaneRequest({ sessionId: route.id, pane: route.pane });
    setRoute({ view: "session", id: route.id });
  }, [route, setRoute]);

  const selectedId = route.view === "session" ? route.id : null;
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const snapshotsSession = sessions.find((s) => s.id === snapshotsFor) ?? null;

  const reloadSessions = useCallback(
    () =>
      run(async () => {
        const list = await api.sessions();
        setSessions(list);
        const all = await Promise.all(list.map(async (s) => [s.id, await api.prs(s.id).catch((): PullRequest[] => [])] as const));
        setPrs(Object.fromEntries(all));
      }),
    [run],
  );
  const loadPrItems = useCallback(
    (sessionId: string, prId: string) => run(async () => {
      const items = await api.prItems(sessionId, prId);
      setPrItems((prev) => ({ ...prev, [prId]: items }));
    }),
    [run],
  );
  const openPr = useCallback(
    (sessionId: string, prId: string | null) => {
      setRoute({ view: "session", id: sessionId });
      setPaneRequest({ sessionId, pane: prId ? `pr:${prId}` : "prs" });
    },
    [setRoute],
  );

  useEffect(() => {
    void reloadSessions();
    void run(async () => setSettings(await api.settings()));
    void run(async () => setModels(await api.models()));
    void run(async () => setOptions(await api.options()));
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
          case "snapshot_failed":
            setError(msg.message);
            break;
          case "models":
            setModels((prev) => ({ ...(prev ?? EMPTY_MODELS), [msg.provider]: msg.models }));
            break;
          case "options":
            setOptions((prev) => ({ ...(prev ?? EMPTY_OPTIONS), [msg.provider]: msg.options }));
            break;
          case "prs":
            setPrs((prev) => ({ ...prev, [msg.sessionId]: msg.prs }));
            break;
          case "pr_items":
            setPrItems((prev) => (prev[msg.prId] ? { ...prev, [msg.prId]: msg.items } : prev));
            break;
          case "pr_activity": {
            const id = Date.now() + Math.random();
            setToasts((prev) => [...prev.slice(-4), { id, sessionId: msg.sessionId, sessionTitle: msg.sessionTitle, prs: msg.prs }]);
            notifyBrowser(msg.sessionId, msg.sessionTitle, msg.prs, () => openPr(msg.sessionId, msg.prs.length === 1 ? msg.prs[0]!.prId : null));
            break;
          }
          case "remote":
            setSettings((prev) => (prev ? { ...prev, remote: msg.remote } : prev));
            break;
        }
      },
      () => {
        // Reconnected: refetch to fill any gap.
        void reloadSessions();
        void run(async () => setModels(await api.models()));
        void run(async () => setOptions(await api.options()));
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
  }, [selectedId, reloadSessions, run, setError, setRoute, openPr]);

  const branches = selected?.branches ?? EMPTY_BRANCHES;
  const visibleSnapshots = useMemo(() => {
    const scope = branchScope(branches, activeBranchId);
    return snapshots.filter((s) => inBranchScope(scope, s.branchId, s.eventSeq));
  }, [snapshots, branches, activeBranchId]);
  const items = useMemo(() => buildTranscript(events, visibleSnapshots), [events, visibleSnapshots]);
  const context = useMemo(() => deriveContext(events), [events]);
  const llmCalls = useMemo(() => llmCallsOf(events), [events]);
  const anyTokenSet = settings
    ? settings.providerSecretsSet["claude-code"].CLAUDE_CODE_OAUTH_TOKEN || settings.providerSecretsSet.devin.WINDSURF_API_KEY
    : true;
  const sysboxMissing = settings ? settings.dockerModeAvailable !== "sysbox" : false;
  const settingsWarning = !anyTokenSet ? "No Provider token configured" : sysboxMissing ? "Sysbox runtime not installed" : null;

  const topTitle = route.view === "new" ? "New session" : route.view === "settings" ? "Settings" : (selected?.title ?? "Sessionboxer");

  return (
    <div className={`app${mobile ? " mobile" : ""}${drawerOpen ? " drawer-open" : ""}`}>
      {mobile && drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      <aside className="sidebar" aria-hidden={mobile && !drawerOpen}>
        <div className="sidebar-header">
          <h1 className="brand">
            <img src="/icon-192.png" alt="" />
            Sessionboxer
          </h1>
          <button onClick={() => setRoute({ view: "new" })}>+ New</button>
          {mobile && (
            <button className="drawer-close" aria-label="Close the session list" onClick={() => setDrawerOpen(false)}>
              {"\u00d7"}
            </button>
          )}
        </div>
        <ul className="session-list">
          {sessions.map((s) => (
            <li
              key={s.id}
              className={s.id === selectedId ? "active" : ""}
              onClick={() => setRoute({ view: "session", id: s.id })}
            >
              <div className="session-row">
                {s.branches.length > 1 ? (
                  <button
                    type="button"
                    className="chevron"
                    aria-expanded={expanded.has(s.id)}
                    title={expanded.has(s.id) ? "Hide the conversation branches" : `Show the ${s.branches.length} conversation branches`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(s.id)) next.add(s.id);
                        return next;
                      });
                    }}
                  >
                    {expanded.has(s.id) ? "\u25BE" : "\u25B8"}
                  </button>
                ) : (
                  <span className="chevron chevron-blank" />
                )}
                <span className={`dot dot-${s.status}`} title={s.status} />
                <span className="session-title">{s.title}</span>
                <span className="session-provider">
                  {(prs[s.id] ?? []).some((p) => p.unread > 0) && (
                    <span
                      className="count"
                      title={`${(prs[s.id] ?? []).reduce((n, p) => n + p.unread, 0)} unread PR comment(s)`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openPr(s.id, null);
                      }}
                    >
                      {(prs[s.id] ?? []).reduce((n, p) => n + p.unread, 0)}
                    </span>
                  )}
                  {s.queueRunning && <span title="Playing the saved-message queue">{"\u25b6"}</span>}
                  {s.settings.sandbox.dockerMode !== "none" && (
                    <span
                      className={s.settings.sandbox.dockerMode === "privileged" ? "warn" : undefined}
                      title={DOCKER_MODE_LABELS[s.settings.sandbox.dockerMode]}
                    >
                      {s.settings.sandbox.dockerMode === "privileged" ? "\u26a0 " : ""}docker
                    </span>
                  )}
                  <SessionSourceIcon session={s} />
                  <span title={PROVIDER_LABELS[s.provider]}>
                    <ProviderIcon provider={s.provider} />
                  </span>
                </span>
              </div>
              <SessionSizes
                session={s}
                snapshotting={snapshotting.has(s.id)}
                autoSnapshot={s.settings.autoSnapshot ?? settings?.autoSnapshot ?? true}
                onClick={() => setSnapshotsFor(s.id)}
              />
              {expanded.has(s.id) && s.branches.length > 1 && (
                <BranchTree
                  session={s}
                  switching={treeSwitching === s.id}
                  onFocus={(divider) => {
                    setRoute({ view: "session", id: s.id });
                    setFocus(divider ? { sessionId: s.id, ...divider } : null);
                  }}
                  onSwitch={(b) => {
                    setRoute({ view: "session", id: s.id });
                    setFocus(null);
                    if (treeSwitching) return;
                    if (!confirm(`Switch the conversation to "${b.name}"?\n\nThe chat will show that branch and the Agent will continue from it. The current branch stays in the tree.`)) return;
                    setTreeSwitching(s.id);
                    void run(() => api.switchBranch(s.id, { branchId: b.id })).finally(() => setTreeSwitching(null));
                  }}
                />
              )}
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
          onAutoSnapshotChange={(value) => void run(() => api.updateSession(snapshotsSession.id, { settings: { autoSnapshot: value } }))}
          onSnapshotNow={() => void run(() => api.createSnapshot(snapshotsSession.id))}
          onRebuild={() => {
            if (
              !confirm(
                `Rebuild the Sandbox of "${snapshotsSession.title}"?\n\nIts filesystem is exported into a new image and a new Sandbox starts from it; the Session is unavailable meanwhile (minutes for a big Sandbox). Terminals and the Code pane reconnect afterwards.`,
              )
            )
              return;
            void run(() => api.rebuild(snapshotsSession.id));
          }}
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
        {mobile && (
          <div className="topbar">
            <button className="hamburger" aria-label="Open the session list" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
              {"\u2630"}
            </button>
            <span className="topbar-title">{topTitle}</span>
            {selected && route.view === "session" && <span className={`dot dot-${selected.status}`} title={selected.status} />}
          </div>
        )}
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
            options={options ?? EMPTY_OPTIONS}
            onCreated={(s) => setRoute({ view: "session", id: s.id })}
            onCancel={() => setRoute({ view: "session", id: null })}
            run={run}
          />
        )}
        {route.view === "settings" && settings && (
          <SettingsView
            settings={settings}
            onStored={setSettings}
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
            settings={settings}
            models={models?.[selected.provider] ?? []}
            options={
              selected.status === "idle" || selected.status === "running" ? selected.availableOptions : (options?.[selected.provider] ?? [])
            }
            items={items}
            context={context}
            llmCalls={llmCalls}
            saved={saved}
            snapshots={visibleSnapshots}
            snapshotting={snapshotting.has(selected.id)}
            forkRequest={forkRequest?.sessionId === selected.id ? forkRequest.snapshotId : null}
            onForkRequestHandled={clearForkRequest}
            focus={focus?.sessionId === selected.id ? focus : null}
            onFocused={clearFocus}
            prs={prs[selected.id] ?? EMPTY_PRS}
            prItems={prItems}
            onLoadPrItems={loadPrItems}
            paneRequest={paneRequest?.sessionId === selected.id ? paneRequest.pane : null}
            onPaneRequestHandled={clearPaneRequest}
            mobile={mobile}
            run={run}
            onForked={(s) => setRoute({ view: "session", id: s.id })}
          />
        )}
      </main>
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className="toast" role="status">
              <button className="toast-close" title="Dismiss" onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}>
                ×
              </button>
              <div className="toast-title">{t.sessionTitle}</div>
              {t.prs.map((p) => (
                <button
                  key={p.prId}
                  className="link toast-line"
                  onClick={() => {
                    setToasts((prev) => prev.filter((x) => x.id !== t.id));
                    openPr(t.sessionId, p.prId);
                  }}
                >
                  #{p.number} {p.title}: {activityLine(p)}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY_PRS: PullRequest[] = [];

function activityLine(p: PrActivity): string {
  const who = p.authors.length <= 2 ? p.authors.map((a) => `@${a}`).join(", ") : `@${p.authors[0]} and ${p.authors.length - 1} others`;
  return `${p.count} new ${p.count === 1 ? "item" : "items"} from ${who}${p.changesRequested ? " (changes requested)" : ""}`;
}

/** A browser notification when the tab is in the background and permission was given (the PRs pane asks for it). */
function notifyBrowser(sessionId: string, sessionTitle: string, prs: PrActivity[], onClick: () => void): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return;
  const body = prs.map((p) => `#${p.number}: ${activityLine(p)}`).join("\n");
  const tag = `sessionboxer-pr-${prs.map((p) => p.prId).join(",")}`;
  const title = `${sessionTitle}: pull request feedback`;
  // Same tag as the push the Control Plane sends for a sleeping phone, so a device that gets both sees one.
  const url = sessionRoute(sessionId, prs.length === 1 ? `pr:${prs[0]!.prId}` : "prs");
  void showNotification(title, { body, tag, url }).then((shown) => {
    if (shown) return;
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  });
}

/** Through the service worker when there is one (Android refuses `new Notification` on pages with a worker); false if not possible. */
async function showNotification(title: string, opts: { body: string; tag: string; url: string }): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const reg = await navigator.serviceWorker.getRegistration("/").catch(() => undefined);
  if (!reg?.active) return false;
  try {
    await reg.showNotification(title, { body: opts.body, tag: opts.tag, icon: "/icon-192.png", data: { url: opts.url } });
    return true;
  } catch {
    return false;
  }
}

type Runner = (fn: () => Promise<unknown>) => Promise<void>;

const EMPTY_MODELS: ProviderModels = Object.fromEntries(PROVIDERS.map((p): [Provider, ModelOption[]] => [p, []])) as ProviderModels;
const EMPTY_OPTIONS: ProviderOptions = Object.fromEntries(PROVIDERS.map((p): [Provider, AgentOption[]] => [p, []])) as ProviderOptions;
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

/**
 * Side pane: the fixed ones, the PR overview, or one attached PR (`pr:<id>`). On a phone only one pane
 * shows at a time and the chat is one of them (`chat`); on a desktop the chat is always there, so `chat`
 * and `hidden` mean the same.
 */
type Pane = "chat" | "desktop" | "code" | "terminal" | "context" | "prs" | `pr:${string}` | "hidden";
const PANES: Array<{ id: "desktop" | "code" | "terminal" | "context"; label: string; hint: string }> = [
  { id: "desktop", label: "Desktop", hint: "The Sandbox's Linux desktop: browser, editor, whatever the Agent opens" },
  { id: "code", label: "Code", hint: "The files in the Sandbox's workspace, with the Agent's edits" },
  { id: "terminal", label: "Terminal", hint: "A shell inside the Sandbox, alongside the one the Agent uses" },
  { id: "context", label: "Context", hint: "What the Agent is carrying in its context window, and the model calls behind it" },
];

function loadPane(): Pane {
  const v = localStorage.getItem("sessionboxer.pane");
  return v === "chat" || v === "desktop" || v === "code" || v === "terminal" || v === "context" || v === "prs" || v === "hidden" ? v : "desktop";
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
  settings,
  models,
  options,
  items,
  context,
  llmCalls,
  saved,
  snapshots,
  snapshotting,
  forkRequest,
  onForkRequestHandled,
  focus,
  onFocused,
  prs,
  prItems,
  onLoadPrItems,
  paneRequest,
  onPaneRequestHandled,
  mobile,
  run,
  onForked,
}: {
  session: Session;
  /** `null` until loaded; the Session settings dialog needs it (MCP registry, global defaults). */
  settings: PublicSettings | null;
  models: ModelOption[];
  /** Non-model options (Effort, Fast mode…): what this Session's Agent advertises, else the Provider cache. */
  options: AgentOption[];
  items: ReturnType<typeof buildTranscript>;
  context: ContextState;
  llmCalls: LlmCall[];
  saved: SavedMessage[];
  snapshots: Snapshot[];
  snapshotting: boolean;
  /** Snapshot id to open the fork dialog on (from the Snapshots popup). */
  forkRequest: string | null;
  onForkRequestHandled: () => void;
  /** Turn divider to scroll the chat to (from the sidebar branch tree). */
  focus: DividerRef | null;
  onFocused: () => void;
  prs: PullRequest[];
  prItems: Record<string, PrItem[]>;
  onLoadPrItems: (sessionId: string, prId: string) => Promise<void>;
  /** Pane to switch to (from a PR notification). */
  paneRequest: string | null;
  onPaneRequestHandled: () => void;
  /** Phone shell: bottom tabs pick one full-width pane, header actions live in a sheet. */
  mobile: boolean;
  run: Runner;
  onForked: (s: Session) => void;
}) {
  const [text, setText] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [forkFrom, setForkFrom] = useState<string | null>(null);
  const [forkWithSettings, setForkWithSettings] = useState(false);
  const [forking, setForking] = useState(false);
  const [branching, setBranching] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [inspecting, setInspecting] = useState<{ index: number; compaction: Compaction } | null>(null);
  const [inspectingCall, setInspectingCall] = useState<LlmCall | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [reposOpen, setReposOpen] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [pane, setPane] = useState<Pane>(loadPane);
  const [menuOpen, setMenuOpen] = useState(false);
  // What is on screen: on a phone the chat is a pane like the others; on a desktop it is always there.
  const shown: Pane = mobile ? (pane === "hidden" ? "chat" : pane) : pane === "chat" ? "hidden" : pane;
  const showChat = !mobile || shown === "chat";
  const togglePane = (id: Pane) => setPane((cur) => (cur === id ? (mobile ? "chat" : "hidden") : id));
  const [composerMode, setComposerMode] = useState<ComposerMode>(loadComposerMode);
  const [composerHeight, setComposerHeight] = useState<number | null>(loadComposerHeight);
  const [zen, setZen] = useState(false);
  const [codeTarget, setCodeTarget] = useState<CodeTarget | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const openFile = useCallback((ref: FileRef) => {
    setPane("code");
    setCodeTarget({ ...ref, nonce: Date.now() });
  }, []);
  useEffect(() => setTitle(session.title), [session.title]);
  useEffect(() => {
    if (!forkRequest) return;
    setForkFrom(forkRequest);
    onForkRequestHandled();
  }, [forkRequest, onForkRequestHandled]);
  useEffect(() => {
    if (!pane.startsWith("pr:")) localStorage.setItem("sessionboxer.pane", pane);
  }, [pane]);
  useEffect(() => {
    if (!paneRequest) return;
    setPane(paneRequest as Pane);
    onPaneRequestHandled();
  }, [paneRequest, onPaneRequestHandled]);
  const openPrId = pane.startsWith("pr:") ? pane.slice(3) : null;
  const openPr = openPrId ? (prs.find((p) => p.id === openPrId) ?? null) : null;
  // A PR tab whose PR was detached falls back to the overview.
  useEffect(() => {
    if (openPrId && !openPr) setPane("prs");
  }, [openPrId, openPr]);
  useEffect(() => {
    if (openPrId && openPr && !prItems[openPrId]) void onLoadPrItems(session.id, openPrId);
  }, [openPrId, openPr, prItems, onLoadPrItems, session.id]);
  const prUnread = prs.reduce((n, p) => n + p.unread, 0);
  const appendToComposer = useCallback((t: string) => setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${t}` : t)), []);
  useEffect(() => localStorage.setItem("sessionboxer.composerMode", composerMode), [composerMode]);
  useEffect(() => {
    if (composerHeight === null) localStorage.removeItem("sessionboxer.composerHeight");
    else localStorage.setItem("sessionboxer.composerHeight", String(composerHeight));
  }, [composerHeight]);

  const canPrompt = session.status === "idle" || session.status === "running";
  const attachError = useCallback((message: string) => void run(() => Promise.reject(new Error(message))), [run]);
  const attachments = usePendingAttachments(session.id, canPrompt, attachError);
  const send = () => {
    const t = text.trim();
    const files = attachments.attachments;
    if (!canPrompt || (!t && files.length === 0)) return;
    if (attachments.items.length !== files.length) return;
    setText("");
    void run(async () => {
      try {
        await api.prompt(session.id, files.length > 0 ? { text: t, attachments: files } : { text: t });
      } catch (e) {
        setText((cur) => (cur.trim() === "" ? text : cur));
        throw e;
      }
      attachments.clear();
    });
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

  const copiedRepos = session.repos.filter((r) => r.source.type === "copy");
  const isLive = session.status === "idle" || session.status === "running";
  const latestSnapshot = snapshots[snapshots.length - 1];
  const mcpActive = (settings?.mcpServers ?? []).filter((s) => session.settings.mcpEnabled.includes(s.id));
  const settingsPending = session.mcpPending || session.modelPending || session.optionsPending || session.inspectLlmPending;
  const settingsSummary = [
    mcpActive.length === 0 ? "MCP: desktop only" : `MCP: desktop, ${mcpActive.map((s) => s.name).join(", ")}`,
    session.settings.instructions.trim() === "" ? "Instructions: none" : "Instructions: set",
    ...(session.provider === "claude-code" ? [`Inspect LLM: ${session.settings.inspectLlm ? "on" : "off"}`] : []),
    ...(settingsPending ? ["A change applies when the current turn ends"] : []),
  ].join("\n");
  const changeModel = (model: string | null) => {
    if (!model || model === session.settings.model) return;
    setModelBusy(true);
    void run(() => api.updateSession(session.id, { settings: { model } })).finally(() => setModelBusy(false));
  };
  const showModelSelect = models.length > 0 || session.settings.model !== null;
  const changeOption = (id: string, value: string | null) => {
    if (!value || value === session.settings.options[id]) return;
    setModelBusy(true);
    void run(() => api.updateSession(session.id, { settings: { options: { [id]: value } } })).finally(() => setModelBusy(false));
  };
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
    <AttachmentSession.Provider value={session.id}>
    <OpenFile.Provider value={openFile}>
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
        {mobile && (
          <>
            <span className="spacer" />
            <button className="more" aria-label="Session actions" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
              {"\u22ef"}
            </button>
          </>
        )}
        {mobile && menuOpen && <div className="sheet-backdrop" onClick={() => setMenuOpen(false)} />}
        <div className={`session-actions${menuOpen ? " open" : ""}`} role={mobile ? "dialog" : undefined} aria-label={mobile ? "Session actions" : undefined}>
        {mobile && (
          <div className="sheet-header">
            <strong>{session.title}</strong>
            <span className="spacer" />
            <button aria-label="Close" onClick={() => setMenuOpen(false)}>
              {"\u00d7"}
            </button>
          </div>
        )}
        <span className="muted">{PROVIDER_LABELS[session.provider]}</span>
        {session.settings.sandbox.dockerMode !== "none" && (
          <span
            className={session.settings.sandbox.dockerMode === "privileged" ? "warn" : "muted"}
            title={session.settings.sandbox.dockerMode === "privileged" ? PRIVILEGED_WARNING : "Private Docker daemon under the Sysbox runtime"}
          >
            {DOCKER_MODE_LABELS[session.settings.sandbox.dockerMode]}
          </span>
        )}
        {session.repos.length > 0 ? (
          <RepoChips session={session} onClick={() => setReposOpen(true)} />
        ) : (
          <>
            <span className="muted source" title={`${sessionSourceTitle(session)}${gitIdentityNote(session)}`}>
              <SessionSourceIcon session={session} size={14} />
              {sessionSourceLabel(session)}
            </span>
            <button title="Clone a git URL or copy a host folder into /workspace/<name> of this Sandbox" onClick={() => setReposOpen(true)}>
              Add repository…
            </button>
          </>
        )}
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
              title={`${p.hint}. Click to ${pane === p.id ? "hide" : "show"} it.`}
              onClick={() => togglePane(p.id)}
            >
              {p.label}
            </button>
          ))}
          <button
            role="tab"
            aria-selected={pane === "prs"}
            className={pane === "prs" ? "active" : ""}
            title={pane === "prs" ? "Hide pull requests" : `Pull requests attached to this Session${prUnread > 0 ? ` (${prUnread} unread)` : ""}`}
            onClick={() => togglePane("prs")}
          >
            PRs{prUnread > 0 && <span className="count">{prUnread}</span>}
          </button>
          {prs.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={pane === `pr:${p.id}`}
              className={`${pane === `pr:${p.id}` ? "active" : ""} pr-tab pr-tab-${p.state}`}
              title={`${p.owner}/${p.repo}#${p.number} ${p.title}${p.unread > 0 ? ` (${p.unread} unread)` : ""}`}
              onClick={() => togglePane(`pr:${p.id}`)}
            >
              #{p.number}
              {p.unread > 0 && <span className="count">{p.unread}</span>}
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
        {copiedRepos.length > 0 && (
          <button
            disabled={!isLive || session.status === "running"}
            title={
              !isLive
                ? "Pulling needs a running Sandbox (Resume first)"
                : session.status === "running"
                  ? "Wait for the Agent to finish its turn"
                  : `Copy the box's changes back into ${copiedRepos.map((r) => (r.source.type === "copy" ? r.source.path : "")).join(", ")} (you see what changes first)`
            }
            onClick={() => setSyncOpen(true)}
          >
            Pull to folder…
          </button>
        )}
        <button
          className={settingsPending ? "pending" : ""}
          disabled={!settings}
          title={`Session settings: model, instructions, MCP servers, Inspect LLM, snapshots, Sandbox\n${settingsSummary}`}
          onClick={() => setSettingsOpen(true)}
        >
          {"\u2699"} Settings
          {mcpActive.length > 0 && <span className="count">{mcpActive.length}</span>}
          {settingsPending && <span className="warn-sign">pending</span>}
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
        </div>
      </header>
      {session.error && <div className="banner banner-error">{session.error}</div>}
      {settingsOpen && settings && (
        <SessionSettingsDialog
          session={session}
          settings={settings}
          models={models}
          options={options}
          busy={settingsBusy}
          onPatch={(patch) => {
            setSettingsBusy(true);
            void run(() => api.updateSession(session.id, { settings: patch })).finally(() => setSettingsBusy(false));
          }}
          onFork={
            latestSnapshot
              ? () => {
                  setSettingsOpen(false);
                  setForkWithSettings(true);
                  setForkFrom(latestSnapshot.id);
                }
              : null
          }
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {inspecting && <CompactionDialog session={session} compaction={inspecting.compaction} index={inspecting.index} onClose={() => setInspecting(null)} />}
      {inspectingCall && <LlmCallDialog session={session} call={inspectingCall} calls={llmCalls} onClose={() => setInspectingCall(null)} />}
      {syncOpen && <SyncDialog session={session} onClose={() => setSyncOpen(false)} />}
      {reposOpen && <ReposDialog session={session} onClose={() => setReposOpen(false)} />}
      {forkFrom && settings && (
        <ForkDialog
          session={session}
          settings={settings}
          models={models}
          options={options}
          snapshots={snapshots}
          saved={saved}
          initialSnapshotId={forkFrom}
          initialSettingsOpen={forkWithSettings}
          busy={forking}
          onClose={() => {
            setForkFrom(null);
            setForkWithSettings(false);
          }}
          onSubmit={(req) => {
            setForking(true);
            void run(async () => {
              const fork = await api.forkSession(session.id, req);
              setForkFrom(null);
              setForkWithSettings(false);
              onForked(fork);
            }).finally(() => setForking(false));
          }}
        />
      )}
      <div className="session-body">
        <div className="chat" ref={chatRef} hidden={!showChat}>
          <Transcript
            key={session.id}
            items={items}
            actions={snapshotActions}
            branchActions={branchActions}
            branches={session.branches}
            activeBranchId={session.activeBranchId}
            canBranch={session.status === "idle"}
            branchBusy={branching}
            focus={focus}
            onFocused={onFocused}
            onInspectCompaction={(index, compaction) => setInspecting({ index, compaction })}
            onInspectLlmCall={setInspectingCall}
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
              <>
                {showModelSelect && (
                  <ModelSelect compact models={models} value={session.settings.model} onChange={changeModel} disabled={modelBusy} pending={session.modelPending} />
                )}
                <OptionSelects compact options={options} values={session.settings.options} onChange={changeOption} disabled={modelBusy} pending={session.optionsPending} />
                <ContextGauge context={context} active={pane === "context"} onOpen={() => togglePane("context")} />
              </>
            }
            disabled={!canPrompt}
            placeholder={canPrompt ? "Message the agent\u2026" : `Session is ${session.status}`}
            mode={composerMode}
            onModeChange={setComposerMode}
            zen={zen}
            onZenChange={setZen}
            heightFrac={mobile ? null : composerHeight}
            onHeightFracChange={setComposerHeight}
            chatRef={chatRef}
            onTranslate={translateToEnglish}
            attachments={attachments}
          />
        </div>
        {shown === "desktop" && <Desktop session={session} />}
        {shown === "code" && <CodePane session={session} target={codeTarget} />}
        {shown === "terminal" && <TerminalPane session={session} />}
        {shown === "context" && <ContextPane session={session} context={context} llmCalls={llmCalls} onInspectLlmCall={setInspectingCall} run={run} />}
        {shown === "prs" && <PrsPane session={session} prs={prs} run={run} onOpen={(id) => setPane(`pr:${id}`)} />}
        {openPr && (
          <PrPane
            session={session}
            pr={openPr}
            items={prItems[openPr.id] ?? null}
            run={run}
            onPromptText={appendToComposer}
            onDetached={() => setPane("prs")}
          />
        )}
      </div>
      {mobile && (
        <nav className="bottom-tabs" role="tablist" aria-label="Pane">
          {[{ id: "chat" as const, label: "Chat", hint: "The conversation with the Agent" }, ...PANES].map((p) => (
            <button key={p.id} role="tab" aria-selected={shown === p.id} className={shown === p.id ? "active" : ""} title={p.hint} onClick={() => setPane(p.id)}>
              {p.label}
            </button>
          ))}
          {prs.length > 0 && (
            <button
              role="tab"
              aria-selected={shown === "prs" || openPr !== null}
              className={shown === "prs" || openPr ? "active" : ""}
              onClick={() => setPane("prs")}
            >
              PRs{prUnread > 0 && <span className="count">{prUnread}</span>}
            </button>
          )}
        </nav>
      )}
    </div>
    </OpenFile.Provider>
    </AttachmentSession.Provider>
  );
}

function gitIdentityNote(session: Session): string {
  const { name, email } = session.settings.sandbox.gitIdentity;
  if (!name && !email) return "";
  return `\nGit commits as ${name}${email ? ` <${email}>` : ""}`;
}

function NewSession({
  settings,
  models,
  options,
  onCreated,
  onCancel,
  run,
}: {
  settings: PublicSettings;
  models: ProviderModels;
  options: ProviderOptions;
  onCreated: (s: Session) => void;
  onCancel: () => void;
  run: Runner;
}) {
  const [provider, setProvider] = useState<Provider>("claude-code");
  const [draft, setDraft] = useState<SessionSettingsDraft>(() => draftFromDefaults(settings));
  const [repos, setRepos] = useState<RepoDraft[]>([]);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const repoSpecs = draftsToSpecs(repos);
  const repoError = draftsError(repos);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (repoError) return;
    setBusy(true);
    void run(async () => {
      const s = await api.createSession({
        provider,
        repos: repoSpecs,
        workspaceSource: { type: "empty" },
        settings: draftToInput(draft),
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
            setDraft((d) => ({ ...d, model: null, options: {}, inspectLlm: false }));
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="choice">
        <legend>Repositories (each goes to <code>/workspace/&lt;name&gt;</code> in the Sandbox; more can be added or removed later)</legend>
        <RepoEditor drafts={repos} onChange={setRepos} disabled={busy} />
        {repos.some((d) => d.type === "copy") && (
          <p className="muted">
            A host folder is copied (tracked + untracked-but-not-ignored files and <code>.git</code>); changes can be pulled back into it from the Session
            header.
          </p>
        )}
      </fieldset>
      <SessionSettingsForm
        mode="create"
        provider={provider}
        settings={settings}
        models={models[provider]}
        options={options[provider]}
        value={draft}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        disabled={busy}
      />
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
        <button type="submit" disabled={busy || repoError !== null}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
    </>
  );
}

function parseAliasList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0))];
}

function SettingsView({
  settings,
  onSaved,
  onStored,
  run,
}: {
  settings: PublicSettings;
  onSaved: (s: PublicSettings) => void;
  /** Settings the Control Plane stored on its own (connector logins), without the form being saved. */
  onStored: (s: PublicSettings) => void;
  run: Runner;
}) {
  const [token, setToken] = useState("");
  const [devinToken, setDevinToken] = useState("");
  const [claudeBaseUrl, setClaudeBaseUrl] = useState(settings.claudeApi.baseUrl);
  const [claudeAuthToken, setClaudeAuthToken] = useState("");
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [forgetClaudeAuthToken, setForgetClaudeAuthToken] = useState(false);
  const [forgetClaudeApiKey, setForgetClaudeApiKey] = useState(false);
  const claudeAuthTokenSet = settings.claudeApi.authTokenSet && !forgetClaudeAuthToken;
  const claudeApiKeySet = settings.claudeApi.apiKeySet && !forgetClaudeApiKey;
  const [gitUserName, setGitUserName] = useState(settings.gitUserName);
  const [gitUserEmail, setGitUserEmail] = useState(settings.gitUserEmail);
  const [cpus, setCpus] = useState(String(settings.sandboxCpus));
  const [memory, setMemory] = useState(String(settings.sandboxMemoryGb));
  const [docker, setDocker] = useState(settings.dockerInSandbox);
  const [autoSnapshot, setAutoSnapshot] = useState(settings.autoSnapshot);
  const [snapshotKeep, setSnapshotKeep] = useState(String(settings.snapshotKeep));
  const [narrationMode, setNarrationMode] = useState<NarrationMode>(settings.recordingNarration.mode);
  const [narrationAskAbove, setNarrationAskAbove] = useState(String(settings.recordingNarration.askAboveSeconds));
  const [mcpServers, setMcpServers] = useState<PublicMcpServerDef[]>(settings.mcpServers);
  const [claudeModels, setClaudeModels] = useState(settings.claudeModels.join(", "));
  const [instructions, setInstructions] = useState(settings.instructions);
  const [trustHostCaCerts, setTrustHostCaCerts] = useState(settings.trustHostCaCerts);
  const [extraCaCerts, setExtraCaCerts] = useState(settings.extraCaCerts);
  const [githubClientId, setGithubClientId] = useState(settings.connectors.github.clientId);
  const [githubClientSecret, setGithubClientSecret] = useState("");
  const [forgetGithubSecret, setForgetGithubSecret] = useState(false);
  const githubSecretSet = settings.connectors.github.clientSecretSet && !forgetGithubSecret;
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
        recordingNarration: { mode: narrationMode, askAboveSeconds: Math.max(0, Number(narrationAskAbove) || 0) },
        mcpServers,
        claudeModels: parseAliasList(claudeModels),
        instructions,
        trustHostCaCerts,
        extraCaCerts,
        connectors: {
          github: {
            clientId: githubClientId.trim(),
            ...(githubClientSecret.trim() ? { clientSecret: githubClientSecret.trim() } : forgetGithubSecret ? { clientSecret: "" } : {}),
          },
        },
        providerSecrets: {
          ...(token.trim() ? { "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: token.trim() } } : {}),
          ...(devinToken.trim() ? { devin: { WINDSURF_API_KEY: devinToken.trim() } } : {}),
        },
        claudeApi: {
          baseUrl: claudeBaseUrl.trim(),
          ...(claudeAuthToken.trim() ? { authToken: claudeAuthToken.trim() } : forgetClaudeAuthToken ? { authToken: "" } : {}),
          ...(claudeApiKey.trim() ? { apiKey: claudeApiKey.trim() } : forgetClaudeApiKey ? { apiKey: "" } : {}),
        },
      });
      setToken("");
      setDevinToken("");
      setClaudeAuthToken("");
      setClaudeApiKey("");
      setForgetClaudeAuthToken(false);
      setForgetClaudeApiKey(false);
      setGithubClientSecret("");
      setForgetGithubSecret(false);
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
        <span className="label-row">
          Claude API base URL (ANTHROPIC_BASE_URL)
          <span className="muted">
            current: <code>{settings.claudeApi.effectiveBaseUrl}</code>{" "}
            {settings.claudeApi.effectiveBaseUrlSource === "settings"
              ? "(set here)"
              : settings.claudeApi.effectiveBaseUrlSource === "env"
                ? "(from the Control Plane's environment)"
                : "(Anthropic's default)"}
          </span>
        </span>
        <input
          value={claudeBaseUrl}
          onChange={(e) => setClaudeBaseUrl(e.target.value)}
          placeholder={settings.claudeApi.effectiveBaseUrlSource === "env" ? settings.claudeApi.effectiveBaseUrl : ANTHROPIC_DEFAULT_BASE_URL}
          spellCheck={false}
        />
      </label>
      <p className="muted">
        Where Claude Code in each Sandbox sends its model API calls: a company Claude proxy, for instance. Empty takes <code>ANTHROPIC_BASE_URL</code>{" "}
        from the Control Plane&apos;s environment, else Anthropic. Applies to Sandboxes created afterwards. A Session with <em>Inspect LLM</em> on
        puts its own loopback proxy in front of this URL; the Sandbox trusts the extra CA certificates below for it.
      </p>
      <div className="row">
        <label>
          <span className="label-row">
            Proxy auth token (ANTHROPIC_AUTH_TOKEN) {claudeAuthTokenSet ? <span className="ok">(set)</span> : <span className="muted">(not set)</span>}
            {claudeAuthTokenSet && (
              <button type="button" className="link" onClick={() => setForgetClaudeAuthToken(true)}>
                Forget
              </button>
            )}
          </span>
          <input
            type="password"
            autoComplete="off"
            value={claudeAuthToken}
            onChange={(e) => setClaudeAuthToken(e.target.value)}
            placeholder={claudeAuthTokenSet ? "Leave empty to keep the current token" : "Only if the proxy wants its own bearer token"}
          />
        </label>
        <label>
          <span className="label-row">
            Proxy API key (ANTHROPIC_API_KEY) {claudeApiKeySet ? <span className="ok">(set)</span> : <span className="muted">(not set)</span>}
            {claudeApiKeySet && (
              <button type="button" className="link" onClick={() => setForgetClaudeApiKey(true)}>
                Forget
              </button>
            )}
          </span>
          <input
            type="password"
            autoComplete="off"
            value={claudeApiKey}
            onChange={(e) => setClaudeApiKey(e.target.value)}
            placeholder={claudeApiKeySet ? "Leave empty to keep the current key" : "Only if the proxy wants an x-api-key"}
          />
        </label>
      </div>
      <p className="muted">
        Optional credentials for that URL, given to Claude Code alongside (or instead of) the OAuth token; never shown again, stripped from snapshots.
      </p>
      <label>
        Claude model aliases (offered in the Model picker, comma-separated)
        <input value={claudeModels} onChange={(e) => setClaudeModels(e.target.value)} placeholder={DEFAULT_CLAUDE_MODELS.join(", ")} />
      </label>
      <p className="muted">
        Written to Claude&apos;s <code>availableModels</code> setting inside each Sandbox, so models your account has but the picker does not list by
        default (e.g. <code>fable</code>) become selectable; leave empty for Claude&apos;s built-in list. Aliases only, no keys. Applies to new
        Sessions and to idle running ones (their Agent restarts in place, keeping the conversation); Stop → Resume a Session if it does not pick it up.
      </p>
      <label>
        <span className="label-row">
          Instructions for the Agent (default for new Sessions; each Session can change them at creation)
          {instructions !== DEFAULT_INSTRUCTIONS && (
            <button type="button" className="link" onClick={() => setInstructions(DEFAULT_INSTRUCTIONS)}>
              Reset to the shipped default
            </button>
          )}
        </span>
        <textarea rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} spellCheck={false} />
      </label>
      <p className="muted">
        Given to the Agent itself rather than left in a file it may or may not read: {deliveryNote("claude-code")} {deliveryNote("devin")} Comes on top of
        the Sandbox briefing (desktop, recordings, handing files to you) and the project&apos;s own CLAUDE.md / AGENTS.md. Empty sends none. Applies to
        Sessions created afterwards.
      </p>
      <label>
        Git user.name
        <input value={gitUserName} onChange={(e) => setGitUserName(e.target.value)} placeholder={settings.hostGitIdentity.name} />
      </label>
      <label>
        Git user.email
        <input value={gitUserEmail} onChange={(e) => setGitUserEmail(e.target.value)} placeholder={settings.hostGitIdentity.email} />
      </label>
      <p className="muted">
        Default author/committer for commits made in Sandboxes; blank takes this machine&apos;s git config
        {settings.hostGitIdentity.name ? ` (${settings.hostGitIdentity.name}${settings.hostGitIdentity.email ? ` <${settings.hostGitIdentity.email}>` : ""})` : ""}.
        Overridable per Session when creating it.
      </p>
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
      <fieldset className="choice">
        <legend>Narrated recordings</legend>
        <p className="muted">
          The captions the Agent writes while recording the desktop can be spoken into the video (local text-to-speech in the Sandbox, no account).
          It costs processing when the recording stops: roughly a third of the spoken time plus a re-encode.
        </p>
        <div className="row">
          <label>
            Narrate recordings
            <select value={narrationMode} onChange={(e) => setNarrationMode(e.target.value as NarrationMode)}>
              <option value="ask">Ask when it takes longer than…</option>
              <option value="always">Always</option>
              <option value="never">Never</option>
            </select>
          </label>
          {narrationMode === "ask" && (
            <label>
              …seconds of extra processing (below that it is added without asking)
              <input type="number" min={0} step={1} value={narrationAskAbove} onChange={(e) => setNarrationAskAbove(e.target.value)} />
            </label>
          )}
        </div>
      </fieldset>
      <fieldset className="choice">
        <legend>TLS certificates in Sandboxes</legend>
        <p className="muted">
          Sandboxes trust the public CAs only. If this machine goes through a proxy that re-signs HTTPS (Cloudflare WARP, Zscaler, a corporate
          gateway, mitmproxy…), the Agent and MCP servers inside see “self signed certificate in certificate chain” unless its CA is trusted there
          too. Installed at Sandbox start: Stop → Resume running Sessions to apply.
        </p>
        <label className="check">
          <input type="checkbox" checked={trustHostCaCerts} onChange={(e) => setTrustHostCaCerts(e.target.checked)} />
          Trust the CA certificates this machine trusts beyond the public ones{" "}
          {settings.hostCaCerts.length === 0 ? (
            <span className="muted">(none found in the system trust store)</span>
          ) : (
            <span className="muted">
              ({settings.hostCaCerts.length} found: {settings.hostCaCerts.map((s) => s.replace(/^CN=/, "")).join(", ")})
            </span>
          )}
        </label>
        <label>
          Additional CA certificates (PEM; for CAs not installed on this machine)
          <textarea
            className="pem"
            rows={4}
            spellCheck={false}
            value={extraCaCerts}
            onChange={(e) => setExtraCaCerts(e.target.value)}
            placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
          />
        </label>
      </fieldset>
      <McpServersEditor servers={mcpServers} onChange={setMcpServers} onStored={onStored} />
      <Devices remote={settings.remote} tunnels={settings.tunnels} onStored={onStored} run={run} />
      <fieldset className="choice">
        <legend>GitHub login (OAuth App)</legend>
        <p className="muted">
          “Add GitHub” above logs in through a GitHub OAuth App. The built-in one (client id <code>{CONNECTORS.github.defaultClientId}</code>) needs
          nothing here and uses the device-code flow. To use your own app instead, register one at github.com → Settings → Developer settings with
          callback URL <code>{settings.remote.publicUrl}/api/connectors/github/callback</code> and Device Flow enabled; with its client secret set,
          the browser redirect flow is used.
        </p>
        <div className="row">
          <label>
            Client ID (empty = built-in)
            <input value={githubClientId} autoComplete="off" onChange={(e) => setGithubClientId(e.target.value)} placeholder={CONNECTORS.github.defaultClientId} />
          </label>
          <label>
            Client secret (optional) {githubSecretSet ? <span className="ok">(set)</span> : <span className="muted">(not set)</span>}
            <input
              type="password"
              autoComplete="off"
              value={githubClientSecret}
              onChange={(e) => setGithubClientSecret(e.target.value)}
              placeholder={githubSecretSet ? "Leave empty to keep the current secret" : "Only for the redirect flow"}
            />
          </label>
        </div>
        {settings.connectors.github.clientSecretSet && (
          <label className="check">
            <input type="checkbox" checked={forgetGithubSecret} onChange={(e) => setForgetGithubSecret(e.target.checked)} />
            Forget the stored client secret on Save (back to the device-code flow)
          </label>
        )}
      </fieldset>
      <div className="actions">
        <button type="submit">Save</button>
      </div>
    </form>
  );
}
