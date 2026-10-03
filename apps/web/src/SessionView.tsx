import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  PROVIDERS,
  resolveSessionSettings,
  sessionRoute,
  type AgentOption,
  type Branch,
  type E2eRun,
  type LlmCall,
  type ModelOption,
  type PrCheckItem,
  type PrItem,
  type Provider,
  type ProviderModels,
  type ProviderOptions,
  type PublicSettings,
  type PullRequest,
  type SavedMessage,
  type Session,
  type Snapshot,
} from "@sessionboxer/protocol";
import { api, reportViewing } from "./api";
import { PANE_MAX_FRAC, PANE_MIN_FRAC, clampPane, loadSize, saveSize, startSplitterDrag } from "./splitter";
import { AttachmentSession } from "./Attachments";
import { OpenApp, type FsChange } from "./HtmlArtifact";
import { type DividerRef } from "./BranchTree";
import { COMPOSER_MAX_FRAC, COMPOSER_MIN_FRAC, type ComposerMode } from "./Composer";
import { useDraftStore } from "./draft";
import { isRunOpen } from "./E2e";
import { FORK_NOW } from "./ForkDialog";
import { type ContextState } from "./context-model";
import { Modal } from "./ui";
import { type TerminalFocus } from "./Terminal";
import { type CodeTarget } from "./Code";
import { OpenFile } from "./FileLink";
import type { FileRef } from "./file-links";
import { buildTranscript } from "./transcript-model";

/**
 * The transcript refetched after a reconnection, keeping what the socket delivered while the fetch
 * was in flight (events newer than the fetch's last one, for the same Session).
 */
import { PANES, SCHEDULES_HINT, SessionHeader } from "./session/SessionHeader";
import { SessionChat } from "./session/SessionChat";
import { SessionDialogs, useSessionDialogs } from "./session/SessionDialogs";
import { SessionPane } from "./session/SessionPane";

/** One line about the stored Codex login, from the metadata the Control Plane exposes (never the tokens). */
export const EMPTY_PRS: PullRequest[] = [];
export const EMPTY_E2E_RUNS: E2eRun[] = [];

/** A browser notification when the tab is in the background and permission was given (the PRs pane asks for it). */
export function notifyBrowser(sessionId: string, title: string, body: string, tag: string, prId: string | null, onClick: () => void): void {
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

export type Runner = (fn: () => Promise<unknown>) => Promise<void>;

export const EMPTY_MODELS: ProviderModels = Object.fromEntries(PROVIDERS.map((p): [Provider, ModelOption[]] => [p, []])) as ProviderModels;
export const EMPTY_OPTIONS: ProviderOptions = Object.fromEntries(PROVIDERS.map((p): [Provider, AgentOption[]] => [p, []])) as ProviderOptions;
export const EMPTY_BRANCHES: Branch[] = [];

/** The one-line name dialog behind "New folder…" and a folder's "Rename…" (ADR-0074). */
export function FolderNameDialog({
  title,
  initial = "",
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <Modal
      title={title}
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit(name.trim());
      }}
    >
      <label>
        Name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} spellCheck={false} />
      </label>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!name.trim()}>
          {submitLabel}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Side pane: the fixed ones, the PR overview, or one attached PR (`pr:<id>`). On a phone only one pane
 * shows at a time and the chat is one of them (`chat`); on a desktop the chat is always there, so `chat`
 * and `hidden` mean the same.
 */
export type Pane = "chat" | "desktop" | "code" | "terminal" | "app" | "context" | "prs" | `pr:${string}` | "e2e" | "schedules" | "hidden";
function loadPane(): Pane {
  const v = localStorage.getItem("sessionboxer.pane");
  return v === "chat" || v === "desktop" || v === "code" || v === "terminal" || v === "app" || v === "context" || v === "prs" || v === "e2e" || v === "schedules" || v === "hidden"
    ? v
    : "desktop";
}

function loadComposerMode(): ComposerMode {
  return localStorage.getItem("sessionboxer.composerMode") === "rich" ? "rich" : "raw";
}

function loadComposerHeight(): number | null {
  const v = Number(localStorage.getItem("sessionboxer.composerHeight"));
  return v >= COMPOSER_MIN_FRAC && v <= COMPOSER_MAX_FRAC ? v : null;
}

