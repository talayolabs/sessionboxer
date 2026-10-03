import { useCallback, useEffect, useRef, useState } from "react";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  CONNECTORS,
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_DOCKER_ADDRESS_POOL,
  DEFAULT_HTML_APP_CDNS,
  DEFAULT_INSTRUCTIONS,
  DOCKER_ADDRESS_POOL_PATTERN,
  SPEECH_MODELS,
  SPEECH_MODEL_INFO,
  type AgentToolsPolicy,
  AGENT_CHILDREN_PER_SESSION,
  type CodexLogin,
  type CursorLogin,
  type OpenCodeLogin,
  type FxLogin,
  type NarrationMode,
  type PublicMcpServerDef,
  type PublicSettings,
  type PublicUtilityDef,
  type ProcedureDef,
  type UtilityEnvironment,
  type SpeechModel,
  type WindowsBaseStatus,
  WINDOWS_VERSIONS,
  WINDOWS_GUEST_USER,
  type MacosBaseStatus,
  MACOS_VERSIONS,
  MACOS_GUEST_USER,
  type SpeechStatus,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { AgentToolsSelect, ApproveCreateSelect } from "./SessionToolsPolicy";
import { CopyCommand } from "./CopyCommand";
import { Devices } from "./Devices";
import { formatMb } from "./format";
import { MOBILE_QUERY } from "./mobile";
import { GitAccounts } from "./GitAccounts";
import { McpServersEditor } from "./McpServersEditor";
import { UtilitiesEditor } from "./UtilitiesEditor";
import { ProviderConnectDialog } from "./ProviderConnect";
import { MacosBase } from "./MacosBase";
import { ThemeFieldset } from "./ThemePicker";
import {
  DESKTOP_MCP_DOCS,
  DockerModeNote,
  SESSIONBOXER_MCP_DOCS,
  deliveryNote,
} from "./SessionSettingsForm";
import {
  Caption,
  Select,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "./ui";

/**
 * The transcript refetched after a reconnection, keeping what the socket delivered while the fetch
 * was in flight (events newer than the fetch's last one, for the same Session).
 */
import type { Runner } from "./SessionView";

/** One line about the stored Codex login, from the metadata the Control Plane exposes (never the tokens). */
function describeCodexLogin(login: CodexLogin): string {
  const parts = [login.email ?? (login.apiKey ? "API key" : "ChatGPT account")];
  if (login.plan) parts.push(`${login.plan} plan`);
  if (login.lastRefresh) parts.push(`refreshed ${new Date(login.lastRefresh).toLocaleString()}`);
  return parts.join(", ");
}

/** One line about the stored OpenCode login (ADR-0076): which model providers its auth.json covers. */
function describeOpenCodeLogin(login: OpenCodeLogin): string {
  return login.providers.map((p) => `${p.id} (${p.kind === "oauth" ? "login" : p.kind === "api" ? "API key" : "token"})`).join(", ");
}

/** One line about the stored Cursor login (ADR-0054), from its metadata only. */
function describeCursorLogin(login: CursorLogin): string {
  if (login.kind === "api-key") return "API key";
  return login.expiresAt ? `auth.json, token valid until ${new Date(login.expiresAt).toLocaleString()}` : "auth.json";
}

/** One line about the stored fx login (ADR-0077), from its metadata only. */
function describeFxLogin(login: FxLogin): string {
  const what = login.kind === "api-key" ? "AI Gateway API key" : login.kind === "vercel" ? "Vercel login" : login.kind === "codex" ? "ChatGPT login" : "Grok login";
  return login.expiresAt && login.kind !== "api-key" ? `${what}, token valid until ${new Date(login.expiresAt).toLocaleString()}` : what;
}

/** `pane` carries a deep link into a Session (`#/sessions/<id>/prs`, `…/pr/<prId>`, as notifications send them). */
export function mobileQuery(): boolean {
  return typeof matchMedia === "function" && matchMedia(MOBILE_QUERY).matches;
}

function parseAliasList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0))];
}

/** Origins (`https://host`) from a list typed one per line or separated by spaces/commas; anything that is not a URL is dropped. */
function parseOriginList(text: string): string[] {
  const origins: string[] = [];
  for (const part of text.split(/[\s,]+/)) {
    const v = part.trim();
    if (!v) continue;
    try {
      const origin = new URL(v.includes("://") ? v : `https://${v}`).origin;
      if (origin !== "null" && !origins.includes(origin)) origins.push(origin);
    } catch {
      // not a URL
    }
  }
  return origins;
}

