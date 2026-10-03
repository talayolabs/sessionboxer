import type { Provider } from "@sessionboxer/protocol";

/** ACP adapter per Provider; `SESSIONBOXER_ACP_COMMAND` overrides (space-separated) for experiments. */
export const ACP_COMMANDS: Record<Provider, string[]> = {
  "claude-code": ["claude-agent-acp"],
  devin: ["devin", "acp"],
  codex: ["codex-acp"],
  // Auto-update off (the image pins the version); --force runs commands without asking and
  // --approve-mcps/--trust skip the MCP and workspace prompts nobody would answer (ADR-0054).
  cursor: ["cursor-agent", "--disable-auto-update", "--force", "--approve-mcps", "--trust", "acp"],
  // pi has no ACP mode of its own: pi-acp bridges `pi --mode rpc` to ACP (ADR-0075).
  pi: ["pi-acp"],
  opencode: ["opencode", "acp"],
  // fx's ACP server is built in (ADR-0077); permission mode and auto-upgrade are set in its environment (`FX_AGENT_ENV`).
  fx: ["fx", "acp"],
  kimi: ["kimi", "acp"],
  // Copilot's ACP server is built in (ADR-0082); every permission is granted on the command line and the
  // pinned version runs (`--no-auto-update`); `--no-ask-user` keeps it from waiting on a question no client answers.
  copilot: ["copilot", "--acp", "--allow-all", "--no-auto-update", "--no-ask-user"],
  // Mistral Vibe ships `vibe-acp`, its ACP server, as a standalone binary (ADR-0085).
  vibe: ["vibe-acp"],
  // Grok Build's ACP server is built in (ADR-0086); `--always-approve` is its full-permission flag (the Daemon still answers permission requests).
  grok: ["grok", "agent", "--always-approve", "stdio"],
};