export type SessionViewProps = {
  session: Session;
  /** All Sessions, to name the one a USB device is taken from. */
  sessions: Session[];
  /** `null` until loaded; the Session settings dialog needs it (MCP registry, global defaults). */
  settings: PublicSettings | null;
  /** Settings the Session stored itself (`/util` registers a Utility). */
  onSettings: (s: PublicSettings) => void;
  models: ModelOption[];
  /** Non-model options (Effort, Fast mode…): what this Session's Agent advertises, else the Provider cache. */
  options: AgentOption[];
  /** Every Provider's catalogue, for a fork that runs another Agent. */
  allModels: ProviderModels;
  allOptions: ProviderOptions;
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
  prChecks: Record<string, PrCheckItem[]>;
  onLoadPrItems: (sessionId: string, prId: string) => Promise<void>;
  /** End-to-end verification runs of this Session, newest first (ADR-0044). */
  e2eRuns: E2eRun[];
  /** Pane to switch to (from a PR notification or a verification that started). */
  paneRequest: string | null;
  onPaneRequestHandled: () => void;
  /** A Terminal the Agent opened (`ui_open`) to bring to the front. */
  terminalFocus?: TerminalFocus | null;
  /** A watched Workspace file changed (`fs_changed`); the App pane reloads when it is its file. */
  fsChange: FsChange | null;
  /** Phone shell: bottom tabs pick one full-width pane, header actions live in a sheet. */
  mobile: boolean;
  run: Runner;
  onForked: (s: Session) => void;
  /** The Scheduled pane: the automations that prompt this Session, and how many there are. */
  schedulesPane: ReactNode;
  sessionSchedules: number;
};

