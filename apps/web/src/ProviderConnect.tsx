import { useRef, useState, type ReactNode } from "react";
import { PROVIDER_LABELS, type Provider, type PublicSettings } from "@sessionboxer/protocol";
import { api } from "./api";
import { CopyCommand } from "./CopyCommand";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderLogos } from "./ProviderLogos";
import { ProviderSignIn } from "./ProviderSignIn";
import { providerTokenSet } from "./providers";
import { Modal, Tab, TabList, TabPanel, Tabs } from "./ui";

export type Os = "mac" | "windows" | "linux";

export const OS_LABELS: Record<Os, string> = {
  mac: "macOS",
  windows: "Windows",
  linux: "Linux",
};

/** The OS of the machine the person is sitting at (that is where the Provider CLIs run), else the Control Plane's. */
export function detectOs(settings: PublicSettings): Os {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua)) return "mac";
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return settings.hostPlatform === "darwin"
    ? "mac"
    : settings.hostPlatform === "win32"
      ? "windows"
      : "linux";
}

export const PROVIDER_BLURB: Record<Provider, string> = {
  "claude-code": "Anthropic's Agent; runs on your Claude subscription",
  codex: "OpenAI's Agent; runs on your ChatGPT subscription",
  cursor: "Cursor's Agent; runs on your Cursor subscription",
  devin: "Cognition's Agent; runs on your Devin account",
  pi: "earendil-works' open-source Agent; runs on your own model API keys or logins",
  opencode: "The open-source Agent; runs on the model subscriptions and API keys of its providers",
  kimi: "Moonshot AI’s coding agent, using your Kimi Code account",
  fx: "Vercel Labs' Agent; runs on Vercel's AI Gateway, or your ChatGPT or Grok subscription",
  copilot: "GitHub's Agent; runs on your GitHub Copilot subscription",
  vibe: "Mistral's open-source Agent; runs on your Mistral account or a Mistral API key",
};

interface Step {
  title: string;
  body?: ReactNode;
  commands: string[];
}

