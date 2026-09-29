import { useEffect, useState, type ReactNode } from "react";
import {
  CONNECTORS,
  DOCKER_MODE_LABELS,
  ENVIRONMENT_LABELS,
  PROVIDER_LABELS,
  type Environment,
  applyNote,
  instructionsDelivery,
  type AgentOption,
  type AgentToolsPolicy,
  type ModelOption,
  type OptionValues,
  type Provider,
  type PublicSettings,
  type Session,
  type SessionSettings,
  type SessionSettingsInput,
} from "@sessionboxer/protocol";
import { summarize } from "./mcp";
import { ModelSelect } from "./ModelSelect";
import { OptionSelects } from "./OptionSelect";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { Caption, Help, Select } from "./ui";
import { AgentToolsSelect, ApproveCreateSelect } from "./SessionToolsPolicy";

/** How `instructions` reach the Agent of a Provider, in one sentence for the UI. */
export function deliveryNote(provider: Provider): string {
  return instructionsDelivery(provider) === "system-prompt"
    ? `${PROVIDER_LABELS[provider]} gets them appended to its system prompt (every turn, before the conversation).`
    : `${PROVIDER_LABELS[provider]} has no system-prompt hook: they are prepended to the first message of the conversation (again after a rewind that replays the transcript).`;
}

export const PRIVILEGED_WARNING =
  "This Sandbox runs with --privileged: the Agent can escape to the host (root-equivalent). Install Sysbox for isolated nested Docker.";

/** Explains what "Docker inside Sandboxes" means on this host (ADR-0008). */
export function DockerModeNote({ settings, enabled }: { settings: PublicSettings; enabled: boolean }) {
  if (settings.dockerModeAvailable === "sysbox") {
    return <p className="muted">Sysbox runtime detected: Docker-enabled Sandboxes get a private, unprivileged Docker daemon.</p>;
  }
  if (settings.hostPlatform !== "linux") {
    // Sysbox is a Linux runtime: on macOS and Windows the Sandboxes live in Docker's own Linux VM, so there is nothing to install here.
    return (
      <p className="muted">
        Docker-enabled Sandboxes run with <code>--privileged</code>: the Agent can escape to Docker&apos;s Linux VM (which has the folders you shared
        with Docker), so only run code you trust. Isolated nested Docker (Sysbox) is available on Linux hosts only.
      </p>
    );
  }
  return (
    <div className="banner banner-warn" role="alert">
      <strong>Sysbox runtime not installed on this host.</strong>{" "}
      {enabled
        ? "Docker-enabled Sandboxes fall back to --privileged: the Agent can escape to your host (root-equivalent), so only run code you trust."
        : "Enabling Docker would fall back to --privileged, which lets the Agent escape to your host (root-equivalent)."}{" "}
      Install Sysbox (Linux, <code>sysbox-ce</code> .deb from github.com/nestybox/sysbox), then reload this page.
    </div>
  );
}

/** Every per-Session setting as the form edits it (Docker is a yes/no here; the host picks the mode). */
export interface SessionSettingsDraft {
  model: string | null;
  options: OptionValues;
  inspectLlm: boolean;
  mcpEnabled: string[];
  instructions: string;
  autoSnapshot: boolean | null;
  snapshotKeep: number | null;
  /** Verify each turn end to end (ADR-0044); `null` follows Settings. */
  e2eVerify: boolean | null;
  /** What the `sessionboxer` MCP lets the Agent do (ADR-0062); `null` follows Settings. */
  agentTools: AgentToolsPolicy | null;
  approveCreate: boolean | null;
  /** Where the desktop runs (ADR-0057); fixed once the Session exists, a fork keeps the origin's. */
  environment: Environment;
  /** Start from this Snapshot's image instead of a fresh one (ADR-0069); `environment` is then the Snapshot's. Creation only. */
  snapshotId: string | null;
  docker: boolean;
  cpus: number | null;
  memoryGb: number | null;
  gitName: string;
  gitEmail: string;
}