/** What is on disk for dictation (whisper-cli and models), with a download-now button and per-model removal. */
function SpeechAssets({ selected, saved }: { selected: SpeechModel; saved: SpeechModel }) {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const refresh = useCallback(() => {
    api.speechStatus().then(setStatus, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(refresh, [refresh]);
  const downloading = status !== null && (status.engine.state === "downloading" || status.model.state === "downloading");
  useEffect(() => {
    if (!downloading && !working) return;
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [downloading, working, refresh]);
  const prepare = async () => {
    setWorking(true);
    setError(null);
    try {
      setStatus(await api.speechPrepare());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      refresh();
    }
  };
  const remove = async (model: SpeechModel) => {
    setError(null);
    try {
      await api.speechDeleteModel(model);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };
  if (!status) return error ? <p className="error">{error}</p> : <p className="muted">Checking what is downloaded…</p>;
  const engine =
    status.engine.state === "ready"
      ? `whisper-cli ${status.engine.version ?? ""} ready`
      : status.engine.state === "downloading"
        ? "downloading whisper-cli…"
        : status.engine.state === "error"
          ? `whisper-cli: ${status.engine.error ?? "unavailable"}`
          : "whisper-cli not downloaded yet";
  const model =
    status.model.state === "ready"
      ? `model ${status.model.name} ready`
      : status.model.state === "downloading"
        ? `downloading model ${status.model.name}… ${status.model.total > 0 ? Math.floor((100 * status.model.received) / status.model.total) : 0}%`
        : status.model.state === "error"
          ? `model ${status.model.name}: ${status.model.error ?? "failed"}`
          : `model ${status.model.name} not downloaded yet (${formatMb(SPEECH_MODEL_INFO[status.model.name].bytes)})`;
  const ready = status.engine.state === "ready" && status.model.state === "ready";
  return (
    <div className="speech-assets">
      <p className={status.engine.state === "error" || status.model.state === "error" ? "error" : "muted"}>
        {engine} · {model}
        {status.busy > 0 && ` · transcribing ${status.busy} clip${status.busy === 1 ? "" : "s"}`}
      </p>
      <div className="row">
        {!ready && (
          <button type="button" className="small" disabled={working || downloading} onClick={() => void prepare()}>
            {downloading || working ? "Downloading…" : "Download now"}
          </button>
        )}
        {selected !== saved && <span className="muted">Save to switch to {SPEECH_MODEL_INFO[selected].label}; it is downloaded on the first dictation.</span>}
        {status.downloaded
          .filter((m) => m !== status.model.name)
          .map((m) => (
            <button key={m} type="button" className="small" title={`Delete ggml-${m}.bin from this machine`} onClick={() => void remove(m)}>
              Delete {SPEECH_MODEL_INFO[m].label} ({formatMb(SPEECH_MODEL_INFO[m].bytes)})
            </button>
          ))}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** The shared Windows base disk (ADR-0057): its state and the Install / Cancel / Delete buttons. */
function WindowsBase({
  settings,
  status,
  onStatus,
  dirty,
}: {
  settings: PublicSettings;
  status: WindowsBaseStatus | null;
  onStatus: (status: WindowsBaseStatus) => void;
  /** Edition or disk size changed in the form but not saved yet: installing now would use the saved ones. */
  dirty: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const availability = settings.environments["qemu-windows"];
  const act = async (call: () => Promise<WindowsBaseStatus>) => {
    setWorking(true);
    setError(null);
    try {
      onStatus(await call());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      setConfirmDelete(false);
    }
  };
  if (!status) return <p className="muted">Checking the base disk…</p>;
  const edition = WINDOWS_VERSIONS.find((v) => v.code === status.version)?.label ?? status.version;
  const started = status.startedAt ? new Date(status.startedAt) : null;
  const line =
    status.state === "ready"
      ? `Base disk ready: ${edition} (${formatMb(status.sizeBytes)} on disk)${status.sessions > 0 ? `, ${status.sessions} Session${status.sessions === 1 ? "" : "s"} built on it` : ""}.`
      : status.state === "installing"
        ? `Installing ${edition}${started ? `, started ${started.toLocaleTimeString()}` : ""}… Windows downloads and installs itself; this takes 20–40 minutes.`
        : status.state === "error"
          ? `Installing ${edition ?? "the base"} failed: ${status.error ?? "unknown error"}`
          : "No base disk yet: no Windows Session can be created until it is installed.";
  return (
    <div className="windows-base">
      <p className={status.state === "error" ? "error" : "muted"}>{line}</p>
      {!availability.available && availability.reason && status.state !== "installing" && (
        <p className="muted">QEMU · Windows cannot be picked yet: {availability.reason}</p>
      )}
      {(status.state === "installing" || status.state === "error") && status.log.length > 0 && (
        <pre className="windows-base-log">{status.log.join("\n")}</pre>
      )}
      <div className="row">
        {(status.state === "missing" || status.state === "error") && (
          <button type="button" className="small" disabled={working || dirty} title={dirty ? "Save the settings first" : undefined} onClick={() => void act(api.windowsInstall)}>
            {status.state === "error" ? "Install again" : "Install the base disk"}
          </button>
        )}
        {status.state === "installing" && (
          <button type="button" className="small" disabled={working} onClick={() => void act(api.windowsCancel)}>
            Cancel the install
          </button>
        )}
        {(status.state === "ready" || status.state === "error") &&
          (confirmDelete ? (
            <>
              <span className="muted">Delete the base disk{status.sessions > 0 ? " (not while Sessions are built on it)" : ""}?</span>
              <button type="button" className="small danger" disabled={working || status.sessions > 0} onClick={() => void act(api.windowsRemove)}>
                Delete
              </button>
              <button type="button" className="small" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="small" disabled={working} onClick={() => setConfirmDelete(true)}>
              Delete the base disk
            </button>
          ))}
        {dirty && <span className="muted">Save to apply the edition / disk size before installing.</span>}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Blocks rarely used by home routers (192.168.0–1.x), office LANs (10.0–10.10.x), WSL2 (172.16–31.x) or Kubernetes (10.96/10.244). */
const DOCKER_POOL_SUGGESTIONS = [
  { block: DEFAULT_DOCKER_ADDRESS_POOL, why: "Default — top of 192.168.x: clear of home routers (192.168.0–1.x) and Docker Desktop (192.168.65.x)" },
  { block: "10.213.0.0/16", why: "High 10.x: clear of the 10.0–10.10.x office LANs and the 10.96/10.244 Kubernetes ranges" },
  { block: "100.64.0.0/16", why: "Carrier-grade NAT range, unused on most LANs; not if you run Tailscale or WARP (100.64–127.x)" },
];

/** The sections of Global settings, in the order of the left-hand list; `id` is the `#/settings/<id>` route. */
const UTILITIES_DOCS = "https://sessionboxer.talayolabs.com/guide/#utilities";

const GLOBAL_SETTINGS_SECTIONS = [
  { id: "providers", label: "Providers" },
  { id: "environment", label: "Machine" },
  { id: "agent", label: "Agent" },
  { id: "mcp", label: "MCP & connectors" },
  { id: "utilities", label: "Utilities" },
  { id: "verification", label: "Auto QA" },
  { id: "interface", label: "Interface" },
  { id: "devices", label: "Devices and remote access" },
] as const;
type GlobalSettingsSection = (typeof GLOBAL_SETTINGS_SECTIONS)[number]["id"];

/** Routes of the sections before they were grouped like the Session settings: each now names a block inside a section. */
const GLOBAL_SETTINGS_BLOCKS: Record<string, GlobalSettingsSection> = {
  "claude-api": "providers",
  sandbox: "environment",
  snapshots: "environment",
  windows: "environment",
  macos: "environment",
  tls: "environment",
  models: "agent",
  git: "mcp",
  "git-identity": "mcp",
  "github-app": "mcp",
  "agent-tools": "mcp",
  recordings: "mcp",
  environments: "utilities",
  procedures: "utilities",
  theme: "interface",
  dictation: "interface",
};

function isGlobalSettingsSection(id: string | undefined): id is GlobalSettingsSection {
  return GLOBAL_SETTINGS_SECTIONS.some((s) => s.id === id);
}

/** The section a `#/settings/<id>` route shows, and the block to scroll to when the id names one. */
function resolveGlobalSettingsRoute(id: string | undefined): { section: GlobalSettingsSection; block: string | null } {
  if (isGlobalSettingsSection(id)) return { section: id, block: null };
  const section = id !== undefined ? GLOBAL_SETTINGS_BLOCKS[id] : undefined;
  return section ? { section, block: id ?? null } : { section: "providers", block: null };
}

export function SettingsView({
  settings,
  section,
  onSection,
  onSaved,
  onStored,
  windowsBase,
  onWindowsBase,
  macosBase,
  onMacosBase,
  run,
}: {
  settings: PublicSettings;
  /** Section shown on the right (`#/settings/providers`), as the no-login banner links there. */
  section?: string;
  onSection: (section: GlobalSettingsSection) => void;
  onSaved: (s: PublicSettings) => void;
  /** Settings the Control Plane stored on its own (connector logins), without the form being saved. */
  onStored: (s: PublicSettings) => void;
  /** The shared Windows base disk (ADR-0057), kept current by the `windows_base` broadcast. */
  windowsBase: WindowsBaseStatus | null;
  onWindowsBase: (status: WindowsBaseStatus) => void;
  /** The shared macOS base disk (ADR-0059), kept current by the `macos_base` broadcast. */
  macosBase: MacosBaseStatus | null;
  onMacosBase: (status: MacosBaseStatus) => void;
  run: Runner;
}) {
  const [token, setToken] = useState("");
  const [devinToken, setDevinToken] = useState("");
  const [codexAuth, setCodexAuth] = useState("");
  const [forgetCodexAuth, setForgetCodexAuth] = useState(false);
  const codexFileRef = useRef<HTMLInputElement>(null);
  const [cursorLogin, setCursorLogin] = useState("");
  const [forgetCursorLogin, setForgetCursorLogin] = useState(false);
  const cursorFileRef = useRef<HTMLInputElement>(null);
  const [piAuth, setPiAuth] = useState("");
  const [forgetPiAuth, setForgetPiAuth] = useState(false);
  const piFileRef = useRef<HTMLInputElement>(null);
  const [piApiKeys, setPiApiKeys] = useState("");
  const [forgetPiApiKeys, setForgetPiApiKeys] = useState(false);
  const [opencodeAuth, setOpenCodeAuth] = useState("");
  const [forgetOpenCodeAuth, setForgetOpenCodeAuth] = useState(false);
  const opencodeFileRef = useRef<HTMLInputElement>(null);
  const [fxLogin, setFxLogin] = useState("");
  const [forgetFxLogin, setForgetFxLogin] = useState(false);
  const fxFileRef = useRef<HTMLInputElement>(null);
  const [claudeBaseUrl, setClaudeBaseUrl] = useState(settings.claudeApi.baseUrl);
  const [claudeAuthToken, setClaudeAuthToken] = useState("");
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [forgetClaudeAuthToken, setForgetClaudeAuthToken] = useState(false);
  const [forgetClaudeApiKey, setForgetClaudeApiKey] = useState(false);
  const claudeAuthTokenSet = settings.claudeApi.authTokenSet && !forgetClaudeAuthToken;
  const claudeApiKeySet = settings.claudeApi.apiKeySet && !forgetClaudeApiKey;
  const [gitUserName, setGitUserName] = useState(settings.gitUserName);
  const [gitUserEmail, setGitUserEmail] = useState(settings.gitUserEmail);
  const [cpus, setCpus] = useState(String(settings.sandboxCpus));
  const [memory, setMemory] = useState(String(settings.sandboxMemoryGb));
  const [docker, setDocker] = useState(settings.dockerInSandbox);
  const [dockerPool, setDockerPool] = useState(settings.sandboxDockerAddressPool);
  const [windowsVersion, setWindowsVersion] = useState(settings.windows.version);
  const [windowsRam, setWindowsRam] = useState(String(settings.windows.ramGb));
  const [windowsCpus, setWindowsCpus] = useState(String(settings.windows.cpus));
  const [windowsDisk, setWindowsDisk] = useState(String(settings.windows.diskGb));
  const [macosVersion, setMacosVersion] = useState(settings.macos.version);
  const [macosRam, setMacosRam] = useState(String(settings.macos.ramGb));
  const [macosCpus, setMacosCpus] = useState(String(settings.macos.cpus));
  const [macosDisk, setMacosDisk] = useState(String(settings.macos.diskGb));
  const [autoSnapshot, setAutoSnapshot] = useState(settings.autoSnapshot);
  const [snapshotKeep, setSnapshotKeep] = useState(String(settings.snapshotKeep));
  const [e2eVerify, setE2eVerify] = useState(settings.e2eVerify);
  const [agentTools, setAgentTools] = useState<AgentToolsPolicy>(settings.agentTools);
  const [approveCreate, setApproveCreate] = useState(settings.approveCreate);
  const [agentChildrenCap, setAgentChildrenCap] = useState(String(settings.agentChildrenCap));
  const [narrationMode, setNarrationMode] = useState<NarrationMode>(settings.recordingNarration.mode);
  const [speechModel, setSpeechModel] = useState<SpeechModel>(settings.speech.model);
  const [speechLanguage, setSpeechLanguage] = useState(settings.speech.language);
  const [narrationAskAbove, setNarrationAskAbove] = useState(String(settings.recordingNarration.askAboveSeconds));
  const [mcpServers, setMcpServers] = useState<PublicMcpServerDef[]>(settings.mcpServers);
  const [utilities, setUtilities] = useState<PublicUtilityDef[]>(settings.utilities);
  const [utilityEnvironments, setUtilityEnvironments] = useState<UtilityEnvironment[]>(settings.utilityEnvironments);
  const [procedures, setProcedures] = useState<ProcedureDef[]>(settings.procedures);
  const [claudeModels, setClaudeModels] = useState(settings.claudeModels.join(", "));
  const [instructions, setInstructions] = useState(settings.instructions);
  const [htmlAppCdns, setHtmlAppCdns] = useState(settings.htmlAppCdns.join("\n"));
  const [trustHostCaCerts, setTrustHostCaCerts] = useState(settings.trustHostCaCerts);
  const [extraCaCerts, setExtraCaCerts] = useState(settings.extraCaCerts);
  const [githubClientId, setGithubClientId] = useState(settings.connectors.github.clientId);
  const [githubClientSecret, setGithubClientSecret] = useState("");
  const [forgetGithubSecret, setForgetGithubSecret] = useState(false);
  const githubSecretSet = settings.connectors.github.clientSecretSet && !forgetGithubSecret;
  const [githubAppOpen] = useState(settings.connectors.github.clientId.trim() !== "" || settings.connectors.github.clientSecretSet);
  const [guided, setGuided] = useState(false);
  const tokenSet = settings.providerSecretsSet["claude-code"].CLAUDE_CODE_OAUTH_TOKEN;
  const devinTokenSet = settings.providerSecretsSet.devin.WINDSURF_API_KEY;
  const codexAuthSet = settings.providerSecretsSet.codex.CODEX_AUTH_JSON && !forgetCodexAuth;
  const cursorLoginSet = settings.providerSecretsSet.cursor.CURSOR_LOGIN && !forgetCursorLogin;
  const piAuthSet = settings.providerSecretsSet.pi.PI_AUTH_JSON && !forgetPiAuth;
  const piApiKeysSet = settings.providerSecretsSet.pi.PI_API_KEYS && !forgetPiApiKeys;
  const opencodeAuthSet = settings.providerSecretsSet.opencode.OPENCODE_AUTH_JSON && !forgetOpenCodeAuth;
  const fxLoginSet = settings.providerSecretsSet.fx.FX_LOGIN && !forgetFxLogin;

  const { section: active, block } = resolveGlobalSettingsRoute(section);
  const show = (id: GlobalSettingsSection) => active === id;
  useEffect(() => {
    if (block) document.getElementById(`settings-${block}`)?.scrollIntoView({ block: "start" });
  }, [block]);

  const importCursorAuth = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setCursorLogin(text);
      setForgetCursorLogin(false);
    });
  };

  const importPiAuth = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setPiAuth(text);
      setForgetPiAuth(false);
    });
  };

  const importOpenCodeAuth = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setOpenCodeAuth(text);
      setForgetOpenCodeAuth(false);
    });
  };

  const importFxAuth = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setFxLogin(text);
      setForgetFxLogin(false);
    });
  };

  const importCodexAuth = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setCodexAuth(text);
      setForgetCodexAuth(false);
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const saved = await api.updateSettings({
        gitUserName,
        gitUserEmail,
        sandboxCpus: Number(cpus),
        sandboxMemoryGb: Number(memory),
        dockerInSandbox: docker,
        sandboxDockerAddressPool: dockerPool.trim(),
        windows: {
          version: windowsVersion,
          ramGb: Math.max(1, Number(windowsRam) || settings.windows.ramGb),
          cpus: Math.max(1, Math.floor(Number(windowsCpus) || settings.windows.cpus)),
          diskGb: Math.max(16, Math.floor(Number(windowsDisk) || settings.windows.diskGb)),
        },
        macos: {
          version: macosVersion,
          ramGb: Math.max(2, Number(macosRam) || settings.macos.ramGb),
          cpus: Math.max(1, Math.floor(Number(macosCpus) || settings.macos.cpus)),
          diskGb: Math.max(32, Math.floor(Number(macosDisk) || settings.macos.diskGb)),
        },
        autoSnapshot,
        snapshotKeep: Math.max(0, Math.floor(Number(snapshotKeep) || 0)),
        e2eVerify,
        agentTools,
        approveCreate,
        agentChildrenCap: Math.max(0, Math.floor(Number(agentChildrenCap) || 0)),
        recordingNarration: { mode: narrationMode, askAboveSeconds: Math.max(0, Number(narrationAskAbove) || 0) },
        speech: { model: speechModel, language: speechLanguage },
        mcpServers,
        utilities,
        utilityEnvironments,
        procedures,
        claudeModels: parseAliasList(claudeModels),
        instructions,
        htmlAppCdns: parseOriginList(htmlAppCdns),
        trustHostCaCerts,
        extraCaCerts,
        connectors: {
          github: {
            clientId: githubClientId.trim(),
            ...(githubClientSecret.trim() ? { clientSecret: githubClientSecret.trim() } : forgetGithubSecret ? { clientSecret: "" } : {}),
          },
        },
        providerSecrets: {
          ...(token.trim() ? { "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: token.trim() } } : {}),
          ...(devinToken.trim() ? { devin: { WINDSURF_API_KEY: devinToken.trim() } } : {}),
          ...(codexAuth.trim() ? { codex: { CODEX_AUTH_JSON: codexAuth.trim() } } : forgetCodexAuth ? { codex: { CODEX_AUTH_JSON: "" } } : {}),
          ...(cursorLogin.trim() ? { cursor: { CURSOR_LOGIN: cursorLogin.trim() } } : forgetCursorLogin ? { cursor: { CURSOR_LOGIN: "" } } : {}),
          ...(piAuth.trim() || forgetPiAuth || piApiKeys.trim() || forgetPiApiKeys
            ? {
                pi: {
                  ...(piAuth.trim() ? { PI_AUTH_JSON: piAuth.trim() } : forgetPiAuth ? { PI_AUTH_JSON: "" } : {}),
                  ...(piApiKeys.trim() ? { PI_API_KEYS: piApiKeys.trim() } : forgetPiApiKeys ? { PI_API_KEYS: "" } : {}),
                },
              }
            : {}),
          ...(opencodeAuth.trim() ? { opencode: { OPENCODE_AUTH_JSON: opencodeAuth.trim() } } : forgetOpenCodeAuth ? { opencode: { OPENCODE_AUTH_JSON: "" } } : {}),
          ...(fxLogin.trim() ? { fx: { FX_LOGIN: fxLogin.trim() } } : forgetFxLogin ? { fx: { FX_LOGIN: "" } } : {}),
        },
        claudeApi: {
          baseUrl: claudeBaseUrl.trim(),
          ...(claudeAuthToken.trim() ? { authToken: claudeAuthToken.trim() } : forgetClaudeAuthToken ? { authToken: "" } : {}),
          ...(claudeApiKey.trim() ? { apiKey: claudeApiKey.trim() } : forgetClaudeApiKey ? { apiKey: "" } : {}),
        },
      });
      setToken("");
      setDevinToken("");
      setCodexAuth("");
      setForgetCodexAuth(false);
      setCursorLogin("");
      setForgetCursorLogin(false);
      setPiAuth("");
      setForgetPiAuth(false);
      setPiApiKeys("");
      setForgetPiApiKeys(false);
      setOpenCodeAuth("");
      setForgetOpenCodeAuth(false);
      setFxLogin("");
      setForgetFxLogin(false);
      setClaudeAuthToken("");
      setClaudeApiKey("");
      setForgetClaudeAuthToken(false);
      setForgetClaudeApiKey(false);
      setGithubClientSecret("");
      setForgetGithubSecret(false);
      onSaved(saved);
    });
  };

  return (
    <form className="panel settings-view" onSubmit={submit}>
      <h2 className="advanced-title">
        <span>Global settings</span>
        <span className="muted advanced-sub">defaults for every Session; Save applies all sections</span>
      </h2>
      <Tabs className="split-settings" orientation="vertical" value={active} onValueChange={onSection}>
        <TabList className="split-nav" aria-label="Settings sections">
          {GLOBAL_SETTINGS_SECTIONS.map((s) => (
            <Tab key={s.id} value={s.id}>
              {s.label}
            </Tab>
          ))}
        </TabList>
        <TabPanel value={active} className="split-body">
          {show("providers") && (
            <section className="ss-section" id="settings-providers">
              <h3>
                <Caption
                  help={
                    <p>
                      A Session needs the login of its Provider; one is enough to start. Sign in with the Provider in this browser, or make the login
                      with its own CLI on your machine and paste it here. Logins apply to Sandboxes created afterwards.
                    </p>
                  }
                >
                  Providers
                </Caption>
              </h3>
              <div className="guided-row">
                <button type="button" className="primary" onClick={() => setGuided(true)}>
                  Connect a Provider…
                </button>
                <span className="muted">Claude, Codex, Cursor, OpenCode, Devin, pi or fx</span>
              </div>
              {guided && <ProviderConnectDialog settings={settings} initial={null} onClose={() => setGuided(false)} onStored={onStored} />}
              <label>
                <Caption
                  help={
                    <>
                      <p>Get one on the machine you run Claude Code on (a Claude subscription; the token is long-lived):</p>
                      <CopyCommand command="claude setup-token" />
                    </>
                  }
                >
                  Claude Code OAuth token {tokenSet ? <span className="ok">(set)</span> : <span className="warn">(not set)</span>}
                </Caption>
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={tokenSet ? "Leave empty to keep the current token" : "Paste the token"}
                />
              </label>
              <label>
                <Caption
                  help={
                    <>
                      <p>
                        Log in with the Devin CLI, then copy the token out of the credentials file it writes (the Sandbox gets it as{" "}
                        <code>WINDSURF_API_KEY</code>):
                      </p>
                      <CopyCommand command="devin auth login" />
                      <CopyCommand command="cat ~/.local/share/devin/credentials.toml" />
                    </>
                  }
                >
                  Devin token {devinTokenSet ? <span className="ok">(set)</span> : <span className="warn">(not set)</span>}
                </Caption>
                <input
                  type="password"
                  autoComplete="off"
                  value={devinToken}
                  onChange={(e) => setDevinToken(e.target.value)}
                  placeholder={devinTokenSet ? "Leave empty to keep the current token" : "Paste the token"}
                />
              </label>
              <label>
                <Caption
                  help={
                    <>
                      <p>
                        Codex runs on your ChatGPT subscription, not on API credit. Log in on your own machine, then paste or import the file it
                        writes; the Sandbox keeps it in memory only and refreshed tokens flow back here.
                      </p>
                      <CopyCommand command="codex login" />
                      <CopyCommand command="cat ~/.codex/auth.json" />
                    </>
                  }
                >
                  Codex: ChatGPT login (auth.json){" "}
                  {codexAuthSet ? (
                    <span className="ok">(set{settings.codexLogin && !forgetCodexAuth ? `: ${describeCodexLogin(settings.codexLogin)}` : ""})</span>
                  ) : (
                    <span className="warn">(not set)</span>
                  )}
                </Caption>
                <textarea
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  value={codexAuth}
                  onChange={(e) => {
                    setCodexAuth(e.target.value);
                    if (e.target.value.trim()) setForgetCodexAuth(false);
                  }}
                  placeholder={codexAuthSet ? "Leave empty to keep the current login" : "Paste the contents of ~/.codex/auth.json"}
                />
              </label>
              <div className="field-hint">
                <input
                  ref={codexFileRef}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    importCodexAuth(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => codexFileRef.current?.click()}>
                  Import auth.json…
                </button>
                {settings.providerSecretsSet.codex.CODEX_AUTH_JSON && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={forgetCodexAuth}
                      onChange={(e) => {
                        setForgetCodexAuth(e.target.checked);
                        if (e.target.checked) setCodexAuth("");
                      }}
                    />{" "}
                    Forget the stored login
                  </label>
                )}
              </div>
              <label>
                <Caption
                  help={
                    <>
                      <p>
                        Cursor runs on your Cursor subscription. Log in with its CLI on your own machine and paste or import the file it writes (the
                        Sandbox keeps it in memory only; refreshed tokens flow back here), or paste an API key from cursor.com &rarr; Dashboard &rarr;
                        Integrations.
                      </p>
                      <CopyCommand command="agent login" />
                      <CopyCommand command="cat ~/.config/cursor/auth.json" />
                    </>
                  }
                >
                  Cursor: login (auth.json or API key){" "}
                  {cursorLoginSet ? (
                    <span className="ok">(set{settings.cursorLogin && !forgetCursorLogin ? `: ${describeCursorLogin(settings.cursorLogin)}` : ""})</span>
                  ) : (
                    <span className="warn">(not set)</span>
                  )}
                </Caption>
                <textarea
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  value={cursorLogin}
                  onChange={(e) => {
                    setCursorLogin(e.target.value);
                    if (e.target.value.trim()) setForgetCursorLogin(false);
                  }}
                  placeholder={cursorLoginSet ? "Leave empty to keep the current login" : "Paste the contents of Cursor's auth.json, or an API key"}
                />
              </label>
              <div className="field-hint">
                <input
                  ref={cursorFileRef}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    importCursorAuth(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => cursorFileRef.current?.click()}>
                  Import auth.json…
                </button>
                {settings.providerSecretsSet.cursor.CURSOR_LOGIN && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={forgetCursorLogin}
                      onChange={(e) => {
                        setForgetCursorLogin(e.target.checked);
                        if (e.target.checked) setCursorLogin("");
                      }}
                    />{" "}
                    Forget the stored login
                  </label>
                )}
              </div>
              <label>
                <Caption
                  help={
                    <>
                      <p>
                        pi (earendil-works/pi) runs on your own model provider accounts. Run <code>pi</code> on your machine, type <code>/login</code> to
                        sign in with Anthropic, OpenAI, GitHub Copilot, OpenRouter, … and paste or import the file it writes (the Sandbox keeps it in
                        memory only; refreshed tokens flow back here). API keys go in the field below instead, or as well.
                      </p>
                      <CopyCommand command="pi" />
                      <CopyCommand command="cat ~/.pi/agent/auth.json" />
                    </>
                  }
                >
                  pi: login (auth.json){" "}
                  {piAuthSet ? (
                    <span className="ok">(set{settings.piLogin && settings.piLogin.authProviders.length > 0 && !forgetPiAuth ? `: ${settings.piLogin.authProviders.map((p) => p.id).join(", ")}` : ""})</span>
                  ) : (
                    <span className="warn">(not set)</span>
                  )}
                </Caption>
                <textarea
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  value={piAuth}
                  onChange={(e) => {
                    setPiAuth(e.target.value);
                    if (e.target.value.trim()) setForgetPiAuth(false);
                  }}
                  placeholder={piAuthSet ? "Leave empty to keep the current login" : "Paste the contents of pi's auth.json"}
                />
              </label>
              <div className="field-hint">
                <input
                  ref={piFileRef}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    importPiAuth(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => piFileRef.current?.click()}>
                  Import auth.json…
                </button>
                {settings.providerSecretsSet.pi.PI_AUTH_JSON && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={forgetPiAuth}
                      onChange={(e) => {
                        setForgetPiAuth(e.target.checked);
                        if (e.target.checked) setPiAuth("");
                      }}
                    />{" "}
                    Forget the stored login
                  </label>
                )}
              </div>
              <label>
                <Caption
                  help={
                    <p>
                      API keys pi should run with, one <code>NAME=value</code> line per model provider: <code>ANTHROPIC_API_KEY</code>,{" "}
                      <code>OPENAI_API_KEY</code>, <code>GEMINI_API_KEY</code>, <code>OPENROUTER_API_KEY</code>, <code>AI_GATEWAY_API_KEY</code>, … (the names
                      pi&apos;s providers documentation lists). They reach the pi process in the Sandbox as its environment only: never the container, a
                      snapshot or the logs. Saving replaces the whole list.
                    </p>
                  }
                >
                  pi: API keys (NAME=value lines){" "}
                  {piApiKeysSet ? (
                    <span className="ok">(set{settings.piLogin && settings.piLogin.apiKeyNames.length > 0 && !forgetPiApiKeys ? `: ${settings.piLogin.apiKeyNames.join(", ")}` : ""})</span>
                  ) : (
                    <span className="warn">(not set)</span>
                  )}
                </Caption>
                <textarea
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  value={piApiKeys}
                  onChange={(e) => {
                    setPiApiKeys(e.target.value);
                    if (e.target.value.trim()) setForgetPiApiKeys(false);
                  }}
                  placeholder={piApiKeysSet ? "Leave empty to keep the current keys" : "ANTHROPIC_API_KEY=sk-ant-…\nOPENAI_API_KEY=sk-…"}
                />
              </label>
              {settings.providerSecretsSet.pi.PI_API_KEYS && (
                <div className="field-hint">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={forgetPiApiKeys}
                      onChange={(e) => {
                        setForgetPiApiKeys(e.target.checked);
                        if (e.target.checked) setPiApiKeys("");
                      }}
                    />{" "}
                    Forget the stored API keys
                  </label>
                </div>
              )}
              <label>
                <Caption
                  help={
                    <>
                      <p>
                        OpenCode runs on the model providers you log into with its CLI on your own machine (Anthropic with a Claude Pro/Max login,
                        OpenAI with ChatGPT, OpenCode Zen, Google, API keys…): paste or import the file it writes (the Sandbox keeps it in memory
                        only; refreshed tokens flow back here), or paste an OpenCode Zen API key from opencode.ai/auth.
                      </p>
                      <CopyCommand command="opencode auth login" />
                      <CopyCommand command="cat ~/.local/share/opencode/auth.json" />
                    </>
                  }
                >
                  OpenCode: login (auth.json or OpenCode Zen API key){" "}
                  {opencodeAuthSet ? (
                    <span className="ok">(set{settings.opencodeLogin && !forgetOpenCodeAuth ? `: ${describeOpenCodeLogin(settings.opencodeLogin)}` : ""})</span>
                  ) : (
                    <span className="warn">(not set)</span>
                  )}
                </Caption>
                <textarea
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  value={opencodeAuth}
                  onChange={(e) => {
                    setOpenCodeAuth(e.target.value);
                    if (e.target.value.trim()) setForgetOpenCodeAuth(false);
                  }}
                  placeholder={opencodeAuthSet ? "Leave empty to keep the current login" : "Paste the contents of OpenCode's auth.json, or an OpenCode Zen API key"}
                />
              </label>
              <div className="field-hint">
                <input
                  ref={opencodeFileRef}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    importOpenCodeAuth(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => opencodeFileRef.current?.click()}>
                  Import auth.json…
                </button>
                {settings.providerSecretsSet.opencode.OPENCODE_AUTH_JSON && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={forgetOpenCodeAuth}
                      onChange={(e) => {
                        setForgetOpenCodeAuth(e.target.checked);
                        if (e.target.checked) setOpenCodeAuth("");
                      }}
                    />{" "}
                    Forget the stored login
                  </label>
                )}
              </div>
              <label>
                <Caption
                  help={
                    <>
                      <p>
                        fx (Vercel Labs) runs on Vercel&apos;s AI Gateway, or on your ChatGPT or Grok subscription. Log in with fx on your own machine and
                        paste or import the file it writes: <code>~/.fx/auth.json</code> after <code>fx login</code>, <code>~/.fx/chatgpt-auth.json</code>{" "}
                        after <code>fx login codex</code>, <code>~/.fx/grok-auth.json</code> after <code>fx login grok</code> (the Sandbox keeps it in
                        memory only; refreshed tokens flow back here). Or paste an AI Gateway API key from vercel.com &rarr; AI Gateway &rarr; API keys.
                        fx runs in Linux and macOS Sandboxes; it has no Windows build.
                      </p>
                      <CopyCommand command="fx login" />
                      <CopyCommand command="cat ~/.fx/auth.json" />
                    </>
                  }
                >
                  fx: login (auth.json or AI Gateway API key){" "}
                  {fxLoginSet ? (
                    <span className="ok">(set{settings.fxLogin && !forgetFxLogin ? `: ${describeFxLogin(settings.fxLogin)}` : ""})</span>
                  ) : (
                    <span className="warn">(not set)</span>
                  )}
                </Caption>
                <textarea
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  value={fxLogin}
                  onChange={(e) => {
                    setFxLogin(e.target.value);
                    if (e.target.value.trim()) setForgetFxLogin(false);
                  }}
                  placeholder={fxLoginSet ? "Leave empty to keep the current login" : "Paste the contents of ~/.fx/auth.json, or an AI Gateway API key"}
                />
              </label>
              <div className="field-hint">
                <input
                  ref={fxFileRef}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    importFxAuth(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => fxFileRef.current?.click()}>
                  Import auth.json…
                </button>
                {settings.providerSecretsSet.fx.FX_LOGIN && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={forgetFxLogin}
                      onChange={(e) => {
                        setForgetFxLogin(e.target.checked);
                        if (e.target.checked) setFxLogin("");
                      }}
                    />{" "}
                    Forget the stored login
                  </label>
                )}
              </div>

              <h4 className="ss-sub" id="settings-claude-api">
                <Caption
                  help={
                    <p>
                      Where Claude Code in each Sandbox sends its model API calls: a company Claude proxy, for instance. Empty takes{" "}
                      <code>ANTHROPIC_BASE_URL</code> from the Control Plane&apos;s environment, else Anthropic. Applies to Sandboxes created
                      afterwards. A Session with <em>Inspect LLM</em> on puts its own loopback proxy in front of this URL; the Sandbox trusts the
                      extra CA certificates of Environment → TLS certificates for it.
                    </p>
                  }
                >
                  Claude API
                </Caption>
              </h4>
              <label>
                <span className="label-row">
                  Base URL (ANTHROPIC_BASE_URL)
                  <span className="muted">
                    current: <code>{settings.claudeApi.effectiveBaseUrl}</code>{" "}
                    {settings.claudeApi.effectiveBaseUrlSource === "settings"
                      ? "(set here)"
                      : settings.claudeApi.effectiveBaseUrlSource === "env"
                        ? "(from the Control Plane's environment)"
                        : "(Anthropic's default)"}
                  </span>
                </span>
                <input
                  value={claudeBaseUrl}
                  onChange={(e) => setClaudeBaseUrl(e.target.value)}
                  placeholder={settings.claudeApi.effectiveBaseUrlSource === "env" ? settings.claudeApi.effectiveBaseUrl : ANTHROPIC_DEFAULT_BASE_URL}
                  spellCheck={false}
                />
              </label>
              <div className="row">
                <label>
                  <span className="label-row">
                    <Caption
                      help={
                        <p>
                          Optional credentials for that URL, given to Claude Code alongside (or instead of) the OAuth token; never shown again, stripped
                          from snapshots.
                        </p>
                      }
                    >
                      Proxy auth token (ANTHROPIC_AUTH_TOKEN) {claudeAuthTokenSet ? <span className="ok">(set)</span> : <span className="muted">(not set)</span>}
                    </Caption>
                    {claudeAuthTokenSet && (
                      <button type="button" className="link" onClick={() => setForgetClaudeAuthToken(true)}>
                        Forget
                      </button>
                    )}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={claudeAuthToken}
                    onChange={(e) => setClaudeAuthToken(e.target.value)}
                    placeholder={claudeAuthTokenSet ? "Leave empty to keep the current token" : "Only if the proxy wants its own bearer token"}
                  />
                </label>
                <label>
                  <span className="label-row">
                    Proxy API key (ANTHROPIC_API_KEY) {claudeApiKeySet ? <span className="ok">(set)</span> : <span className="muted">(not set)</span>}
                    {claudeApiKeySet && (
                      <button type="button" className="link" onClick={() => setForgetClaudeApiKey(true)}>
                        Forget
                      </button>
                    )}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={claudeApiKey}
                    onChange={(e) => setClaudeApiKey(e.target.value)}
                    placeholder={claudeApiKeySet ? "Leave empty to keep the current key" : "Only if the proxy wants an x-api-key"}
                  />
                </label>
              </div>
            </section>
          )}

          {show("environment") && (
            <section className="ss-section">
              <h3>
                <Caption
                  help={
                    <p>
                      Defaults for the box every Session runs in: the Linux Sandbox container, and the Windows or macOS VM a QEMU Session boots next to
                      it. A Session can override the limits and snapshots in its own settings. Resources and Docker apply to Sandboxes created
                      afterwards; snapshot settings apply immediately.
                    </p>
                  }
                >
                  Environment
                </Caption>
              </h3>

              <h4 className="ss-sub" id="settings-sandbox">
                <Caption help={<p>Limits of each Sandbox container (Docker · Linux, and the Linux side of a VM Session). Applies to Sandboxes created afterwards.</p>}>
                  Limits
                </Caption>
              </h4>
              <div className="row">
                <label>
                  CPUs
                  <input type="number" min={0.5} step={0.5} value={cpus} onChange={(e) => setCpus(e.target.value)} />
                </label>
                <label>
                  Memory (GB)
                  <input type="number" min={1} step={1} value={memory} onChange={(e) => setMemory(e.target.value)} />
                </label>
              </div>
              <label className="check switch">
                <input type="checkbox" checked={docker} onChange={(e) => setDocker(e.target.checked)} />
                <span className="slider" aria-hidden="true" />
                <Caption help={<DockerModeNote settings={settings} enabled={docker} />}>Docker inside Sandboxes (per-Session override in its settings)</Caption>
              </label>
              <label>
                <Caption
                  help={
                    <p>
                      The dockerd inside a Docker-enabled Sandbox carves its own networks out of this block. Hosts of your company network or VPN that
                      fall in the block are unreachable from such a Sandbox (“No route to host”), so pick one nothing you need to reach lives in — the
                      default <code>{DEFAULT_DOCKER_ADDRESS_POOL}</code> keeps clear of home routers, Docker Desktop, WSL2, company 10.x networks and
                      Kubernetes; the field suggests alternatives. Empty = Docker&apos;s default (172.17.0.0/16 and up). Applies to Sandboxes created
                      afterwards.
                    </p>
                  }
                >
                  Addresses for Docker inside Sandboxes
                </Caption>
                <input
                  value={dockerPool}
                  autoComplete="off"
                  spellCheck={false}
                  pattern={DOCKER_ADDRESS_POOL_PATTERN.source}
                  title="An IPv4 block like 192.168.240.0/20 (/8 to /24)"
                  onChange={(e) => setDockerPool(e.target.value)}
                  placeholder="Docker's default (172.17.0.0/16 and up)"
                  list="docker-pool-suggestions"
                />
                <datalist id="docker-pool-suggestions">
                  {DOCKER_POOL_SUGGESTIONS.map((s) => (
                    <option key={s.block} value={s.block}>
                      {s.why}
                    </option>
                  ))}
                </datalist>
              </label>

              <h4 className="ss-sub" id="settings-snapshots">
                <Caption
                  help={
                    <p>
                      A snapshot is an image of the whole box (files, installed tools, the Agent&apos;s conversation) you can fork from or go back to: a
                      docker commit that pauses the Sandbox for a few seconds and stores only what changed since the previous image, so turns that touch
                      few files cost a few MB. Sizes in the sidebar are what Docker reports per layer. Manual snapshots and fork origins are always
                      kept. Defaults for new Sessions; each Session can override them in its settings or from its size line in the sidebar.
                    </p>
                  }
                >
                  Snapshots
                </Caption>
              </h4>
              <label className="check switch">
                <input type="checkbox" checked={autoSnapshot} onChange={(e) => setAutoSnapshot(e.target.checked)} />
                <span className="slider" aria-hidden="true" />
                Snapshot automatically after every completed turn
              </label>
              <label>
                Automatic snapshots to keep per Session (0 = all)
                <input type="number" min={0} step={1} value={snapshotKeep} onChange={(e) => setSnapshotKeep(e.target.value)} />
              </label>

              <h4 className="ss-sub" id="settings-windows">
                <Caption
                  help={
                    <>
                      <p>
                        A <strong>QEMU · Windows</strong> Session runs a Windows VM (QEMU/KVM) next to its Linux Sandbox: the Desktop shows Windows
                        over RDP, the Agent runs inside Windows and drives it with the same screenshot, mouse and keyboard tools, and{" "}
                        <code>win &lt;command&gt;</code> runs PowerShell in it over SSH as <code>{WINDOWS_GUEST_USER}</code>. Every VM starts from
                        one shared base disk, installed here once from Microsoft&apos;s installation media (unattended, 20–40 minutes; a licence is
                        yours to bring). Needs a Linux host with <code>/dev/kvm</code>; Docker Desktop on macOS or Windows cannot run it.
                      </p>
                      <p>
                        Memory and CPUs are on top of the Session&apos;s Sandbox and apply to VMs started afterwards; edition and disk size are those
                        of the base, so changing them means deleting and installing the base again. Save first, then install.
                      </p>
                    </>
                  }
                >
                  Windows VMs
                </Caption>
              </h4>
              <div className="row">
                <label>
                  Edition of the base disk
                  <Select<string> value={windowsVersion} onChange={setWindowsVersion} aria-label="Edition of the base disk" options={WINDOWS_VERSIONS.map((v) => ({ value: v.code, label: v.label }))} />
                </label>
                <label>
                  Base disk size (GB)
                  <input type="number" min={16} step={1} value={windowsDisk} onChange={(e) => setWindowsDisk(e.target.value)} />
                </label>
              </div>
              <div className="row">
                <label>
                  VM memory (GB)
                  <input type="number" min={1} step={1} value={windowsRam} onChange={(e) => setWindowsRam(e.target.value)} />
                </label>
                <label>
                  VM CPUs
                  <input type="number" min={1} step={1} value={windowsCpus} onChange={(e) => setWindowsCpus(e.target.value)} />
                </label>
              </div>
              <WindowsBase
                settings={settings}
                status={windowsBase}
                onStatus={onWindowsBase}
                dirty={windowsVersion !== settings.windows.version || Number(windowsDisk) !== settings.windows.diskGb}
              />

              <h4 className="ss-sub" id="settings-macos">
                <Caption
                  help={
                    <>
                      <p>
                        A <strong>QEMU · macOS</strong> Session runs a macOS VM (QEMU/KVM booted by OpenCore, the dockur/macos way) next to its Linux
                        Sandbox: the Desktop shows macOS over VNC, the Agent runs inside macOS and drives it with the same screenshot, mouse and keyboard
                        tools, and <code>mac &lt;command&gt;</code> runs a shell command in it over SSH as <code>{MACOS_GUEST_USER}</code>. Every VM
                        starts from one shared base disk, installed here once from Apple&apos;s Recovery image. There is no unattended installer: you
                        install macOS and create the <code>{MACOS_GUEST_USER}</code> account by hand in the VM&apos;s screen (about an hour, mostly
                        waiting), then Sessionboxer finishes the base by itself.
                      </p>
                      <p>
                        Needs a Linux host with <code>/dev/kvm</code> and a CPU with AVX2; Docker Desktop on macOS or Windows cannot run it. Apple&apos;s
                        software licence allows macOS to run in a VM only on Apple hardware: running this on other hardware is on you.
                      </p>
                      <p>
                        Memory and CPUs are on top of the Session&apos;s Sandbox and apply to VMs started afterwards; release and disk size are those
                        of the base, so changing them means deleting and installing the base again. Save first, then install.
                      </p>
                    </>
                  }
                >
                  macOS VMs
                </Caption>
              </h4>
              <div className="row">
                <label>
                  Release of the base disk
                  <Select<string> value={macosVersion} onChange={setMacosVersion} aria-label="Release of the base disk" options={MACOS_VERSIONS.map((v) => ({ value: v.code, label: v.label }))} />
                </label>
                <label>
                  Base disk size (GB)
                  <input type="number" min={32} step={1} value={macosDisk} onChange={(e) => setMacosDisk(e.target.value)} />
                </label>
              </div>
              <div className="row">
                <label>
                  VM memory (GB)
                  <input type="number" min={2} step={1} value={macosRam} onChange={(e) => setMacosRam(e.target.value)} />
                </label>
                <label>
                  VM CPUs
                  <input type="number" min={1} step={1} value={macosCpus} onChange={(e) => setMacosCpus(e.target.value)} />
                </label>
              </div>
              <MacosBase
                settings={settings}
                status={macosBase}
                onStatus={onMacosBase}
                dirty={macosVersion !== settings.macos.version || Number(macosDisk) !== settings.macos.diskGb}
              />

              <h4 className="ss-sub" id="settings-tls">
                <Caption
                  help={
                    <p>
                      Sandboxes trust the public CAs only. If this machine goes through a proxy that re-signs HTTPS (Cloudflare WARP, Zscaler, a
                      corporate gateway, mitmproxy…), the Agent and MCP servers inside see “self signed certificate in certificate chain” unless its CA
                      is trusted there too. Installed at Sandbox start: Stop → Resume running Sessions to apply.
                    </p>
                  }
                >
                  TLS certificates
                </Caption>
              </h4>
              <label className="check switch">
                <input type="checkbox" checked={trustHostCaCerts} onChange={(e) => setTrustHostCaCerts(e.target.checked)} />
                <span className="slider" aria-hidden="true" />
                Trust the CA certificates this machine trusts beyond the public ones{" "}
                {settings.hostCaCerts.length === 0 ? (
                  <span className="muted">(none found in the system trust store)</span>
                ) : (
                  <span className="muted">
                    ({settings.hostCaCerts.length} found: {settings.hostCaCerts.map((s) => s.replace(/^CN=/, "")).join(", ")})
                  </span>
                )}
              </label>
              <label>
                Additional CA certificates (PEM; for CAs not installed on this machine)
                <textarea
                  className="pem"
                  rows={4}
                  spellCheck={false}
                  value={extraCaCerts}
                  onChange={(e) => setExtraCaCerts(e.target.value)}
                  placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
                />
              </label>
            </section>
          )}

          {show("agent") && (
            <section className="ss-section" id="settings-models">
              <h3>
                <Caption help={<p>Defaults for the Agent of new Sessions; each Session sets its own model, fast mode, effort and system prompt on top.</p>}>
                  Agent
                </Caption>
              </h3>
              <label>
                <Caption
                  help={
                    <p>
                      Written to Claude&apos;s <code>availableModels</code> setting inside each Sandbox, so models your account has but the picker does
                      not list by default (e.g. <code>fable</code>) become selectable; leave empty for Claude&apos;s built-in list. Aliases only, no
                      keys. Applies to new Sessions and to idle running ones (their Agent restarts in place, keeping the conversation); Stop → Resume a
                      Session if it does not pick it up.
                    </p>
                  }
                >
                  Claude model aliases (comma-separated, offered in the Model picker)
                </Caption>
                <input value={claudeModels} onChange={(e) => setClaudeModels(e.target.value)} placeholder={DEFAULT_CLAUDE_MODELS.join(", ")} />
              </label>
              <label>
                <span className="label-row">
                  <Caption
                    help={
                      <p>
                        Given to the Agent itself rather than left in a file it may or may not read: {deliveryNote("claude-code")} {deliveryNote("devin")}{" "}
                        {deliveryNote("codex")} {deliveryNote("cursor")} {deliveryNote("pi")} {deliveryNote("opencode")} {deliveryNote("fx")} Comes on top of the Sandbox briefing (desktop, recordings, handing files to you)
                        and the project&apos;s own CLAUDE.md / AGENTS.md. Empty sends none. Default for new Sessions; each Session can change it in its
                        settings.
                      </p>
                    }
                  >
                    System prompt
                  </Caption>
                  {instructions !== DEFAULT_INSTRUCTIONS && (
                    <button type="button" className="link" onClick={() => setInstructions(DEFAULT_INSTRUCTIONS)}>
                      Reset to the shipped default
                    </button>
                  )}
                </span>
                <textarea rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} spellCheck={false} />
              </label>
              <label>
                <span className="label-row">
                  <Caption
                    help={
                      <p>
                        A self-contained <code>.html</code> file the Agent writes under the Workspace runs as an app in the chat and in the App pane,
                        sandboxed: no origin of its own, no network, except scripts, styles, images and fonts from these origins (one per line,
                        scheme and host). Empty allows none. Applies to apps loaded from now on.
                      </p>
                    }
                  >
                    HTML app CDN allowlist
                  </Caption>
                  {parseOriginList(htmlAppCdns).join("\n") !== DEFAULT_HTML_APP_CDNS.join("\n") && (
                    <button type="button" className="link" onClick={() => setHtmlAppCdns(DEFAULT_HTML_APP_CDNS.join("\n"))}>
                      Reset to the shipped default
                    </button>
                  )}
                </span>
                <textarea rows={4} value={htmlAppCdns} onChange={(e) => setHtmlAppCdns(e.target.value)} spellCheck={false} placeholder="https://cdn.jsdelivr.net" />
              </label>
            </section>
          )}

          {show("mcp") && (
            <section className="ss-section">
              <h3>
                <Caption
                  help={
                    <p>
                      What the Agent can reach beyond the model: the two built-in MCP servers every Sandbox has, the Git accounts Sessions clone and push
                      with, and the MCP servers you register. Each Session picks which registered servers are on; the built-in ones are always on.
                    </p>
                  }
                >
                  MCP &amp; connectors
                </Caption>
              </h3>
              <ul className="mcp-switches builtin">
                <li>
                  <label className="check switch">
                    <input type="checkbox" checked disabled readOnly />
                    <span className="slider" aria-hidden="true" />
                    <span className="mcp-name">desktop</span>
                    <span className="muted mcp-summary">screen, mouse, keyboard, recordings</span>
                    <span className="muted ss-always">
                      Always on ·{" "}
                      <a href={DESKTOP_MCP_DOCS} target="_blank" rel="noreferrer">
                        more info
                      </a>
                    </span>
                  </label>
                  <div className="ss-indent" id="settings-recordings">
                    <div className="row">
                      <label>
                        <Caption
                          help={
                            <p>
                              The captions the Agent writes while recording the desktop can be spoken into the video (local text-to-speech in the
                              Sandbox, no account). It costs processing when the recording stops: roughly a third of the spoken time plus a re-encode.
                              <strong> Ask</strong> puts a card in the chat when it would take longer than the seconds given; below that it is added
                              without asking.
                            </p>
                          }
                        >
                          Narrate recordings
                        </Caption>
                        <Select<NarrationMode>
                          value={narrationMode}
                          onChange={setNarrationMode}
                          aria-label="Narrate recordings"
                          options={[
                            { value: "ask", label: "Ask when it takes longer than…" },
                            { value: "always", label: "Always" },
                            { value: "never", label: "Never" },
                          ]}
                        />
                      </label>
                      {narrationMode === "ask" && (
                        <label>
                          …seconds of extra processing
                          <input type="number" min={0} step={1} value={narrationAskAbove} onChange={(e) => setNarrationAskAbove(e.target.value)} />
                        </label>
                      )}
                    </div>
                  </div>
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
                  <div className="ss-indent" id="settings-agent-tools">
                    <label>
                      <Caption
                        help={
                          <p>
                            Every Sandbox has a <code>sessionboxer</code> MCP: the Agent knows which Session it runs in (<code>whoami</code>,{" "}
                            <code>.sessionboxer/session.json</code>) and can act on Sessionboxer. <strong>Off</strong>: no <code>sessionboxer</code>{" "}
                            tools. <strong>This Session only</strong>: self-knowledge and actions on its own Session, its forks and schedules that
                            target it. <strong>All Sessions</strong>: the cross-Session tools too (list, message, create, fork, hand off). Every action
                            shows as a marker in the chat. Default for new Sessions; each Session can override it in its settings.
                          </p>
                        }
                      >
                        The sessionboxer MCP lets the Agent act on
                      </Caption>
                      <AgentToolsSelect value={agentTools} onChange={(v) => setAgentTools(v ?? "all")} />
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
                      <ApproveCreateSelect value={approveCreate} onChange={(v) => setApproveCreate(v ?? true)} />
                    </label>
                    <label>
                      <Caption help={<p>A cap over all Sessions; each Agent also keeps at most {AGENT_CHILDREN_PER_SESSION} of its own children alive.</p>}>
                        Sessions created by Agents alive at once
                      </Caption>
                      <input type="number" min={0} step={1} value={agentChildrenCap} onChange={(e) => setAgentChildrenCap(e.target.value)} />
                    </label>
                  </div>
                </li>
              </ul>

              <h4 className="ss-sub" id="settings-git">
                <Caption
                  help={
                    <p>
                      The accounts Sessions clone private repositories with, push as and open pull requests from. GitHub offers three logins: GitHub CLI
                      (everything your account sees), the Sessionboxer OAuth App (you grant organizations one by one on GitHub&apos;s page) and a
                      personal access token (the one that can be limited to a single organization); the dialog explains each. A GitHub account also adds
                      GitHub&apos;s MCP server to the list below. Public repositories need none.
                    </p>
                  }
                >
                  Git
                </Caption>
              </h4>
              <GitAccounts servers={mcpServers} onChange={setMcpServers} onStored={onStored} />
              <div className="row" id="settings-git-identity">
                <label>
                  <Caption
                    help={
                      <p>
                        Default author and committer of commits made in Sandboxes; blank takes this machine&apos;s git config
                        {settings.hostGitIdentity.name
                          ? ` (${settings.hostGitIdentity.name}${settings.hostGitIdentity.email ? ` <${settings.hostGitIdentity.email}>` : ""})`
                          : ""}
                        . Each Session can override it in its settings.
                      </p>
                    }
                  >
                    Git author name
                  </Caption>
                  <input value={gitUserName} onChange={(e) => setGitUserName(e.target.value)} placeholder={settings.hostGitIdentity.name} />
                </label>
                <label>
                  Git author email
                  <input value={gitUserEmail} onChange={(e) => setGitUserEmail(e.target.value)} placeholder={settings.hostGitIdentity.email} />
                </label>
              </div>
              <details className="ss-details" id="settings-github-app" open={githubAppOpen || block === "github-app"}>
                <summary>
                  <Caption
                    help={
                      <p>
                        Only for the “Log in with the Sessionboxer OAuth App” option of Git accounts. The built-in app (client id{" "}
                        <code>{CONNECTORS.github.defaultClientId}</code>) needs nothing here and uses the device-code flow. To have GitHub&apos;s consent
                        page name you instead, register your own app at github.com → Settings → Developer settings with callback URL{" "}
                        <code>{settings.remote.publicUrl}/api/connectors/github/callback</code> and Device Flow enabled; with its client secret set, the
                        browser redirect flow is used.
                      </p>
                    }
                  >
                    Your own GitHub OAuth App (optional)
                  </Caption>
                </summary>
                <div className="row">
                  <label>
                    Client ID (empty = built-in)
                    <input value={githubClientId} autoComplete="off" onChange={(e) => setGithubClientId(e.target.value)} placeholder={CONNECTORS.github.defaultClientId} />
                  </label>
                  <label>
                    Client secret (optional) {githubSecretSet ? <span className="ok">(set)</span> : <span className="muted">(not set)</span>}
                    <input
                      type="password"
                      autoComplete="off"
                      value={githubClientSecret}
                      onChange={(e) => setGithubClientSecret(e.target.value)}
                      placeholder={githubSecretSet ? "Leave empty to keep the current secret" : "Only for the redirect flow"}
                    />
                  </label>
                </div>
                {settings.connectors.github.clientSecretSet && (
                  <label className="check">
                    <input type="checkbox" checked={forgetGithubSecret} onChange={(e) => setForgetGithubSecret(e.target.checked)} />
                    Forget the stored client secret on Save (back to the device-code flow)
                  </label>
                )}
              </details>

              <h4 className="ss-sub">
                <Caption
                  help={
                    <p>
                      Available to every Session; each Session picks which ones are on (new Sessions start with the ones marked default) and can switch
                      them at any time. Servers on this machine are reachable as <code>host.docker.internal</code> (<code>localhost</code> URLs are
                      rewritten). <code>npx</code>, <code>uvx</code>, <code>python3</code> and <code>node</code> are available in the Sandbox; in a
                      Windows or macOS Session stdio servers run inside the VM. GitHub and Bitbucket entries come from the Git accounts above.
                    </p>
                  }
                >
                  MCP servers
                </Caption>
              </h4>
              <McpServersEditor servers={mcpServers} onChange={setMcpServers} onStored={onStored} />
            </section>
          )}

          {show("utilities") && (
            <section className="ss-section" id="settings-utilities">
              <h3>
                <Caption
                  help={
                    <p>
                      What Agents may investigate with: observability systems (New Relic, Grafana, Graylog, Argo CD…) and applications (a QA web app, an
                      admin UI, a database, an SSH host), each in a target Environment (prod, staging, qa) with its credentials and facets (web UI,
                      HTTP API, SSH, CLI, MCP server). A Session switches them on by group, Environment or one by one; the Agent reads the list in{" "}
                      <code>.sessionboxer/utilities.json</code> and uses credentials by name (<code>{"${util:<name>.password}"}</code>, <code>sb-util</code>)
                      without seeing them. Credentials are write-only here and never enter the chat. Agents can register Utilities too
                      (<code>utilities_add</code>; you allow each in the chat) and propose procedures. See{" "}
                      <a href={UTILITIES_DOCS} target="_blank" rel="noreferrer">
                        the guide
                      </a>
                      .
                    </p>
                  }
                >
                  Utilities
                </Caption>
              </h3>
              <UtilitiesEditor
                utilities={utilities}
                environments={utilityEnvironments}
                procedures={procedures}
                onUtilities={setUtilities}
                onEnvironments={setUtilityEnvironments}
                onProcedures={setProcedures}
              />
            </section>
          )}

          {show("verification") && (
            <section className="ss-section">
              <h3>Auto QA</h3>
              <label className="check switch">
                <input type="checkbox" checked={e2eVerify} onChange={(e) => setE2eVerify(e.target.checked)} />
                <span className="slider" aria-hidden="true" />
                <Caption
                  help={
                    <p>
                      After a completed turn the Agent gets a hidden follow-up: it looks at what changed, plans 2–5 test cases (up to 10 for a very
                      large change), runs them on the Sandbox desktop while recording, fixes and reruns what fails (3 attempts per case), and posts the
                      video. Turns that only answer are recorded as skipped. It costs a second turn of model time after each of yours. Default for new
                      Sessions; each Session can override it in its settings or from the Auto QA pane.
                    </p>
                  }
                >
                  Verify each turn end to end
                </Caption>
              </label>
            </section>
          )}

          {show("interface") && (
            <section className="ss-section">
              <h3>
                <Caption help={<p>How this browser shows Sessionboxer and how you talk to it. The theme is a preference of this browser; dictation runs on the machine the Control Plane runs on.</p>}>
                  Interface
                </Caption>
              </h3>
              <div id="settings-theme">
                <ThemeFieldset />
              </div>
              <h4 className="ss-sub" id="settings-dictation">
                <Caption
                  help={
                    <p>
                      The microphone button in the composer records a clip in the browser and whisper.cpp transcribes it on this machine, offline:
                      nothing leaves it (phones paired through a tunnel send the clip here). whisper-cli and the model are downloaded once, on first use
                      or with the button below. Detecting the language is slower and takes one language per clip.
                    </p>
                  }
                >
                  Dictation
                </Caption>
              </h4>
              <div className="row">
                <label>
                  Model
                  <Select<SpeechModel>
                    value={speechModel}
                    onChange={setSpeechModel}
                    aria-label="Dictation model"
                    options={SPEECH_MODELS.map((m) => ({
                      value: m,
                      label: `${SPEECH_MODEL_INFO[m].label} (${formatMb(SPEECH_MODEL_INFO[m].bytes)})`,
                      hint: SPEECH_MODEL_INFO[m].note,
                    }))}
                  />
                </label>
                <label>
                  Language
                  <Select<string>
                    value={speechLanguage}
                    onChange={setSpeechLanguage}
                    aria-label="Dictation language"
                    options={[
                      { value: "auto", label: "Detect (slower, one language per clip)" },
                      { value: "en", label: "English" },
                      { value: "es", label: "Spanish" },
                      { value: "pt", label: "Portuguese" },
                      { value: "fr", label: "French" },
                      { value: "de", label: "German" },
                      { value: "it", label: "Italian" },
                      { value: "ca", label: "Catalan" },
                      { value: "nl", label: "Dutch" },
                      { value: "pl", label: "Polish" },
                      { value: "ru", label: "Russian" },
                      { value: "uk", label: "Ukrainian" },
                      { value: "tr", label: "Turkish" },
                      { value: "ja", label: "Japanese" },
                      { value: "zh", label: "Chinese" },
                      { value: "ko", label: "Korean" },
                      { value: "hi", label: "Hindi" },
                      { value: "ar", label: "Arabic" },
                    ]}
                  />
                </label>
              </div>
              <SpeechAssets selected={speechModel} saved={settings.speech.model} />
            </section>
          )}

          {show("devices") && (
            <section className="ss-section">
              <Devices remote={settings.remote} tunnels={settings.tunnels} onStored={onStored} run={run} />
            </section>
          )}
        </TabPanel>
      </Tabs>
      <div className="actions settings-actions">
        <span className="muted">Stored in ~/.sessionboxer/config.json (mode 0600). Logins, resources and Docker apply to Sandboxes created afterwards; snapshot settings apply immediately.</span>
        <span className="spacer" />
        <button type="submit">Save</button>
      </div>
    </form>
  );
}