/** The commands to run on the person's own machine, per OS: install the Provider's CLI, log in, get the credential. */
function steps(provider: Provider, os: Os): Step[] {
  const shell = os === "windows" ? "PowerShell" : "a terminal";
  switch (provider) {
    case "claude-code":
      return [
        {
          title: `Install Claude Code (skip if you already use it)`,
          body:
            os === "windows"
              ? "In PowerShell (not CMD or Git Bash):"
              : `In ${shell}; Homebrew users can run brew install --cask claude-code instead.`,
          commands: [
            os === "windows"
              ? "irm https://claude.ai/install.ps1 | iex"
              : "curl -fsSL https://claude.ai/install.sh | bash",
          ],
        },
        {
          title: "Create a long-lived token",
          body: "Logs you in with your Claude subscription in the browser, then prints a token that starts with sk-ant-oat…",
          commands: ["claude setup-token"],
        },
        { title: "Paste the token below", commands: [] },
      ];
    case "codex":
      return [
        {
          title: "Install Codex (skip if you already use it)",
          body:
            os === "windows"
              ? "Needs Node.js 18+ (winget install OpenJS.NodeJS.LTS if missing); in PowerShell:"
              : `In ${shell}; or npm i -g @openai/codex if you have Node.js.`,
          commands: [
            os === "windows"
              ? "npm i -g @openai/codex"
              : "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
          ],
        },
        {
          title: "Log in with your ChatGPT account",
          body: "Opens the browser; pick Sign in with ChatGPT.",
          commands: ["codex login"],
        },
        {
          title: "Copy the login file it wrote and paste it below",
          body: "The whole file, or use Import below. The Sandbox keeps it in memory only; refreshed tokens flow back here.",
          commands: [
            os === "windows"
              ? "Get-Content $env:USERPROFILE\\.codex\\auth.json"
              : "cat ~/.codex/auth.json",
          ],
        },
      ];
    case "cursor":
      return [
        {
          title: "Install the Cursor CLI (skip if you already use it)",
          body: os === "windows" ? "In PowerShell:" : `In ${shell}:`,
          commands: [
            os === "windows"
              ? "irm 'https://cursor.com/install?win32=true' | iex"
              : "curl https://cursor.com/install -fsS | bash",
          ],
        },
        {
          title: "Log in",
          body: "Opens the browser with your Cursor account.",
          commands: ["agent login"],
        },
        {
          title: "Copy the login file it wrote and paste it below",
          body: "The whole file, or use Import below. An API key from cursor.com → Dashboard → Integrations works too.",
          commands: [
            os === "windows" ? "Get-Content $env:APPDATA\\Cursor\\auth.json" : os === "mac" ? "cat ~/.cursor/auth.json" : "cat ~/.config/cursor/auth.json",
          ],
        },
      ];
    case "opencode":
      return [
        {
          title: "Install OpenCode (skip if you already use it)",
          body:
            os === "windows"
              ? "Needs Node.js 18+ (winget install OpenJS.NodeJS.LTS if missing); in PowerShell:"
              : `In ${shell}; or npm i -g opencode-ai, brew install opencode.`,
          commands: [os === "windows" ? "npm i -g opencode-ai" : "curl -fsSL https://opencode.ai/install | bash"],
        },
        {
          title: "Log in with a model provider",
          body: "Pick the provider (Anthropic with a Claude Pro/Max login, OpenAI with ChatGPT, OpenCode Zen, Google, an API key…) and sign in; repeat for each provider you want.",
          commands: ["opencode auth login"],
        },
        {
          title: "Copy the login file it wrote and paste it below",
          body: "The whole file, or use Import below. An OpenCode Zen API key from opencode.ai/auth works too. The Sandbox keeps it in memory only; refreshed tokens flow back here.",
          commands: [os === "windows" ? "Get-Content $env:USERPROFILE\\.local\\share\\opencode\\auth.json" : "cat ~/.local/share/opencode/auth.json"],
        },
      ];
    case "kimi":
      return [
        { title: "Install Kimi CLI (skip if already installed)", body: "Requires uv; macOS standalone builds are Apple Silicon only.", commands: ["uv tool install kimi-cli==1.52.0"] },
        { title: "Sign in with your Kimi account", body: "Opens a browser device sign-in. You can also use Sign in with Kimi CLI here.", commands: ["kimi login"] },
        { title: "Paste or import the whole OAuth file below", body: "API-key-only use is unsupported until Kimi’s ACP server honours it. Refreshed tokens flow back to Settings.", commands: [os === "windows" ? "Get-Content $env:USERPROFILE\\.kimi\\credentials\\kimi-code.json" : "cat ~/.kimi/credentials/kimi-code.json"] },
      ];
    case "fx":
      return [
        {
          title: "Install fx (skip if you already use it)",
          body: `In ${shell} (fx runs on macOS and Linux; there is no Windows build):`,
          commands: ["curl -fsSL https://fx.sh/setup.sh | bash"],
        },
        {
          title: "Log in",
          body: "Opens the browser with your Vercel account; `fx login codex` or `fx login grok` use a ChatGPT or Grok subscription instead.",
          commands: ["fx login"],
        },
        {
          title: "Copy the login file it wrote and paste it below",
          body: "The whole file, or use Import below (chatgpt-auth.json / grok-auth.json for the other logins). An AI Gateway API key from vercel.com → AI Gateway → API keys works too.",
          commands: ["cat ~/.fx/auth.json"],
        },
      ];
    case "copilot":
      return [
        {
          title: "Install GitHub Copilot CLI (skip if you already use it)",
          body: `In ${shell} (needs Node.js 22; a Copilot subscription with the CLI enabled):`,
          commands: ["npm install -g @github/copilot"],
        },
        {
          title: "Log in",
          body: "Opens github.com with a one-time code. Put { \"storeTokenPlaintext\": true } in ~/.copilot/settings.json first so the token lands in a file rather than the OS keychain.",
          commands: ["copilot login"],
        },
        {
          title: "Copy the login file it wrote and paste it below",
          body: "The whole file, or use Import below. A fine-grained GitHub token with the Copilot Requests permission (github.com → Settings → Developer settings) works too.",
          commands: [os === "windows" ? "Get-Content $env:USERPROFILE\\.copilot\\config.json" : "cat ~/.copilot/config.json"],
        },
      ];
    case "vibe":
      return [
        {
          title: "Get a Mistral API key",
          body: "Sign in with Mistral Vibe above (the browser opens console.mistral.ai), or create a key at console.mistral.ai → API Keys and paste it below.",
          commands: [],
        },
        {
          title: "Or copy the login Vibe made on your machine",
          body: `If you use Mistral Vibe (${os === "windows" ? "`uv tool install mistral-vibe`" : "`uv tool install mistral-vibe` or its installer"}) and signed in there, it keeps the key in your OS keyring, or in this file when there is none:`,
          commands: [os === "windows" ? "Get-Content $env:USERPROFILE\\.vibe\\.env" : "cat ~/.vibe/.env"],
        },
      ];
    case "devin":
      return [
        {
          title: "Install the Devin CLI (skip if you already use it)",
          body:
            os === "windows"
              ? "In PowerShell (not CMD or Git Bash):"
              : os === "mac"
                ? "In a terminal; Homebrew users can run brew install --cask devin-cli instead."
                : "In a terminal:",
          commands: [
            os === "windows"
              ? "irm https://static.devin.ai/cli/setup.ps1 | iex"
              : "curl -fsSL https://cli.devin.ai/install.sh | bash",
          ],
        },
        {
          title: "Log in",
          body: "Opens the browser with your Devin account.",
          commands: ["devin auth login"],
        },
        {
          title:
            "Copy the token out of the credentials file it wrote and paste it below",
          body:
            os === "windows"
              ? "The file is called credentials.toml, in the Devin CLI's data folder under your user profile; copy the token value from it."
              : "Copy the token value (not the whole file). The Sandbox gets it as WINDSURF_API_KEY.",
          commands:
            os === "windows"
              ? []
              : ["cat ~/.local/share/devin/credentials.toml"],
        },
      ];
    case "pi":
      return [
        {
          title: "Install pi (skip if you already use it)",
          body: "Needs Node.js 22+; in a terminal:",
          commands: ["npm i -g @earendil-works/pi-coding-agent"],
        },
        {
          title: "Log in to a model provider, or get an API key",
          body: "Run pi and type /login to sign in (Anthropic, OpenAI, GitHub Copilot, OpenRouter, …); it writes auth.json. Or take an API key from the provider's console instead.",
          commands: ["pi"],
        },
        {
          title: "Paste the login file, or the API keys, below",
          body: "The whole auth.json (or use Import below), or NAME=value lines such as ANTHROPIC_API_KEY=… or OPENAI_API_KEY=…, one per provider. The Sandbox keeps them in memory only.",
          commands: [
            os === "windows"
              ? "Get-Content $env:USERPROFILE\\.pi\\agent\\auth.json"
              : "cat ~/.pi/agent/auth.json",
          ],
        },
      ];
  }
}