/** A new Session starts from the global Settings. */
export function draftFromDefaults(settings: PublicSettings): SessionSettingsDraft {
  return {
    model: null,
    options: {},
    inspectLlm: true,
    mcpEnabled: settings.mcpServers.filter((s) => s.enabledByDefault).map((s) => s.id),
    instructions: settings.instructions,
    autoSnapshot: null,
    snapshotKeep: null,
    e2eVerify: null,
    agentTools: null,
    approveCreate: null,
    environment: "docker-linux",
    snapshotId: null,
    docker: settings.dockerInSandbox,
    cpus: null,
    memoryGb: null,
    gitName: settings.gitUserName || settings.hostGitIdentity.name,
    gitEmail: settings.gitUserEmail || settings.hostGitIdentity.email,
  };
}

/** A fork (or the live dialog) starts from what the Session has. */
export function draftFromSettings(s: SessionSettings): SessionSettingsDraft {
  return {
    model: s.model,
    options: s.options,
    inspectLlm: s.inspectLlm,
    mcpEnabled: s.mcpEnabled,
    instructions: s.instructions,
    autoSnapshot: s.autoSnapshot,
    snapshotKeep: s.snapshotKeep,
    e2eVerify: s.e2eVerify,
    agentTools: s.agentTools,
    approveCreate: s.approveCreate,
    environment: s.sandbox.environment,
    snapshotId: null,
    docker: s.sandbox.dockerMode !== "none",
    cpus: s.sandbox.cpus,
    memoryGb: s.sandbox.memoryGb,
    gitName: s.sandbox.gitIdentity.name,
    gitEmail: s.sandbox.gitIdentity.email,
  };
}

/** The `settings` of a create/fork request. */
export function draftToInput(d: SessionSettingsDraft): SessionSettingsInput {
  return {
    model: d.model,
    options: d.options,
    inspectLlm: d.inspectLlm,
    mcpEnabled: d.mcpEnabled,
    instructions: d.instructions,
    autoSnapshot: d.autoSnapshot,
    snapshotKeep: d.snapshotKeep,
    e2eVerify: d.e2eVerify,
    agentTools: d.agentTools,
    approveCreate: d.approveCreate,
    sandbox: {
      environment: d.environment,
      docker: d.docker,
      cpus: d.cpus,
      memoryGb: d.memoryGb,
      gitIdentity: { name: d.gitName.trim(), email: d.gitEmail.trim() },
    },
  };
}

export type SessionSettingsMode = "create" | "fork" | "live";

export type SessionSettingsSection = "environment" | "agent" | "mcp" | "qa" | "debug";

/** The sections of the form in display order, for a split view's navigation; Debug (Inspect LLM) is Claude Code only. */
export function sessionSettingsSections(provider: Provider): Array<{ id: SessionSettingsSection; label: string }> {
  return [
    { id: "environment", label: "Environment" },
    { id: "agent", label: "Agent" },
    { id: "mcp", label: "MCP & connectors" },
    { id: "qa", label: "Auto QA" },
    ...(provider === "claude-code" ? [{ id: "debug" as const, label: "Debug" }] : []),
  ];
}

export const DESKTOP_MCP_DOCS = "https://sessionboxer.talayolabs.com/guide/mcp-tools/#the-desktop-server";
export const SESSIONBOXER_MCP_DOCS = "https://sessionboxer.talayolabs.com/guide/mcp-tools/#the-sessionboxer-server";

type OnOff = "default" | "on" | "off";
const onOff = (v: boolean | null): OnOff => (v === null ? "default" : v ? "on" : "off");
const fromOnOff = (v: OnOff): boolean | null => (v === "default" ? null : v === "on");

/**
 * The one place a Session is configured: the New Session form (`create`, prefilled from the global
 * Settings), the Fork dialog (`fork`, prefilled from the origin) and the Session settings dialog
 * (`live`, where each control saves as it changes and creation-only values are read-only).
 * Sections — Environment, Agent, MCP & connectors, Auto QA, Debug — each a group of captions with the
 * explanations behind a "?".
 */
