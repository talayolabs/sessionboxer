import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  CONNECTORS,
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_DOCKER_ADDRESS_POOL,
  DEFAULT_INSTRUCTIONS,
  DOCKER_ADDRESS_POOL_PATTERN,
  DOCKER_MODE_LABELS,
  PROVIDERS,
  PROVIDER_LABELS,
  ROOT_BRANCH_ID,
  SPEECH_MODELS,
  SPEECH_MODEL_INFO,
  branchScope,
  inBranchScope,
  resolveSessionSettings,
  sessionRoute,
  type AgentOption,
  type Branch,
  type CodexLogin,
  type E2eRun,
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
  type Schedule,
  type ScheduleRun,
  type Session,
  type SessionEvent,
  type SessionStatus,
  type Snapshot,
  type SpeechModel,
  type SpeechStatus,
} from "@sessionboxer/protocol";
import { api, subscribe } from "./api";
import { SIDEBAR_MAX_PX, SIDEBAR_MIN_PX, PANE_MAX_FRAC, PANE_MIN_FRAC, clampPane, clampSidebar, loadSize, saveSize, startSplitterDrag } from "./splitter";
import { AttachmentSession } from "./Attachments";
import { usePendingAttachments } from "./attachments-pending";
import { BranchTree, type DividerRef } from "./BranchTree";
import { COMPOSER_MAX_FRAC, COMPOSER_MIN_FRAC, Composer, type ComposerMode } from "./Composer";
import { CopyCommand } from "./CopyCommand";
import { Desktop } from "./Desktop";
import { Devices } from "./Devices";
import { E2ePane, isRunOpen } from "./E2e";
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
import { DockerIcon } from "./DockerIcon";
import { Icon, type IconName } from "./Icons";
import { ContextGauge, ContextPane } from "./Context";
import { deriveContext, type Compaction, type ContextState } from "./context-model";
import { PrPane, PrsPane } from "./PullRequests";
import { SavedMessages } from "./SavedMessages";
import { SessionSettingsDialog } from "./SessionSettingsDialog";
import { ThemeFieldset } from "./ThemePicker";
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
import { RepoChips, RepoEditor, ReposDialog, draftsError, draftsToSpecs, githubAccounts, type RepoDraft } from "./Repos";
import { Schedules } from "./Schedules";
import { SessionSourceIcon, sessionSourceLabel, sessionSourceTitle } from "./SourceIcon";
import { SyncDialog } from "./SyncDialog";
import { TerminalPane } from "./Terminal";
import { CodePane, type CodeTarget } from "./Code";
import { OpenFile } from "./FileLink";
import type { FileRef } from "./file-links";
import { Transcript } from "./Transcript";
import { buildTranscript, llmCallsOf } from "./transcript-model";

/** What a status dot means, spelled out: `idle` in particular is the Agent's turn being over. */
function statusTitle(status: SessionStatus): string {
  return status === "idle" ? "waiting for you: the Agent finished its turn" : status;
}

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

/** One line about the stored Codex login, from the metadata the Control Plane exposes (never the tokens). */
function describeCodexLogin(login: CodexLogin): string {
  const parts = [login.email ?? (login.apiKey ? "API key" : "ChatGPT account")];
  if (login.plan) parts.push(`${login.plan} plan`);
  if (login.lastRefresh) parts.push(`refreshed ${new Date(login.lastRefresh).toLocaleString()}`);
  return parts.join(", ");
}

/** Whether the secret a Session of `provider` needs to talk to its model is configured. */
function providerTokenSet(settings: PublicSettings, provider: Provider): boolean {
  switch (provider) {
    case "claude-code":
      return settings.providerSecretsSet["claude-code"].CLAUDE_CODE_OAUTH_TOKEN;
    case "devin":
      return settings.providerSecretsSet.devin.WINDSURF_API_KEY;
    case "codex":
      return settings.providerSecretsSet.codex.CODEX_AUTH_JSON;
  }
}

/** `pane` carries a deep link into a Session (`#/sessions/<id>/prs`, `…/pr/<prId>`, as notifications send them). */
type Route = { view: "session"; id: string | null; pane?: string } | { view: "new" } | { view: "settings" } | { view: "schedules" };

// Routes live in the URL hash so a reload (or a shared link) lands on the same Session.
function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "new") return { view: "new" };
  if (path === "settings") return { view: "settings" };
  if (path === "schedules") return { view: "schedules" };
  const m = /^sessions\/([^/]+)(?:\/(prs)|\/pr\/([^/]+))?$/.exec(path);
  if (!m) return { view: "session", id: null };
  const pane = m[2] ? "prs" : m[3] ? `pr:${m[3]}` : undefined;
  return pane ? { view: "session", id: m[1]!, pane } : { view: "session", id: m[1]! };
}

