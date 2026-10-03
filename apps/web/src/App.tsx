import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ENVIRONMENT_LABELS,
  PROVIDERS,
  PROVIDER_LABELS,
  ROOT_BRANCH_ID,
  branchScope,
  inBranchScope,
  type E2eRun,
  prActivityLine,
  type PrCheckItem,
  type PrItem,
  type Provider,
  type ProviderModels,
  type ProviderOptions,
  type PublicSettings,
  type PullRequest,
  type SavedMessage,
  type Automation,
  type AutomationRun,
  type FollowedPr,
  type PrEvent,
  type PrFollow,
  type Session,
  type SessionEvent,
  type SessionFolder,
  type SessionStatus,
  type Snapshot,
  type WindowsBaseStatus,
  type MacosBaseStatus,
  VM_NO_SNAPSHOT,
} from "@sessionboxer/protocol";
import { api, subscribe } from "./api";
import { uiHintApplies } from "./AgentActions";
import { SessionFamily } from "./SessionFamily";
import { SIDEBAR_MAX_PX, SIDEBAR_MIN_PX, clampSidebar, loadSize, saveSize, startSplitterDrag } from "./splitter";
import { type FsChange } from "./HtmlArtifact";
import { BranchTree, type DividerRef } from "./BranchTree";
import { FORK_NOW, ForkDialog } from "./ForkDialog";
import { formatMb } from "./format";
import { MOBILE_QUERY, useMediaQuery, useVisualViewportHeight } from "./mobile";
import { onServiceWorkerNavigate, registerServiceWorker } from "./push";
import { GitConnectDialog } from "./GitAccounts";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderConnectDialog } from "./ProviderConnect";
import { providerTokenSet } from "./providers";
import { DockerIcon } from "./DockerIcon";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { Icon } from "./Icons";
import { NoEntrySign } from "./Usage";
import { deriveContext } from "./context-model";
import {
  PRIVILEGED_WARNING,
} from "./SessionSettingsForm";
import { SnapshotsDialog } from "./SnapshotsDialog";
import { Automations, promptsSession } from "./Automations";
import { PrsPage, followLabel } from "./Prs";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  cx,
} from "./ui";
import { SessionSourceIcon, sessionSourceTitle } from "./SourceIcon";
import { type TerminalFocus } from "./Terminal";
import { buildTranscript, llmCallsOf } from "./transcript-model";

/**
 * The transcript refetched after a reconnection, keeping what the socket delivered while the fetch
 * was in flight (events newer than the fetch's last one, for the same Session).
 */
import { EMPTY_BRANCHES, EMPTY_E2E_RUNS, EMPTY_MODELS, EMPTY_OPTIONS, EMPTY_PRS, FolderNameDialog, SessionView, notifyBrowser } from "./SessionView";
import { NewSession, RuntimeDialog, SandboxImageBanner, runtimesPresent } from "./NewSession";
import { SettingsView } from "./SettingsView";

function mergeEvents(prev: SessionEvent[], fetched: SessionEvent[]): SessionEvent[] {
  const last = fetched[fetched.length - 1];
  if (!last) return fetched;
  const tail = prev.filter((e) => e.sessionId === last.sessionId && e.seq > last.seq);
  return tail.length === 0 ? fetched : [...fetched, ...tail];
}

/** A running Sandbox can fork from "now" (a snapshot is taken with the fork); a stopped one only from a snapshot. */
const isLiveSession = (s: Session) => s.status === "idle" || s.status === "running";

/** What a status dot means, spelled out: `idle` in particular is the Agent's turn being over. */
/** The sidebar's order: pinned Sessions first, then newest first (the Control Plane lists them the same way). */
function sortSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));
}

