import { useRef } from "react";
import { ANTHROPIC_DEFAULT_BASE_URL, type CodexLogin, type CursorLogin, type OpenCodeLogin, type FxLogin, type PublicSettings } from "@sessionboxer/protocol";
import { CopyCommand } from "../CopyCommand";
import { ProviderConnectDialog } from "../ProviderConnect";
import { Caption } from "../ui";
import { useSectionState, type Setter } from "./shared";

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

/** Global settings → Providers: the stored Provider logins and the Claude API base URL / proxy credentials. */
/** Form state of the Providers section; `SettingsView` spreads `values` and `set` into `<ProvidersSettings>`. */
export function useProvidersSettings(settings: PublicSettings) {
  return useSectionState({
    token: "",
    devinToken: "",
    codexAuth: "",
    forgetCodexAuth: false,
    cursorLogin: "",
    forgetCursorLogin: false,
    piAuth: "",
    forgetPiAuth: false,
    piApiKeys: "",
    forgetPiApiKeys: false,
    opencodeAuth: "",
    forgetOpenCodeAuth: false,
    fxLogin: "",
    forgetFxLogin: false,
    claudeBaseUrl: settings.claudeApi.baseUrl,
    claudeAuthToken: "",
    claudeApiKey: "",
    forgetClaudeAuthToken: false,
    forgetClaudeApiKey: false,
    guided: false,
  });
}

export function ProvidersSettings({
  settings,
  onStored,
  token,
  setToken,
  devinToken,
  setDevinToken,
  codexAuth,
  setCodexAuth,
  forgetCodexAuth,
  setForgetCodexAuth,
  cursorLogin,
  setCursorLogin,
  forgetCursorLogin,
  setForgetCursorLogin,
  piAuth,
  setPiAuth,
  forgetPiAuth,
  setForgetPiAuth,
  piApiKeys,
  setPiApiKeys,
  forgetPiApiKeys,
  setForgetPiApiKeys,
  opencodeAuth,
  setOpencodeAuth,
  forgetOpenCodeAuth,
  setForgetOpenCodeAuth,
  fxLogin,
  setFxLogin,
  forgetFxLogin,
  setForgetFxLogin,
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
  guided,
  setGuided,
}: {
  settings: PublicSettings;
  /** Settings the Control Plane stored on its own (connector logins), without the form being saved. */
  onStored: (s: PublicSettings) => void;
  token: string;
  setToken: Setter<string>;
  devinToken: string;
  setDevinToken: Setter<string>;
  codexAuth: string;
  setCodexAuth: Setter<string>;
  forgetCodexAuth: boolean;
  setForgetCodexAuth: Setter<boolean>;
  cursorLogin: string;
  setCursorLogin: Setter<string>;
  forgetCursorLogin: boolean;
  setForgetCursorLogin: Setter<boolean>;
  piAuth: string;
  setPiAuth: Setter<string>;
  forgetPiAuth: boolean;
  setForgetPiAuth: Setter<boolean>;
  piApiKeys: string;
  setPiApiKeys: Setter<string>;
  forgetPiApiKeys: boolean;
  setForgetPiApiKeys: Setter<boolean>;
  opencodeAuth: string;
  setOpencodeAuth: Setter<string>;
  forgetOpenCodeAuth: boolean;
  setForgetOpenCodeAuth: Setter<boolean>;
  fxLogin: string;
  setFxLogin: Setter<string>;
  forgetFxLogin: boolean;
  setForgetFxLogin: Setter<boolean>;
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
  guided: boolean;
  setGuided: Setter<boolean>;
}) {
  const tokenSet = settings.providerSecretsSet["claude-code"].CLAUDE_CODE_OAUTH_TOKEN;
  const devinTokenSet = settings.providerSecretsSet.devin.WINDSURF_API_KEY;
  const codexAuthSet = settings.providerSecretsSet.codex.CODEX_AUTH_JSON && !forgetCodexAuth;
  const cursorLoginSet = settings.providerSecretsSet.cursor.CURSOR_LOGIN && !forgetCursorLogin;
  const piAuthSet = settings.providerSecretsSet.pi.PI_AUTH_JSON && !forgetPiAuth;
  const piApiKeysSet = settings.providerSecretsSet.pi.PI_API_KEYS && !forgetPiApiKeys;
  const opencodeAuthSet = settings.providerSecretsSet.opencode.OPENCODE_AUTH_JSON && !forgetOpenCodeAuth;
  const fxLoginSet = settings.providerSecretsSet.fx.FX_LOGIN && !forgetFxLogin;
  const claudeAuthTokenSet = settings.claudeApi.authTokenSet && !forgetClaudeAuthToken;
  const claudeApiKeySet = settings.claudeApi.apiKeySet && !forgetClaudeApiKey;

  const codexFileRef = useRef<HTMLInputElement>(null);
  const cursorFileRef = useRef<HTMLInputElement>(null);
  const piFileRef = useRef<HTMLInputElement>(null);
  const opencodeFileRef = useRef<HTMLInputElement>(null);
  const fxFileRef = useRef<HTMLInputElement>(null);

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
      setOpencodeAuth(text);
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

  return (
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
            setOpencodeAuth(e.target.value);
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
                if (e.target.checked) setOpencodeAuth("");
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
  );
}
