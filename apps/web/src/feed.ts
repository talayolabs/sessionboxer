import {
  PROVIDERS,
  prActivityLine,
  type AgentOption,
  type Automation,
  type AutomationRun,
  type E2eRun,
  type FollowedPr,
  type MacosBaseStatus,
  type McpEventSubscription,
  type ModelOption,
  type PrActivity,
  type PrCheckItem,
  type PrEvent,
  type PrFollow,
  type PrItem,
  type PrMergedNotice,
  type Provider,
  type ProviderModels,
  type ProviderOptions,
  type PublicSettings,
  type PullRequest,
  type SavedMessage,
  type Session,
  type SessionBroadcast,
  type SessionEvent,
  type SessionFolder,
  type Snapshot,
  type WindowsBaseStatus,
} from "@sessionboxer/protocol";
import type { FsChange } from "./HtmlArtifact";
import type { TerminalFocus } from "./Terminal";

/**
 * What the Control Plane pushes over `/api/ws` and how the page's state answers each message
 * (ADR-0002). `feedReducer` is a pure function so `scripts/feed.test.mjs` can pin every message
 * type; the socket, the toasts' notifications and the navigation live in `useSessionFeed`.
 * This module imports no component: Node runs it directly in that test.
 */
export type ServerMessage = SessionBroadcast;

export type Toast = { id: number; sessionId: string; sessionTitle: string; lines: Array<{ prId: string; text: string }> };

export type FeedState = {
  /** The Session on screen and the one whose Snapshots popup is open: scope for per-Session messages. */
  selectedId: string | null;
  snapshotsFor: string | null;
  sessions: Session[];
  folders: SessionFolder[];
  // The selected Session's transcript, saved messages, Snapshots and end-to-end runs (ADR-0044).
  events: SessionEvent[];
  saved: SavedMessage[];
  snapshots: Snapshot[];
  e2eRuns: E2eRun[];
  /** Snapshots of the popup opened from the sidebar (may be another Session's). */
  dialogSnapshots: Snapshot[] | null;
  snapshotting: Set<string>;
  settings: PublicSettings | null;
  windowsBase: WindowsBaseStatus | null;
  macosBase: MacosBaseStatus | null;
  models: ProviderModels | null;
  options: ProviderOptions | null;
  // Attached Pull Requests per Session and, per PR opened on the page, its detail.
  prs: Record<string, PullRequest[]>;
  prItems: Record<string, PrItem[]>;
  prChecks: Record<string, PrCheckItem[]>;
  automations: Automation[];
  automationRuns: Record<string, AutomationRun[]>;
  mcpEventSubscriptions: McpEventSubscription[];
  // Followed pull requests (ADR-0064): the follows, the PRs and, per PR opened on the page, its detail.
  prFollows: PrFollow[];
  followedPrs: FollowedPr[];
  fprItems: Record<string, PrItem[]>;
  fprChecks: Record<string, PrCheckItem[]>;
  fprEvents: Record<string, PrEvent[]>;
  fprRuns: Record<string, AutomationRun[]>;
  toasts: Toast[];
  // Pane the selected Session should switch to (from a PR notification).
  paneRequest: { sessionId: string; pane: string } | null;
  /** A Terminal the Agent opened with `ui_open` that the Terminal pane should show. */
  terminalFocus: { sessionId: string; focus: TerminalFocus } | null;
  /** The last Workspace file the Daemon reported as changed (`fs/watch`), for the App pane. */
  fsChange: FsChange | null;
};

export function initialFeed(): FeedState {
  return {
    selectedId: null,
    snapshotsFor: null,
    sessions: [],
    folders: [],
    events: [],
    saved: [],
    snapshots: [],
    e2eRuns: [],
    dialogSnapshots: null,
    snapshotting: new Set(),
    settings: null,
    windowsBase: null,
    macosBase: null,
    models: null,
    options: null,
    prs: {},
    prItems: {},
    prChecks: {},
    automations: [],
    automationRuns: {},
    mcpEventSubscriptions: [],
    prFollows: [],
    followedPrs: [],
    fprItems: {},
    fprChecks: {},
    fprEvents: {},
    fprRuns: {},
    toasts: [],
    paneRequest: null,
    terminalFocus: null,
    fsChange: null,
  };
}

