import { useCallback, useEffect, useRef, useState } from "react";
import {
  ENVIRONMENTS,
  ENVIRONMENT_LABELS,
  PROVIDERS,
  PROVIDER_LABELS,
  providerUnavailableIn,
  type Environment,
  type Provider,
  type ProviderModels,
  type ProviderOptions,
  type PublicSettings,
  type Session,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { useStagedAttachments } from "./attachments-pending";
import { AttachButton, AttachList, CameraButton, DictationLine, MicButton, SketchButton, droppedFiles, useDictation } from "./composer-tools";
import { ModelSelect } from "./ModelSelect";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderLogos } from "./ProviderLogos";
import { SandboxImageBanner } from "./SandboxImageBanner";
import { AdvancedSettingsDialog } from "./AdvancedSettingsDialog";
import { providerTokenSet } from "./providers";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { Icon } from "./Icons";
import { draftFromDefaults, draftToInput, type SessionSettingsDraft } from "./session-settings-model";
import { RepoEditor, draftsError, draftsToSpecs, githubAccounts, type RepoDraft } from "./Repos";
import {
  Modal,
  Select,
} from "./ui";

/**
 * The transcript refetched after a reconnection, keeping what the socket delivered while the fetch
 * was in flight (events newer than the fetch's last one, for the same Session).
 */
import type { Runner } from "./SessionView";
import { mobileQuery } from "./SettingsView";

export function gitIdentityNote(session: Session): string {
  const { name, email } = session.settings.sandbox.gitIdentity;
  if (!name && !email) return "";
  return `\nGit commits as ${name}${email ? ` <${email}>` : ""}`;
}

/**
 * The first screen and the "+ New" screen (A+B of the hallway feedback): a prompt box in the middle
 * with the Provider, the repositories and the advanced settings under it, and the four Provider
 * logos above it until one is connected. Nothing here is a long form.
 */
/** The runtimes the Control Plane can start Sessions on right now, for the set-up checklist. */
export function runtimesPresent(settings: PublicSettings): string[] {
  const out: string[] = [];
  if (settings.dockerReachable) out.push("Docker");
  if (settings.environments["qemu-windows"].available || settings.environments["qemu-macos"].available) out.push("QEMU");
  return out;
}

function dockerInstallUrl(hostPlatform: string): string {
  if (hostPlatform === "darwin") return "https://docs.docker.com/desktop/setup/install/mac-install/";
  if (hostPlatform === "win32") return "https://docs.docker.com/desktop/setup/install/windows-install/";
  return "https://docs.docker.com/engine/install/";
}

