
/**
 * The shapes of what the Providers read from disk, apart from the files themselves (`index.ts` puts
 * those in place): which fx login file a pasted login is (ADR-0077), Mistral Vibe's `.env` and
 * trusted folders (ADR-0085), and the absolute paths fx wants for MCP commands.
 */

export type FxLoginKind = "vercel" | "codex" | "grok";

/**
 * Which of fx's three login files a pasted login is: `fx login` (Vercel) writes an OAuth session
 * with a `token_type`; `fx login codex` and `fx login grok` write `{ version, access_token,
 * refresh_token, expires_at_ms, account_id }`, told apart by the access token's issuer (ChatGPT's
 * is a JWT issued by auth.openai.com). The Control Plane validated the JSON already.
 */
export function fxLoginKind(login: string): FxLoginKind {
  const parsed = JSON.parse(login) as Record<string, unknown>;
  if (typeof parsed.token_type === "string" || !("account_id" in parsed)) return "vercel";
  const token = typeof parsed.access_token === "string" ? parsed.access_token : "";
  const payload = token.split(".")[1];
  try {
    const claims = payload ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>) : null;
    return typeof claims?.iss === "string" && /openai\.com/i.test(claims.iss) ? "codex" : "grok";
  } catch {
    return "grok";
  }
}


/** A pasted Mistral API key becomes Vibe's `.env` line (quoted as Vibe itself writes it); a pasted `.env` is written as is. */
export function vibeEnvFile(login: string): string {
  if (login.includes("=")) return login.endsWith("\n") ? login : `${login}\n`;
  return `MISTRAL_API_KEY='${login}'\n`;
}

/** `.env` as Vibe reads it must set `MISTRAL_API_KEY`; anything else (half-written, or a sign-out that removed the line) is not reported. */
export function validateVibeEnv(text: string): void {
  if (!/^MISTRAL_API_KEY=.+/m.test(text)) throw new Error("no MISTRAL_API_KEY line");
}

/** Vibe's `trusted_folders.toml` with the Workspace trusted: it reads AGENTS.md and runs tools only in folders it trusts; the Sandbox is the isolation. */
export function vibeTrustedFolders(workspace: string): string {
  return `trusted = [${JSON.stringify(workspace)}]\nuntrusted = []\n`;
}
