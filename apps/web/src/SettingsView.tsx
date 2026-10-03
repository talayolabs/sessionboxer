import { useEffect, useState } from "react";
import {
  type AgentToolsPolicy,
  type NarrationMode,
  type PublicMcpServerDef,
  type PublicSettings,
  type PublicUtilityDef,
  type ProcedureDef,
  type UtilityEnvironment,
  type SpeechModel,
  type WindowsBaseStatus,
  type MacosBaseStatus,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { MOBILE_QUERY } from "./mobile";
import { ProvidersSettings } from "./settings/ProvidersSettings";
import { EnvironmentSettings } from "./settings/EnvironmentSettings";
import { AgentSettings } from "./settings/AgentSettings";
import { McpSettings } from "./settings/McpSettings";
import { UtilitiesSettings } from "./settings/UtilitiesSettings";
import { AutoQaSettings } from "./settings/AutoQaSettings";
import { InterfaceSettings } from "./settings/InterfaceSettings";
import { DevicesSettings } from "./settings/DevicesSettings";
import { parseOriginList } from "./settings/shared";
import { Tab, TabList, TabPanel, Tabs } from "./ui";

/**
 * The transcript refetched after a reconnection, keeping what the socket delivered while the fetch
 * was in flight (events newer than the fetch's last one, for the same Session).
 */
import type { Runner } from "./SessionView";

/** `pane` carries a deep link into a Session (`#/sessions/<id>/prs`, `…/pr/<prId>`, as notifications send them). */
export function mobileQuery(): boolean {
  return typeof matchMedia === "function" && matchMedia(MOBILE_QUERY).matches;
}

function parseAliasList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0))];
}