/** Folders the user collapsed in the sidebar, remembered per browser (ADR-0074). */
function loadCollapsedFolders(): Set<string> {
  try {
    const ids = JSON.parse(localStorage.getItem("sessionboxer.foldersCollapsed") ?? "[]") as unknown;
    return new Set(Array.isArray(ids) ? (ids as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedFolders(collapsed: Set<string>): void {
  localStorage.setItem("sessionboxer.foldersCollapsed", JSON.stringify([...collapsed]));
}

/** The MIME a dragged sidebar Session announces; text/plain carries the id for the drop. */
const SESSION_DRAG_TYPE = "application/x-sessionboxer-session";

function statusTitle(status: SessionStatus): string {
  return status === "idle" ? "waiting for you: the Agent finished its turn" : status;
}

type Route =
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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [route, setRoute] = useRoute();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [saved, setSaved] = useState<SavedMessage[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotting, setSnapshotting] = useState<Set<string>>(() => new Set());
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [windowsBase, setWindowsBase] = useState<WindowsBaseStatus | null>(null);
  const [macosBase, setMacosBase] = useState<MacosBaseStatus | null>(null);
  const [models, setModels] = useState<ProviderModels | null>(null);
  const [options, setOptions] = useState<ProviderOptions | null>(null);
  // The set-up dialogs (Provider logins, GitHub), reachable from the first screen, the sidebar checklist and the banner.
  const [providerConnect, setProviderConnect] = useState<{ provider: Provider | null } | null>(null);
  const [gitConnect, setGitConnect] = useState(false);
  // Pull Requests attached per Session (all Sessions, for the sidebar badges) and the rows of the ones opened.
  const [prs, setPrs] = useState<Record<string, PullRequest[]>>({});
  const [prItems, setPrItems] = useState<Record<string, PrItem[]>>({});
  const [prChecks, setPrChecks] = useState<Record<string, PrCheckItem[]>>({});
  // End-to-end verification runs of the selected Session (ADR-0044); the ref lets the WS handler see what changed.
  const [e2eRuns, setE2eRuns] = useState<E2eRun[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [automationRuns, setAutomationRuns] = useState<Record<string, AutomationRun[]>>({});
  // Followed pull requests (ADR-0064): the follows, the PRs and, per PR opened on the page, its detail.
  const [prFollows, setPrFollows] = useState<PrFollow[]>([]);
  const [followedPrs, setFollowedPrs] = useState<FollowedPr[]>([]);
  const [fprItems, setFprItems] = useState<Record<string, PrItem[]>>({});
  const [fprChecks, setFprChecks] = useState<Record<string, PrCheckItem[]>>({});
  const [fprEvents, setFprEvents] = useState<Record<string, PrEvent[]>>({});
  const [fprRuns, setFprRuns] = useState<Record<string, AutomationRun[]>>({});
  const e2eRunsRef = useRef<E2eRun[]>([]);
  e2eRunsRef.current = e2eRuns;
  const [toasts, setToasts] = useState<Array<{ id: number; sessionId: string; sessionTitle: string; lines: Array<{ prId: string; text: string }> }>>([]);
  // Pane the selected Session should switch to (from a PR notification).
  const [paneRequest, setPaneRequest] = useState<{ sessionId: string; pane: string } | null>(null);
  const clearPaneRequest = useCallback(() => setPaneRequest(null), []);
  /** A Terminal the Agent opened with `ui_open` that the Terminal pane should show. */
  const [terminalFocus, setTerminalFocus] = useState<{ sessionId: string; focus: TerminalFocus } | null>(null);
  /** The last Workspace file the Daemon reported as changed (`fs/watch`), for the App pane. */
  const [fsChange, setFsChange] = useState<FsChange | null>(null);
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
  // Sidebar folders (ADR-0074): the list, the ones collapsed, the Session mid-drag and the row under it.
  const [folders, setFolders] = useState<SessionFolder[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(loadCollapsedFolders);
  const [draggingSession, setDraggingSession] = useState<string | null>(null);
  /** Drop target under the pointer: a folder id, a Session's id (its folder is the target) or `"list"` (unfile). */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // The name dialog (new folder / rename) and a Fork dialog opened for a sidebar Session that may not be selected.
  const [folderDialog, setFolderDialog] = useState<{ mode: "new" | "rename"; folderId?: string; sessionId?: string } | null>(null);
  const [sidebarFork, setSidebarFork] = useState<{ sessionId: string; snapshots: Snapshot[]; saved: SavedMessage[] } | null>(null);
  const [sidebarForkBusy, setSidebarForkBusy] = useState(false);
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
        setSessions(sortSessions(list));
        const all = await Promise.all(list.map(async (s) => [s.id, await api.prs(s.id).catch((): PullRequest[] => [])] as const));
        setPrs(Object.fromEntries(all));
      }),
    [run],
  );
  const loadPrItems = useCallback(
    (sessionId: string, prId: string) => run(async () => {
      const [items, checks] = await Promise.all([api.prItems(sessionId, prId), api.prChecks(sessionId, prId)]);
      setPrItems((prev) => ({ ...prev, [prId]: items }));
      setPrChecks((prev) => ({ ...prev, [prId]: checks }));
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
    void api.windowsBase().then(setWindowsBase, () => undefined);
    void api.macosBase().then(setMacosBase, () => undefined);
    void run(async () => setModels(await api.models()));
    void run(async () => setOptions(await api.options()));
    void run(async () => setAutomations(await api.automations()));
    void run(async () => setPrFollows(await api.prFollows()));
    void run(async () => setFollowedPrs(await api.followedPrs()));
    void run(async () => setFolders(await api.folders()));
  }, [reloadSessions, run]);

  const loadFollowedPrDetail = useCallback(
    (prId: string) => {
      void run(async () => {
        const [items, checks, events, runs] = await Promise.all([api.followedPrItems(prId), api.followedPrChecks(prId), api.followedPrEvents(prId), api.followedPrRuns(prId)]);
        setFprItems((prev) => ({ ...prev, [prId]: items }));
        setFprChecks((prev) => ({ ...prev, [prId]: checks }));
        setFprEvents((prev) => ({ ...prev, [prId]: events }));
        setFprRuns((prev) => ({ ...prev, [prId]: runs }));
      });
    },
    [run],
  );

  const loadAutomationRuns = useCallback(
    (automationId: string) => {
      void run(async () => {
        const runs = await api.automationRuns(automationId);
        setAutomationRuns((prev) => ({ ...prev, [automationId]: runs }));
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
              if (i < 0) return sortSessions([msg.session, ...prev]);
              const next = [...prev];
              next[i] = msg.session;
              return sortSessions(next);
            });
            break;
          case "session_deleted":
            setSessions((prev) => prev.filter((s) => s.id !== msg.id));
            if (selectedId === msg.id) setRoute({ view: "session", id: null });
            if (snapshotsForRef.current === msg.id) setSnapshotsFor(null);
            break;
          case "folders":
            setFolders(msg.folders);
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
          case "pr_checks":
            setPrChecks((prev) => (prev[msg.prId] ? { ...prev, [msg.prId]: msg.checks } : prev));
            break;
          case "automations":
            setAutomations(msg.automations);
            break;
          case "automation_runs":
            setAutomationRuns((prev) => ({ ...prev, [msg.automationId]: msg.runs }));
            setFprRuns((prev) => {
              const touched = Object.keys(prev).filter((prId) => msg.runs.some((r) => r.followedPrId === prId));
              if (touched.length === 0) return prev;
              const next = { ...prev };
              for (const prId of touched) {
                const fresh = msg.runs.filter((r) => r.followedPrId === prId);
                const ids = new Set(fresh.map((r) => r.id));
                next[prId] = [...fresh, ...(prev[prId] ?? []).filter((r) => !ids.has(r.id))].sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt));
              }
              return next;
            });
            break;
          case "pr_follows":
            setPrFollows(msg.follows);
            break;
          case "followed_prs":
            setFollowedPrs(msg.prs);
            break;
          case "followed_pr_items":
            setFprItems((prev) => (prev[msg.prId] ? { ...prev, [msg.prId]: msg.items } : prev));
            break;
          case "followed_pr_checks":
            setFprChecks((prev) => (prev[msg.prId] ? { ...prev, [msg.prId]: msg.checks } : prev));
            break;
          case "pr_events":
            setFprEvents((prev) => (prev[msg.prId] ? { ...prev, [msg.prId]: msg.events } : prev));
            break;
          case "fs_changed":
            setFsChange({ sessionId: msg.sessionId, path: msg.path, exists: msg.exists, nonce: Date.now() });
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
            const lines = msg.prs.map((p) => ({ prId: p.prId, text: `#${p.number} ${p.title}: ${prActivityLine(p)}` }));
            const onlyChecks = msg.prs.every((p) => p.count === 0);
            const failed = msg.prs.reduce((n, p) => n + p.failedChecks.length, 0);
            setToasts((prev) => [...prev.slice(-4), { id, sessionId: msg.sessionId, sessionTitle: msg.sessionTitle, lines }]);
            notifyBrowser(
              msg.sessionId,
              `${msg.sessionTitle}: ${onlyChecks ? (failed === 1 ? "a check failed" : "checks failed") : "pull request feedback"}`,
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
          case "ui_hint":
            // The Agent asked to show a pane: only for the Session on screen, and never under a message being typed.
            if (!uiHintApplies(msg.hint, selectedId)) break;
            setPaneRequest({ sessionId: msg.hint.sessionId, pane: msg.hint.pane });
            if (msg.hint.terminalId) setTerminalFocus({ sessionId: msg.hint.sessionId, focus: { ptyId: msg.hint.terminalId, nonce: Date.now() } });
            break;
          case "windows_base":
            setWindowsBase(msg.status);
            // Whether `qemu-windows` can be picked follows the base disk's state.
            void api.settings().then(setSettings, () => undefined);
            break;
          case "macos_base":
            setMacosBase(msg.status);
            void api.settings().then(setSettings, () => undefined);
            break;
        }
      },
      () => {
        // Reconnected: refetch to fill any gap.
        void reloadSessions();
        void run(async () => setFolders(await api.folders()));
        void run(async () => setModels(await api.models()));
        void run(async () => setOptions(await api.options()));
        setSnapshotting(new Set());
        if (selectedId) {
          void run(async () => {
            const fetched = await api.events(selectedId);
            setEvents((prev) => mergeEvents(prev, fetched));
          });
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
      ? settings.hostPlatform === "linux"
        ? "Sysbox runtime not installed: Docker-enabled Sandboxes run with --privileged, so the Agent can escape to your host"
        : "Docker-enabled Sandboxes run with --privileged: the Agent can escape to Docker's Linux VM"
      : null;
  const settingsWarning = !anyTokenSet ? "No Provider login configured" : dockerWarning;
  const gitConnected = (settings?.mcpServers ?? []).some((s) => s.connector !== null);
  const [gitLater, setGitLater] = useState(() => localStorage.getItem("sessionboxer.setup.gitLater") === "1");
  const [runtimeHelp, setRuntimeHelp] = useState(false);
  const runtimes = settings === null ? [] : runtimesPresent(settings);
  const runtimeReady = runtimes.length > 0;
  const showSetup = settings !== null && (!runtimeReady || !anyTokenSet || (!gitConnected && !gitLater));

  const topTitle =
    route.view === "new" ? "New session" : route.view === "settings" ? "Global settings" : route.view === "automations" ? "Automations" : route.view === "prs" ? "Pull requests" : (selected?.title ?? "Sessionboxer");
  const collapseSidebar = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    localStorage.setItem("sessionboxer.sidebarCollapsed", collapsed ? "1" : "0");
  };

  // Sidebar folders (ADR-0074): groups in name order, then the unfiled Sessions; a Session filed under a
  // folder that is gone counts as unfiled until the server's update lands.
  const folderGroups = useMemo(
    () => folders.map((folder) => ({ folder, sessions: sessions.filter((s) => s.folderId === folder.id) })),
    [folders, sessions],
  );
  const unfiled = useMemo(() => sessions.filter((s) => s.folderId === null || !folders.some((f) => f.id === s.folderId)), [sessions, folders]);

  const toggleFolder = (id: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      saveCollapsedFolders(next);
      return next;
    });
  };

  const fileSession = (sessionId: string, folderId: string | null) => {
    setDraggingSession(null);
    setDropTarget(null);
    void run(() => api.updateSession(sessionId, { folderId }));
  };

  /** The sidebar's "Fork…": needs the Session's snapshots and queue, fetched on demand (it may not be selected). */
  const openSidebarFork = (s: Session) => {
    void run(async () => {
      const [snaps, queued] = await Promise.all([api.snapshots(s.id), api.savedMessages(s.id)]);
      if (snaps.length === 0 && !isLiveSession(s)) throw new Error(`"${s.title}" has no snapshots yet; start its Sandbox to fork it.`);
      setSidebarFork({ sessionId: s.id, snapshots: snaps, saved: queued });
    });
  };

  const submitFolderDialog = (name: string) => {
    const dialog = folderDialog;
    setFolderDialog(null);
    if (!dialog) return;
    if (dialog.mode === "rename" && dialog.folderId) {
      void run(() => api.updateFolder(dialog.folderId as string, { name }));
      return;
    }
    void run(async () => {
      const folder = await api.createFolder(name);
      if (dialog.sessionId) await api.updateSession(dialog.sessionId, { folderId: folder.id });
    });
  };

  const dropOnSession = (e: React.DragEvent, s: Session) => {
    const id = e.dataTransfer.getData(SESSION_DRAG_TYPE) || e.dataTransfer.getData("text/plain");
    if (!id || id === s.id) return;
    e.preventDefault();
    e.stopPropagation();
    fileSession(id, s.folderId);
  };

  /** One row of the session list, the same inside a folder group as in the unfiled list. */
  const sessionEntry = (s: Session) => {
    const noSnapshot = VM_NO_SNAPSHOT[s.settings.sandbox.environment];
    const canStop = (s.status === "idle" || s.status === "running" || s.status === "error") && s.containerId !== null;
    const canResume = s.status === "stopped" || s.status === "error";
    return (
      <ContextMenu
        key={s.id}
        trigger={
          <li
            className={cx(s.id === selectedId && "active", dropTarget === `s:${s.id}` && "drop-hover", draggingSession === s.id && "dragging")}
            onClick={() => setRoute({ view: "session", id: s.id })}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(SESSION_DRAG_TYPE, s.id);
              e.dataTransfer.setData("text/plain", s.id);
              e.dataTransfer.effectAllowed = "move";
              setDraggingSession(s.id);
            }}
            onDragEnd={() => {
              setDraggingSession(null);
              setDropTarget(null);
            }}
            onDragOver={(e) => {
              if (draggingSession === null || draggingSession === s.id) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(`s:${s.id}`);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget((t) => (t === `s:${s.id}` ? null : t));
            }}
            onDrop={(e) => dropOnSession(e, s)}
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
              <span className={cx("session-status", s.pinned && "pinned")}>
                {s.usage.limit ? (
                  <span className="usage-sign-small" title={`${PROVIDER_LABELS[s.provider]} usage limit reached: ${s.usage.limit.message}`} aria-label="usage limit reached">
                    <NoEntrySign size={11} />
                  </span>
                ) : (
                  <span className={`dot dot-${s.status}`} title={statusTitle(s.status)} />
                )}
                <button
                  type="button"
                  className="session-pin"
                  title={s.pinned ? "Pinned to the top of its group. Click to unpin." : "Pin to the top of its group"}
                  aria-label={s.pinned ? "Unpin" : "Pin to top"}
                  aria-pressed={s.pinned}
                  onClick={(e) => {
                    e.stopPropagation();
                    void run(() => api.updateSession(s.id, { pinned: !s.pinned }));
                  }}
                >
                  <Icon name="pin" size={12} />
                </button>
              </span>
              <span className="session-title">{s.title}</span>
              <span className="session-provider">
                {s.queueRunning && <span title="Messages queued for the Agent">{"\u25b6"}</span>}
                {s.usb && (
                  <span className={`session-usb${s.usb.node ? "" : " unplugged"}`} title={`USB device connected: ${s.usb.name}${s.usb.node ? ` (${s.usb.node})` : " (unplugged right now)"}`}>
                    <Icon name="usb" size={12} />
                  </span>
                )}
                {s.settings.sandbox.dockerMode === "privileged" && (
                  <span className="docker-warn" title={PRIVILEGED_WARNING}>
                    <DockerIcon label={PRIVILEGED_WARNING} />
                  </span>
                )}
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
              </span>
            </div>
            <div className="session-meta">
              <span className="session-size" title="Disk used by the machine and its snapshots">
                {formatMb((s.diskBytes ?? 0) + s.snapshotBytes)}
              </span>
              <span className="session-marks">
                <span title={sessionSourceTitle(s)}>
                  <SessionSourceIcon session={s} size={14} />
                </span>
                <span className="session-env" title={ENVIRONMENT_LABELS[s.settings.sandbox.environment]}>
                  <EnvironmentIcon environment={s.settings.sandbox.environment} size={13} />
                </span>
                <span title={PROVIDER_LABELS[s.provider]}>
                  <ProviderIcon provider={s.provider} size={14} />
                </span>
              </span>
            </div>
            <SessionFamily session={s} sessions={sessions} onOpen={(id) => setRoute({ view: "session", id })} />
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
        }
      >
        <ContextMenuItem className="session-menu-item" onSelect={() => void run(() => api.updateSession(s.id, { pinned: !s.pinned }))}>
          <Icon name="pin" /> {s.pinned ? "Unpin" : "Pin to top"}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger className="session-menu-item">
            <Icon name="folder" /> Move to folder <span className="menu-sub-arrow">{"\u25B8"}</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {folders.map((f) => (
              <ContextMenuItem key={f.id} className={cx("session-menu-item", f.id === s.folderId && "active")} onSelect={() => fileSession(s.id, f.id)}>
                <Icon name="folder" />
                <span className="menu-row">
                  <span>{f.name}</span>
                  {f.id === s.folderId && <span>{"\u2713"}</span>}
                </span>
              </ContextMenuItem>
            ))}
            {s.folderId !== null && (
              <ContextMenuItem className="session-menu-item" onSelect={() => fileSession(s.id, null)}>
                <Icon name="folder" /> No folder
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem className="session-menu-item" onSelect={() => setFolderDialog({ mode: "new", sessionId: s.id })}>
              <Icon name="folder-plus" /> New folder…
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem className="session-menu-item" onSelect={() => setSnapshotsFor(s.id)}>
          <Icon name="snapshot" /> Snapshots…
        </ContextMenuItem>
        <ContextMenuItem
          className="session-menu-item"
          disabled={noSnapshot !== undefined || (s.snapshotCount === 0 && !isLiveSession(s))}
          title={
            noSnapshot ??
            (isLiveSession(s)
              ? "New Session and Sandbox from this one as it is now (a snapshot is taken), or from an earlier snapshot"
              : s.snapshotCount > 0
                ? "New Session and Sandbox from a snapshot of this one"
                : "Start the Sandbox to fork it (there is no snapshot yet)")
          }
          onSelect={() => openSidebarFork(s)}
        >
          <Icon name="fork" /> Fork…
        </ContextMenuItem>
        <ContextMenuSeparator />
        {canStop && (
          <ContextMenuItem
            className="session-menu-item"
            title="Stop the Sandbox; the conversation stays and Resume brings it back"
            onSelect={() => void run(() => api.stop(s.id))}
          >
            <Icon name="stop" /> Stop
          </ContextMenuItem>
        )}
        {canResume && (
          <ContextMenuItem
            className="session-menu-item"
            title="Start the Sandbox again; the Agent picks up its conversation"
            onSelect={() => void run(() => api.resume(s.id))}
          >
            <Icon name="resume" /> Resume
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className="session-menu-item danger"
          onSelect={() => {
            if (confirm(`Delete "${s.title}" and its Sandbox?`)) void run(() => api.deleteSession(s.id));
          }}
        >
          <Icon name="delete" /> Delete
        </ContextMenuItem>
      </ContextMenu>
    );
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
          <span className="sidebar-head-actions">
            <button className="icon-button" title="New folder" aria-label="New folder" onClick={() => setFolderDialog({ mode: "new" })}>
              <Icon name="folder-plus" />
            </button>
            <button onClick={() => setRoute({ view: "new" })}>+ New</button>
          </span>
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
        <ul
          className="session-list"
          onDragOver={(e) => {
            // A drop on bare list space (between groups, below the last row) unfiles the Session.
            if (draggingSession === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={(e) => {
            const id = e.dataTransfer.getData(SESSION_DRAG_TYPE) || e.dataTransfer.getData("text/plain");
            if (!id) return;
            e.preventDefault();
            fileSession(id, null);
          }}
        >
          {folderGroups.map(({ folder, sessions: members }) => (
            <li
              key={folder.id}
              className={cx("session-folder", dropTarget === `f:${folder.id}` && "drop-hover")}
              onDragOver={(e) => {
                if (draggingSession === null) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                setDropTarget(`f:${folder.id}`);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget((t) => (t === `f:${folder.id}` ? null : t));
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(SESSION_DRAG_TYPE) || e.dataTransfer.getData("text/plain");
                if (!id) return;
                e.preventDefault();
                e.stopPropagation();
                fileSession(id, folder.id);
              }}
            >
              <ContextMenu
                trigger={
                  <button
                    type="button"
                    className="folder-head"
                    aria-expanded={!collapsedFolders.has(folder.id)}
                    title={`${members.length} session${members.length === 1 ? "" : "s"} — click to ${collapsedFolders.has(folder.id) ? "open" : "fold"}, right-click for folder actions`}
                    onClick={() => toggleFolder(folder.id)}
                  >
                    <span className="chevron">{collapsedFolders.has(folder.id) ? "\u25B8" : "\u25BE"}</span>
                    <Icon name="folder" size={13} />
                    <span className="folder-name">{folder.name}</span>
                    <span className="count">{members.length}</span>
                  </button>
                }
              >
                <ContextMenuItem className="session-menu-item" onSelect={() => setFolderDialog({ mode: "rename", folderId: folder.id })}>
                  <Icon name="folder" /> Rename…
                </ContextMenuItem>
                <ContextMenuItem className="session-menu-item" onSelect={() => setFolderDialog({ mode: "new" })}>
                  <Icon name="folder-plus" /> New folder…
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="session-menu-item danger"
                  onSelect={() => {
                    const note = members.length > 0 ? `\n\nIts ${members.length === 1 ? "session moves" : `${members.length} sessions move`} back to the unfiled list.` : "";
                    if (confirm(`Delete the folder "${folder.name}"?${note}`)) void run(() => api.deleteFolder(folder.id));
                  }}
                >
                  <Icon name="delete" /> Delete folder
                </ContextMenuItem>
              </ContextMenu>
              {!collapsedFolders.has(folder.id) && (
                <ul className="folder-items">
                  {members.map(sessionEntry)}
                  {members.length === 0 && <li className="empty">Drop sessions here</li>}
                </ul>
              )}
            </li>
          ))}
          {unfiled.map(sessionEntry)}
          {sessions.length === 0 && folders.length === 0 && <li className="empty">No sessions yet</li>}
        </ul>
        <div className="sidebar-footer">
          {showSetup && (
            <div className="setup-todo" aria-label="Set-up checklist">
              <div className="setup-todo-head">
                <span>To set up</span>
                <span className="muted">{(runtimeReady ? 1 : 0) + (anyTokenSet ? 1 : 0) + (gitConnected ? 1 : 0)}/3</span>
              </div>
              <button type="button" className={`setup-item${runtimeReady ? " done" : ""}`} onClick={() => setRuntimeHelp(true)}>
                <span className="setup-check" aria-hidden="true">{runtimeReady ? "\u2713" : ""}</span>
                <span className="setup-text">
                  <span className="setup-title">Runtime</span>
                  <span className="muted">{runtimeReady ? runtimes.join(" + ") : "Docker, or QEMU for Windows/macOS VMs"}</span>
                </span>
              </button>
              <button type="button" className={`setup-item${anyTokenSet ? " done" : ""}`} onClick={() => setProviderConnect({ provider: null })}>
                <span className="setup-check" aria-hidden="true">{anyTokenSet ? "\u2713" : ""}</span>
                <span className="setup-text">
                  <span className="setup-title">Connect a Provider</span>
                  <span className="muted">{anyTokenSet ? "done" : "Claude Code, Codex, Cursor, OpenCode, Devin, pi or fx"}</span>
                </span>
              </button>
              <button type="button" className={`setup-item${gitConnected ? " done" : ""}`} onClick={() => setGitConnect(true)}>
                <span className="setup-check" aria-hidden="true">{gitConnected ? "\u2713" : ""}</span>
                <span className="setup-text">
                  <span className="setup-title">Connect a Git account</span>
                  <span className="muted">{gitConnected ? "done" : "GitHub or Bitbucket, to push and open PRs"}</span>
                </span>
                {!gitConnected && (
                  <span
                    role="button"
                    className="setup-later"
                    title="Hide this item; Global settings → MCP & connectors has it too"
                    onClick={(e) => {
                      e.stopPropagation();
                      localStorage.setItem("sessionboxer.setup.gitLater", "1");
                      setGitLater(true);
                    }}
                  >
                    later
                  </span>
                )}
              </button>
            </div>
          )}
          {runtimeHelp && settings && <RuntimeDialog settings={settings} onClose={() => setRuntimeHelp(false)} />}
          <button
            onClick={() => setRoute({ view: "prs" })}
            title={prFollows.some((f) => f.enabled && f.syncError) ? "A follow cannot be read" : followedPrs.some((p) => p.unread > 0) ? "Pull requests with something new" : undefined}
          >
            Pull requests
            {prFollows.some((f) => f.enabled && f.syncError) ? (
              <span className="warn-sign" aria-label="A follow cannot be read">⚠</span>
            ) : (
              followedPrs.filter((p) => p.unread > 0).length > 0 && <span className="count">{followedPrs.filter((p) => p.unread > 0).length}</span>
            )}
          </button>
          <button onClick={() => setRoute({ view: "automations" })} title={automations.some((a) => a.lastStatus === "failed") ? "An automation failed" : undefined}>
            Automations
            {automations.some((a) => a.lastStatus === "failed") && <span className="warn-sign" aria-label="An automation failed">⚠</span>}
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

      {folderDialog && (
        <FolderNameDialog
          title={folderDialog.mode === "rename" ? "Rename folder" : "New folder"}
          initial={folderDialog.mode === "rename" ? (folders.find((f) => f.id === folderDialog.folderId)?.name ?? "") : ""}
          submitLabel={folderDialog.mode === "rename" ? "Rename" : "Create"}
          onSubmit={submitFolderDialog}
          onClose={() => setFolderDialog(null)}
        />
      )}

      {sidebarFork &&
        settings &&
        (() => {
          const forkOrigin = sessions.find((s) => s.id === sidebarFork.sessionId);
          const forkPoint = forkOrigin && isLiveSession(forkOrigin) ? FORK_NOW : sidebarFork.snapshots[sidebarFork.snapshots.length - 1]?.id;
          if (!forkOrigin || !forkPoint) return null;
          return (
            <ForkDialog
              session={forkOrigin}
              settings={settings}
              models={models ?? EMPTY_MODELS}
              options={options ?? EMPTY_OPTIONS}
              snapshots={sidebarFork.snapshots}
              saved={sidebarFork.saved}
              initialSnapshotId={forkPoint}
              busy={sidebarForkBusy}
              onClose={() => setSidebarFork(null)}
              onSubmit={(req) => {
                setSidebarForkBusy(true);
                void run(async () => {
                  const fork = await api.forkSession(forkOrigin.id, req);
                  setSidebarFork(null);
                  setRoute({ view: "session", id: fork.id });
                }).finally(() => setSidebarForkBusy(false));
              }}
            />
          );
        })()}

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
        <SandboxImageBanner />
        {!anyTokenSet && route.view !== "settings" && route.view !== "new" && !(route.view === "session" && !selected) && (
          <div className="banner banner-warn" onClick={() => setProviderConnect({ provider: null })}>
            No Provider connected yet: Sessions need a Claude Code, Codex, Cursor, OpenCode, Devin, pi or fx login. Click to connect one.
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
