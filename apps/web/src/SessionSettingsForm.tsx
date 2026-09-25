import { useEffect, useState } from "react";
import {
  DOCKER_MODE_LABELS,
  PROVIDER_LABELS,
  applyNote,
  instructionsDelivery,
  type AgentOption,
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
    sandbox: {
      docker: d.docker,
      cpus: d.cpus,
      memoryGb: d.memoryGb,
      gitIdentity: { name: d.gitName.trim(), email: d.gitEmail.trim() },
    },
  };
}

export type SessionSettingsMode = "create" | "fork" | "live";

export type SessionSettingsSection = "agent" | "instructions" | "mcp" | "inspect" | "snapshots" | "verification" | "sandbox";

/** The sections of the form in display order, for a split view's navigation. */
export function sessionSettingsSections(provider: Provider): Array<{ id: SessionSettingsSection; label: string }> {
  return [
    { id: "agent", label: "Agent" },
    { id: "instructions", label: "Instructions" },
    { id: "mcp", label: "MCP servers & connectors" },
    ...(provider === "claude-code" ? [{ id: "inspect" as const, label: "Inspect LLM" }] : []),
    { id: "snapshots", label: "Snapshots" },
    { id: "verification", label: "Verification" },
    { id: "sandbox", label: "Sandbox" },
  ];
}