function routeToHash(route: Route): string {
  if (route.view === "new") return "#/new";
  if (route.view === "settings") return "#/settings";
  if (route.view === "schedules") return "#/schedules";
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
  // End-to-end verification runs of the selected Session (ADR-0044); the ref lets the WS handler see what changed.
  const [e2eRuns, setE2eRuns] = useState<E2eRun[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [scheduleRuns, setScheduleRuns] = useState<Record<string, ScheduleRun[]>>({});
  const e2eRunsRef = useRef<E2eRun[]>([]);
  e2eRunsRef.current = e2eRuns;
  const [toasts, setToasts] = useState<Array<{ id: number; sessionId: string; sessionTitle: string; lines: Array<{ prId: string; text: string }> }>>([]);
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("sessionboxer.sidebarCollapsed") === "1");
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => loadSize("sessionboxer.sidebarWidth", SIDEBAR_MIN_PX, SIDEBAR_MAX_PX));
  useEffect(() => saveSize("sessionboxer.sidebarWidth", sidebarWidth), [sidebarWidth]);
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
    setPaneRequest({ sessionId: route.id, pane: route.pane });
    setRoute({ view: "session", id: route.id });
  }, [route, setRoute]);

  const selectedId = route.view === "session" ? route.id : null;
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  // Until the new Session's runs arrive the state still holds the old Session's; never render those under the new id.
  const selectedE2eRuns = useMemo(() => (e2eRuns.every((r) => r.sessionId === selectedId) ? e2eRuns : EMPTY_E2E_RUNS), [e2eRuns, selectedId]);
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
    void run(async () => setSchedules(await api.schedules()));
  }, [reloadSessions, run]);

  const loadScheduleRuns = useCallback(
    (scheduleId: string) => {
      void run(async () => {
        const runs = await api.scheduleRuns(scheduleId);
        setScheduleRuns((prev) => ({ ...prev, [scheduleId]: runs }));
      });
    },
    [run],
  );

  // Load events and saved messages when the selected session (or its active branch) changes; the WS keeps them current.
  const activeBranchId = selected?.activeBranchId ?? ROOT_BRANCH_ID;
  useEffect(() => {
    if (!selectedId) {
      setEvents([]);
      setSaved([]);
      setSnapshots([]);
      setE2eRuns([]);
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
      setEvents(evs);
      setSaved(msgs);
      setSnapshots(snaps);
      setE2eRuns(runs);
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
          case "schedules":
            setSchedules(msg.schedules);
            break;
          case "schedule_runs":
            setScheduleRuns((prev) => ({ ...prev, [msg.scheduleId]: msg.runs }));
            break;
          case "e2e_changed": {
            if (msg.sessionId !== selectedId) break;
            const before = e2eRunsRef.current.find((r) => r.id === msg.run.id);
            const wasRunning = new Set(before?.cases.filter((c) => c.status === "running").map((c) => c.id));
            // A case just started: show the pane, but only for the Session on screen (never steal focus from another one).
            if (msg.run.cases.some((c) => c.status === "running" && !wasRunning.has(c.id))) setPaneRequest({ sessionId: msg.sessionId, pane: "e2e" });
            setE2eRuns((prev) => {
              const i = prev.findIndex((r) => r.id === msg.run.id);
              if (i < 0) return [msg.run, ...prev];
              const next = [...prev];
              next[i] = msg.run;
              return next;
            });
            break;
          }
          case "pr_activity": {
            const id = Date.now() + Math.random();
            const lines = msg.prs.map((p) => ({ prId: p.prId, text: `#${p.number} ${p.title}: ${activityLine(p)}` }));
            setToasts((prev) => [...prev.slice(-4), { id, sessionId: msg.sessionId, sessionTitle: msg.sessionTitle, lines }]);
            notifyBrowser(
              msg.sessionId,
              `${msg.sessionTitle}: pull request feedback`,
              lines.map((l) => l.text).join("\n"),
              `sessionboxer-pr-${msg.prs.map((p) => p.prId).join(",")}`,
              msg.prs.length === 1 ? msg.prs[0]!.prId : null,
              () => openPr(msg.sessionId, msg.prs.length === 1 ? msg.prs[0]!.prId : null),
            );
            break;
          }
          case "pr_merged": {
            const id = Date.now() + Math.random();
            const text = `#${msg.pr.number} ${msg.pr.title}: merged (${msg.pr.method})`;
            setToasts((prev) => [...prev.slice(-4), { id, sessionId: msg.sessionId, sessionTitle: msg.sessionTitle, lines: [{ prId: msg.pr.prId, text }] }]);
            notifyBrowser(msg.sessionId, `${msg.sessionTitle}: pull request merged`, text, `sessionboxer-pr-merged-${msg.pr.prId}`, msg.pr.prId, () => openPr(msg.sessionId, msg.pr.prId));
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
          void run(async () => setE2eRuns(await api.e2eRuns(selectedId)));
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
  const anyTokenSet = settings ? PROVIDERS.some((p) => providerTokenSet(settings, p)) : true;
  const dockerWarning =
    settings && settings.dockerInSandbox && settings.dockerModeAvailable === "privileged"
      ? "Sysbox runtime not installed: Docker-enabled Sandboxes run with --privileged, so the Agent can escape to your host"
      : null;
  const settingsWarning = !anyTokenSet ? "No Provider token configured" : dockerWarning;

  const topTitle =
    route.view === "new" ? "New session" : route.view === "settings" ? "Global settings" : route.view === "schedules" ? "Scheduled tasks" : (selected?.title ?? "Sessionboxer");
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
      <aside className="sidebar" aria-hidden={mobile && !drawerOpen}>
        <div className="sidebar-header">
          <h1 className="brand">
            <img src="/icon-192.png" alt="" />
            Sessionboxer
          </h1>
          <button onClick={() => setRoute({ view: "new" })}>+ New</button>
          {!mobile && (
            <button className="sidebar-hide" title="Hide the session list" aria-label="Hide the session list" onClick={() => collapseSidebar(true)}>
              {"\u00ab"}
            </button>
          )}
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
                <span className={`dot dot-${s.status}`} title={statusTitle(s.status)} />
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
                  {s.queueRunning && <span title="Messages queued for the Agent">{"\u25b6"}</span>}
                  {s.settings.sandbox.dockerMode === "privileged" && (
                    <span className="docker-warn" title={PRIVILEGED_WARNING}>
                      <DockerIcon label={PRIVILEGED_WARNING} />
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
                autoSnapshot={s.settings.autoSnapshot ?? settings?.autoSnapshot ?? false}
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
          <button onClick={() => setRoute({ view: "schedules" })} title={schedules.some((s) => s.lastStatus === "failed") ? "A scheduled task failed" : undefined}>
            Scheduled tasks
            {schedules.some((s) => s.lastStatus === "failed") && <span className="warn-sign" aria-label="A scheduled task failed">⚠</span>}
          </button>
          <button onClick={() => setRoute({ view: "settings" })} title={settingsWarning ?? undefined}>
            Global settings
            {!anyTokenSet ? (
              <span className="warn-sign" aria-label={settingsWarning ?? undefined}>⚠</span>
            ) : (
              dockerWarning && (
                <span className="docker-warn">
                  <DockerIcon label={dockerWarning} />
                </span>
              )
            )}
          </button>
        </div>
      </aside>

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
            {selected && route.view === "session" && <span className={`dot dot-${selected.status}`} title={statusTitle(selected.status)} />}
          </div>
        )}
        {error && (
          <div className="banner banner-error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {!anyTokenSet && route.view !== "settings" && (
          <div className="banner banner-warn" onClick={() => setRoute({ view: "settings" })}>
            No Provider token configured. Open Global settings and add a Claude Code or Devin token, or a Codex login.
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
        {route.view === "schedules" && settings && (
          <Schedules
            schedules={schedules}
            runs={scheduleRuns}
            sessions={sessions}
            settings={settings}
            models={models ?? EMPTY_MODELS}
            options={options ?? EMPTY_OPTIONS}
            onOpenSession={(id) => setRoute({ view: "session", id })}
            loadRuns={loadScheduleRuns}
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
            e2eRuns={selectedE2eRuns}
            paneRequest={paneRequest?.sessionId === selected.id ? paneRequest.pane : null}
            onPaneRequestHandled={clearPaneRequest}
            mobile={mobile}
            run={run}
            onForked={(s) => setRoute({ view: "session", id: s.id })}
            sessionSchedules={schedules.filter((s) => s.action.type === "prompt" && s.action.sessionId === selected.id).length}
            schedulesPane={
              settings && (
                <Schedules
                  schedules={schedules}
                  runs={scheduleRuns}
                  sessions={sessions}
                  settings={settings}
                  models={models ?? EMPTY_MODELS}
                  options={options ?? EMPTY_OPTIONS}
                  onOpenSession={(id) => setRoute({ view: "session", id })}
                  loadRuns={loadScheduleRuns}
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
              <button className="toast-close" title="Dismiss" onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}>
                ×
              </button>
              <div className="toast-title">{t.sessionTitle}</div>
              {t.lines.map((l) => (
                <button
                  key={l.prId}
                  className="link toast-line"
                  onClick={() => {
                    setToasts((prev) => prev.filter((x) => x.id !== t.id));
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

const EMPTY_PRS: PullRequest[] = [];
const EMPTY_E2E_RUNS: E2eRun[] = [];

function activityLine(p: PrActivity): string {
  const who = p.authors.length <= 2 ? p.authors.map((a) => `@${a}`).join(", ") : `@${p.authors[0]} and ${p.authors.length - 1} others`;
  return `${p.count} new ${p.count === 1 ? "item" : "items"} from ${who}${p.changesRequested ? " (changes requested)" : ""}`;
}

/** A browser notification when the tab is in the background and permission was given (the PRs pane asks for it). */
function notifyBrowser(sessionId: string, title: string, body: string, tag: string, prId: string | null, onClick: () => void): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return;
  // Same tag as the push the Control Plane sends for a sleeping phone, so a device that gets both sees one.
  const url = sessionRoute(sessionId, prId ? `pr:${prId}` : "prs");
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
type Pane = "chat" | "desktop" | "code" | "terminal" | "context" | "prs" | `pr:${string}` | "e2e" | "schedules" | "hidden";
/** The panes with a tab of their own in the header; Terminal and Context live in the header's "…" menu. */
const PANES: Array<{ id: "desktop" | "code"; label: string; hint: string }> = [
  { id: "desktop", label: "Desktop", hint: "The Sandbox's Linux desktop: browser, editor, whatever the Agent opens" },
  { id: "code", label: "Code", hint: "The files in the Sandbox's workspace, with the Agent's edits" },
];
const MENU_PANES: Array<{ id: "terminal" | "context"; label: string; hint: string }> = [
  { id: "terminal", label: "Terminal", hint: "A shell inside the Sandbox, alongside the one the Agent uses" },
  { id: "context", label: "Context", hint: "What the Agent is carrying in its context window, and the model calls behind it" },
];
const SCHEDULES_HINT = "Prompts sent to this Session on a schedule";

function loadPane(): Pane {
  const v = localStorage.getItem("sessionboxer.pane");
  return v === "chat" || v === "desktop" || v === "code" || v === "terminal" || v === "context" || v === "prs" || v === "e2e" || v === "schedules" || v === "hidden"
    ? v
    : "desktop";
}

type SessionMenuItem = {
  key: string;
  icon: IconName;
  label: string;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  /** A pane entry that is currently shown. */
  active?: boolean;
  pending?: boolean;
  count?: number;
  onPick: () => void;
};

/** The Session's secondary actions: a "…" dropdown on a desktop, plain buttons inside the phone's action sheet. */
function SessionMenu({ items, mobile, pending }: { items: SessionMenuItem[]; mobile: boolean; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const buttons = items.map((it) => (
    <button
      key={it.key}
      type="button"
      role={mobile ? undefined : "menuitem"}
      className={`${mobile ? "" : "menu-item session-menu-item"}${it.danger ? " danger" : ""}${it.active ? " active" : ""}${it.pending ? " pending" : ""}`}
      disabled={it.disabled}
      title={it.title}
      onClick={() => {
        setOpen(false);
        it.onPick();
      }}
    >
      <Icon name={it.icon} />
      {it.label}
      {it.count !== undefined && it.count > 0 && <span className="count">{it.count}</span>}
      {it.pending && <span className="warn-sign">pending</span>}
    </button>
  ));
  if (mobile) return <>{buttons}</>;
  return (
    <div className="menu-anchor session-menu" ref={ref}>
      <button
        type="button"
        ref={trigger}
        className={`more-menu${pending ? " pending" : ""}`}
        aria-label="More"
        title={pending ? "More (a settings change applies when the current turn ends)" : "Terminal, Context, Snapshot, Fork, Session settings, Stop, Delete"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {"\u22ef"}
      </button>
      {open && (
        <div className="menu session-menu-list" role="menu">
          {buttons}
        </div>
      )}
    </div>
  );
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
  e2eRuns,
  paneRequest,
  onPaneRequestHandled,
  mobile,
  run,
  onForked,
  schedulesPane,
  sessionSchedules,
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
  /** End-to-end verification runs of this Session, newest first (ADR-0044). */
  e2eRuns: E2eRun[];
  /** Pane to switch to (from a PR notification or a verification that started). */
  paneRequest: string | null;
  onPaneRequestHandled: () => void;
  /** Phone shell: bottom tabs pick one full-width pane, header actions live in a sheet. */
  mobile: boolean;
  run: Runner;
  onForked: (s: Session) => void;
  /** The Scheduled pane: the scheduled tasks that prompt this Session, and how many there are. */
  schedulesPane: ReactNode;
  sessionSchedules: number;
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
  const [paneFrac, setPaneFrac] = useState<number | null>(() => loadSize("sessionboxer.paneWidth", PANE_MIN_FRAC, PANE_MAX_FRAC));
  useEffect(() => saveSize("sessionboxer.paneWidth", paneFrac), [paneFrac]);
  const bodyRef = useRef<HTMLDivElement>(null);
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
  // Verification: the effective switch, whether a run is live (tab badge), and the run a transcript marker asked to see.
  const e2eEnabled = settings ? resolveSessionSettings(session.settings, settings).e2eVerify : (session.settings.e2eVerify ?? true);
  const e2eLive = e2eRuns.some(isRunOpen);
  const [e2eFocus, setE2eFocus] = useState<string | null>(null);
  const openE2e = useCallback((runId: string | null) => {
    setE2eFocus(runId);
    setPane("e2e");
  }, []);
  const setE2eVerify = (value: boolean | null) => void run(() => api.updateSession(session.id, { settings: { e2eVerify: value } }));
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
  const enqueue = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    void run(() => api.enqueueMessage(session.id, t));
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
  const canStop = (session.status === "idle" || session.status === "running" || session.status === "error") && session.containerId !== null;
  const menuItems: SessionMenuItem[] = [
    ...MENU_PANES.map(
      (p): SessionMenuItem => ({
        key: p.id,
        icon: p.id,
        label: p.label,
        title: `${p.hint}. Click to ${pane === p.id ? "hide" : "show"} it.`,
        active: pane === p.id,
        onPick: () => togglePane(p.id),
      }),
    ),
    {
      key: "snapshot",
      icon: "snapshot",
      label: snapshotting ? "Snapshotting\u2026" : "Snapshot",
      title: isLive ? "docker commit the Sandbox now (a fork point)" : "Snapshots need a running Sandbox",
      disabled: !isLive || snapshotting,
      onPick: () => void run(() => api.createSnapshot(session.id)),
    },
    {
      key: "fork",
      icon: "fork",
      label: "Fork\u2026",
      title: latestSnapshot ? "New Session and Sandbox from a snapshot of this one" : "Take a snapshot first",
      disabled: !latestSnapshot,
      onPick: () => latestSnapshot && setForkFrom(latestSnapshot.id),
    },
    ...(copiedRepos.length > 0
      ? [
          {
            key: "pull",
            icon: "pull" as const,
            label: "Pull to folder\u2026",
            title: !isLive
              ? "Pulling needs a running Sandbox (Resume first)"
              : session.status === "running"
                ? "Wait for the Agent to finish its turn"
                : `Copy the box's changes back into ${copiedRepos.map((r) => (r.source.type === "copy" ? r.source.path : "")).join(", ")} (you see what changes first)`,
            disabled: !isLive || session.status === "running",
            onPick: () => setSyncOpen(true),
          },
        ]
      : []),
    {
      key: "settings",
      icon: "settings",
      label: "Session settings",
      title: `Session settings: model, instructions, MCP servers, Inspect LLM, snapshots, Sandbox\n${settingsSummary}`,
      disabled: !settings,
      pending: settingsPending,
      count: mcpActive.length,
      onPick: () => setSettingsOpen(true),
    },
    ...(canStop
      ? [
          {
            key: "stop",
            icon: "stop" as const,
            label: "Stop",
            title: "Stop the Sandbox; the conversation stays and Resume brings it back",
            onPick: () => void run(() => api.stop(session.id)),
          },
        ]
      : []),
    {
      key: "delete",
      icon: "delete",
      label: "Delete",
      danger: true,
      onPick: () => {
        if (confirm(`Delete "${session.title}" and its Sandbox?`)) void run(() => api.deleteSession(session.id));
      },
    },
  ];
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
        <span className={`badge badge-${session.status}`} title={session.status === "idle" ? "The Agent finished its turn; it does nothing until you send it something" : undefined}>
          {session.status === "idle" ? "waiting for you" : session.status}
        </span>
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
        <span className="provider-badge" title={PROVIDER_LABELS[session.provider]}>
          <ProviderIcon provider={session.provider} size={18} />
          {mobile && <span className="muted">{PROVIDER_LABELS[session.provider]}</span>}
        </span>
        {session.settings.sandbox.dockerMode === "privileged" && (
          <span className="docker-warn" title={PRIVILEGED_WARNING}>
            <DockerIcon size={18} label={PRIVILEGED_WARNING} />
            {mobile && <span className="warn">{DOCKER_MODE_LABELS.privileged}</span>}
          </span>
        )}
        {session.repos.length > 0 ? (
          <>
            <RepoChips session={session} onClick={() => setReposOpen(true)} />
            <button className="icon-button" title="Add repository…" aria-label="Add repository…" onClick={() => setReposOpen(true)}>
              +
            </button>
          </>
        ) : (
          <>
            {session.workspaceSource.type !== "empty" && (
              <span className="muted source" title={`${sessionSourceTitle(session)}${gitIdentityNote(session)}`}>
                <SessionSourceIcon session={session} size={14} />
                {sessionSourceLabel(session)}
              </span>
            )}
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
        <div className="header-tabs">
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
              <Icon name={p.id} />
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
            <Icon name="prs" />
            PRs{prUnread > 0 && <span className="count">{prUnread}</span>}
          </button>
          <button
            role="tab"
            aria-selected={pane === "e2e"}
            className={`${pane === "e2e" ? "active" : ""}${e2eLive ? " e2e-tab-live" : ""}`}
            title={pane === "e2e" ? "Hide the verification runs" : `End-to-end verification of the Agent's turns${e2eLive ? " (running now)" : e2eEnabled ? "" : " (off for this Session)"}`}
            onClick={() => togglePane("e2e")}
          >
            <Icon name="verification" />
            Verification{e2eLive && <span className="count live">●</span>}
          </button>
          <button
            role="tab"
            aria-selected={pane === "schedules"}
            className={pane === "schedules" ? "active" : ""}
            title={pane === "schedules" ? "Hide the scheduled prompts" : `${SCHEDULES_HINT}${sessionSchedules > 0 ? ` (${sessionSchedules})` : ""}`}
            onClick={() => togglePane("schedules")}
          >
            <Icon name="scheduled" />
            Scheduled{sessionSchedules > 0 && <span className="count">{sessionSchedules}</span>}
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
        {(session.status === "stopped" || session.status === "error") && (
          <button title="Start the Sandbox again; the Agent picks up its conversation" onClick={() => void run(() => api.resume(session.id))}>
            <Icon name="resume" /> Resume
          </button>
        )}
        <SessionMenu mobile={mobile} pending={settingsPending} items={menuItems} />
        </div>
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
      {reposOpen && <ReposDialog session={session} accounts={githubAccounts(settings)} onClose={() => setReposOpen(false)} />}
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
      <div
        className={`session-body${!mobile && paneFrac !== null ? " sized" : ""}`}
        ref={bodyRef}
        style={!mobile && paneFrac !== null ? ({ "--pane-width": `${paneFrac * 100}%` } as CSSProperties) : undefined}
      >
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
            onOpenE2e={openE2e}
          />
          <Composer
            value={text}
            onChange={setText}
            onSend={send}
            onEnqueue={enqueue}
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
            placeholder={
              session.status === "idle"
                ? "The Agent is done and waiting for you\u2026"
                : session.status === "running"
                  ? "The Agent is working; a message sent now reaches it after this turn\u2026"
                  : `Session is ${session.status}`
            }
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
        {!mobile && shown !== "hidden" && (
          <div
            className="splitter splitter-v pane-splitter"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize; double-click to reset"
            onPointerDown={(e) => {
              const body = bodyRef.current;
              if (!body) return;
              startSplitterDrag(e, (x) => {
                const rect = body.getBoundingClientRect();
                setPaneFrac(clampPane((rect.right - x) / rect.width));
              });
            }}
            onDoubleClick={() => setPaneFrac(null)}
          />
        )}
        {shown === "desktop" && <Desktop session={session} />}
        {shown === "code" && <CodePane session={session} target={codeTarget} />}
        {shown === "terminal" && <TerminalPane session={session} />}
        {shown === "context" && <ContextPane session={session} context={context} llmCalls={llmCalls} onInspectLlmCall={setInspectingCall} run={run} />}
        {shown === "prs" && <PrsPane session={session} prs={prs} run={run} onOpen={(id) => setPane(`pr:${id}`)} />}
        {shown === "schedules" && <div className="schedules-pane">{schedulesPane}</div>}
        {shown === "e2e" && (
          <E2ePane session={session} runs={e2eRuns} enabled={e2eEnabled} globalEnabled={settings?.e2eVerify ?? true} focusRunId={e2eFocus} onToggle={setE2eVerify} />
        )}
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
          {(e2eRuns.length > 0 || e2eEnabled) && (
            <button role="tab" aria-selected={shown === "e2e"} className={shown === "e2e" ? "active" : ""} onClick={() => setPane("e2e")}>
              Verify{e2eLive && <span className="count live">●</span>}
            </button>
          )}
          {sessionSchedules > 0 && (
            <button role="tab" aria-selected={shown === "schedules"} className={shown === "schedules" ? "active" : ""} title={SCHEDULES_HINT} onClick={() => setPane("schedules")}>
              Scheduled<span className="count">{sessionSchedules}</span>
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
            setDraft((d) => ({ ...d, model: null, options: {}, inspectLlm: true }));
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      {!providerTokenSet(settings, provider) && (
        <p className="field-hint warn">
          No {PROVIDER_LABELS[provider]} token configured: this Session would start without one. Add it in Global settings, or pick a provider you have a token
          for.
        </p>
      )}
      <fieldset className="choice">
        <legend>Repositories (each goes to <code>/workspace/&lt;name&gt;</code> in the Sandbox; more can be added or removed later)</legend>
        <RepoEditor drafts={repos} onChange={setRepos} disabled={busy} accounts={githubAccounts(settings)} />
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

/** What is on disk for dictation (whisper-cli and models), with a download-now button and per-model removal. */
function SpeechAssets({ selected, saved }: { selected: SpeechModel; saved: SpeechModel }) {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const refresh = useCallback(() => {
    api.speechStatus().then(setStatus, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(refresh, [refresh]);
  const downloading = status !== null && (status.engine.state === "downloading" || status.model.state === "downloading");
  useEffect(() => {
    if (!downloading && !working) return;
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [downloading, working, refresh]);
  const prepare = async () => {
    setWorking(true);
    setError(null);
    try {
      setStatus(await api.speechPrepare());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      refresh();
    }
  };
  const remove = async (model: SpeechModel) => {
    setError(null);
    try {
      await api.speechDeleteModel(model);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };
  if (!status) return error ? <p className="error">{error}</p> : <p className="muted">Checking what is downloaded…</p>;
  const engine =
    status.engine.state === "ready"
      ? `whisper-cli ${status.engine.version ?? ""} ready`
      : status.engine.state === "downloading"
        ? "downloading whisper-cli…"
        : status.engine.state === "error"
          ? `whisper-cli: ${status.engine.error ?? "unavailable"}`
          : "whisper-cli not downloaded yet";
  const model =
    status.model.state === "ready"
      ? `model ${status.model.name} ready`
      : status.model.state === "downloading"
        ? `downloading model ${status.model.name}… ${status.model.total > 0 ? Math.floor((100 * status.model.received) / status.model.total) : 0}%`
        : status.model.state === "error"
          ? `model ${status.model.name}: ${status.model.error ?? "failed"}`
          : `model ${status.model.name} not downloaded yet (${formatMb(SPEECH_MODEL_INFO[status.model.name].bytes)})`;
  const ready = status.engine.state === "ready" && status.model.state === "ready";
  return (
    <div className="speech-assets">
      <p className={status.engine.state === "error" || status.model.state === "error" ? "error" : "muted"}>
        {engine} · {model}
        {status.busy > 0 && ` · transcribing ${status.busy} clip${status.busy === 1 ? "" : "s"}`}
      </p>
      <div className="row">
        {!ready && (
          <button type="button" className="small" disabled={working || downloading} onClick={() => void prepare()}>
            {downloading || working ? "Downloading…" : "Download now"}
          </button>
        )}
        {selected !== saved && <span className="muted">Save to switch to {SPEECH_MODEL_INFO[selected].label}; it is downloaded on the first dictation.</span>}
        {status.downloaded
          .filter((m) => m !== status.model.name)
          .map((m) => (
            <button key={m} type="button" className="small" title={`Delete ggml-${m}.bin from this machine`} onClick={() => void remove(m)}>
              Delete {SPEECH_MODEL_INFO[m].label} ({formatMb(SPEECH_MODEL_INFO[m].bytes)})
            </button>
          ))}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Blocks rarely used by home routers (192.168.0–1.x), office LANs (10.0–10.10.x), WSL2 (172.16–31.x) or Kubernetes (10.96/10.244). */
const DOCKER_POOL_SUGGESTIONS = [
  { block: DEFAULT_DOCKER_ADDRESS_POOL, why: "Default — top of 192.168.x: clear of home routers (192.168.0–1.x) and Docker Desktop (192.168.65.x)" },
  { block: "10.213.0.0/16", why: "High 10.x: clear of the 10.0–10.10.x office LANs and the 10.96/10.244 Kubernetes ranges" },
  { block: "100.64.0.0/16", why: "Carrier-grade NAT range, unused on most LANs; not if you run Tailscale or WARP (100.64–127.x)" },
];

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
  const [codexAuth, setCodexAuth] = useState("");
  const [forgetCodexAuth, setForgetCodexAuth] = useState(false);
  const codexFileRef = useRef<HTMLInputElement>(null);
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
  const [dockerPool, setDockerPool] = useState(settings.sandboxDockerAddressPool);
  const [autoSnapshot, setAutoSnapshot] = useState(settings.autoSnapshot);
  const [snapshotKeep, setSnapshotKeep] = useState(String(settings.snapshotKeep));
  const [e2eVerify, setE2eVerify] = useState(settings.e2eVerify);
  const [narrationMode, setNarrationMode] = useState<NarrationMode>(settings.recordingNarration.mode);
  const [speechModel, setSpeechModel] = useState<SpeechModel>(settings.speech.model);
  const [speechLanguage, setSpeechLanguage] = useState(settings.speech.language);
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
  const codexAuthSet = settings.providerSecretsSet.codex.CODEX_AUTH_JSON && !forgetCodexAuth;

  const importCodexAuth = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setCodexAuth(text);
      setForgetCodexAuth(false);
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const saved = await api.updateSettings({
        gitUserName,
        gitUserEmail,
        sandboxCpus: Number(cpus),
        sandboxMemoryGb: Number(memory),
        dockerInSandbox: docker,
        sandboxDockerAddressPool: dockerPool.trim(),
        autoSnapshot,
        snapshotKeep: Math.max(0, Math.floor(Number(snapshotKeep) || 0)),
        e2eVerify,
        recordingNarration: { mode: narrationMode, askAboveSeconds: Math.max(0, Number(narrationAskAbove) || 0) },
        speech: { model: speechModel, language: speechLanguage },
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
          ...(codexAuth.trim() ? { codex: { CODEX_AUTH_JSON: codexAuth.trim() } } : forgetCodexAuth ? { codex: { CODEX_AUTH_JSON: "" } } : {}),
        },
        claudeApi: {
          baseUrl: claudeBaseUrl.trim(),
          ...(claudeAuthToken.trim() ? { authToken: claudeAuthToken.trim() } : forgetClaudeAuthToken ? { authToken: "" } : {}),
          ...(claudeApiKey.trim() ? { apiKey: claudeApiKey.trim() } : forgetClaudeApiKey ? { apiKey: "" } : {}),
        },
      });
      setToken("");
      setDevinToken("");
      setCodexAuth("");
      setForgetCodexAuth(false);
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
      <h2>Global settings</h2>
      <p className="muted">Stored in ~/.sessionboxer/config.json (mode 0600). Tokens, resources and Docker apply to Sandboxes created afterwards; snapshot settings apply immediately.</p>
      <ThemeFieldset />
      <fieldset className="choice">
        <legend>Provider tokens</legend>
        <label>
          Claude Code OAuth token {tokenSet ? <span className="ok">(set)</span> : <span className="warn">(not set)</span>}
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={tokenSet ? "Leave empty to keep the current token" : "Paste the token"}
          />
        </label>
        <p className="field-hint">
          <span>Get one on the machine you run Claude Code on:</span>
          <CopyCommand command="claude setup-token" />
        </p>
        <label>
          Devin token (WINDSURF_API_KEY) {devinTokenSet ? <span className="ok">(set)</span> : <span className="warn">(not set)</span>}
          <input
            type="password"
            autoComplete="off"
            value={devinToken}
            onChange={(e) => setDevinToken(e.target.value)}
            placeholder={devinTokenSet ? "Leave empty to keep the current token" : "Paste the token"}
          />
        </label>
        <p className="field-hint">
          <span>Log in, then copy the token out of the credentials file it writes:</span>
          <CopyCommand command="devin auth login" />
          <CopyCommand command="cat ~/.local/share/devin/credentials.toml" />
        </p>
        <label>
          <span className="label-row">
            Codex: ChatGPT login (auth.json){" "}
            {codexAuthSet ? (
              <span className="ok">
                (set{settings.codexLogin && !forgetCodexAuth ? `: ${describeCodexLogin(settings.codexLogin)}` : ""})
              </span>
            ) : (
              <span className="warn">(not set)</span>
            )}
          </span>
          <textarea
            rows={3}
            spellCheck={false}
            autoComplete="off"
            value={codexAuth}
            onChange={(e) => {
              setCodexAuth(e.target.value);
              if (e.target.value.trim()) setForgetCodexAuth(false);
            }}
            placeholder={codexAuthSet ? "Leave empty to keep the current login" : "Paste the contents of ~/.codex/auth.json"}
          />
        </label>
        <p className="field-hint">
          <span>
            Codex runs on your ChatGPT subscription, not on API credit. Log in on your own machine, then paste or import the file it writes; the Sandbox
            keeps it in memory only and refreshed tokens flow back here.
          </span>
          <CopyCommand command="codex login" />
          <CopyCommand command="cat ~/.codex/auth.json" />
          <input
            ref={codexFileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              importCodexAuth(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button type="button" onClick={() => codexFileRef.current?.click()}>
            Import auth.json…
          </button>
          {settings.providerSecretsSet.codex.CODEX_AUTH_JSON && (
            <label className="check">
              <input
                type="checkbox"
                checked={forgetCodexAuth}
                onChange={(e) => {
                  setForgetCodexAuth(e.target.checked);
                  if (e.target.checked) setCodexAuth("");
                }}
              />{" "}
              Forget the stored login
            </label>
          )}
        </p>
      </fieldset>
      <fieldset className="choice">
        <legend>Claude API</legend>
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
      </fieldset>
      <fieldset className="choice">
        <legend>Models and instructions</legend>
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
          Given to the Agent itself rather than left in a file it may or may not read: {deliveryNote("claude-code")} {deliveryNote("devin")}{" "}
          {deliveryNote("codex")} Comes on top of
          the Sandbox briefing (desktop, recordings, handing files to you) and the project&apos;s own CLAUDE.md / AGENTS.md. Empty sends none. Applies to
          Sessions created afterwards.
        </p>
      </fieldset>
      <fieldset className="choice">
        <legend>Git identity in Sandboxes</legend>
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
      </fieldset>
      <fieldset className="choice">
        <legend>Sandbox resources</legend>
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
        <label>
          Addresses for Docker inside Sandboxes (empty = Docker's default, 172.17.0.0/16 and up)
          <input
            value={dockerPool}
            autoComplete="off"
            spellCheck={false}
            pattern={DOCKER_ADDRESS_POOL_PATTERN.source}
            title="An IPv4 block like 192.168.240.0/20 (/8 to /24)"
            onChange={(e) => setDockerPool(e.target.value)}
            placeholder="Docker's default (172.17.0.0/16 and up)"
            list="docker-pool-suggestions"
          />
          <datalist id="docker-pool-suggestions">
            {DOCKER_POOL_SUGGESTIONS.map((s) => (
              <option key={s.block} value={s.block}>
                {s.why}
              </option>
            ))}
          </datalist>
        </label>
        <p className="muted">
          The dockerd inside a Docker-enabled Sandbox carves its own networks out of this block. Hosts of your company network or VPN that fall
          in the block are unreachable from such a Sandbox (“No route to host”), so pick one nothing you need to reach lives in — the
          default <code>{DEFAULT_DOCKER_ADDRESS_POOL}</code> keeps clear of home routers, Docker Desktop, WSL2, company 10.x networks and
          Kubernetes; the field suggests alternatives. Applies to Sandboxes created afterwards.
        </p>
      </fieldset>
      <fieldset className="choice">
        <legend>Snapshots</legend>
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
      </fieldset>
      <fieldset className="choice">
        <legend>Verification</legend>
        <label className="check">
          <input type="checkbox" checked={e2eVerify} onChange={(e) => setE2eVerify(e.target.checked)} />
          Verify each turn end to end. Default for new Sessions; each Session can override it in its Session settings or from the Verification pane.
        </label>
        <p className="muted">
          After a completed turn the Agent gets a hidden follow-up: it looks at what changed, plans 2–5 test cases (up to 10 for a very large
          change), runs them on the Sandbox desktop while recording, fixes and reruns what fails (3 attempts per case), and posts the video. Turns that
          only answer are recorded as skipped. It costs a second turn of model time after each of yours.
        </p>
      </fieldset>
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
        <legend>Dictation</legend>
        <p className="muted">
          The microphone button in the composer records a clip in the browser and whisper.cpp transcribes it on this machine, offline: nothing leaves
          it (phones paired through a tunnel send the clip here). whisper-cli and the model are downloaded once, on first use or with the button below.
        </p>
        <div className="row">
          <label>
            Model
            <select value={speechModel} onChange={(e) => setSpeechModel(e.target.value as SpeechModel)}>
              {SPEECH_MODELS.map((m) => (
                <option key={m} value={m}>
                  {SPEECH_MODEL_INFO[m].label} ({formatMb(SPEECH_MODEL_INFO[m].bytes)}) — {SPEECH_MODEL_INFO[m].note}
                </option>
              ))}
            </select>
          </label>
          <label>
            Language
            <select value={speechLanguage} onChange={(e) => setSpeechLanguage(e.target.value)}>
              <option value="auto">Detect (slower, one language per clip)</option>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="pt">Portuguese</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="ca">Catalan</option>
              <option value="nl">Dutch</option>
              <option value="pl">Polish</option>
              <option value="ru">Russian</option>
              <option value="uk">Ukrainian</option>
              <option value="tr">Turkish</option>
              <option value="ja">Japanese</option>
              <option value="zh">Chinese</option>
              <option value="ko">Korean</option>
              <option value="hi">Hindi</option>
              <option value="ar">Arabic</option>
            </select>
          </label>
        </div>
        <SpeechAssets selected={speechModel} saved={settings.speech.model} />
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