/** What the Runtime item of the set-up checklist opens: the state of each runtime and how to get the missing ones. */
export function RuntimeDialog({ settings, onClose }: { settings: PublicSettings; onClose: () => void }) {
  const vms = (["qemu-windows", "qemu-macos"] as const).map((env) => [env, settings.environments[env]] as const);
  return (
    <Modal title="Runtime" description="Every Session runs in a Sandbox on Docker; Windows and macOS Sessions add a QEMU VM next to it." onClose={onClose}>
      <ul className="runtime-list">
        <li>
          <EnvironmentIcon environment="docker-linux" />
          <span>
            <b>Docker</b>: {settings.dockerReachable ? "reachable" : "not reachable"}.{" "}
            {settings.dockerReachable
              ? "Linux Sessions can start."
              : settings.hostPlatform === "darwin"
                ? <>
                    Install <a href="https://orbstack.dev" target="_blank" rel="noreferrer">OrbStack</a> or{" "}
                    <a href={dockerInstallUrl(settings.hostPlatform)} target="_blank" rel="noreferrer">Docker Desktop</a> and start it.
                  </>
                : <>
                    Install <a href={dockerInstallUrl(settings.hostPlatform)} target="_blank" rel="noreferrer">Docker Engine</a>, make sure the daemon runs and that
                    your user can run <code>docker</code>.
                  </>}
          </span>
        </li>
        {vms.map(([env, a]) => (
          <li key={env}>
            <EnvironmentIcon environment={env} />
            <span>
              <b>{ENVIRONMENT_LABELS[env]}</b>: {a.available ? "available." : `not available. ${a.reason ?? ""}`.trim()}
            </span>
          </li>
        ))}
      </ul>
      <p className="muted small-text">
        Windows and macOS VMs need a Linux host with <code>/dev/kvm</code> (bare metal, a VM with nested virtualisation, or WSL2 with KVM) that your user can
        use; Docker Desktop on macOS cannot. See the guide&apos;s Requirements.
      </p>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/** Whether a Session of this Environment can start here: Docker answers for the Linux box, the VM base disk and KVM for the others. */
function runtimePresent(settings: PublicSettings, environment: Environment): boolean {
  return environment === "docker-linux" ? settings.dockerReachable : settings.environments[environment].available;
}

/** Picking an Environment whose runtime is missing from the New session toolbar: what it needs and where to get it. */
function RuntimeInstallDialog({ environment, settings, onClose }: { environment: Environment; settings: PublicSettings; onClose: () => void }) {
  const label = ENVIRONMENT_LABELS[environment];
  const section = environment === "qemu-windows" ? "windows" : environment === "qemu-macos" ? "macos" : null;
  const reason = environment === "docker-linux" ? null : settings.environments[environment].reason;
  return (
    <Modal title={`${label} needs to be installed`} onClose={onClose}>
      <div className="runtime-install">
        <EnvironmentIcon environment={environment} size={40} />
        <p className="muted">
          {environment === "docker-linux"
            ? settings.hostPlatform === "darwin"
              ? "Docker is not reachable. Install OrbStack or Docker Desktop and start it."
              : "Docker is not reachable. Install Docker Engine, make sure the daemon runs and that your user can run docker."
            : (reason ?? `${label} is not available on this host.`)}
        </p>
      </div>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
        {environment === "docker-linux" ? (
          <button
            type="button"
            className="primary"
            onClick={() => window.open(settings.hostPlatform === "darwin" ? "https://orbstack.dev" : dockerInstallUrl(settings.hostPlatform), "_blank", "noreferrer")}
          >
            Install Docker
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            onClick={() => {
              onClose();
              location.hash = `#/settings/${section}`;
            }}
          >
            Install…
          </button>
        )}
      </div>
    </Modal>
  );
}

const NEW_PROVIDER_KEY = "sessionboxer.new.provider";
const NEW_ENVIRONMENT_KEY = "sessionboxer.new.environment";

/** The Agent picked last time on the New session screen, if still one of ours. */
function rememberedProvider(): Provider | null {
  const v = localStorage.getItem(NEW_PROVIDER_KEY);
  return PROVIDERS.find((p) => p === v) ?? null;
}

/** The Environment picked last time on the New session screen. */
function rememberedEnvironment(): Environment | null {
  const v = localStorage.getItem(NEW_ENVIRONMENT_KEY);
  return ENVIRONMENTS.find((e) => e === v) ?? null;
}

export function NewSession({
  settings,
  models,
  options,
  firstTime,
  hidden,
  onCreated,
  onConnectProvider,
  onConnectGit,
  run,
}: {
  settings: PublicSettings;
  models: ProviderModels;
  options: ProviderOptions;
  /** No Session exists yet: a welcome heading instead of "New session". */
  firstTime: boolean;
  /** Another route is on screen: render nothing but keep the state (text, repositories, staged files) for when it comes back. */
  hidden: boolean;
  onCreated: (s: Session) => void;
  onConnectProvider: (provider: Provider | null) => void;
  onConnectGit: () => void;
  run: Runner;
}) {
  const connectedProviders = PROVIDERS.filter((p) => providerTokenSet(settings, p));
  const [provider, setProvider] = useState<Provider>(() => {
    const remembered = rememberedProvider();
    if (remembered && (connectedProviders.length === 0 || providerTokenSet(settings, remembered))) return remembered;
    return connectedProviders[0] ?? "claude-code";
  });
  const [draft, setDraft] = useState<SessionSettingsDraft>(() => {
    const remembered = rememberedEnvironment();
    const base = draftFromDefaults(settings);
    return remembered && settings.environments[remembered].available ? { ...base, environment: remembered } : base;
  });
  const [repos, setRepos] = useState<RepoDraft[]>([]);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [reposOpen, setReposOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [runtimeNeeded, setRuntimeNeeded] = useState<Environment | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pickedRef = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const attachError = useCallback((message: string) => void run(() => Promise.reject(new Error(message))), [run]);
  const attachments = useStagedAttachments(attachError);
  const appendDictation = useCallback((text: string) => {
    setPrompt((cur) => (cur.length === 0 || /\s$/.test(cur) ? cur + text : `${cur} ${text}`));
    requestAnimationFrame(() => {
      const ta = promptRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }, []);
  const dictation = useDictation(appendDictation);

  // Back on this screen the prompt takes focus again (the autofocus attribute only fires on mount).
  useEffect(() => {
    if (!hidden && !mobileQuery()) promptRef.current?.focus();
  }, [hidden]);

  // Leaving the screen mid-recording releases the microphone; the clip is still transcribed into the prompt.
  useEffect(() => {
    if (hidden && dictation.dictation.kind === "recording") void dictation.toggle();
  }, [hidden, dictation]);

  // A login stored from the connect dialog while this screen is open becomes the selection (unless one was picked by hand).
  useEffect(() => {
    if (pickedRef.current || providerTokenSet(settings, provider)) return;
    const first = PROVIDERS.find((p) => providerTokenSet(settings, p));
    if (first) setProvider(first);
  }, [settings, provider]);

  const repoSpecs = draftsToSpecs(repos);
  const repoError = draftsError(repos);
  const providerReady = providerTokenSet(settings, provider);
  const accounts = githubAccounts(settings);
  const repoCount = repos.filter((d) => (d.type === "git" ? d.url.trim() : d.path.trim()) !== "").length;
  // Files still uploading or failed hold Start back, as they hold Send back in the chat.
  const filesSettled = attachments.items.length === 0 || attachments.ready;
  const fromSnapshot = draft.snapshotId !== null;
  const canStart = !busy && (repoError === null || fromSnapshot) && providerReady && filesSettled;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canStart) return;
    const files = attachments.attachments;
    setBusy(true);
    void run(async () => {
      const s = await api.createSession({
        provider,
        repos: fromSnapshot ? [] : repoSpecs,
        workspaceSource: { type: "empty" },
        ...(draft.snapshotId ? { snapshotId: draft.snapshotId } : {}),
        settings: draftToInput(draft),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(files.length > 0 ? { attachments: files.map((f) => f.id) } : {}),
      });
      onCreated(s);
    }).finally(() => setBusy(false));
  };

  const startTitle = !providerReady
    ? `Connect ${PROVIDER_LABELS[provider]} first`
    : attachments.uploading
      ? "Waiting for the files to upload"
      : !filesSettled
        ? "Remove the files that failed to upload"
        : "Ctrl/\u2318+Enter";

  return (
    <div className="start" hidden={hidden}>
      <div className="start-inner">
        <h2 className="start-title">{firstTime ? "What should the Agent work on?" : "New session"}</h2>
        <SandboxImageBanner selector={draft.environment === "docker-linux" ? provider : "base"} />
        {connectedProviders.length === 0 && (
          <div className="start-connect">
            <p className="muted">
              First, connect the Agent you have a subscription for (one is enough). Click a logo for the three commands to run on your machine.
            </p>
            <ProviderLogos settings={settings} onPick={onConnectProvider} />
          </div>
        )}
        <form
          className={`start-box${busy ? " busy" : ""}${dragging ? " dragging" : ""}`}
          onSubmit={submit}
          onDragOver={(e) => {
            if (busy || !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            setDragging(false);
            const files = droppedFiles(e.dataTransfer);
            if (!files || busy) return;
            e.preventDefault();
            attachments.add(files);
          }}
        >
          <div className="start-editor">
            <textarea
              ref={promptRef}
              className="start-prompt"
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={(e) => {
                const files = droppedFiles(e.clipboardData);
                if (!files || busy) return;
                e.preventDefault();
                attachments.add(files);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="e.g. Read the README, run the tests and fix the one that fails; open a PR when they pass. (Optional: an empty Session waits for you in the chat.)"
              disabled={busy}
            />
            <div className="toolbar start-attach">
              <AttachButton disabled={busy} onFiles={attachments.add} />
              <CameraButton disabled={busy} onFiles={attachments.add} />
              <MicButton control={dictation} disabled={busy} />
              <SketchButton disabled={busy} onFiles={attachments.add} />
            </div>
            {dragging && <div className="drop-hint">Drop to attach to the first message</div>}
          </div>
          {(attachments.items.length > 0 || dictation.dictation.kind !== "idle") && (
            <div className="start-extras">
              <AttachList attachments={attachments} />
              <DictationLine dictation={dictation.dictation} />
            </div>
          )}
          <div className="start-tools">
            <EnvironmentPicker
              compact
              value={{ environment: draft.environment, snapshotId: draft.snapshotId }}
              disabled={busy}
              environmentOption={(env) => ({ hint: runtimePresent(settings, env) ? undefined : "not installed" })}
              onEnvironment={(environment) => {
                if (!runtimePresent(settings, environment)) {
                  setRuntimeNeeded(environment);
                  return;
                }
                localStorage.setItem(NEW_ENVIRONMENT_KEY, environment);
                setDraft((d) => ({ ...d, environment, snapshotId: null }));
              }}
              onSnapshot={(s) => setDraft((d) => ({ ...d, environment: s.environment, snapshotId: s.id }))}
            />
            <Select<Provider>
              value={provider}
              onChange={(p) => {
                pickedRef.current = true;
                localStorage.setItem(NEW_PROVIDER_KEY, p);
                setProvider(p);
                setDraft((d) => ({ ...d, model: null, options: {}, inspectLlm: true }));
                if (!providerTokenSet(settings, p)) onConnectProvider(p);
              }}
              disabled={busy}
              aria-label="Agent"
              tip={`Agent: ${PROVIDER_LABELS[provider]}`}
              className="compact icon-only"
              options={PROVIDERS.map((p) => {
                const unavailable = providerUnavailableIn(p, draft.environment);
                return {
                  value: p,
                  label: PROVIDER_LABELS[p],
                  icon: <ProviderIcon provider={p} size={16} />,
                  disabled: unavailable !== null,
                  hint: unavailable ?? (providerTokenSet(settings, p) ? undefined : "not connected"),
                };
              })}
            >
              <ProviderIcon provider={provider} size={16} />
            </Select>
            <ModelSelect
              compact
              models={models[provider]}
              value={draft.model}
              onChange={(model) => setDraft((d) => ({ ...d, model }))}
              disabled={busy}
              allowDefault
              emptyHint={`The list of ${PROVIDER_LABELS[provider]} models appears once one of its Sessions has started; you can switch the model from the chat afterwards.`}
            />
            <button
              type="button"
              className={`small${reposOpen ? " active" : ""}`}
              disabled={busy || fromSnapshot}
              aria-expanded={reposOpen}
              onClick={() => setReposOpen((v) => !v)}
              title={
                fromSnapshot
                  ? "The repositories come with the snapshot; more can be added once the Session runs"
                  : "Git repositories to clone (or host folders to copy) into the Sandbox; more can be added later"
              }
            >
              <Icon name="code" /> {fromSnapshot ? "Snapshot's repositories" : repoCount > 0 ? `${repoCount} repositor${repoCount === 1 ? "y" : "ies"}` : "Repository"}
            </button>
            <button type="button" className="small" disabled={busy} onClick={() => setAdvancedOpen(true)} title="Model, instructions, MCP servers, snapshots, Sandbox resources, title">
              Advanced…
            </button>
            <span className="spacer" />
            <button type="submit" className="primary" disabled={!canStart} title={startTitle}>
              {busy ? "Starting…" : "Start"}
            </button>
          </div>
          {reposOpen && (
            <div className="start-repos">
              <RepoEditor drafts={repos} onChange={setRepos} disabled={busy} accounts={accounts} />
              {repos.some((d) => d.type === "copy") && (
                <p className="muted">
                  A host folder is copied (tracked + untracked-but-not-ignored files and <code>.git</code>); changes can be pulled back into it from the
                  Session header.
                </p>
              )}
              {accounts.length === 0 && (
                <p className="muted">
                  Public repositories clone as they are. Private ones, pushing and pull requests need a Git account:{" "}
                  <button type="button" className="link" onClick={onConnectGit}>
                    Connect GitHub or Bitbucket…
                  </button>
                </p>
              )}
            </div>
          )}
        </form>
        {repoError && <p className="field-hint warn">{repoError}</p>}
      </div>
      {runtimeNeeded && <RuntimeInstallDialog environment={runtimeNeeded} settings={settings} onClose={() => setRuntimeNeeded(null)} />}
      {advancedOpen && (
        <AdvancedSettingsDialog
          provider={provider}
          settings={settings}
          models={models[provider]}
          options={options[provider]}
          value={draft}
          title={title}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          onTitle={setTitle}
          onClose={() => setAdvancedOpen(false)}
        />
      )}
    </div>
  );
}
