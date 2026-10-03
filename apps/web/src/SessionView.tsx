import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DOCKER_MODE_LABELS,
  ENVIRONMENT_LABELS,
  PROVIDERS,
  PROVIDER_LABELS,
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
  VM_NO_SNAPSHOT,
} from "@sessionboxer/protocol";
import { api, reportViewing } from "./api";
import { PANE_MAX_FRAC, PANE_MIN_FRAC, clampPane, loadSize, saveSize, startSplitterDrag } from "./splitter";
import { AttachmentSession } from "./Attachments";
import { AppPane, OpenApp, type FsChange } from "./HtmlArtifact";
import { usePendingAttachments } from "./attachments-pending";
import { type DividerRef } from "./BranchTree";
import { COMPOSER_MAX_FRAC, COMPOSER_MIN_FRAC, Composer, type ComposerMode } from "./Composer";
import { useDraftStore } from "./draft";
import { Desktop } from "./Desktop";
import { E2ePane, isRunOpen } from "./E2e";
import { FORK_NOW, ForkDialog } from "./ForkDialog";
import { formatMb } from "./format";
import { CompactionDialog } from "./CompactionDialog";
import { LlmCallDialog } from "./LlmCallDialog";
import { utilityLabel } from "./UtilitiesEditor";
import { UtilityQuickAdd, parseUtilCommand, type UtilCommand } from "./UtilityQuickAdd";
import { ModelSelect } from "./ModelSelect";
import { OptionSelects } from "./OptionSelect";
import { ProviderIcon } from "./ProviderIcon";
import { DockerIcon } from "./DockerIcon";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { Icon, type IconName } from "./Icons";
import { ContextGauge, ContextPane } from "./Context";
import { UsageBars, UsageLimitBar } from "./Usage";
import { type Compaction, type ContextState } from "./context-model";
import { PrPane, PrsPane } from "./PullRequests";
import { SavedMessages } from "./SavedMessages";
import { SessionSettingsDialog } from "./SessionSettingsDialog";
import {
  PRIVILEGED_WARNING,
} from "./SessionSettingsForm";
import { RepoChips, ReposButton, ReposDialog, githubAccounts } from "./Repos";
import { UsbDialog } from "./UsbDialog";
import {
  Menu,
  MenuItem,
  Modal,
  Select,
  Tip,
  cx,
} from "./ui";
import { SessionSourceIcon, sessionSourceLabel, sessionSourceTitle } from "./SourceIcon";
import { SyncDialog } from "./SyncDialog";
import { TerminalPane, type TerminalFocus } from "./Terminal";
import { CodePane, type CodeTarget } from "./Code";
import { OpenFile } from "./FileLink";
import type { FileRef } from "./file-links";
import { Transcript } from "./Transcript";
import { buildTranscript } from "./transcript-model";

/**
 * The transcript refetched after a reconnection, keeping what the socket delivered while the fetch
 * was in flight (events newer than the fetch's last one, for the same Session).
 */
import { gitIdentityNote } from "./NewSession";

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
/** The panes with a tab of their own in the header; Context and Scheduled live in the header's "…" menu. */
const PANES: Array<{ id: "desktop" | "terminal" | "code" | "app"; label: string; hint: string }> = [
  { id: "desktop", label: "Desktop", hint: "The Sandbox's Linux desktop: browser, editor, whatever the Agent opens" },
  { id: "terminal", label: "Terminal", hint: "A shell inside the Sandbox, alongside the one the Agent uses" },
  { id: "code", label: "Code", hint: "The files in the Sandbox's workspace, with the Agent's edits" },
  { id: "app", label: "App", hint: "An HTML file the Agent wrote, running sandboxed; reloads as the file changes" },
];
const SCHEDULES_HINT = "Automations that prompt this Session";
const MENU_PANES: Array<{ id: "context" | "schedules"; icon: IconName; label: string; hint: string }> = [
  { id: "context", icon: "context", label: "Context", hint: "What the Agent is carrying in its context window, and the model calls behind it" },
  { id: "schedules", icon: "scheduled", label: "Scheduled", hint: SCHEDULES_HINT },
];