// Same shape as SessionView's EMPTY_MODELS / EMPTY_OPTIONS, kept here so this module stays component-free.
const EMPTY_MODELS = Object.fromEntries(PROVIDERS.map((p): [Provider, ModelOption[]] => [p, []])) as ProviderModels;
const EMPTY_OPTIONS = Object.fromEntries(PROVIDERS.map((p): [Provider, AgentOption[]] => [p, []])) as ProviderOptions;

/** The sidebar's order: pinned Sessions first, then newest first (the Control Plane lists them the same way). */
export function sortSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));
}

/** One toast line per Pull Request with new feedback; the browser notification repeats them. */
export function prActivityLines(prs: PrActivity[]): Toast["lines"] {
  return prs.map((p) => ({ prId: p.prId, text: `#${p.number} ${p.title}: ${prActivityLine(p)}` }));
}

export function prMergedText(pr: PrMergedNotice): string {
  return `#${pr.number} ${pr.title}: merged (${pr.method})`;
}

function pushToast(toasts: Toast[], toast: Omit<Toast, "id">): Toast[] {
  return [...toasts.slice(-4), { id: Date.now() + Math.random(), ...toast }];
}

/**
 * The page's state after one server message. Returns `state` itself when the message changes
 * nothing (a message for a Session not on screen, a PR whose detail was never opened), so React
 * skips the render as it did with the per-field setters this replaces.
 */
