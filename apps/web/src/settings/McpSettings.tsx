import {
  CONNECTORS,
  type AgentToolsPolicy,
  AGENT_CHILDREN_PER_SESSION,
  type NarrationMode,
  type PublicMcpServerDef,
  type PublicSettings,
} from "@sessionboxer/protocol";
import { AgentToolsSelect, ApproveCreateSelect } from "../SessionToolsPolicy";
import { GitAccounts } from "../GitAccounts";
import { McpServersEditor } from "../McpServersEditor";
import { DESKTOP_MCP_DOCS, SESSIONBOXER_MCP_DOCS } from "../SessionSettingsForm";
import { Caption, Select } from "../ui";
import type { Setter } from "./shared";

/** Global settings → MCP & connectors: the built-in MCPs' options, Git accounts and identity, the GitHub App and the registered MCP servers. */
export function McpSettings({
  settings,
  onStored,
  block,
  narrationMode,
  setNarrationMode,
  narrationAskAbove,
  setNarrationAskAbove,
  agentTools,
  setAgentTools,
  approveCreate,
  setApproveCreate,
  agentChildrenCap,
  setAgentChildrenCap,
  mcpServers,
  setMcpServers,
  gitUserName,
  setGitUserName,
  gitUserEmail,
  setGitUserEmail,
  githubClientId,
  setGithubClientId,
  githubClientSecret,
  setGithubClientSecret,
  forgetGithubSecret,
  setForgetGithubSecret,
  githubAppOpen,
}: {
  settings: PublicSettings;
  /** Settings the Control Plane stored on its own (connector logins), without the form being saved. */
  onStored: (s: PublicSettings) => void;
  /** The block a `#/settings/<id>` deep link named, if any (opens the GitHub App details). */
  block: string | null;
  narrationMode: NarrationMode;
  setNarrationMode: Setter<NarrationMode>;
  narrationAskAbove: string;
  setNarrationAskAbove: Setter<string>;
  agentTools: AgentToolsPolicy;
  setAgentTools: Setter<AgentToolsPolicy>;
  approveCreate: boolean;
  setApproveCreate: Setter<boolean>;
  agentChildrenCap: string;
  setAgentChildrenCap: Setter<string>;
  mcpServers: PublicMcpServerDef[];
  setMcpServers: Setter<PublicMcpServerDef[]>;
  gitUserName: string;
  setGitUserName: Setter<string>;
  gitUserEmail: string;
  setGitUserEmail: Setter<string>;
  githubClientId: string;
  setGithubClientId: Setter<string>;
  githubClientSecret: string;
  setGithubClientSecret: Setter<string>;
  forgetGithubSecret: boolean;
  setForgetGithubSecret: Setter<boolean>;
  githubAppOpen: boolean;
}) {
  const githubSecretSet = settings.connectors.github.clientSecretSet && !forgetGithubSecret;
  return (
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
  );
}