/** The sections of Global settings, in the order of the left-hand list; `id` is the `#/settings/<id>` route. */
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
  const [cursorLogin, setCursorLogin] = useState("");
  const [forgetCursorLogin, setForgetCursorLogin] = useState(false);
  const [piAuth, setPiAuth] = useState("");
  const [forgetPiAuth, setForgetPiAuth] = useState(false);
  const [piApiKeys, setPiApiKeys] = useState("");
  const [forgetPiApiKeys, setForgetPiApiKeys] = useState(false);
  const [opencodeAuth, setOpenCodeAuth] = useState("");
  const [forgetOpenCodeAuth, setForgetOpenCodeAuth] = useState(false);
  const [fxLogin, setFxLogin] = useState("");
  const [forgetFxLogin, setForgetFxLogin] = useState(false);
  const [claudeBaseUrl, setClaudeBaseUrl] = useState(settings.claudeApi.baseUrl);
  const [claudeAuthToken, setClaudeAuthToken] = useState("");
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [forgetClaudeAuthToken, setForgetClaudeAuthToken] = useState(false);
  const [forgetClaudeApiKey, setForgetClaudeApiKey] = useState(false);
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
  const [githubAppOpen] = useState(settings.connectors.github.clientId.trim() !== "" || settings.connectors.github.clientSecretSet);
  const [guided, setGuided] = useState(false);

  const { section: active, block } = resolveGlobalSettingsRoute(section);
  const show = (id: GlobalSettingsSection) => active === id;
  useEffect(() => {
    if (block) document.getElementById(`settings-${block}`)?.scrollIntoView({ block: "start" });
  }, [block]);

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
            <ProvidersSettings
              settings={settings}
              onStored={onStored}
              token={token}
              setToken={setToken}
              devinToken={devinToken}
              setDevinToken={setDevinToken}
              codexAuth={codexAuth}
              setCodexAuth={setCodexAuth}
              forgetCodexAuth={forgetCodexAuth}
              setForgetCodexAuth={setForgetCodexAuth}
              cursorLogin={cursorLogin}
              setCursorLogin={setCursorLogin}
              forgetCursorLogin={forgetCursorLogin}
              setForgetCursorLogin={setForgetCursorLogin}
              piAuth={piAuth}
              setPiAuth={setPiAuth}
              forgetPiAuth={forgetPiAuth}
              setForgetPiAuth={setForgetPiAuth}
              piApiKeys={piApiKeys}
              setPiApiKeys={setPiApiKeys}
              forgetPiApiKeys={forgetPiApiKeys}
              setForgetPiApiKeys={setForgetPiApiKeys}
              opencodeAuth={opencodeAuth}
              setOpenCodeAuth={setOpenCodeAuth}
              forgetOpenCodeAuth={forgetOpenCodeAuth}
              setForgetOpenCodeAuth={setForgetOpenCodeAuth}
              fxLogin={fxLogin}
              setFxLogin={setFxLogin}
              forgetFxLogin={forgetFxLogin}
              setForgetFxLogin={setForgetFxLogin}
              claudeBaseUrl={claudeBaseUrl}
              setClaudeBaseUrl={setClaudeBaseUrl}
              claudeAuthToken={claudeAuthToken}
              setClaudeAuthToken={setClaudeAuthToken}
              claudeApiKey={claudeApiKey}
              setClaudeApiKey={setClaudeApiKey}
              forgetClaudeAuthToken={forgetClaudeAuthToken}
              setForgetClaudeAuthToken={setForgetClaudeAuthToken}
              forgetClaudeApiKey={forgetClaudeApiKey}
              setForgetClaudeApiKey={setForgetClaudeApiKey}
              guided={guided}
              setGuided={setGuided}
            />
          )}

          {show("environment") && (
            <EnvironmentSettings
              settings={settings}
              cpus={cpus}
              setCpus={setCpus}
              memory={memory}
              setMemory={setMemory}
              docker={docker}
              setDocker={setDocker}
              dockerPool={dockerPool}
              setDockerPool={setDockerPool}
              autoSnapshot={autoSnapshot}
              setAutoSnapshot={setAutoSnapshot}
              snapshotKeep={snapshotKeep}
              setSnapshotKeep={setSnapshotKeep}
              windowsVersion={windowsVersion}
              setWindowsVersion={setWindowsVersion}
              windowsDisk={windowsDisk}
              setWindowsDisk={setWindowsDisk}
              windowsRam={windowsRam}
              setWindowsRam={setWindowsRam}
              windowsCpus={windowsCpus}
              setWindowsCpus={setWindowsCpus}
              macosVersion={macosVersion}
              setMacosVersion={setMacosVersion}
              macosDisk={macosDisk}
              setMacosDisk={setMacosDisk}
              macosRam={macosRam}
              setMacosRam={setMacosRam}
              macosCpus={macosCpus}
              setMacosCpus={setMacosCpus}
              trustHostCaCerts={trustHostCaCerts}
              setTrustHostCaCerts={setTrustHostCaCerts}
              extraCaCerts={extraCaCerts}
              setExtraCaCerts={setExtraCaCerts}
              windowsBase={windowsBase}
              onWindowsBase={onWindowsBase}
              macosBase={macosBase}
              onMacosBase={onMacosBase}
            />
          )}

          {show("agent") && (
            <AgentSettings
              claudeModels={claudeModels}
              setClaudeModels={setClaudeModels}
              instructions={instructions}
              setInstructions={setInstructions}
              htmlAppCdns={htmlAppCdns}
              setHtmlAppCdns={setHtmlAppCdns}
            />
          )}

          {show("mcp") && (
            <McpSettings
              settings={settings}
              onStored={onStored}
              block={block}
              narrationMode={narrationMode}
              setNarrationMode={setNarrationMode}
              narrationAskAbove={narrationAskAbove}
              setNarrationAskAbove={setNarrationAskAbove}
              agentTools={agentTools}
              setAgentTools={setAgentTools}
              approveCreate={approveCreate}
              setApproveCreate={setApproveCreate}
              agentChildrenCap={agentChildrenCap}
              setAgentChildrenCap={setAgentChildrenCap}
              mcpServers={mcpServers}
              setMcpServers={setMcpServers}
              gitUserName={gitUserName}
              setGitUserName={setGitUserName}
              gitUserEmail={gitUserEmail}
              setGitUserEmail={setGitUserEmail}
              githubClientId={githubClientId}
              setGithubClientId={setGithubClientId}
              githubClientSecret={githubClientSecret}
              setGithubClientSecret={setGithubClientSecret}
              forgetGithubSecret={forgetGithubSecret}
              setForgetGithubSecret={setForgetGithubSecret}
              githubAppOpen={githubAppOpen}
            />
          )}

          {show("utilities") && (
            <UtilitiesSettings
              utilities={utilities}
              setUtilities={setUtilities}
              utilityEnvironments={utilityEnvironments}
              setUtilityEnvironments={setUtilityEnvironments}
              procedures={procedures}
              setProcedures={setProcedures}
            />
          )}

          {show("verification") && <AutoQaSettings e2eVerify={e2eVerify} setE2eVerify={setE2eVerify} />}

          {show("interface") && (
            <InterfaceSettings
              settings={settings}
              speechModel={speechModel}
              setSpeechModel={setSpeechModel}
              speechLanguage={speechLanguage}
              setSpeechLanguage={setSpeechLanguage}
            />
          )}

          {show("devices") && <DevicesSettings settings={settings} onStored={onStored} run={run} />}
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