function credentialField(provider: Provider): {
  label: string;
  multiline: boolean;
  file: boolean;
  /** What the import button names when it is not `auth.json`. */
  fileName?: string;
  placeholder: string;
} {
  switch (provider) {
    case "claude-code":
      return {
        label: "Claude Code token",
        multiline: false,
        file: false,
        placeholder: "sk-ant-oat01-…",
      };
    case "devin":
      return {
        label: "Devin token",
        multiline: false,
        file: false,
        placeholder: "Paste the token",
      };
    case "codex":
      return {
        label: "Codex login (contents of auth.json)",
        multiline: true,
        file: true,
        placeholder: '{ "tokens": … }',
      };
    case "cursor":
      return {
        label: "Cursor login (contents of auth.json, or an API key)",
        multiline: true,
        file: true,
        placeholder: "{ … } or key_…",
      };
    case "pi":
      return {
        label: "pi login (contents of auth.json, or NAME=value API keys)",
        multiline: true,
        file: true,
        placeholder: '{ "anthropic": … } or ANTHROPIC_API_KEY=sk-ant-…',
      };
    case "opencode":
      return {
        label: "OpenCode login (contents of auth.json, or an OpenCode Zen API key)",
        multiline: true,
        file: true,
        placeholder: '{ "anthropic": { "type": "oauth", … } } or sk-…',
      };
    case "kimi":
      return { label: "Kimi CLI login (kimi-code.json)", multiline: true, file: true, fileName: "kimi-code.json", placeholder: '{ "access_token": …, "refresh_token": … }' };
    case "fx":
      return {
        label: "fx login (contents of ~/.fx/auth.json, or an AI Gateway API key)",
        multiline: true,
        file: true,
        placeholder: "{ … } or vck_…",
      };
    case "copilot":
      return {
        label: "GitHub Copilot login (contents of ~/.copilot/config.json, or a GitHub token)",
        multiline: true,
        file: true,
        fileName: "config.json",
        placeholder: "{ … } or github_pat_…",
      };
    case "vibe":
      return { label: "Mistral Vibe login (a Mistral API key, or the contents of ~/.vibe/.env)", multiline: true, file: true, placeholder: "The API key, or MISTRAL_API_KEY='…'" };
  }
}

