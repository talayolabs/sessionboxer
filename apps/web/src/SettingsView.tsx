import { useEffect } from "react";
import {
  type PublicSettings,
  type WindowsBaseStatus,
  type MacosBaseStatus,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { MOBILE_QUERY } from "./mobile";
import { ProvidersSettings, useProvidersSettings } from "./settings/ProvidersSettings";
import { EnvironmentSettings, useEnvironmentSettings } from "./settings/EnvironmentSettings";
import { AgentSettings, useAgentSettings } from "./settings/AgentSettings";
import { McpSettings, useMcpSettings } from "./settings/McpSettings";
import { UtilitiesSettings, useUtilitiesSettings } from "./settings/UtilitiesSettings";
import { AutoQaSettings, useAutoQaSettings } from "./settings/AutoQaSettings";
import { InterfaceSettings, useInterfaceSettings } from "./settings/InterfaceSettings";
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
  const providers = useProvidersSettings(settings);
  const environment = useEnvironmentSettings(settings);
  const agent = useAgentSettings(settings);
  const mcp = useMcpSettings(settings);
  const utilities = useUtilitiesSettings(settings);
  const autoQa = useAutoQaSettings(settings);
  const ui = useInterfaceSettings(settings);

  const { section: active, block } = resolveGlobalSettingsRoute(section);
  const show = (id: GlobalSettingsSection) => active === id;
  useEffect(() => {
    if (block) document.getElementById(`settings-${block}`)?.scrollIntoView({ block: "start" });
  }, [block]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const saved = await api.updateSettings({
        gitUserName: mcp.values.gitUserName,
        gitUserEmail: mcp.values.gitUserEmail,
        sandboxCpus: Number(environment.values.cpus),
        sandboxMemoryGb: Number(environment.values.memory),
        dockerInSandbox: environment.values.docker,
        sandboxDockerAddressPool: environment.values.dockerPool.trim(),
        windows: {
          version: environment.values.windowsVersion,
          ramGb: Math.max(1, Number(environment.values.windowsRam) || settings.windows.ramGb),
          cpus: Math.max(1, Math.floor(Number(environment.values.windowsCpus) || settings.windows.cpus)),
          diskGb: Math.max(16, Math.floor(Number(environment.values.windowsDisk) || settings.windows.diskGb)),
        },
        macos: {
          version: environment.values.macosVersion,
          ramGb: Math.max(2, Number(environment.values.macosRam) || settings.macos.ramGb),
          cpus: Math.max(1, Math.floor(Number(environment.values.macosCpus) || settings.macos.cpus)),
          diskGb: Math.max(32, Math.floor(Number(environment.values.macosDisk) || settings.macos.diskGb)),
        },
        autoSnapshot: environment.values.autoSnapshot,
        snapshotKeep: Math.max(0, Math.floor(Number(environment.values.snapshotKeep) || 0)),
        e2eVerify: autoQa.values.e2eVerify,
        agentTools: mcp.values.agentTools,
        approveCreate: mcp.values.approveCreate,
        agentChildrenCap: Math.max(0, Math.floor(Number(mcp.values.agentChildrenCap) || 0)),
        recordingNarration: { mode: mcp.values.narrationMode, askAboveSeconds: Math.max(0, Number(mcp.values.narrationAskAbove) || 0) },
        speech: { model: ui.values.speechModel, language: ui.values.speechLanguage },
        mcpServers: mcp.values.mcpServers,
        utilities: utilities.values.utilities,
        utilityEnvironments: utilities.values.utilityEnvironments,
        procedures: utilities.values.procedures,
        claudeModels: parseAliasList(agent.values.claudeModels),
        instructions: agent.values.instructions,
        htmlAppCdns: parseOriginList(agent.values.htmlAppCdns),
        trustHostCaCerts: environment.values.trustHostCaCerts,
        extraCaCerts: environment.values.extraCaCerts,
        connectors: {
          github: {
            clientId: mcp.values.githubClientId.trim(),
            ...(mcp.values.githubClientSecret.trim() ? { clientSecret: mcp.values.githubClientSecret.trim() } : mcp.values.forgetGithubSecret ? { clientSecret: "" } : {}),
          },
        },
        providerSecrets: {
          ...(providers.values.token.trim() ? { "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: providers.values.token.trim() } } : {}),
          ...(providers.values.devinToken.trim() ? { devin: { WINDSURF_API_KEY: providers.values.devinToken.trim() } } : {}),
          ...(providers.values.codexAuth.trim() ? { codex: { CODEX_AUTH_JSON: providers.values.codexAuth.trim() } } : providers.values.forgetCodexAuth ? { codex: { CODEX_AUTH_JSON: "" } } : {}),
          ...(providers.values.cursorLogin.trim() ? { cursor: { CURSOR_LOGIN: providers.values.cursorLogin.trim() } } : providers.values.forgetCursorLogin ? { cursor: { CURSOR_LOGIN: "" } } : {}),
          ...(providers.values.piAuth.trim() || providers.values.forgetPiAuth || providers.values.piApiKeys.trim() || providers.values.forgetPiApiKeys
            ? {
                pi: {
                  ...(providers.values.piAuth.trim() ? { PI_AUTH_JSON: providers.values.piAuth.trim() } : providers.values.forgetPiAuth ? { PI_AUTH_JSON: "" } : {}),
                  ...(providers.values.piApiKeys.trim() ? { PI_API_KEYS: providers.values.piApiKeys.trim() } : providers.values.forgetPiApiKeys ? { PI_API_KEYS: "" } : {}),
                },
              }
            : {}),
          ...(providers.values.opencodeAuth.trim() ? { opencode: { OPENCODE_AUTH_JSON: providers.values.opencodeAuth.trim() } } : providers.values.forgetOpenCodeAuth ? { opencode: { OPENCODE_AUTH_JSON: "" } } : {}),
          ...(providers.values.kimiLogin.trim() ? { kimi: { KIMI_LOGIN: providers.values.kimiLogin.trim() } } : providers.values.forgetKimiLogin ? { kimi: { KIMI_LOGIN: "" } } : {}),
          ...(providers.values.fxLogin.trim() ? { fx: { FX_LOGIN: providers.values.fxLogin.trim() } } : providers.values.forgetFxLogin ? { fx: { FX_LOGIN: "" } } : {}),
          ...(providers.values.copilotLogin.trim()
            ? { copilot: { COPILOT_LOGIN: providers.values.copilotLogin.trim() } }
            : providers.values.forgetCopilotLogin
              ? { copilot: { COPILOT_LOGIN: "" } }
              : {}),
          ...(providers.values.vibeLogin.trim() ? { vibe: { VIBE_LOGIN: providers.values.vibeLogin.trim() } } : providers.values.forgetVibeLogin ? { vibe: { VIBE_LOGIN: "" } } : {}),
          ...(providers.values.grokLogin.trim() ? { grok: { GROK_LOGIN: providers.values.grokLogin.trim() } } : providers.values.forgetGrokLogin ? { grok: { GROK_LOGIN: "" } } : {}),
          ...(providers.values.geminiLogin.trim() ? { gemini: { GEMINI_LOGIN: providers.values.geminiLogin.trim() } } : providers.values.forgetGeminiLogin ? { gemini: { GEMINI_LOGIN: "" } } : {}),
        },
        claudeApi: {
          baseUrl: providers.values.claudeBaseUrl.trim(),
          ...(providers.values.claudeAuthToken.trim() ? { authToken: providers.values.claudeAuthToken.trim() } : providers.values.forgetClaudeAuthToken ? { authToken: "" } : {}),
          ...(providers.values.claudeApiKey.trim() ? { apiKey: providers.values.claudeApiKey.trim() } : providers.values.forgetClaudeApiKey ? { apiKey: "" } : {}),
        },
      });
      providers.set.setToken("");
      providers.set.setDevinToken("");
      providers.set.setCodexAuth("");
      providers.set.setForgetCodexAuth(false);
      providers.set.setCursorLogin("");
      providers.set.setForgetCursorLogin(false);
      providers.set.setPiAuth("");
      providers.set.setForgetPiAuth(false);
      providers.set.setPiApiKeys("");
      providers.set.setForgetPiApiKeys(false);
      providers.set.setOpencodeAuth("");
      providers.set.setForgetOpenCodeAuth(false);
      providers.set.setFxLogin("");
      providers.set.setForgetFxLogin(false);
      providers.set.setVibeLogin("");
      providers.set.setForgetVibeLogin(false);
      providers.set.setGrokLogin("");
      providers.set.setForgetGrokLogin(false);
      providers.set.setGeminiLogin("");
      providers.set.setForgetGeminiLogin(false);
      providers.set.setClaudeAuthToken("");
      providers.set.setClaudeApiKey("");
      providers.set.setForgetClaudeAuthToken(false);
      providers.set.setForgetClaudeApiKey(false);
      mcp.set.setGithubClientSecret("");
      mcp.set.setForgetGithubSecret(false);
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
          {show("providers") && <ProvidersSettings settings={settings} onStored={onStored} {...providers.values} {...providers.set} />}

          {show("environment") && (
            <EnvironmentSettings
              settings={settings}
              {...environment.values}
              {...environment.set}
              windowsBase={windowsBase}
              onWindowsBase={onWindowsBase}
              macosBase={macosBase}
              onMacosBase={onMacosBase}
            />
          )}

          {show("agent") && <AgentSettings {...agent.values} {...agent.set} />}

          {show("mcp") && <McpSettings settings={settings} onStored={onStored} block={block} {...mcp.values} {...mcp.set} />}

          {show("utilities") && <UtilitiesSettings {...utilities.values} {...utilities.set} />}

          {show("verification") && <AutoQaSettings {...autoQa.values} {...autoQa.set} />}

          {show("interface") && <InterfaceSettings settings={settings} {...ui.values} {...ui.set} />}

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
