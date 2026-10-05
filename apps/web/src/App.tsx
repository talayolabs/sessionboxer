import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  ROOT_BRANCH_ID,
  branchScope,
  inBranchScope,
  type Provider,
  type PublicSettings,
  type WindowsBaseStatus,
  type MacosBaseStatus,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { SIDEBAR_MAX_PX, SIDEBAR_MIN_PX, clampSidebar, loadSize, saveSize, startSplitterDrag } from "./splitter";
import { type DividerRef } from "./BranchTree";
import { formatMb } from "./format";
import { MOBILE_QUERY, useMediaQuery, useVisualViewportHeight } from "./mobile";
import { onServiceWorkerNavigate, registerServiceWorker } from "./push";
import { GitConnectDialog } from "./GitAccounts";
import { ProviderConnectDialog } from "./ProviderConnect";
import { providerTokenSet } from "./providers";
import { NoEntrySign } from "./Usage";
import { deriveContext } from "./context-model";
import { SnapshotsDialog } from "./SnapshotsDialog";
import { Automations, promptsSession } from "./Automations";
import { PrsPage, followLabel } from "./Prs";
import { buildTranscript, llmCallsOf } from "./transcript-model";

import { EMPTY_BRANCHES, EMPTY_E2E_RUNS, EMPTY_MODELS, EMPTY_OPTIONS, EMPTY_PRS, SessionView } from "./SessionView";
import { NewSession } from "./NewSession";
import { SettingsView } from "./SettingsView";
import { Sidebar, statusTitle } from "./Sidebar";
import { useSessionFeed } from "./useSessionFeed";

export type Route =
  | { view: "session"; id: string | null; pane?: string }
  | { view: "new" }
  | { view: "settings"; section?: string }
  | { view: "automations"; id?: string }
  | { view: "prs"; id?: string };

// Routes live in the URL hash so a reload (or a shared link) lands on the same Session.
function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "new") return { view: "new" };
  const settings = /^settings(?:\/([a-z-]+))?$/.exec(path);
  if (settings) return settings[1] ? { view: "settings", section: settings[1] } : { view: "settings" };
  // `#/schedules` is where Scheduled tasks lived before Automations (ADR-0063).
  if (path === "schedules") return { view: "automations" };
  const automations = /^automations(?:\/([^/]+))?$/.exec(path);
  if (automations) return automations[1] ? { view: "automations", id: automations[1] } : { view: "automations" };
  const prs = /^prs(?:\/([^/]+))?$/.exec(path);
  if (prs) return prs[1] ? { view: "prs", id: prs[1] } : { view: "prs" };
  const m = /^sessions\/([^/]+)(?:\/(prs)|\/pr\/([^/]+))?$/.exec(path);
  if (!m) return { view: "session", id: null };
  const pane = m[2] ? "prs" : m[3] ? `pr:${m[3]}` : undefined;
  return pane ? { view: "session", id: m[1]!, pane } : { view: "session", id: m[1]! };
}

