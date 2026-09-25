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
  }
}

/** What the Provider's credential is called in the UI: Claude Code and Devin take a token, Codex and Cursor a login. */
export function providerCredentialNoun(provider: Provider): "token" | "login" {
  return provider === "claude-code" || provider === "devin" ? "token" : "login";
}