export function SessionSettingsForm({
  mode,
  provider,
  session,
  settings,
  models,
  options,
  value,
  onChange,
  disabled = false,
  onFork,
  only,
}: {
  mode: SessionSettingsMode;
  provider: Provider;
  /** The Session being edited (`live`) or forked (`fork`): status and pending flags. */
  session?: Session;
  settings: PublicSettings;
  models: ModelOption[];
  options: AgentOption[];
  value: SessionSettingsDraft;
  onChange: (patch: Partial<SessionSettingsDraft>) => void;
  disabled?: boolean;
  /** `live`: opens the Fork dialog, the way to change the creation-only values. */
  onFork?: () => void;
  /** Render this one section (a split view shows one at a time); all of them otherwise. */
  only?: SessionSettingsSection;
}) {
  const show = (section: SessionSettingsSection) => only === undefined || only === section;
  const live = mode === "live";
  const status = session?.status ?? "idle";
  const frozen = live;
  const pending = live && session ? session : null;
  const defaultDraft = draftFromDefaults(settings);
  const canInspect = provider === "claude-code";
  const enabledMcp = new Set(value.mcpEnabled);
  const providerLabel = PROVIDER_LABELS[provider];
  const dockerMode = session?.settings.sandbox.dockerMode ?? (value.docker ? settings.dockerModeAvailable : "none");
  const environment = session?.settings.sandbox.environment ?? value.environment;
  const vm = environment !== "docker-linux";
  const guest = environment === "qemu-macos" ? "macOS" : "Windows";
  // A fork keeps the origin's Environment: its snapshot is a disk of that kind.
  const environmentFixed = frozen || mode === "fork";
  const gitServers = settings.mcpServers.filter((s) => s.connector !== null);
  const customServers = settings.mcpServers.filter((s) => s.connector === null);
  const fixed = <span className="ss-lock">(fixed for the Session)</span>;

  const mcpSwitch = (s: PublicSettings["mcpServers"][number]) => (
    <li key={s.id}>
      <label className="check switch">
        <input
          type="checkbox"
          checked={enabledMcp.has(s.id)}
          disabled={disabled}
          onChange={(e) => onChange({ mcpEnabled: e.target.checked ? [...value.mcpEnabled, s.id] : value.mcpEnabled.filter((id) => id !== s.id) })}
        />
        <span className="slider" aria-hidden="true" />
        <span className="mcp-name">{s.connector ? CONNECTORS[s.connector.kind].label : s.name}</span>
        {s.connector ? (
          <span className="muted mcp-summary">{s.connector.account ? `@${s.connector.account}` : "not connected"}{s.connector.host ? ` · ${s.connector.host}` : ""}</span>
        ) : (
          <>
            <span className="muted mcp-transport">{s.transport}</span>
            <span className="muted mcp-summary" title={summarize(s)}>
              {summarize(s)}
            </span>
          </>
        )}
      </label>
    </li>
  );

  return (
    <div className="ss-form">
      {show("environment") && (
        <section className="ss-section">
          <h3>Environment</h3>
          {environmentFixed ? (
            <p className="muted ss-fixed">
              Environment: {ENVIRONMENT_LABELS[environment]} <span className="ss-lock">(fixed for the Session{mode === "fork" ? " and its forks" : ""})</span>
              <Help>{environmentNote(settings, environment)}</Help>
            </p>
          ) : (
            <label>
              <Caption help={environmentNote(settings, value.environment)}>Environment</Caption>
              <EnvironmentPicker
                value={{ environment: value.environment, snapshotId: value.snapshotId }}
                disabled={disabled}
                environmentOption={(env) => ({
                  disabled: !settings.environments[env].available,
                  hint: settings.environments[env].available ? undefined : (settings.environments[env].reason ?? "Not available on this host"),
                })}
                onEnvironment={(environment) => onChange({ environment, snapshotId: null })}
                onSnapshot={(s) => onChange({ environment: s.environment, snapshotId: s.id })}
              />
              {value.snapshotId && (
                <span className="field-hint">
                  The Sandbox starts from that snapshot — its files, installed tools and repositories, on {ENVIRONMENT_LABELS[value.environment]} — with an empty conversation for the agent
                  picked here.
                </span>
              )}
            </label>
          )}
          {!vm &&
            (frozen ? (
              <p className="muted ss-fixed">
                Docker inside the Sandbox: {dockerMode === "none" ? "off" : DOCKER_MODE_LABELS[dockerMode]} {fixed}
                {dockerMode === "privileged" && <span className="warn"> {PRIVILEGED_WARNING}</span>}
              </p>
            ) : (
              <label className="check switch">
                <input type="checkbox" checked={value.docker} disabled={disabled} onChange={(e) => onChange({ docker: e.target.checked })} />
                <span className="slider" aria-hidden="true" />
                <Caption help={<DockerModeNote settings={settings} enabled={value.docker} />}>
                  Docker inside the Sandbox ({DOCKER_MODE_LABELS[settings.dockerModeAvailable]})
                </Caption>
              </label>
            ))}

          <h4 className="ss-sub">
            <Caption
              help={
                <>
                  <p>
                    Limits of the Sandbox container; empty means the Global settings default. {live ? applyNote(status, "next-sandbox") : ""}
                  </p>
                  {vm && (
                    <p>
                      The {guest} VM has its own RAM and vCPUs, set in Global settings → Environment → {guest} VMs.
                    </p>
                  )}
                </>
              }
            >
              Limits
            </Caption>
          </h4>
          <div className="row">
            <NumberField
              label="CPUs"
              value={value.cpus}
              placeholder={`Settings default (${settings.sandboxCpus})`}
              min={0.5}
              step={0.5}
              disabled={disabled}
              onCommit={(cpus) => onChange({ cpus })}
            />
            <NumberField
              label="Memory (GB)"
              value={value.memoryGb}
              placeholder={`Settings default (${settings.sandboxMemoryGb})`}
              min={0.5}
              step={0.5}
              disabled={disabled}
              onCommit={(memoryGb) => onChange({ memoryGb })}
            />
          </div>

          <h4 className="ss-sub">
            <Caption
              help={
                vm ? (
                  <p>Snapshots, forks and rebuilds are not available for {guest} Sessions yet: the VM disk lives outside the Sandbox image.</p>
                ) : (
                  <p>
                    A snapshot is an image of the whole box (files, installed tools, the agent&apos;s conversation) you can fork from or go back to.
                    Automatic ones are taken after every completed turn; older ones are dropped down to the number kept (never one a fork was started
                    from), 0 keeps them all.
                  </p>
                )
              }
            >
              Snapshots
            </Caption>
          </h4>
          <label>
            Snapshot automatically after every completed turn
            <Select<OnOff>
              value={onOff(value.autoSnapshot)}
              disabled={disabled || vm}
              onChange={(v) => onChange({ autoSnapshot: fromOnOff(v) })}
              aria-label="Snapshot automatically after every completed turn"
              options={[
                { value: "default", label: `Settings default (${settings.autoSnapshot ? "on" : "off"})` },
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
          </label>
          <NumberField
            label="Automatic snapshots to keep"
            value={value.snapshotKeep}
            placeholder={`Settings default (${settings.snapshotKeep === 0 ? "all" : settings.snapshotKeep})`}
            min={0}
            step={1}
            disabled={disabled || vm}
            onCommit={(snapshotKeep) => onChange({ snapshotKeep })}
          />
          {live && onFork && !vm && (
            <div className="ss-fork">
              <button type="button" onClick={onFork} disabled={disabled}>
                Fork with different settings…
              </button>
              <Help>A fork is a new Session from a snapshot of this one; the Environment, Docker, the system prompt and the git identity can differ there.</Help>
            </div>
          )}
        </section>
      )}

      {show("agent") && (
        <section className="ss-section">
          <h3>
            Agent
            {(pending?.modelPending || pending?.optionsPending) && <span className="warn-sign">pending</span>}
          </h3>
          {live && (
            <p className="muted ss-fixed">
              Provider: {providerLabel} {fixed}
            </p>
          )}
          {mode === "create" && (
            <p className="muted ss-fixed">
              Model: {value.model ?? `${providerLabel}'s default`} <span className="ss-lock">(picked under the prompt box)</span>
            </p>
          )}
          {models.length > 0 || value.model !== null ? (
            <>
              {mode !== "create" && (
                <ModelSelect
                  models={models}
                  value={value.model}
                  onChange={(model) => onChange({ model })}
                  allowDefault={!live}
                  disabled={disabled}
                  pending={pending?.modelPending ?? false}
                />
              )}
              <OptionSelects
                options={options}
                values={value.options}
                allowDefault={!live}
                disabled={disabled}
                pending={pending?.optionsPending ?? false}
                onChange={(id, v) => {
                  const next = { ...value.options };
                  if (v === null) delete next[id];
                  else next[id] = v;
                  onChange({ options: next });
                }}
              />
              {live && (
                <Help>
                  {applyNote(status, "immediate")} Also in the composer footer.
                </Help>
              )}
            </>
          ) : (
            <p className="muted ss-fixed">
              Fast mode and effort: {providerLabel}&apos;s defaults{" "}
              <span className="ss-lock">
                (the choices appear once a {providerLabel} session has started{live ? "" : "; you can switch them from the chat afterwards"})
              </span>
            </p>
          )}

          <h4 className="ss-sub">
            <Caption
              help={
                <p>
                  Instructions the Agent gets on top of the Sandbox briefing, fixed once the Session exists. {deliveryNote(provider)} The default for
                  new Sessions is in <a href="#/settings/agent">Global settings → Agent</a>.
                </p>
              }
            >
              System prompt
            </Caption>
          </h4>
          {frozen ? (
            value.instructions.trim() === "" ? (
              <p className="empty ss-empty">None: this Session&apos;s Agent only has the Sandbox briefing and the project&apos;s own instruction files.</p>
            ) : (
              <pre className="instructions-text">{value.instructions}</pre>
            )
          ) : (
            <label>
              <span className="label-row">
                <span className="muted">Empty for none</span>
                {value.instructions !== settings.instructions && (
                  <button type="button" className="link" onClick={() => onChange({ instructions: settings.instructions })}>
                    Reset to the Settings default
                  </button>
                )}
              </span>
              <textarea rows={4} value={value.instructions} onChange={(e) => onChange({ instructions: e.target.value })} spellCheck={false} disabled={disabled} />
            </label>
          )}
        </section>
      )}

      {show("mcp") && (
        <section className="ss-section">
          <h3>
            MCP &amp; connectors
            {pending?.mcpPending && <span className="warn-sign">pending</span>}
          </h3>
          {pending?.mcpPending && (
            <div className="banner banner-warn dialog-banner" role="status">
              Change pending: the Agent is busy, the new set applies when the current turn ends.
            </div>
          )}
          <ul className="mcp-switches builtin">
            <li>
              <label className="check switch">
                <input type="checkbox" checked disabled readOnly />
                <span className="slider" aria-hidden="true" />
                <span className="mcp-name">desktop</span>
                <span className="muted mcp-summary">screen, mouse, keyboard</span>
                <span className="muted ss-always">
                  Always on ·{" "}
                  <a href={DESKTOP_MCP_DOCS} target="_blank" rel="noreferrer">
                    more info
                  </a>
                </span>
              </label>
            </li>
            <li>
              <label className="check switch">
                <input type="checkbox" checked disabled readOnly />
                <span className="slider" aria-hidden="true" />
                <span className="mcp-name">sessionboxer</span>
                <span className="muted mcp-summary">self-knowledge, other Sessions</span>
                <span className="muted ss-always">
                  Always on ·{" "}
                  <a href={SESSIONBOXER_MCP_DOCS} target="_blank" rel="noreferrer">
                    more info
                  </a>
                </span>
              </label>
              <div className="ss-indent">
                <label>
                  <Caption
                    help={
                      <p>
                        <strong>Off</strong>: the Agent gets no <code>sessionboxer</code> tools. <strong>This Session only</strong>: self-knowledge and
                        actions on its own Session, its forks and schedules that target it. <strong>All Sessions</strong>: the cross-Session tools too
                        (list, message, create, fork, hand off). Every action shows as a marker in the chat; a change applies to the running Agent at
                        its next turn.
                      </p>
                    }
                  >
                    The sessionboxer MCP lets the Agent act on
                  </Caption>
                  <AgentToolsSelect value={value.agentTools} fallback={settings.agentTools} disabled={disabled} onChange={(agentTools) => onChange({ agentTools })} />
                </label>
                <label>
                  <Caption
                    help={
                      <p>
                        <strong>Ask me</strong>: a card appears in the chat with Allow and Deny and the Agent waits for your answer (a card nobody
                        answers in 10 minutes is denied). <strong>Do not ask</strong>: the Session is created right away.
                      </p>
                    }
                  >
                    When the Agent creates a Session
                  </Caption>
                  <ApproveCreateSelect value={value.approveCreate} fallback={settings.approveCreate} disabled={disabled} onChange={(approveCreate) => onChange({ approveCreate })} />
                </label>
              </div>
            </li>
          </ul>

          <h4 className="ss-sub">
            <Caption
              help={
                <p>
                  A connector logs the Sandbox into GitHub or Bitbucket (git push, <code>gh</code>, pull-request watching) and, for GitHub, gives the
                  Agent that MCP server too. Log in under <a href="#/settings/git">Global settings → MCP &amp; connectors</a>.
                  {live ? ` ${applyNote(status, "restart")}` : ""}
                </p>
              }
            >
              Git
            </Caption>
          </h4>
          {gitServers.length === 0 ? (
            <p className="empty ss-empty">
              No git connector yet: log in with GitHub or Bitbucket in <a href="#/settings/git">Global settings → MCP &amp; connectors</a>.
            </p>
          ) : (
            <ul className="mcp-switches" aria-busy={disabled}>
              {gitServers.map(mcpSwitch)}
            </ul>
          )}
          {frozen ? (
            <p className="muted ss-fixed">
              Git commits as{" "}
              {value.gitName || value.gitEmail ? `${value.gitName}${value.gitEmail ? ` <${value.gitEmail}>` : ""}` : "git's own fallback (no identity set)"}{" "}
              {fixed}
            </p>
          ) : (
            <>
              <span className="label-row muted">
                <Caption
                  help={
                    <p>
                      Used as git&apos;s <code>user.name</code> / <code>user.email</code> inside the Sandbox (author and committer). Prefilled from
                      Settings{!settings.gitUserName && settings.hostGitIdentity.name ? " (blank there, so from this machine's git config)" : ""}; fixed
                      once the Session exists.
                    </p>
                  }
                >
                  Git author for commits made in the Sandbox
                </Caption>
                {(value.gitName !== defaultDraft.gitName || value.gitEmail !== defaultDraft.gitEmail) && (
                  <button type="button" className="link" onClick={() => onChange({ gitName: defaultDraft.gitName, gitEmail: defaultDraft.gitEmail })}>
                    Reset to the global identity
                  </button>
                )}
              </span>
              <div className="row">
                <label>
                  Name
                  <input value={value.gitName} disabled={disabled} onChange={(e) => onChange({ gitName: e.target.value })} placeholder="Jane Doe" autoComplete="name" />
                </label>
                <label>
                  Email
                  <input value={value.gitEmail} disabled={disabled} onChange={(e) => onChange({ gitEmail: e.target.value })} placeholder="jane@example.com" autoComplete="email" />
                </label>
              </div>
            </>
          )}

          <h4 className="ss-sub">
            <Caption
              help={
                <p>
                  MCP servers registered once in <a href="#/settings/mcp">Global settings → MCP &amp; connectors</a>, on or off for this Session. stdio servers
                  run {vm ? `inside the ${guest} VM` : "inside the Sandbox"}; <code>localhost</code> in an http/sse URL means this machine.
                  {live ? ` ${applyNote(status, "restart")}` : ""}
                </p>
              }
            >
              MCP servers
            </Caption>
          </h4>
          {customServers.length === 0 ? (
            <p className="empty ss-empty">
              No MCP servers registered: add them in <a href="#/settings/mcp">Global settings → MCP &amp; connectors</a>.
            </p>
          ) : (
            <ul className="mcp-switches" aria-busy={disabled}>
              {customServers.map(mcpSwitch)}
            </ul>
          )}
        </section>
      )}

      {show("qa") && (
        <section className="ss-section">
          <h3>Auto QA</h3>
          <label>
            <Caption
              help={
                <p>
                  After each completed turn the Agent checks what it changed, plans 2–5 test cases, runs them on the Sandbox desktop while recording,
                  fixes and reruns what fails, and hands the video to the chat. Answer-only turns are skipped. Watch it in the Auto QA pane.
                  {live ? ` ${applyNote(status, "immediate")}` : ""}
                </p>
              }
            >
              Verify each turn end to end
            </Caption>
            <Select<OnOff>
              value={onOff(value.e2eVerify)}
              disabled={disabled}
              onChange={(v) => onChange({ e2eVerify: fromOnOff(v) })}
              aria-label="Verify each turn end to end"
              options={[
                { value: "default", label: `Settings default (${settings.e2eVerify ? "on" : "off"})` },
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
          </label>
        </section>
      )}

      {show("debug") && canInspect && (
        <section className="ss-section">
          <h3>Debug</h3>
          <label className="check switch">
            <input type="checkbox" checked={value.inspectLlm} disabled={disabled} onChange={(e) => onChange({ inspectLlm: e.target.checked })} />
            <span className="slider" aria-hidden="true" />
            <Caption
              help={
                <p>
                  Records the exact request and response of every call to the model. The calls go through a loopback inspector in the Sandbox; the
                  bodies stay in the Sandbox&apos;s memory (last 40), headers are never recorded, and each Claude bubble gets an LLM #n tab.
                  {live ? ` ${applyNote(status, "restart")}` : ""}
                </p>
              }
            >
              Inspect LLM calls
              {pending?.inspectLlmPending && <span className="warn-sign">pending</span>}
            </Caption>
          </label>
        </section>
      )}
    </div>
  );
}

/** What picking an Environment means on this host, or why it cannot be picked (ADR-0057, ADR-0060, ADR-0061). */
function environmentNote(settings: PublicSettings, environment: Environment): ReactNode {
  const availability = settings.environments[environment];
  if (!availability.available) {
    return (
      <p>
        {ENVIRONMENT_LABELS[environment]} is not available: {availability.reason ?? "not on this host"}
        {environment === "qemu-windows" ? (
          <>
            {" "}
            See <a href="#/settings/windows">Global settings → Environment → Windows VMs</a>.
          </>
        ) : environment === "qemu-macos" ? (
          <>
            {" "}
            See <a href="#/settings/macos">Global settings → Environment → macOS VMs</a>.
          </>
        ) : null}
      </p>
    );
  }
  if (environment === "qemu-windows") {
    return (
      <>
        <p>
          A Windows {settings.windows.version} VM (QEMU/KVM, {settings.windows.ramGb} GB RAM, {settings.windows.cpus} vCPUs, its own disk from the
          shared base) starts next to the Linux Sandbox; the Desktop shows it over RDP.
        </p>
        <p>
          The Agent, its MCP servers, git and the Terminal (PowerShell) run inside the VM, with the repositories in <code>C:\workspace</code>. Docker
          inside the Sandbox, VS Code, snapshots, forks and rebuilds are not available for Windows Sessions yet.
        </p>
      </>
    );
  }
  if (environment === "qemu-macos") {
    return (
      <>
        <p>
          A macOS {settings.macos.version} VM (QEMU/KVM with OpenCore, {settings.macos.ramGb} GB RAM, {settings.macos.cpus} vCPUs, its own disk from the
          shared base) starts next to the Linux Sandbox; the Desktop shows it over VNC.
        </p>
        <p>
          The Agent, its MCP servers, git and the Terminal (zsh) run inside the VM, with the repositories in <code>/Users/agent/workspace</code>. Docker
          inside the Sandbox, VS Code, snapshots, forks and rebuilds are not available for macOS Sessions yet.
        </p>
      </>
    );
  }
  return (
    <p>
      A Linux desktop (Ubuntu, XFCE) in a Docker container, with the Agent, its MCP servers, git, VS Code and the Terminal inside; the repositories
      are under <code>/workspace</code>. Snapshots and forks work here.
    </p>
  );
}

/** Optional number: empty means "the Settings default". Commits on blur/Enter so a live dialog does not save every keystroke. */
function NumberField({
  label,
  value,
  placeholder,
  min,
  step,
  disabled,
  onCommit,
}: {
  label: string;
  value: number | null;
  placeholder: string;
  min: number;
  step: number;
  disabled: boolean;
  onCommit: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "") {
      if (value !== null) onCommit(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < min) {
      setText(value === null ? "" : String(value));
      return;
    }
    const rounded = step === 1 ? Math.floor(n) : n;
    if (rounded !== value) onCommit(rounded);
  };
  return (
    <label>
      {label}
      <input
        type="number"
        inputMode="decimal"
        min={min}
        step={step}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}
