import { useCallback, useEffect, useReducer, useRef } from "react";
import { type PullRequest, type SessionEvent } from "@sessionboxer/protocol";
import { api, subscribe } from "./api";
import { userIsTyping } from "./AgentActions";
import { type Runner, notifyBrowser } from "./SessionView";
import { type FeedState, type ServerMessage, feedReducer, initialFeed, prActivityLines, prMergedText, sortSessions } from "./feed";
import type { Route } from "./App";

export type FeedSetter = <K extends keyof FeedState>(key: K, value: FeedState[K] | ((prev: FeedState[K]) => FeedState[K])) => void;

type FeedAction =
  | { type: "message"; msg: ServerMessage }
  | { type: "scope"; selectedId: string | null; snapshotsFor: string | null }
  /** A write from the page itself (a fetch landed, a toast was dismissed). */
  | { type: "set"; apply: (state: FeedState) => FeedState };

function reduce(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case "message":
      return feedReducer(state, action.msg);
    case "scope":
      if (state.selectedId === action.selectedId && state.snapshotsFor === action.snapshotsFor) return state;
      return { ...state, selectedId: action.selectedId, snapshotsFor: action.snapshotsFor };
    case "set":
      return action.apply(state);
  }
}

/**
 * The transcript refetched after a reconnection, keeping what the socket delivered while the fetch
 * was in flight (events newer than the fetch's last one, for the same Session).
 */
function mergeEvents(prev: SessionEvent[], fetched: SessionEvent[]): SessionEvent[] {
  const last = fetched[fetched.length - 1];
  if (!last) return fetched;
  const tail = prev.filter((e) => e.sessionId === last.sessionId && e.seq > last.seq);
  return tail.length === 0 ? fetched : [...fetched, ...tail];
}

/**
 * Owns the `/api/ws` subscription (`subscribe` keeps the socket open: reconnect, heartbeat) and the
 * state it feeds, reduced by `feedReducer`. Side effects a message asks for happen here, after the
 * state change: navigating away from a deleted Session, the error banner, browser notifications
 * for PR toasts, refetching the settings when a base disk changes. On reconnection everything the
 * socket may have missed is refetched.
 */
export function useSessionFeed({
  selectedId,
  snapshotsFor,
  run,
  setError,
  setRoute,
  setSnapshotsFor,
}: {
  selectedId: string | null;
  snapshotsFor: string | null;
  run: Runner;
  setError: (message: string) => void;
  setRoute: (route: Route) => void;
  setSnapshotsFor: (sessionId: string | null) => void;
}) {
  const [feed, dispatch] = useReducer(reduce, undefined, initialFeed);
  const setFeed: FeedSetter = useCallback((key, value) => {
    dispatch({
      type: "set",
      apply: (state) => {
        const next = typeof value === "function" ? value(state[key]) : value;
        return Object.is(state[key], next) ? state : { ...state, [key]: next };
      },
    });
  }, []);
  useEffect(() => dispatch({ type: "scope", selectedId, snapshotsFor }), [selectedId, snapshotsFor]);
  const snapshotsForRef = useRef<string | null>(null);
  snapshotsForRef.current = snapshotsFor;

  const reloadSessions = useCallback(
    () =>
      run(async () => {
        const list = await api.sessions();
        setFeed("sessions", sortSessions(list));
        const all = await Promise.all(list.map(async (s) => [s.id, await api.prs(s.id).catch((): PullRequest[] => [])] as const));
        setFeed("prs", Object.fromEntries(all));
      }),
    [run, setFeed],
  );
  const openPr = useCallback(
    (sessionId: string, prId: string | null) => {
      setRoute({ view: "session", id: sessionId });
      setFeed("paneRequest", { sessionId, pane: prId ? `pr:${prId}` : "prs" });
    },
    [setRoute, setFeed],
  );

  useEffect(() => {
    return subscribe(
      (msg) => {
        // The Agent asked to show a pane under a message being typed: never (the rest of the check is the reducer's).
        if (msg.type === "ui_hint" && userIsTyping()) return;
        dispatch({ type: "message", msg });
        switch (msg.type) {
          case "session_deleted":
            if (selectedId === msg.id) setRoute({ view: "session", id: null });
            if (snapshotsForRef.current === msg.id) setSnapshotsFor(null);
            break;
          case "snapshot_failed":
            setError(msg.message);
            break;
          case "pr_activity": {
            const lines = prActivityLines(msg.prs);
            const onlyChecks = msg.prs.every((p) => p.count === 0);
            const failed = msg.prs.reduce((n, p) => n + p.failedChecks.length, 0);
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
          case "pr_merged":
            notifyBrowser(msg.sessionId, `${msg.sessionTitle}: pull request merged`, prMergedText(msg.pr), `sessionboxer-pr-merged-${msg.pr.prId}`, msg.pr.prId, () => openPr(msg.sessionId, msg.pr.prId));
            break;
          case "windows_base":
          case "macos_base":
            // Whether `qemu-windows` can be picked follows the base disk's state.
            void api.settings().then((s) => setFeed("settings", s), () => undefined);
            break;
        }
      },
      () => {
        // Reconnected: refetch to fill any gap.
        void reloadSessions();
        void run(async () => setFeed("folders", await api.folders()));
        void run(async () => setFeed("models", await api.models()));
        void run(async () => setFeed("options", await api.options()));
        setFeed("snapshotting", new Set());
        if (selectedId) {
          void run(async () => {
            const fetched = await api.events(selectedId);
            setFeed("events", (prev) => mergeEvents(prev, fetched));
          });
          void run(async () => setFeed("saved", await api.savedMessages(selectedId)));
          void run(async () => setFeed("snapshots", await api.snapshots(selectedId)));
          void run(async () => setFeed("e2eRuns", await api.e2eRuns(selectedId)));
        }
        const dialogId = snapshotsForRef.current;
        if (dialogId) void run(async () => setFeed("dialogSnapshots", await api.snapshots(dialogId)));
      },
    );
  }, [selectedId, reloadSessions, run, setError, setRoute, setSnapshotsFor, openPr, setFeed]);

  return { feed, setFeed, reloadSessions, openPr };
}
