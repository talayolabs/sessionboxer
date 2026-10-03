import type { CodexLogin, CursorLogin, OpenCodeLogin, FxLogin, GrokLogin, GeminiLogin, QwenLogin } from "@sessionboxer/protocol";

/** One line about the stored Codex login, from the metadata the Control Plane exposes (never the tokens). */
export function describeCodexLogin(login: CodexLogin): string {
  const parts = [login.email ?? (login.apiKey ? "API key" : "ChatGPT account")];
  if (login.plan) parts.push(`${login.plan} plan`);
  if (login.lastRefresh) parts.push(`refreshed ${new Date(login.lastRefresh).toLocaleString()}`);
  return parts.join(", ");
}

/** One line about the stored OpenCode login (ADR-0076): which model providers its auth.json covers. */
export function describeOpenCodeLogin(login: OpenCodeLogin): string {
  return login.providers.map((p) => `${p.id} (${p.kind === "oauth" ? "login" : p.kind === "api" ? "API key" : "token"})`).join(", ");
}

/** One line about the stored Cursor login (ADR-0054), from its metadata only. */
export function describeCursorLogin(login: CursorLogin): string {
  if (login.kind === "api-key") return "API key";
  return login.expiresAt ? `auth.json, token valid until ${new Date(login.expiresAt).toLocaleString()}` : "auth.json";
}

/** One line about the stored fx login (ADR-0077), from its metadata only. */
export function describeFxLogin(login: FxLogin): string {
  const what = login.kind === "api-key" ? "AI Gateway API key" : login.kind === "vercel" ? "Vercel login" : login.kind === "codex" ? "ChatGPT login" : "Grok login";
  return login.expiresAt && login.kind !== "api-key" ? `${what}, token valid until ${new Date(login.expiresAt).toLocaleString()}` : what;
}

/** One line about the stored Grok Build login (ADR-0086), from its metadata only. */
export function describeGrokLogin(login: GrokLogin): string {
  if (login.kind === "api-key") return "xAI API key";
  const what = login.email ? `xAI account ${login.email}` : "xAI account";
  return login.expiresAt ? `${what}, token valid until ${new Date(login.expiresAt).toLocaleString()}` : what;
}

/** One line about the stored Gemini CLI login (ADR-0087), from its metadata only. */
export function describeGeminiLogin(login: GeminiLogin): string {
  if (login.kind === "api-key") return "Gemini API key";
  const who = login.email ? `Google login (${login.email})` : "Google login";
  return login.expiresAt ? `${who}, token valid until ${new Date(login.expiresAt).toLocaleString()}` : who;
}

/** Qwen Code (ADR-0083): the OAuth login's expiry, or which OPENAI_* names the key lines set. */
export function describeQwenOauth(login: QwenLogin): string {
  if (!login.oauth) return "Qwen OAuth";
  return login.oauth.expiresAt ? `Qwen OAuth, token valid until ${new Date(login.oauth.expiresAt).toLocaleString()}` : "Qwen OAuth";
}
