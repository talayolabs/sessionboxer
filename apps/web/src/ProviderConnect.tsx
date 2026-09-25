import { useRef, useState, type ReactNode } from "react";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  type Provider,
  type PublicSettings,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { CopyCommand } from "./CopyCommand";
import { ProviderIcon } from "./ProviderIcon";
import { providerTokenSet } from "./providers";

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

export function OsTabs({
  value,
  onChange,
}: {
  value: Os;
  onChange: (os: Os) => void;
}) {
  return (
    <div
      className="os-tabs"
      role="tablist"
      aria-label="Operating system of your machine"
    >
      {(["mac", "windows", "linux"] as const).map((os) => (
        <button
          key={os}
          type="button"
          role="tab"
          aria-selected={value === os}
          className={value === os ? "active" : ""}
          onClick={() => onChange(os)}
        >
          {OS_LABELS[os]}
        </button>
      ))}
    </div>
  );
}

const PROVIDER_BLURB: Record<Provider, string> = {
  "claude-code": "Anthropic's Agent; runs on your Claude subscription",
  codex: "OpenAI's Agent; runs on your ChatGPT subscription",
  cursor: "Cursor's Agent; runs on your Cursor subscription",
  devin: "Cognition's Agent; runs on your Devin account",
};

/** Four big buttons, one per Provider, marked when a login is already stored. */
export function ProviderLogos({
  settings,
  onPick,
  size = 40,
}: {
  settings: PublicSettings;
  onPick: (provider: Provider) => void;
  size?: number;
}) {
  return (
    <div className="provider-logos">
      {PROVIDERS.map((p) => {
        const set = providerTokenSet(settings, p);
        return (
          <button
            key={p}
            type="button"
            className={`provider-logo${set ? " connected" : ""}`}
            onClick={() => onPick(p)}
            title={PROVIDER_BLURB[p]}
          >
            <ProviderIcon provider={p} size={size} />
            <span className="provider-logo-name">{PROVIDER_LABELS[p]}</span>
            <span className={`provider-logo-state ${set ? "ok" : "muted"}`}>
              {set ? "connected" : "not connected"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

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
          body:
            os === "windows"
              ? "The whole file (it is in Cursor's config folder under your user profile), or use Import below. An API key from cursor.com → Dashboard → Integrations works too."
              : "The whole file, or use Import below. An API key from cursor.com → Dashboard → Integrations works too.",
          commands: os === "windows" ? [] : ["cat ~/.config/cursor/auth.json"],
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
  }
}

function credentialField(provider: Provider): {
  label: string;
  multiline: boolean;
  file: boolean;
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
  }
}

/**
 * "Connect a Provider": the four logos, then for the chosen one the three commands to run on your
 * own machine (for your OS, others one click away) and a field to paste the result into. Saves right
 * away; the same secrets as Global settings → Provider logins.
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
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = (p: Provider) => {
    setProvider(p);
    setValue("");
    setError(null);
    setSaved(false);
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
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal panel provider-connect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-connect-title"
      >
        <h2 id="provider-connect-title" className="provider-connect-title">
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
        </h2>
        {!provider && (
          <>
            <p className="muted">
              A Session runs one of these Agents with your own subscription;
              connect the one you have (one is enough). Each login is made with
              the Provider&apos;s CLI on your machine, then pasted here; the
              steps are shown for your operating system.
            </p>
            <ProviderLogos settings={settings} onPick={pick} />
          </>
        )}
        {provider && field && (
          <>
            <div className="provider-connect-head">
              <ProviderIcon provider={provider} size={28} />
              <span className="muted">{PROVIDER_BLURB[provider]}.</span>
              {connected && <span className="ok">Connected</span>}
            </div>
            <div className="os-row">
              <span className="muted">Commands for</span>
              <OsTabs value={os} onChange={setOs} />
              <span className="muted">
                (where you run the CLI, not the Sessionboxer server)
              </span>
            </div>
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
              {field.file && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  Import auth.json…
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
              {saved && (
                <button type="button" onClick={onClose}>
                  Done
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