export function SessionView({
  session,
  sessions,
  settings,
  onSettings,
  models,
  options,
  allModels,
  allOptions,
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
  prChecks,
  onLoadPrItems,
  e2eRuns,
  paneRequest,
  onPaneRequestHandled,
  terminalFocus = null,
  fsChange,
  mobile,
  run,
  onForked,
  schedulesPane,
  sessionSchedules,
}: SessionViewProps) {
  const draft = useDraftStore();
  const dialogs = useSessionDialogs();
  const { setForkFrom, setInspectingCall } = dialogs;
  const [branching, setBranching] = useState(false);
  const [pane, setPane] = useState<Pane>(loadPane);
  // What is on screen: on a phone the chat is a pane like the others; on a desktop it is always there.
  const shown: Pane = mobile ? (pane === "hidden" ? "chat" : pane) : pane === "chat" ? "hidden" : pane;
  const showChat = !mobile || shown === "chat";
  const togglePane = (id: Pane) => setPane((cur) => (cur === id ? (mobile ? "chat" : "hidden") : id));
  const [composerMode, setComposerMode] = useState<ComposerMode>(loadComposerMode);
  const [composerHeight, setComposerHeight] = useState<number | null>(loadComposerHeight);
  const [paneFrac, setPaneFrac] = useState<number | null>(() => loadSize("sessionboxer.paneWidth", PANE_MIN_FRAC, PANE_MAX_FRAC));
  useEffect(() => saveSize("sessionboxer.paneWidth", paneFrac), [paneFrac]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [codeTarget, setCodeTarget] = useState<CodeTarget | null>(null);
  const openFile = useCallback((ref: FileRef) => {
    setPane("code");
    setCodeTarget({ ...ref, nonce: Date.now() });
  }, []);
  // The HTML Artifact the App pane shows, remembered per Session (ADR-0078).
  const appKey = `sessionboxer.app.${session.id}`;
  const [appTarget, setAppTarget] = useState<string | null>(() => localStorage.getItem(appKey));
  const openApp = useCallback(
    (path: string) => {
      localStorage.setItem(appKey, path);
      setAppTarget(path);
      setPane("app");
    },
    [appKey],
  );
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
  // What this browser shows, for the Agent's `whoami` (`panes`) and `ui_open`.
  useEffect(() => {
    reportViewing({ sessionId: session.id, pane: shown === "hidden" ? "chat" : shown });
    return () => reportViewing(null);
  }, [session.id, shown]);
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
  const e2eEnabled = settings ? resolveSessionSettings(session.settings, settings).e2eVerify : (session.settings.e2eVerify ?? false);
  const e2eLive = e2eRuns.some(isRunOpen);
  const [e2eFocus, setE2eFocus] = useState<string | null>(null);
  const openE2e = useCallback((runId: string | null) => {
    setE2eFocus(runId);
    setPane("e2e");
  }, []);
  const setE2eVerify = (value: boolean | null) => void run(() => api.updateSession(session.id, { settings: { e2eVerify: value } }));
  const appendToComposer = useCallback((t: string) => draft.set((cur) => (cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${t}` : t)), [draft]);
  useEffect(() => localStorage.setItem("sessionboxer.composerMode", composerMode), [composerMode]);
  useEffect(() => {
    if (composerHeight === null) localStorage.removeItem("sessionboxer.composerHeight");
    else localStorage.setItem("sessionboxer.composerHeight", String(composerHeight));
  }, [composerHeight]);

  const isLive = session.status === "idle" || session.status === "running";
  const latestSnapshot = snapshots[snapshots.length - 1];
  // A running Sandbox forks from now (a snapshot is taken with the fork); a stopped one only from an existing snapshot.
  const defaultForkPoint = isLive ? FORK_NOW : latestSnapshot?.id;
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
    <OpenApp.Provider value={openApp}>
    <div className="session">
      <SessionHeader session={session} settings={settings} mobile={mobile} run={run}
        snapshotting={snapshotting} sessionSchedules={sessionSchedules} prs={prs} pane={pane} setPane={setPane} togglePane={togglePane}
        openPr={openPr} prUnread={prUnread} e2eEnabled={e2eEnabled} e2eLive={e2eLive}
        branching={branching} branchActions={branchActions} isLive={isLive}
        latestSnapshot={latestSnapshot} defaultForkPoint={defaultForkPoint}
        setForkFrom={setForkFrom} setSyncOpen={dialogs.setSyncOpen} setUsbOpen={dialogs.setUsbOpen}
        setSettingsOpen={dialogs.setSettingsOpen} setReposOpen={dialogs.setReposOpen} />
      {session.error && <div className="banner banner-error">{session.error}</div>}
      <SessionDialogs {...dialogs} session={session} sessions={sessions} settings={settings} onSettings={onSettings}
        models={models} options={options} allModels={allModels} allOptions={allOptions}
        snapshots={snapshots} saved={saved} llmCalls={llmCalls} run={run} onForked={onForked}
        defaultForkPoint={defaultForkPoint} />
      <div
        className={`session-body${!mobile && paneFrac !== null ? " sized" : ""}`}
        ref={bodyRef}
        style={!mobile && paneFrac !== null ? ({ "--pane-width": `${paneFrac * 100}%` } as CSSProperties) : undefined}
      >
        <SessionChat session={session} models={models} options={options} items={items} context={context}
          saved={saved} focus={focus} onFocused={onFocused} mobile={mobile} run={run} draft={draft}
          showChat={showChat} pane={pane} setPane={setPane} togglePane={togglePane}
          branching={branching} branchActions={branchActions} openE2e={openE2e}
          composerMode={composerMode} setComposerMode={setComposerMode} composerHeight={composerHeight}
          setComposerHeight={setComposerHeight} setForkFrom={setForkFrom} setUtilQuickAdd={dialogs.setUtilQuickAdd}
          setInspecting={dialogs.setInspecting} setInspectingCall={setInspectingCall} />
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
        <SessionPane session={session} context={context} llmCalls={llmCalls} settings={settings}
          prs={prs} prItems={prItems} prChecks={prChecks} e2eRuns={e2eRuns} schedulesPane={schedulesPane}
          terminalFocus={terminalFocus} fsChange={fsChange} run={run} shown={shown} setPane={setPane}
          codeTarget={codeTarget} appTarget={appTarget} openPr={openPr} e2eEnabled={e2eEnabled}
          e2eFocus={e2eFocus} setE2eVerify={setE2eVerify} appendToComposer={appendToComposer}
          setInspectingCall={setInspectingCall} />
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
    </OpenApp.Provider>
    </OpenFile.Provider>
    </AttachmentSession.Provider>
  );
}

/**
 * The Sandbox image download, while it runs or after it failed: the first Session cannot start
 * before it is here, which took minutes of an unexplained "Creating…" otherwise.
 */
