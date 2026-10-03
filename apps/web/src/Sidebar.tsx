import { useMemo, useState } from "react";
import {
  ENVIRONMENT_LABELS,
  PROVIDER_LABELS,
  type Automation,
  type FollowedPr,
  type PrFollow,
  type Provider,
  type ProviderModels,
  type ProviderOptions,
  type PublicSettings,
  type PullRequest,
  type SavedMessage,
  type Session,
  type SessionFolder,
  type SessionStatus,
  type Snapshot,
  VM_NO_SNAPSHOT,
} from "@sessionboxer/protocol";
import { api } from "./api";
import type { Route } from "./App";
import { SessionFamily } from "./SessionFamily";
import { BranchTree, type DividerRef } from "./BranchTree";
import { FORK_NOW, ForkDialog } from "./ForkDialog";
import { formatMb } from "./format";
import { ProviderIcon } from "./ProviderIcon";
import { DockerIcon } from "./DockerIcon";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { Icon } from "./Icons";
import { NoEntrySign } from "./Usage";
import { PRIVILEGED_WARNING } from "./SessionSettingsForm";
import { EMPTY_MODELS, EMPTY_OPTIONS, FolderNameDialog, type Runner } from "./SessionView";
import { RuntimeDialog, runtimesPresent } from "./NewSession";
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

/** A running Sandbox can fork from "now" (a snapshot is taken with the fork); a stopped one only from a snapshot. */
const isLiveSession = (s: Session) => s.status === "idle" || s.status === "running";

/** What a status dot means, spelled out: `idle` in particular is the Agent's turn being over. */
export function statusTitle(status: SessionStatus): string {
  return status === "idle" ? "waiting for you: the Agent finished its turn" : status;
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

/**
 * The session list: folders (ADR-0074) with drag-and-drop, one row per Session with its branch tree and
 * context menu, the set-up checklist and the page buttons. Owns only what no other part of the page
 * reads; the selection, the folders and the dialogs App renders arrive as props and callbacks.
 */
export function Sidebar({
  selectedId,
  sessions,
  folders,
  prs,
  prFollows,
  followedPrs,
  automations,
  settings,
  models,
  options,
  anyTokenSet,
  mobile,
  drawerOpen,
  setDrawerOpen,
  collapseSidebar,
  setRoute,
  setFocus,
  setSnapshotsFor,
  openPr,
  setProviderConnect,
  setGitConnect,
  run,
}: {
  selectedId: string | null;
  sessions: Session[];
  folders: SessionFolder[];
  /** Pull Requests attached per Session, for the unread badges. */
  prs: Record<string, PullRequest[]>;
  prFollows: PrFollow[];
  followedPrs: FollowedPr[];
  automations: Automation[];
  settings: PublicSettings | null;
  models: ProviderModels | null;
  options: ProviderOptions | null;
  anyTokenSet: boolean;
  mobile: boolean;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  collapseSidebar: (collapsed: boolean) => void;
  setRoute: (route: Route) => void;
  /** Turn divider the chat should scroll to (picked from a branch tree). */
  setFocus: (focus: (DividerRef & { sessionId: string }) | null) => void;
  /** Opens the Snapshots popup App renders for a Session that may not be the selected one. */
  setSnapshotsFor: (sessionId: string | null) => void;
  openPr: (sessionId: string, prId: string | null) => void;
  setProviderConnect: (connect: { provider: Provider | null } | null) => void;
  setGitConnect: (open: boolean) => void;
  run: Runner;
}) {
  // Sidebar entries whose branch tree is unfolded, and the Session whose branch is being switched from the tree.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [treeSwitching, setTreeSwitching] = useState<string | null>(null);
  // Sidebar folders (ADR-0074): the ones collapsed, the Session mid-drag and the row under it.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(loadCollapsedFolders);
  const [draggingSession, setDraggingSession] = useState<string | null>(null);
  /** Drop target under the pointer: a folder id, a Session's id (its folder is the target) or `"list"` (unfile). */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // The name dialog (new folder / rename) and a Fork dialog opened for a sidebar Session that may not be selected.
  const [folderDialog, setFolderDialog] = useState<{ mode: "new" | "rename"; folderId?: string; sessionId?: string } | null>(null);
  const [sidebarFork, setSidebarFork] = useState<{ sessionId: string; snapshots: Snapshot[]; saved: SavedMessage[] } | null>(null);
  const [sidebarForkBusy, setSidebarForkBusy] = useState(false);
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
    <>
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
                    <span className="muted">{anyTokenSet ? "done" : "Claude Code, Codex, Cursor, OpenCode, Devin, pi, fx or GitHub Copilot"}</span>
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
    </>
  );
}