function secretUpdate(provider: Provider, value: string) {
  switch (provider) {
    case "claude-code":
      return { "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: value } };
    case "devin":
      return { devin: { WINDSURF_API_KEY: value } };
    case "codex":
      return { codex: { CODEX_AUTH_JSON: value } };
    case "cursor":
      return { cursor: { CURSOR_LOGIN: value } };
    case "pi":
      return value.startsWith("{") ? { pi: { PI_AUTH_JSON: value } } : { pi: { PI_API_KEYS: value } };
    case "opencode":
      return { opencode: { OPENCODE_AUTH_JSON: value } };
    case "kimi":
      return { kimi: { KIMI_LOGIN: value } };
    case "fx":
      return { fx: { FX_LOGIN: value } };
    case "copilot":
      return { copilot: { COPILOT_LOGIN: value } };
    case "vibe":
      return { vibe: { VIBE_LOGIN: value } };
  }
}

/**
 * "Connect a Provider": the four logos, then for the chosen one "Sign in with …" (the browser
 * login, ADR-0058) and, folded away, the three commands to run on your own machine (for your OS,
 * others one click away) with a field to paste the result into. Saves right away; the same
 * secrets as Global settings → Providers.
 */
export function ProviderConnectDialog({
  settings,
  initial,
  onClose,
  onStored,
}: {
  settings: PublicSettings;
  /** Open on this Provider's steps; `null` starts at the four logos. */
  initial: Provider | null;
  onClose: () => void;
  onStored: (settings: PublicSettings) => void;
}) {
  const [provider, setProvider] = useState<Provider | null>(initial);
  const [os, setOs] = useState<Os>(() => detectOs(settings));
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [manual, setManual] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = (p: Provider) => {
    setProvider(p);
    setValue("");
    setError(null);
    setSaved(false);
    setManual(false);
  };

  const save = async () => {
    if (!provider || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateSettings({
        providerSecrets: secretUpdate(provider, value.trim()),
      });
      onStored(next);
      setValue("");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = provider ? providerTokenSet(settings, provider) : false;
  const field = provider ? credentialField(provider) : null;

  return (
    <Modal
      className="provider-connect"
      titleClassName="large"
      title={
        <>
          {provider && (
            <button
              type="button"
              className="link"
              onClick={() => setProvider(null)}
              aria-label="Back to the list of Providers"
            >
              ‹ Providers
            </button>
          )}
          <span>
            {provider
              ? `Connect ${PROVIDER_LABELS[provider]}`
              : "Connect a Provider"}
          </span>
          <span className="spacer" />
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        </>
      }
      onClose={onClose}
    >
      {!provider && (
        <>
          <p className="muted">
            A Session runs one of these Agents with your own subscription;
            connect the one you have (one is enough). Sign in with the
            Provider in this browser, or make the login with its CLI on your
            machine and paste it here.
          </p>
          <ProviderLogos settings={settings} onPick={pick} />
        </>
      )}
      {provider && field && (
        <>
          <div className="provider-connect-head">
            <ProviderIcon provider={provider} size={40} />
            {connected && <span className="ok">Connected</span>}
          </div>
          <ProviderSignIn
            provider={provider}
            connected={connected}
            onStored={onStored}
          />
          <details
            className="provider-manual"
            open={manual}
            onToggle={(e) => setManual(e.currentTarget.open)}
          >
            <summary>Or using the CLI</summary>
          <Tabs className="tabs" value={os} onValueChange={setOs}>
            <div className="os-row">
              <span className="muted">Commands for</span>
              <TabList className="segmented small" aria-label="Operating system of your machine">
                {(["mac", "windows", "linux"] as const).map((o) => (
                  <Tab key={o} value={o}>
                    {OS_LABELS[o]}
                  </Tab>
                ))}
              </TabList>
              <span className="muted">
                (where you run the CLI, not the Sessionboxer server)
              </span>
            </div>
            <TabPanel value={os} asChild>
              <ol className="connect-steps">
                {steps(provider, os).map((step, i) => (
                  <li key={i}>
                    <strong>{step.title}</strong>
                    {step.body && <p className="muted">{step.body}</p>}
                    {step.commands.map((c) => (
                      <CopyCommand key={c} command={c} />
                    ))}
                  </li>
                ))}
              </ol>
            </TabPanel>
          </Tabs>
          <label>
            {field.label}{" "}
            {connected && <span className="ok">(set; paste to replace)</span>}
            {field.multiline ? (
              <textarea
                rows={3}
                spellCheck={false}
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={field.placeholder}
              />
            ) : (
              <input
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  }
                }}
                placeholder={field.placeholder}
              />
            )}
          </label>
          {field.file && (
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void f.text().then(setValue);
              }}
            />
          )}
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <span className="spacer" />
            {field.file && (
              <button
                type="button"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                Import {field.fileName ?? "auth.json"}…
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={busy || !value.trim()}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
          </details>
          {saved && !error && (
            <p className="ok">
              Saved. Sessions can use {PROVIDER_LABELS[provider]} now.
            </p>
          )}
          <div className="actions">
            <a
              className="muted"
              href="#/settings/providers"
              onClick={onClose}
            >
              More options in Global settings
            </a>
            <span className="spacer" />
            {(saved || connected) && (
              <button type="button" onClick={onClose}>
                Done
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
