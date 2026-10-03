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
    case "copilot":
      return settings.providerSecretsSet.copilot.COPILOT_LOGIN;
    case "vibe":
      return settings.providerSecretsSet.vibe.VIBE_LOGIN;
    case "grok":
      return settings.providerSecretsSet.grok.GROK_LOGIN;
    case "gemini":
      return settings.providerSecretsSet.gemini.GEMINI_LOGIN;
  }
}

/** Whether "Sign in with …" exists for the Provider (ADR-0058): pi's `/login` lives in its TUI only, so it is paste-only. */
export function providerSignsInFromBrowser(provider: Provider): boolean {
  return provider !== "pi";
}

/** What the Provider's credential is called in the UI: Claude Code and Devin take a token, Codex, Cursor, pi, OpenCode, fx, Grok Build and Gemini CLI a login. */
export function providerCredentialNoun(provider: Provider): "token" | "login" {
  return provider === "claude-code" || provider === "devin" ? "token" : "login";
}

/** One line per Provider for the Connect dialog's chooser. */
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
  grok: "xAI's own Agent (Grok Build); runs on your xAI account or an xAI API key",
  gemini: "Google's open-source Agent; runs on your Google account (Gemini Code Assist) or a Gemini API key",
};
