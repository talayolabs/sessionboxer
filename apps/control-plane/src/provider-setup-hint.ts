import type { Provider } from "@sessionboxer/protocol";

export function providerSetupHint(provider: Provider): string {
  switch (provider) {
    case "claude-code":
      return "No Claude Code token configured. Run `claude setup-token` on your machine and paste it in Global settings → Providers.";
    case "devin":
      return "No Devin token configured. Run `devin auth login`, then paste the token from ~/.local/share/devin/credentials.toml in Global settings → Providers.";
    case "codex":
      return "No Codex login configured. Run `codex login` (ChatGPT account) and paste ~/.codex/auth.json in Global settings → Providers.";
    case "cursor":
      return "No Cursor login configured. Paste a Cursor API key, or run `agent login` and paste Cursor's auth.json, in Global settings → Providers.";
    case "pi":
      return "No pi login configured. Paste a model provider's API key (ANTHROPIC_API_KEY=..., OPENAI_API_KEY=...), or run `pi`, `/login`, and paste ~/.pi/agent/auth.json, in Global settings → Providers.";
    case "opencode":
      return "No OpenCode login configured. Run `opencode auth login` on your machine and paste ~/.local/share/opencode/auth.json, or an OpenCode Zen API key, in Global settings → Providers.";
    case "fx":
      return "No fx login configured. Paste an AI Gateway API key, or run `fx login` and paste ~/.fx/auth.json, in Global settings → Providers.";
    case "kimi":
      return "No Kimi CLI login configured. Run `kimi login` and paste ~/.kimi/credentials/kimi-code.json in Global settings → Providers, or Sign in with Kimi CLI there.";
    case "copilot":
      return "No GitHub Copilot login configured. Sign in with GitHub Copilot, or paste a GitHub token with the Copilot Requests permission, in Global settings → Providers.";
    case "vibe":
      return "No Mistral Vibe login configured. Sign in with Mistral Vibe, or paste a Mistral API key (console.mistral.ai → API Keys), in Global settings → Providers.";
  }
}