export function feedReducer(state: FeedState, msg: ServerMessage): FeedState {
  switch (msg.type) {
    case "session": {
      const i = state.sessions.findIndex((s) => s.id === msg.session.id);
      if (i < 0) return { ...state, sessions: sortSessions([msg.session, ...state.sessions]) };
      const next = [...state.sessions];
      next[i] = msg.session;
      return { ...state, sessions: sortSessions(next) };
    }
    case "session_deleted":
      return { ...state, sessions: state.sessions.filter((s) => s.id !== msg.id) };
    case "folders":
      return { ...state, folders: msg.folders };
    case "event": {
      if (msg.event.sessionId !== state.selectedId) return state;
      const last = state.events[state.events.length - 1];
      if (last && msg.event.seq <= last.seq) return state;
      return { ...state, events: [...state.events, msg.event] };
    }
    case "saved_messages":
      return msg.sessionId === state.selectedId ? { ...state, saved: msg.messages } : state;
    case "snapshots": {
      const forSelected = msg.sessionId === state.selectedId;
      const forDialog = msg.sessionId === state.snapshotsFor;
      if (!forSelected && !forDialog) return state;
      return {
        ...state,
        snapshots: forSelected ? msg.snapshots : state.snapshots,
        dialogSnapshots: forDialog ? msg.snapshots : state.dialogSnapshots,
      };
    }
    case "snapshotting": {
      const next = new Set(state.snapshotting);
      if (msg.active) next.add(msg.sessionId);
      else next.delete(msg.sessionId);
      return { ...state, snapshotting: next };
    }
    case "snapshot_failed":
      // Shown in the error banner by useSessionFeed; nothing to remember.
      return state;
    case "models":
      return { ...state, models: { ...(state.models ?? EMPTY_MODELS), [msg.provider]: msg.models } };
    case "options":
      return { ...state, options: { ...(state.options ?? EMPTY_OPTIONS), [msg.provider]: msg.options } };
    case "prs":
      return { ...state, prs: { ...state.prs, [msg.sessionId]: msg.prs } };
    case "pr_items":
      return state.prItems[msg.prId] ? { ...state, prItems: { ...state.prItems, [msg.prId]: msg.items } } : state;
    case "pr_checks":
      return state.prChecks[msg.prId] ? { ...state, prChecks: { ...state.prChecks, [msg.prId]: msg.checks } } : state;
    case "automations":
      return { ...state, automations: msg.automations };
    case "automation_runs": {
      const automationRuns = { ...state.automationRuns, [msg.automationId]: msg.runs };
      const prev = state.fprRuns;
      const touched = Object.keys(prev).filter((prId) => msg.runs.some((r) => r.followedPrId === prId));
      if (touched.length === 0) return { ...state, automationRuns };
      const next = { ...prev };
      for (const prId of touched) {
        const fresh = msg.runs.filter((r) => r.followedPrId === prId);
        const ids = new Set(fresh.map((r) => r.id));
        next[prId] = [...fresh, ...(prev[prId] ?? []).filter((r) => !ids.has(r.id))].sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt));
      }
      return { ...state, automationRuns, fprRuns: next };
    }
    case "mcp_event_subscriptions":
      return { ...state, mcpEventSubscriptions: msg.subscriptions };
    case "pr_follows":
      return { ...state, prFollows: msg.follows };
    case "followed_prs":
      return { ...state, followedPrs: msg.prs };
    case "followed_pr_items":
      return state.fprItems[msg.prId] ? { ...state, fprItems: { ...state.fprItems, [msg.prId]: msg.items } } : state;
    case "followed_pr_checks":
      return state.fprChecks[msg.prId] ? { ...state, fprChecks: { ...state.fprChecks, [msg.prId]: msg.checks } } : state;
    case "pr_events":
      return state.fprEvents[msg.prId] ? { ...state, fprEvents: { ...state.fprEvents, [msg.prId]: msg.events } } : state;
    case "fs_changed":
      return { ...state, fsChange: { sessionId: msg.sessionId, path: msg.path, exists: msg.exists, nonce: Date.now() } };
    case "e2e_changed": {
      if (msg.sessionId !== state.selectedId) return state;
      const before = state.e2eRuns.find((r) => r.id === msg.run.id);
      const wasRunning = new Set(before?.cases.filter((c) => c.status === "running").map((c) => c.id));
      // A case just started: show the pane, but only for the Session on screen (never steal focus from another one).
      const started = msg.run.cases.some((c) => c.status === "running" && !wasRunning.has(c.id));
      const i = state.e2eRuns.findIndex((r) => r.id === msg.run.id);
      let e2eRuns: E2eRun[];
      if (i < 0) e2eRuns = [msg.run, ...state.e2eRuns];
      else {
        e2eRuns = [...state.e2eRuns];
        e2eRuns[i] = msg.run;
      }
      return { ...state, e2eRuns, paneRequest: started ? { sessionId: msg.sessionId, pane: "e2e" } : state.paneRequest };
    }
    case "pr_activity":
      return { ...state, toasts: pushToast(state.toasts, { sessionId: msg.sessionId, sessionTitle: msg.sessionTitle, lines: prActivityLines(msg.prs) }) };
    case "pr_merged":
      return {
        ...state,
        toasts: pushToast(state.toasts, { sessionId: msg.sessionId, sessionTitle: msg.sessionTitle, lines: [{ prId: msg.pr.prId, text: prMergedText(msg.pr) }] }),
      };
    case "remote":
      return state.settings ? { ...state, settings: { ...state.settings, remote: msg.remote } } : state;
    case "ui_hint":
      // The Agent asked to show a pane: only for the Session on screen (useSessionFeed drops it while a message is being typed).
      if (msg.hint.sessionId !== state.selectedId) return state;
      return {
        ...state,
        paneRequest: { sessionId: msg.hint.sessionId, pane: msg.hint.pane },
        terminalFocus: msg.hint.terminalId ? { sessionId: msg.hint.sessionId, focus: { ptyId: msg.hint.terminalId, nonce: Date.now() } } : state.terminalFocus,
      };
    case "windows_base":
      // Whether `qemu-windows` can be picked follows the base disk's state: useSessionFeed refetches the settings.
      return { ...state, windowsBase: msg.status };
    case "macos_base":
      return { ...state, macosBase: msg.status };
    case "pong":
      return state;
  }
}
