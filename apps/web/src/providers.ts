import type { Provider, PublicSettings } from "@sessionboxer/protocol";

/** Whether the secret a Session of `provider` needs to talk to its model is configured (mirrors the Control Plane's `providerReady`). */
export function providerTokenSet(settings: PublicSettings, provider: Provider): boolean {
  switch (provider) {
    case "claude-code":
      return settings.providerSecretsSet["claude-code"].CLAUDE_CODE_OAUTH_TOKEN || settings.claudeApi.authTokenSet || settings.claudeApi.apiKeySet;
    case "devin":
      return settings.providerSecretsSet.devin.WINDSURF_API_KEY;
    case "codex":
      return settings.providerSecretsSet.codex.CODEX_AUTH_JSON;
    case "cursor":
      return settings.providerSecretsSet.cursor.CURSOR_LOGIN;
    case "pi":
      return settings.providerSecretsSet.pi.PI_AUTH_JSON || settings.providerSecretsSet.pi.PI_API_KEYS;
    case "opencode":
      return settings.providerSecretsSet.opencode.OPENCODE_AUTH_JSON;
    case "kimi":
      return settings.providerSecretsSet.kimi.KIMI_LOGIN;
    case "fx":
      return settings.providerSecretsSet.fx.FX_LOGIN;
  }
}

/** Whether "Sign in with …" exists for the Provider (ADR-0058): pi's `/login` lives in its TUI only, so it is paste-only. */
export function providerSignsInFromBrowser(provider: Provider): boolean {
  return provider !== "pi";
}

/** What the Provider's credential is called in the UI: Claude Code and Devin take a token, Codex, Cursor, pi and OpenCode a login. */
export function providerCredentialNoun(provider: Provider): "token" | "login" {
  return provider === "claude-code" || provider === "devin" ? "token" : "login";
}