function routeToHash(route: Route): string {
  if (route.view === "new") return "#/new";
  if (route.view === "settings") return route.section ? `#/settings/${route.section}` : "#/settings";
  if (route.view === "automations") return route.id ? `#/automations/${route.id}` : "#/automations";
  if (route.view === "prs") return route.id ? `#/prs/${route.id}` : "#/prs";
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
  const [route, setRoute] = useRoute();
  // The set-up dialogs (Provider logins, GitHub), reachable from the first screen, the sidebar checklist and the banner.
  const [providerConnect, setProviderConnect] = useState<{ provider: Provider | null } | null>(null);
  const [gitConnect, setGitConnect] = useState(false);
  // Snapshots popup opened from the sidebar; it can be for a Session other than the selected one.
  const [snapshotsFor, setSnapshotsFor] = useState<string | null>(null);
  const [forkRequest, setForkRequest] = useState<{ sessionId: string; snapshotId: string } | null>(null);
  const clearForkRequest = useCallback(() => setForkRequest(null), []);
  // Turn divider the chat should scroll to (picked from a branch tree).
  const [focus, setFocus] = useState<(DividerRef & { sessionId: string }) | null>(null);
  const clearFocus = useCallback(() => setFocus(null), []);
  const { error, setError, run } = useErrorBanner();
  const selectedId = route.view === "session" ? route.id : null;
  const { feed, setFeed, reloadSessions, openPr } = useSessionFeed({ selectedId, snapshotsFor, run, setError, setRoute, setSnapshotsFor });
  const {
    sessions,
    folders,
    events,
    saved,
    snapshots,
    e2eRuns,
    dialogSnapshots,
    snapshotting,
    settings,
    windowsBase,
    macosBase,
    models,
    options,
    prs,
    prItems,
    prChecks,
    automations,
    automationRuns,
    mcpEventSubscriptions,
    prFollows,
    followedPrs,
    fprItems,
    fprChecks,
    fprEvents,
    fprRuns,
    toasts,
    paneRequest,
    terminalFocus,
    fsChange,
  } = feed;
  const clearPaneRequest = useCallback(() => setFeed("paneRequest", null), [setFeed]);
  const setSettings = useCallback((s: PublicSettings) => setFeed("settings", s), [setFeed]);
  const setWindowsBase = useCallback((s: WindowsBaseStatus) => setFeed("windowsBase", s), [setFeed]);
  const setMacosBase = useCallback((s: MacosBaseStatus) => setFeed("macosBase", s), [setFeed]);
  const loadPrItems = useCallback(
    (sessionId: string, prId: string) => run(async () => {
      const [items, checks] = await Promise.all([api.prItems(sessionId, prId), api.prChecks(sessionId, prId)]);
      setFeed("prItems", (prev) => ({ ...prev, [prId]: items }));
      setFeed("prChecks", (prev) => ({ ...prev, [prId]: checks }));
    }),
    [run, setFeed],
  );
  const mobile = useMediaQuery(MOBILE_QUERY);
  useVisualViewportHeight();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("sessionboxer.sidebarCollapsed") === "1");
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => loadSize("sessionboxer.sidebarWidth", SIDEBAR_MIN_PX, SIDEBAR_MAX_PX));
  useEffect(() => saveSize("sessionboxer.sidebarWidth", sidebarWidth), [sidebarWidth]);
  // NewSession stays mounted (hidden) so its form survives navigating away; a successful Start bumps this, remounting it empty.
  const [newSessionEpoch, setNewSessionEpoch] = useState(0);
  const appRef = useRef<HTMLDivElement>(null);
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
    setFeed("paneRequest", { sessionId: route.id, pane: route.pane });
    setRoute({ view: "session", id: route.id });
  }, [route, setRoute, setFeed]);

  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  // Until the new Session's runs arrive the state still holds the old Session's; never render those under the new id.
  const selectedE2eRuns = useMemo(() => (e2eRuns.every((r) => r.sessionId === selectedId) ? e2eRuns : EMPTY_E2E_RUNS), [e2eRuns, selectedId]);
  const snapshotsSession = sessions.find((s) => s.id === snapshotsFor) ?? null;

  useEffect(() => {
    void reloadSessions();
    void run(async () => setSettings(await api.settings()));
    void api.windowsBase().then(setWindowsBase, () => undefined);
    void api.macosBase().then(setMacosBase, () => undefined);
    void run(async () => setFeed("models", await api.models()));
    void run(async () => setFeed("options", await api.options()));
    void run(async () => setFeed("automations", await api.automations()));
    void run(async () => setFeed("prFollows", await api.prFollows()));
    void run(async () => setFeed("mcpEventSubscriptions", await api.mcpEventSubscriptions()));
    void run(async () => setFeed("followedPrs", await api.followedPrs()));
    void run(async () => setFeed("folders", await api.folders()));
  }, [reloadSessions, run]);

  const loadFollowedPrDetail = useCallback(
    (prId: string) => {
      void run(async () => {
        const [items, checks, events, runs] = await Promise.all([api.followedPrItems(prId), api.followedPrChecks(prId), api.followedPrEvents(prId), api.followedPrRuns(prId)]);
        setFeed("fprItems", (prev) => ({ ...prev, [prId]: items }));
        setFeed("fprChecks", (prev) => ({ ...prev, [prId]: checks }));
        setFeed("fprEvents", (prev) => ({ ...prev, [prId]: events }));
        setFeed("fprRuns", (prev) => ({ ...prev, [prId]: runs }));
      });
    },
    [run],
  );

  const loadAutomationRuns = useCallback(
    (automationId: string) => {
      void run(async () => {
        const runs = await api.automationRuns(automationId);
        setFeed("automationRuns", (prev) => ({ ...prev, [automationId]: runs }));
      });
    },
    [run],
  );

  // Load events and saved messages when the selected session (or its active branch) changes; the WS keeps them current.
  const activeBranchId = selected?.activeBranchId ?? ROOT_BRANCH_ID;
  useEffect(() => {
    if (!selectedId) {
      setFeed("events", []);
      setFeed("saved", []);
      setFeed("snapshots", []);
      setFeed("e2eRuns", []);
      return;
    }
    let cancelled = false;
    void run(async () => {
      const [evs, msgs, snaps, runs] = await Promise.all([
        api.events(selectedId),
        api.savedMessages(selectedId),
        api.snapshots(selectedId),
        api.e2eRuns(selectedId),
      ]);
      if (cancelled) return;
      setFeed("events", evs);
      setFeed("saved", msgs);
      setFeed("snapshots", snaps);
      setFeed("e2eRuns", runs);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, activeBranchId, run]);

  useEffect(() => {
    setFeed("dialogSnapshots", null);
    if (!snapshotsFor) return;
    let cancelled = false;
    void run(async () => {
      const snaps = await api.snapshots(snapshotsFor);
      if (!cancelled) setFeed("dialogSnapshots", snaps);
    });
    return () => {
      cancelled = true;
    };
  }, [snapshotsFor, run]);

  const branches = selected?.branches ?? EMPTY_BRANCHES;
  const visibleSnapshots = useMemo(() => {
    const scope = branchScope(branches, activeBranchId);
    return snapshots.filter((s) => inBranchScope(scope, s.branchId, s.eventSeq));
  }, [snapshots, branches, activeBranchId]);
  const items = useMemo(() => buildTranscript(events, visibleSnapshots), [events, visibleSnapshots]);
  const context = useMemo(() => deriveContext(events), [events]);
  const llmCalls = useMemo(() => llmCallsOf(events), [events]);
  const anyTokenSet = settings ? PROVIDERS.some((p) => providerTokenSet(settings, p)) : true;

  const topTitle =
    route.view === "new" ? "New session" : route.view === "settings" ? "Global settings" : route.view === "automations" ? "Automations" : route.view === "prs" ? "Pull requests" : (selected?.title ?? "Sessionboxer");
  const collapseSidebar = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    localStorage.setItem("sessionboxer.sidebarCollapsed", collapsed ? "1" : "0");
  };

  return (
    <div
      ref={appRef}
      className={`app${mobile ? " mobile" : ""}${drawerOpen ? " drawer-open" : ""}${!mobile && sidebarCollapsed ? " sidebar-collapsed" : ""}`}
      style={!mobile && !sidebarCollapsed && sidebarWidth !== null ? ({ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties) : undefined}
    >
      {mobile && drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      {!mobile && sidebarCollapsed && (
        <button className="sidebar-show" title="Show the session list" aria-label="Show the session list" onClick={() => collapseSidebar(false)}>
          {"\u00bb"}
        </button>
      )}
      <Sidebar
        selectedId={selectedId}
        sessions={sessions}
        folders={folders}
        prs={prs}
        prFollows={prFollows}
        followedPrs={followedPrs}
        automations={automations}
        settings={settings}
        models={models}
        options={options}
        anyTokenSet={anyTokenSet}
        mobile={mobile}
        drawerOpen={drawerOpen}
        setDrawerOpen={setDrawerOpen}
        collapseSidebar={collapseSidebar}
        setRoute={setRoute}
        setFocus={setFocus}
        setSnapshotsFor={setSnapshotsFor}
        openPr={openPr}
        setProviderConnect={setProviderConnect}
        setGitConnect={setGitConnect}
        run={run}
      />

      {providerConnect && settings && (
        <ProviderConnectDialog settings={settings} initial={providerConnect.provider} onClose={() => setProviderConnect(null)} onStored={setSettings} />
      )}
      {gitConnect && settings && <GitConnectDialog servers={settings.mcpServers} initial={null} onClose={() => setGitConnect(false)} onStored={setSettings} />}
      {snapshotsSession && (
        <SnapshotsDialog
          session={snapshotsSession}
          snapshots={dialogSnapshots}
          globalAutoSnapshot={settings?.autoSnapshot ?? false}
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
      {!mobile && !sidebarCollapsed && (
        <div
          className="splitter splitter-v sidebar-splitter"
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize the session list; double-click to reset"
          onPointerDown={(e) => {
            const app = appRef.current;
            if (!app) return;
            startSplitterDrag(e, (x) => setSidebarWidth(clampSidebar(x - app.getBoundingClientRect().left)));
          }}
          onDoubleClick={() => setSidebarWidth(null)}
        />
      )}
      <main className="main">
        {mobile && (
          <div className="topbar">
            <button className="hamburger" aria-label="Open the session list" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
              {"\u2630"}
            </button>
            <span className="topbar-title">{topTitle}</span>
            {selected && route.view === "session" && (selected.usage.limit ? (
              <span className="usage-sign-small" title={`${PROVIDER_LABELS[selected.provider]} usage limit reached: ${selected.usage.limit.message}`} aria-label="usage limit reached">
                <NoEntrySign size={11} />
              </span>
            ) : (
              <span className={`dot dot-${selected.status}`} title={statusTitle(selected.status)} />
            ))}
          </div>
        )}
        {error && (
          <div className="banner banner-error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {!anyTokenSet && route.view !== "settings" && route.view !== "new" && !(route.view === "session" && !selected) && (
          <div className="banner banner-warn" onClick={() => setProviderConnect({ provider: null })}>
            No Provider connected yet: Sessions need a Claude Code, Codex, Cursor, OpenCode, Devin, pi, fx, GitHub Copilot, Mistral Vibe, Grok Build, Gemini CLI or Qwen Code login. Click to connect one.
          </div>
        )}
        {settings && (
          <NewSession
            key={newSessionEpoch}
            hidden={route.view !== "new" && (route.view !== "session" || selected !== null)}
            settings={settings}
            models={models ?? EMPTY_MODELS}
            options={options ?? EMPTY_OPTIONS}
            firstTime={sessions.length === 0}
            onCreated={(s) => {
              setNewSessionEpoch((n) => n + 1);
              setRoute({ view: "session", id: s.id });
            }}
            onConnectProvider={(provider) => setProviderConnect({ provider })}
            onConnectGit={() => setGitConnect(true)}
            run={run}
          />
        )}
        {route.view === "settings" && settings && (
          <SettingsView
            settings={settings}
            section={route.section}
            onSection={(section) => setRoute({ view: "settings", section })}
            onStored={setSettings}
            onSaved={(s) => {
              setSettings(s);
              setRoute({ view: "session", id: null });
            }}
            windowsBase={windowsBase}
            onWindowsBase={setWindowsBase}
            macosBase={macosBase}
            onMacosBase={setMacosBase}
            run={run}
          />
        )}
        {route.view === "prs" && (
          <PrsPage
            prs={followedPrs}
            follows={prFollows}
            sessions={sessions}
            automations={automations}
            items={fprItems}
            checks={fprChecks}
            events={fprEvents}
            prRuns={fprRuns}
            loadDetail={loadFollowedPrDetail}
            onOpenSession={(id) => setRoute({ view: "session", id })}
            run={run}
            focusId={route.id ?? null}
            onFocus={(id) => setRoute(id ? { view: "prs", id } : { view: "prs" })}
          />
        )}
        {route.view === "automations" && settings && (
          <Automations
            automations={automations}
            runs={automationRuns}
            sessions={sessions}
            settings={settings}
            models={models ?? EMPTY_MODELS}
            options={options ?? EMPTY_OPTIONS}
            follows={prFollows.map((f) => ({ id: f.id, label: followLabel(f) }))}
            mcpSubscriptions={mcpEventSubscriptions}
            onOpenSession={(id) => setRoute({ view: "session", id })}
            loadRuns={loadAutomationRuns}
            run={run}
            focusId={route.id ?? null}
            onFocus={(id) => setRoute(id ? { view: "automations", id } : { view: "automations" })}
          />
        )}
        {route.view === "session" && selected && (
          <SessionView
            session={selected}
            sessions={sessions}
            settings={settings}
            onSettings={setSettings}
            models={models?.[selected.provider] ?? []}
            options={
              selected.status === "idle" || selected.status === "running" ? selected.availableOptions : (options?.[selected.provider] ?? [])
            }
            allModels={models ?? EMPTY_MODELS}
            allOptions={options ?? EMPTY_OPTIONS}
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
            prChecks={prChecks}
            onLoadPrItems={loadPrItems}
            e2eRuns={selectedE2eRuns}
            paneRequest={paneRequest?.sessionId === selected.id ? paneRequest.pane : null}
            onPaneRequestHandled={clearPaneRequest}
            terminalFocus={terminalFocus?.sessionId === selected.id ? terminalFocus.focus : null}
            fsChange={fsChange}
            mobile={mobile}
            run={run}
            onForked={(s) => setRoute({ view: "session", id: s.id })}
            sessionSchedules={automations.filter((a) => promptsSession(a, selected.id)).length}
            schedulesPane={
              settings && (
                <Automations
                  automations={automations}
                  runs={automationRuns}
                  sessions={sessions}
                  settings={settings}
                  models={models ?? EMPTY_MODELS}
                  options={options ?? EMPTY_OPTIONS}
                  onOpenSession={(id) => setRoute({ view: "session", id })}
                  loadRuns={loadAutomationRuns}
                  run={run}
                  forSession={selected}
                />
              )
            }
          />
        )}
      </main>
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className="toast" role="status">
              <button className="toast-close" title="Dismiss" onClick={() => setFeed("toasts", (prev) => prev.filter((x) => x.id !== t.id))}>
                ×
              </button>
              <div className="toast-title">{t.sessionTitle}</div>
              {t.lines.map((l) => (
                <button
                  key={l.prId}
                  className="link toast-line"
                  onClick={() => {
                    setFeed("toasts", (prev) => prev.filter((x) => x.id !== t.id));
                    openPr(t.sessionId, l.prId);
                  }}
                >
                  {l.text}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
