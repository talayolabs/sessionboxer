import { ANTHROPIC_DEFAULT_BASE_URL, type PublicSettings } from "@sessionboxer/protocol";
import { Caption } from "../ui";
import type { Setter } from "./shared";

/** Global settings → Providers → Claude API: the base URL Claude Code calls and the proxy credentials for it. */
export function ClaudeApiSettings({
  settings,
  claudeBaseUrl,
  setClaudeBaseUrl,
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
  claudeBaseUrl: string;
  setClaudeBaseUrl: Setter<string>;
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
