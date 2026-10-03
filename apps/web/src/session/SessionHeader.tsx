import { useEffect, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";
import { DOCKER_MODE_LABELS, ENVIRONMENT_LABELS, PROVIDER_LABELS, VM_NO_SNAPSHOT, type PullRequest, type Snapshot } from "@sessionboxer/protocol";
import { api } from "../api";
import { DockerIcon } from "../DockerIcon";
import { EnvironmentIcon } from "../EnvironmentIcon";
import { Icon, type IconName } from "../Icons";
import { gitIdentityNote } from "../NewSession";
import { ProviderIcon } from "../ProviderIcon";
import { RepoChips, ReposButton } from "../Repos";
import { PRIVILEGED_WARNING } from "../SessionSettingsForm";
import { SessionSourceIcon, sessionSourceLabel, sessionSourceTitle } from "../SourceIcon";
import { utilityLabel } from "../UtilitiesEditor";
import { Menu, MenuItem, Select, Tip, cx } from "../ui";
import type { Pane, SessionViewProps } from "../SessionView";
import type { BranchActions } from "./SessionChat";
import type { useSessionDialogs } from "./SessionDialogs";

/** The panes with a tab of their own in the header; Context and Scheduled live in the header's "…" menu. */
export const PANES: Array<{ id: "desktop" | "terminal" | "code" | "app"; label: string; hint: string }> = [
  { id: "desktop", label: "Desktop", hint: "The Sandbox's Linux desktop: browser, editor, whatever the Agent opens" },
  { id: "terminal", label: "Terminal", hint: "A shell inside the Sandbox, alongside the one the Agent uses" },
  { id: "code", label: "Code", hint: "The files in the Sandbox's workspace, with the Agent's edits" },
  { id: "app", label: "App", hint: "An HTML file the Agent wrote, running sandboxed; reloads as the file changes" },
];
export const SCHEDULES_HINT = "Automations that prompt this Session";
const MENU_PANES: Array<{ id: "context" | "schedules"; icon: IconName; label: string; hint: string }> = [
  { id: "context", icon: "context", label: "Context", hint: "What the Agent is carrying in its context window, and the model calls behind it" },
  { id: "schedules", icon: "scheduled", label: "Scheduled", hint: SCHEDULES_HINT },
];

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

type Props = Pick<SessionViewProps, "session" | "settings" | "mobile" | "run" | "snapshotting" | "sessionSchedules" | "prs">
  & Pick<ReturnType<typeof useSessionDialogs>, "setForkFrom" | "setSyncOpen" | "setUsbOpen" | "setSettingsOpen" | "setReposOpen">
  & {
    pane: Pane;
    setPane: Dispatch<SetStateAction<Pane>>;
    togglePane: (id: Pane) => void;
    openPr: PullRequest | null;
    prUnread: number;
    e2eLive: boolean;
    e2eEnabled: boolean;
    branching: boolean;
    branchActions: BranchActions;
    isLive: boolean;
    latestSnapshot: Snapshot | undefined;
    defaultForkPoint: string | undefined;
  };

export function SessionHeader({
  session, settings, mobile, run, snapshotting, sessionSchedules, prs, pane, setPane, togglePane,
  openPr, prUnread, e2eLive, e2eEnabled, branching, branchActions, isLive,
  latestSnapshot, defaultForkPoint, setForkFrom, setSyncOpen, setUsbOpen, setSettingsOpen, setReposOpen,
}: Props) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setTitle(session.title), [session.title]);
  const copiedRepos = session.repos.filter((r) => r.source.type === "copy");
  const noSnapshot = VM_NO_SNAPSHOT[session.settings.sandbox.environment];
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

  return (
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
  );
}