/**
 * The one place a Session is configured: the New Session form (`create`, prefilled from the global
 * Settings), the Fork dialog (`fork`, prefilled from the origin) and the Session settings dialog
 * (`live`, where each control saves as it changes and creation-only values are read-only).
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

  return (
    <div className="ss-form">
      {show("agent") && (
      <section className="ss-section">
        <h3>
          Agent
          {(pending?.modelPending || pending?.optionsPending) && <span className="warn-sign">pending</span>}
        </h3>
        {live && (
          <p className="muted ss-fixed">
            Provider: {providerLabel} <span className="ss-lock">(fixed for the Session)</span>
          </p>
        )}
        {models.length > 0 || value.model !== null ? (
          <>
            <ModelSelect
              models={models}
              value={value.model}
              onChange={(model) => onChange({ model })}
              allowDefault={!live}
              disabled={disabled}
              pending={pending?.modelPending ?? false}
            />
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
          </>
        ) : (
          <p className="muted">
            Model: {providerLabel}&apos;s default. The list of models appears once a {providerLabel} session has started
            {live ? "" : "; you can switch the model from the chat afterwards"}.
          </p>
        )}
        {live && <p className="muted ss-note">{applyNote(status, "immediate")} Also in the composer footer.</p>}
      </section>
      )}

      {show("instructions") && (
      <section className="ss-section">
        <h3>Instructions</h3>
        {frozen ? (
          <>
            {value.instructions.trim() === "" ? (
              <p className="empty ss-empty">None: this Session&apos;s Agent only has the Sandbox briefing and the project&apos;s own instruction files.</p>
            ) : (
              <pre className="instructions-text">{value.instructions}</pre>
            )}
            <p className="muted ss-note">
              Fixed when the Session was created (on top of the Sandbox briefing). {deliveryNote(provider)} The default for new Sessions is in{" "}
              <a href="#/settings/models">Global settings → Models and instructions</a>.
            </p>
          </>
        ) : (
          <>
            <label>
              <span className="label-row">
                Instructions for the Agent (fixed once the Session exists; empty for none)
                {value.instructions !== settings.instructions && (
                  <button type="button" className="link" onClick={() => onChange({ instructions: settings.instructions })}>
                    Reset to the Settings default
                  </button>
                )}
              </span>
              <textarea rows={4} value={value.instructions} onChange={(e) => onChange({ instructions: e.target.value })} spellCheck={false} disabled={disabled} />
            </label>
            <p className="muted ss-note">{deliveryNote(provider)}</p>
          </>
        )}
      </section>
      )}

      {show("mcp") && (
      <section className="ss-section">
        <h3>
          MCP servers &amp; connectors
          {pending?.mcpPending && <span className="warn-sign">pending</span>}
        </h3>
        <p className="muted ss-note">
          The built-in <code>desktop</code> server (screen, mouse, keyboard) is always on.
          {live ? ` ${applyNote(status, "restart")}` : ""}
        </p>
        {pending?.mcpPending && (
          <div className="banner banner-warn dialog-banner" role="status">
            Change pending: the Agent is busy, the new set applies when the current turn ends.
          </div>
        )}
        <ul className="mcp-switches" aria-busy={disabled}>
          {settings.mcpServers.length === 0 && (
            <li className="empty">
              No MCP servers registered. Add them in <a href="#/settings/mcp">Global settings → MCP servers</a>.
            </li>
          )}
          {settings.mcpServers.map((s) => (
            <li key={s.id}>
              <label className="check switch">
                <input
                  type="checkbox"
                  checked={enabledMcp.has(s.id)}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({ mcpEnabled: e.target.checked ? [...value.mcpEnabled, s.id] : value.mcpEnabled.filter((id) => id !== s.id) })
                  }
                />
                <span className="slider" aria-hidden="true" />
                <span className="mcp-name">{s.name}</span>
                <span className="muted mcp-transport">{s.transport}</span>
                <span className="muted mcp-summary" title={summarize(s)}>
                  {summarize(s)}
                </span>
              </label>
            </li>
          ))}
        </ul>
        {settings.mcpServers.length > 0 && (
          <a className="muted ss-note" href="#/settings/mcp">
            Manage servers in Global settings
          </a>
        )}
      </section>
      )}

      {canInspect && show("inspect") && (
        <section className="ss-section">
          <h3>
            Inspect LLM
            {pending?.inspectLlmPending && <span className="warn-sign">pending</span>}
          </h3>
          <label className="check switch">
            <input type="checkbox" checked={value.inspectLlm} disabled={disabled} onChange={(e) => onChange({ inspectLlm: e.target.checked })} />
            <span className="slider" aria-hidden="true" />
            Record the exact request and response of every call to the model
          </label>
          <p className="muted ss-note">
            The model API calls go through a loopback inspector in the Sandbox; the bodies stay in the Sandbox&apos;s memory (last 40), headers are
            never recorded, and each Claude bubble gets an LLM #n tab.{live ? ` ${applyNote(status, "restart")}` : ""}
          </p>
        </section>
      )}

      {show("snapshots") && (
      <section className="ss-section">
        <h3>Snapshots</h3>
        <label>
          Snapshot automatically after every completed turn
          <select
            value={value.autoSnapshot === null ? "default" : value.autoSnapshot ? "on" : "off"}
            disabled={disabled}
            onChange={(e) => onChange({ autoSnapshot: e.target.value === "default" ? null : e.target.value === "on" })}
          >
            <option value="default">Settings default ({settings.autoSnapshot ? "on" : "off"})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        <NumberField
          label="Automatic snapshots to keep"
          value={value.snapshotKeep}
          placeholder={`Settings default (${settings.snapshotKeep === 0 ? "all" : settings.snapshotKeep})`}
          min={0}
          step={1}
          disabled={disabled}
          onCommit={(snapshotKeep) => onChange({ snapshotKeep })}
        />
        <p className="muted ss-note">Older automatic snapshots are dropped (never one a fork was started from); 0 keeps them all.</p>
      </section>
      )}

      {show("verification") && (
      <section className="ss-section">
        <h3>Verification</h3>
        <label>
          Verify each turn end to end
          <select
            value={value.e2eVerify === null ? "default" : value.e2eVerify ? "on" : "off"}
            disabled={disabled}
            onChange={(e) => onChange({ e2eVerify: e.target.value === "default" ? null : e.target.value === "on" })}
          >
            <option value="default">Settings default ({settings.e2eVerify ? "on" : "off"})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        <p className="muted ss-note">
          After each completed turn the Agent checks what it changed, plans 2–5 test cases, runs them on the Sandbox desktop while recording, fixes
          and reruns what fails, and hands the video to the chat. Answer-only turns are skipped. Watch it in the Verification pane.
        </p>
      </section>
      )}

      {show("sandbox") && (
      <section className="ss-section">
        <h3>Sandbox</h3>
        {frozen ? (
          <p className="muted ss-fixed">
            Docker inside the Sandbox: {dockerMode === "none" ? "off" : DOCKER_MODE_LABELS[dockerMode]}{" "}
            <span className="ss-lock">(fixed for the Session)</span>
            {dockerMode === "privileged" && <span className="warn"> {PRIVILEGED_WARNING}</span>}
          </p>
        ) : (
          <>
            <label className="check">
              <input type="checkbox" checked={value.docker} disabled={disabled} onChange={(e) => onChange({ docker: e.target.checked })} />
              Docker inside the Sandbox ({DOCKER_MODE_LABELS[settings.dockerModeAvailable]})
            </label>
            {value.docker && <DockerModeNote settings={settings} enabled />}
          </>
        )}
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
        {live && <p className="muted ss-note">{applyNote(status, "next-sandbox")}</p>}
        {frozen ? (
          <p className="muted ss-fixed">
            Git commits as{" "}
            {value.gitName || value.gitEmail ? `${value.gitName}${value.gitEmail ? ` <${value.gitEmail}>` : ""}` : "git's own fallback (no identity set)"}{" "}
            <span className="ss-lock">(fixed for the Session)</span>
          </p>
        ) : (
          <>
            <span className="label-row muted">
              Git author for commits made in the Sandbox
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
            <p className="muted ss-note">
              Used as git&apos;s <code>user.name</code> / <code>user.email</code> inside the Sandbox (author and committer). Prefilled from Settings
              {!settings.gitUserName && settings.hostGitIdentity.name ? " (blank there, so from this machine's git config)" : ""}; fixed once the Session exists.
            </p>
          </>
        )}
        {live && onFork && (
          <div className="ss-fork">
            <button type="button" onClick={onFork} disabled={disabled}>
              Fork with different settings…
            </button>
            <span className="muted ss-note">A fork is a new Session from a snapshot of this one; Docker, instructions and the git identity can differ there.</span>
          </div>
        )}
      </section>
      )}
    </div>
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
