import type { Provider } from "@sessionboxer/protocol";

/** The Connect dialog's paste field per Provider, and the secret update a pasted value becomes. */
export function credentialField(provider: Provider): {
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
    case "grok":
      return { label: "Grok Build login (contents of ~/.grok/auth.json, or an xAI API key)", multiline: true, file: true, placeholder: '{ "key": … } or xai-…' };
    case "gemini":
      return { label: "Gemini CLI login (contents of ~/.gemini/oauth_creds.json, or a Gemini API key)", multiline: true, file: true, fileName: "oauth_creds.json", placeholder: '{ "access_token": … } or AIza…' };
    case "qwen":
      return {
        label: "Qwen Code login (contents of oauth_creds.json, or OPENAI_* NAME=value lines)",
        multiline: true,
        file: true,
        fileName: "oauth_creds.json",
        placeholder: '{ "access_token": … } or OPENAI_API_KEY=sk-…\nOPENAI_MODEL=qwen3-coder-plus',
      };
  }
}

export function secretUpdate(provider: Provider, value: string) {
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
    case "grok":
      return { grok: { GROK_LOGIN: value } };
    case "gemini":
      return { gemini: { GEMINI_LOGIN: value } };
    case "qwen":
      return value.startsWith("{") ? { qwen: { QWEN_OAUTH_JSON: value } } : { qwen: { QWEN_API_KEYS: value } };
  }
}
