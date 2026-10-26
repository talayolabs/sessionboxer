import { useState } from "react";
import { ANTHROPIC_DEFAULT_BASE_URL, type PublicSettings } from "@sessionboxer/protocol";
import { ClaudeApiLoginOutput, useClaudeApiLogin } from "./ClaudeApiLogin";
import { api } from "../api";
import { Caption } from "../ui";
import type { Setter } from "./shared";

/** Global settings → Providers → Claude API: the base URL Claude Code calls and the proxy credentials for it. */
export function ClaudeApiSettings({
  settings,
  onStored,
  claudeBaseUrl,
  setClaudeBaseUrl,
  claudeCredentialCommand,
  setClaudeCredentialCommand,
  claudeLoginCommand,
  setClaudeLoginCommand,
  claudeAuthToken,
  setClaudeAuthToken,
  claudeApiKey,
  setClaudeApiKey,
  forgetClaudeAuthToken,
  setForgetClaudeAuthToken,
  forgetClaudeApiKey,
  setForgetClaudeApiKey,
}: {
  settings: PublicSettings;
  onStored: (s: PublicSettings) => void;
  claudeBaseUrl: string;
  setClaudeBaseUrl: Setter<string>;
  claudeCredentialCommand: string;
  setClaudeCredentialCommand: Setter<string>;
  claudeLoginCommand: string;
  setClaudeLoginCommand: Setter<string>;
  claudeAuthToken: string;
  setClaudeAuthToken: Setter<string>;
  claudeApiKey: string;
  setClaudeApiKey: Setter<string>;
  forgetClaudeAuthToken: boolean;
  setForgetClaudeAuthToken: Setter<boolean>;
  forgetClaudeApiKey: boolean;
  setForgetClaudeApiKey: Setter<boolean>;
}) {
  const claudeAuthTokenSet = settings.claudeApi.authTokenSet && !forgetClaudeAuthToken;
  const claudeApiKeySet = settings.claudeApi.apiKeySet && !forgetClaudeApiKey;
  const host = settings.claudeApi.host;
  const [importing, setImporting] = useState(false);
  const login = useClaudeApiLogin();
  const loggingIn = login.state?.running === true;
  const [importError, setImportError] = useState<string | null>(null);
  const importHost = async () => {
    setImporting(true);
    setImportError(null);
    try {
      const next = await api.claudeApiImportHost();
      onStored(next);
      setClaudeBaseUrl(next.claudeApi.baseUrl);
      setClaudeCredentialCommand(next.claudeApi.credentialCommand);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };
  return (
    <>
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
      <label>
        <span className="label-row">
          <Caption
            help={
              <p>
                Claude Code&apos;s <code>apiKeyHelper</code>: a command the Control Plane runs on this machine whose output is the credential for
                that URL (a company gateway&apos;s token helper, for instance). Sessionboxer re-runs it and hands the fresh value to every running
                Claude Sandbox, where Claude Code picks it up within five minutes, so rotating tokens need no restart. While set, the proxy auth
                token and API key below are not used. Not available to Sessions in a Windows or macOS VM.
              </p>
            }
          >
            Credential command (apiKeyHelper)
          </Caption>
        </span>
        <input
          value={claudeCredentialCommand}
          onChange={(e) => setClaudeCredentialCommand(e.target.value)}
          placeholder="e.g. /home/me/.local/bin/my-gateway token"
          spellCheck={false}
        />
      </label>
      <label>
        <span className="label-row">
          <Caption
            help={
              <p>
                The command that renews the login behind the credential command (the gateway&apos;s SSO), run on this machine when the gateway
                rejects the credential: from the button here, or from the notice a Session shows when that happens. Its output is shown as it
                runs (a device code and a URL to open — click it; the browser has the SSO session); a command that waits for the browser has
                five minutes.
              </p>
            }
          >
            Login command
          </Caption>
        </span>
        <input value={claudeLoginCommand} onChange={(e) => setClaudeLoginCommand(e.target.value)} placeholder="e.g. /home/me/.local/bin/my-gateway login" spellCheck={false} />
        {settings.claudeApi.loginCommand !== "" && (
          <p className="muted">
            <button type="button" className="link" disabled={loggingIn} onClick={() => void login.start()}>
              {loggingIn ? "Running login command…" : "Run the login command now"}
            </button>
          </p>
        )}
        <ClaudeApiLoginOutput login={login} />
      </label>
      {host && (
        <p className="muted">
          This machine&apos;s <code>~/.claude/settings.json</code> configures{" "}
          {[
            host.baseUrl ? `the base URL ${host.baseUrl}` : null,
            host.credentialCommand ? `the credential command ${host.credentialCommand}` : null,
            host.authTokenSet ? "an auth token" : null,
            host.apiKeySet ? "an API key" : null,
          ]
            .filter((x) => x !== null)
            .join(", ")}
          .{" "}
          <button type="button" className="link" disabled={importing} onClick={() => void importHost()}>
            {importing ? "Importing…" : "Use this machine's Claude settings"}
          </button>
          {importError && <span className="error"> {importError}</span>}
        </p>
      )}
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
    </>
  );
}