function loadPane(): Pane {
  const v = localStorage.getItem("sessionboxer.pane");
  return v === "chat" || v === "desktop" || v === "code" || v === "terminal" || v === "app" || v === "context" || v === "prs" || v === "e2e" || v === "schedules" || v === "hidden"
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

/**
 * One tab of the header's pane switcher. Hand-written rather than ui/Tabs: a click on the active one hides
 * the pane, which a one-of-N tab list cannot express.
 */
function PaneTab({ icon, active, tip, className, onClick, children }: { icon: IconName; active: boolean; tip: string; className?: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tip text={tip}>
      <button role="tab" aria-selected={active} className={cx(active && "active", className)} onClick={onClick}>
        <Icon name={icon} />
        {children}
      </button>
    </Tip>
  );
}

/** The Session's secondary actions: a "…" dropdown on a desktop, plain buttons inside the phone's action sheet. */
function SessionMenu({ items, mobile, pending }: { items: SessionMenuItem[]; mobile: boolean; pending: boolean }) {
  const content = (it: SessionMenuItem) => (
    <>
      <Icon name={it.icon} />
      {it.label}
      {it.count !== undefined && it.count > 0 && <span className="count">{it.count}</span>}
      {it.pending && <span className="warn-sign">pending</span>}
    </>
  );
  const itemClass = (it: SessionMenuItem) => cx(it.danger && "danger", it.active && "active", it.pending && "pending");
  if (mobile) {
    return (
      <>
        {items.map((it) => (
          <button key={it.key} type="button" className={itemClass(it)} disabled={it.disabled} title={it.title} onClick={it.onPick}>
            {content(it)}
          </button>
        ))}
      </>
    );
  }
  return (
    <Menu
      align="end"
      trigger={
        <Tip text={pending ? "More (a settings change applies when the current turn ends)" : "Context, Scheduled, Snapshot, Fork, Session settings, Stop, Delete"}>
          <button type="button" className={cx("more-menu", pending && "pending")} aria-label="More">
            {"\u22ef"}
          </button>
        </Tip>
      }
    >
      {items.map((it) => (
        <MenuItem key={it.key} className={cx("session-menu-item", itemClass(it))} disabled={it.disabled} title={it.title} onSelect={it.onPick}>
          {content(it)}
        </MenuItem>
      ))}
    </Menu>
  );
}

function loadComposerMode(): ComposerMode {
  return localStorage.getItem("sessionboxer.composerMode") === "rich" ? "rich" : "raw";
}

function loadComposerHeight(): number | null {
  const v = Number(localStorage.getItem("sessionboxer.composerHeight"));
  return v >= COMPOSER_MIN_FRAC && v <= COMPOSER_MAX_FRAC ? v : null;
}

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
}: {
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
}) {
  const draft = useDraftStore();
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [forkFrom, setForkFrom] = useState<string | null>(null);
  const [forkWithSettings, setForkWithSettings] = useState(false);
  const [forking, setForking] = useState(false);
  const [branching, setBranching] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [utilQuickAdd, setUtilQuickAdd] = useState<UtilCommand | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [inspecting, setInspecting] = useState<{ index: number; compaction: Compaction } | null>(null);
  const [inspectingCall, setInspectingCall] = useState<LlmCall | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [reposOpen, setReposOpen] = useState(false);
  const [usbOpen, setUsbOpen] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [usageBusy, setUsageBusy] = useState(false);
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

  const canPrompt = session.status === "idle" || session.status === "running";
  const attachError = useCallback((message: string) => void run(() => Promise.reject(new Error(message))), [run]);
  const attachments = usePendingAttachments(session.id, canPrompt, attachError);
  const send = () => {
    const text = draft.get();
    const t = text.trim();
    const files = attachments.attachments;
    if (!canPrompt || (!t && files.length === 0)) return;
    if (attachments.items.length !== files.length) return;
    // `/util …` registers a Utility from the composer without the credentials ever entering the transcript (ADR-0073).
    const util = parseUtilCommand(t);
    draft.set("");
    if (util) {
      setUtilQuickAdd(util);
      return;
    }
    void run(async () => {
      try {
        await api.prompt(session.id, files.length > 0 ? { text: t, attachments: files } : { text: t });
      } catch (e) {
        draft.set((cur) => (cur.trim() === "" ? text : cur));
        throw e;
      }
      attachments.clear();
    });
  };
  const enqueue = () => {
    const t = draft.get().trim();
    if (!t) return;
    draft.set("");
    void run(() => api.enqueueMessage(session.id, t));
  };
  const translateToEnglish = useCallback(
    async (selected: string) => cleanTranslation((await api.ask(session.id, translationPrompt(selected))).text, selected),
    [session.id],
  );

  const copiedRepos = session.repos.filter((r) => r.source.type === "copy");
  const isLive = session.status === "idle" || session.status === "running";
  const noSnapshot = VM_NO_SNAPSHOT[session.settings.sandbox.environment];
  const latestSnapshot = snapshots[snapshots.length - 1];
  // A running Sandbox forks from now (a snapshot is taken with the fork); a stopped one only from an existing snapshot.
  const defaultForkPoint = isLive ? FORK_NOW : latestSnapshot?.id;
  const mcpActive = (settings?.mcpServers ?? []).filter((s) => session.settings.mcpEnabled.includes(s.id));
  const utilitiesActive = (settings?.utilities ?? []).filter((u) => session.settings.utilitiesEnabled.includes(u.id));
  const settingsPending = session.mcpPending || session.modelPending || session.optionsPending || session.inspectLlmPending;
  const settingsSummary = [
    mcpActive.length === 0 ? "MCP: desktop only" : `MCP: desktop, ${mcpActive.map((s) => s.name).join(", ")}`,
    utilitiesActive.length === 0 ? "Utilities: none" : `Utilities: ${utilitiesActive.map((u) => `${utilityLabel(u)} (${u.environment})`).join(", ")}`,
    session.settings.instructions.trim() === "" ? "Instructions: none" : "Instructions: set",
    ...(session.provider === "claude-code" ? [`Inspect LLM: ${session.settings.inspectLlm ? "on" : "off"}`] : []),
    ...(settingsPending ? ["A change applies when the current turn ends"] : []),
  ].join("\n");
  const canStop = (session.status === "idle" || session.status === "running" || session.status === "error") && session.containerId !== null;
  const menuItems: SessionMenuItem[] = [
    ...MENU_PANES.map(
      (p): SessionMenuItem => ({
        key: p.id,
        icon: p.icon,
        label: p.label,
        title: `${p.hint}. Click to ${pane === p.id ? "hide" : "show"} it.`,
        active: pane === p.id,
        count: p.id === "schedules" ? sessionSchedules : undefined,
        onPick: () => togglePane(p.id),
      }),
    ),
    {
      key: "snapshot",
      icon: "snapshot",
      label: snapshotting ? "Snapshotting\u2026" : "Snapshot",
      title: noSnapshot ?? (isLive ? "docker commit the Sandbox now (a fork point)" : "Snapshots need a running Sandbox"),
      disabled: noSnapshot !== undefined || !isLive || snapshotting,
      onPick: () => void run(() => api.createSnapshot(session.id)),
    },
    {
      key: "fork",
      icon: "fork",
      label: "Fork\u2026",
      title:
        noSnapshot ??
        (isLive
          ? "New Session and Sandbox from this one as it is now (a snapshot is taken), or from an earlier snapshot"
          : latestSnapshot
            ? "New Session and Sandbox from a snapshot of this one"
            : "Start the Sandbox to fork it (there is no snapshot yet)"),
      disabled: noSnapshot !== undefined || !defaultForkPoint,
      onPick: () => defaultForkPoint && setForkFrom(defaultForkPoint),
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
      key: "usb",
      icon: "usb",
      label: session.usb ? `USB: ${session.usb.name}` : "Connect USB device\u2026",
      title: session.usb
        ? `${session.usb.name} is ${session.usb.node ?? "unplugged"} in the Sandbox. Click to change or disconnect it.`
        : "Give the Agent one USB device of this machine (its /dev/bus/usb node in the Sandbox; one Session per device)",
      active: session.usb !== null,
      onPick: () => setUsbOpen(true),
    },
    {
      key: "pin",
      icon: "pin",
      label: session.pinned ? "Unpin" : "Pin to top",
      title: session.pinned ? "Let the Session back into date order in the list" : "Keep the Session at the top of the list, whatever its age",
      active: session.pinned,
      onPick: () => void run(() => api.updateSession(session.id, { pinned: !session.pinned })),
    },
    {
      key: "settings",
      icon: "settings",
      label: "Session settings",
      title: `Session settings: Machine, Agent, MCP & connectors, Utilities, Auto QA, Debug\n${settingsSummary}`,
      disabled: !settings,
      pending: settingsPending,
      count: mcpActive.length + utilitiesActive.length,
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
    <OpenApp.Provider value={openApp}>
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
        {session.settings.sandbox.environment === "qemu-windows" && (
          <span className="session-env" title={`${ENVIRONMENT_LABELS["qemu-windows"]}: the agent, its MCP servers, git and the Terminal run inside the Windows VM (Workspace C:\\workspace); the Desktop shows it over RDP`}>
            <EnvironmentIcon environment="qemu-windows" size={18} />
            {mobile && <span className="muted">{ENVIRONMENT_LABELS["qemu-windows"]}</span>}
          </span>
        )}
        {session.settings.sandbox.environment === "qemu-macos" && (
          <span className="session-env" title={`${ENVIRONMENT_LABELS["qemu-macos"]}: the agent, its MCP servers, git and the Terminal (zsh) run inside a macOS VM, with the Workspace at /Users/agent/workspace; the Desktop shows it over VNC`}>
            <EnvironmentIcon environment="qemu-macos" size={18} />
            {mobile && <span className="muted">{ENVIRONMENT_LABELS["qemu-macos"]}</span>}
          </span>
        )}
        {session.repos.length > 0 ? (
          mobile ? (
            <>
              <RepoChips session={session} onClick={() => setReposOpen(true)} />
              <Tip text="Add repository…">
                <button className="icon-button" aria-label="Add repository…" onClick={() => setReposOpen(true)}>
                  +
                </button>
              </Tip>
            </>
          ) : (
            <ReposButton session={session} onManage={() => setReposOpen(true)} />
          )
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
            <Select<string>
              value={session.activeBranchId}
              disabled={branching || session.status !== "idle"}
              onChange={(id) => branchActions.onSwitch(id)}
              aria-label="Conversation branch"
              className="compact"
              options={session.branches.map((b) => ({
                value: b.id,
                label: b.name,
                hint: b.forkedAtSeq !== null ? `from ${session.branches.find((p) => p.id === b.parentId)?.name ?? "?"}` : undefined,
              }))}
            />
            {branching && <span className="muted">switching…</span>}
          </label>
        )}
        <span className="spacer" />
        <div className="header-tabs">
        <div className="segmented" role="tablist" aria-label="Side pane">
          {PANES.map((p) => (
            <PaneTab key={p.id} icon={p.id} active={pane === p.id} tip={`${p.hint}. Click to ${pane === p.id ? "hide" : "show"} it.`} onClick={() => togglePane(p.id)}>
              {p.label}
            </PaneTab>
          ))}
          <PaneTab
            icon="prs"
            active={pane === "prs" || openPr !== null}
            tip={
              openPr
                ? "Back to the list of pull requests"
                : pane === "prs"
                  ? "Hide pull requests"
                  : `Pull requests attached to this Session${prs.length > 0 ? ` (${prs.length}${prUnread > 0 ? `, ${prUnread} unread` : ""})` : ""}`
            }
            onClick={() => (openPr ? setPane("prs") : togglePane("prs"))}
          >
            PRs{prUnread > 0 && <span className="count">{prUnread}</span>}
          </PaneTab>
          <PaneTab
            icon="verification"
            active={pane === "e2e"}
            className={cx(e2eLive && "e2e-tab-live", e2eEnabled && "e2e-tab-on")}
            tip={pane === "e2e" ? "Hide the Auto QA runs" : `End-to-end verification of the Agent's turns${e2eLive ? " (running now)" : e2eEnabled ? "" : " (off for this Session)"}`}
            onClick={() => togglePane("e2e")}
          >
            Auto QA{e2eLive && <span className="count live">●</span>}
          </PaneTab>
        </div>
        {(session.status === "stopped" || session.status === "error") && (
          <Tip text="Start the Sandbox again; the Agent picks up its conversation">
            <button onClick={() => void run(() => api.resume(session.id))}>
              <Icon name="resume" /> Resume
            </button>
          </Tip>
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
            defaultForkPoint
              ? () => {
                  setSettingsOpen(false);
                  setForkWithSettings(true);
                  setForkFrom(defaultForkPoint);
                }
              : null
          }
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {utilQuickAdd && settings && <UtilityQuickAdd command={utilQuickAdd} session={session} settings={settings} onSettings={onSettings} onClose={() => setUtilQuickAdd(null)} />}
      {inspecting && <CompactionDialog session={session} compaction={inspecting.compaction} index={inspecting.index} onClose={() => setInspecting(null)} />}
      {inspectingCall && <LlmCallDialog session={session} call={inspectingCall} calls={llmCalls} onClose={() => setInspectingCall(null)} />}
      {syncOpen && <SyncDialog session={session} onClose={() => setSyncOpen(false)} />}
      {reposOpen && <ReposDialog session={session} accounts={githubAccounts(settings)} onClose={() => setReposOpen(false)} />}
      {usbOpen && <UsbDialog session={session} sessions={sessions} onClose={() => setUsbOpen(false)} />}
      {forkFrom && settings && (
        <ForkDialog
          session={session}
          settings={settings}
          models={{ ...allModels, [session.provider]: models }}
          options={{ ...allOptions, [session.provider]: options }}
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
            running={session.status === "running"}
            focus={focus}
            onFocused={onFocused}
            onInspectCompaction={(index, compaction) => setInspecting({ index, compaction })}
            onInspectLlmCall={setInspectingCall}
            onOpenE2e={openE2e}
            onOpenPane={(p) => (p === "e2e" ? openE2e(null) : setPane(p as Pane))}
            agent={{ sessionId: session.id, label: PROVIDER_LABELS[session.provider], draft }}
          />
          <Composer
            draft={draft}
            onSend={send}
            onEnqueue={enqueue}
            running={session.status === "running"}
            onStop={() => void run(() => api.cancel(session.id))}
            above={
              <>
                <SavedMessages
                  messages={saved}
                  queueRunning={session.queueRunning}
                  canSend={canPrompt}
                  onLoad={(m) => draft.set(m.text)}
                  onSend={(m) => void run(() => api.sendSavedMessage(session.id, m.id))}
                  onDelete={(m) => void run(() => api.deleteSavedMessage(session.id, m.id))}
                  onMove={(m, position) => void run(() => api.updateSavedMessage(session.id, m.id, { position }))}
                  onQueueToggle={(running) => void run(() => api.setQueueRunning(session.id, running))}
                />
                <UsageLimitBar
                  usage={session.usage}
                  provider={session.provider}
                  canContinue={session.status === "idle"}
                  busy={usageBusy}
                  onContinue={() => {
                    setUsageBusy(true);
                    void run(() => api.continueAfterLimit(session.id)).finally(() => setUsageBusy(false));
                  }}
                  onAutoContinue={(enabled) => {
                    setUsageBusy(true);
                    void run(() => api.setAutoContinue(session.id, enabled)).finally(() => setUsageBusy(false));
                  }}
                />
                <UsageBars usage={session.usage} provider={session.provider} />
                <ContextGauge context={context} active={pane === "context"} onOpen={() => togglePane("context")} />
              </>
            }
            footerStart={
              <>
                {showModelSelect && (
                  <ModelSelect compact models={models} value={session.settings.model} onChange={changeModel} disabled={modelBusy} pending={session.modelPending} />
                )}
                <OptionSelects compact options={options} values={session.settings.options} onChange={changeOption} disabled={modelBusy} pending={session.optionsPending} />
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
        {shown === "app" && <AppPane session={session} path={appTarget} change={fsChange} />}
        {shown === "terminal" && <TerminalPane session={session} focus={terminalFocus} />}
        {shown === "context" && <ContextPane session={session} context={context} llmCalls={llmCalls} onInspectLlmCall={setInspectingCall} run={run} />}
        {shown === "prs" && <PrsPane session={session} prs={prs} run={run} onOpen={(id) => setPane(`pr:${id}`)} />}
        {shown === "schedules" && <div className="pane schedules-pane">{schedulesPane}</div>}
        {shown === "e2e" && (
          <E2ePane
            session={session}
            runs={e2eRuns}
            enabled={e2eEnabled}
            globalEnabled={settings?.e2eVerify ?? false}
            focusRunId={e2eFocus}
            onToggle={setE2eVerify}
            onRunNow={() => void run(() => api.e2eRunNow(session.id))}
          />
        )}
        {openPr && (
          <PrPane
            session={session}
            pr={openPr}
            items={prItems[openPr.id] ?? null}
            checks={prChecks[openPr.id] ?? null}
            run={run}
            onPromptText={appendToComposer}
            onBack={() => setPane("prs")}
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
    </OpenApp.Provider>
    </OpenFile.Provider>
    </AttachmentSession.Provider>
  );
}

/**
 * The Sandbox image download, while it runs or after it failed: the first Session cannot start
 * before it is here, which took minutes of an unexplained "Creating…" otherwise.
 */
