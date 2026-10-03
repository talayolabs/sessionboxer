import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AuthFile } from "./auth-file.js";

/**
 * The Sandbox is the isolation: the workspace is trusted (otherwise Gemini CLI drops `--yolo` back to
 * asking), no browser is opened for a login, no telemetry from the box (the update check and usage
 * statistics are off in the image's settings.json).
 */
export const GEMINI_AGENT_ENV = { GEMINI_CLI_TRUST_WORKSPACE: "true", NO_BROWSER: "true", GEMINI_TELEMETRY_ENABLED: "false" };

type GeminiAuthType = "oauth-personal" | "gemini-api-key";

/**
 * Gemini CLI's login in the Sandbox (ADR-0087): the `oauth_creds.json` its "Login with Google" writes,
 * on tmpfs at the path it reads it from (`~/.gemini/oauth_creds.json`; it refreshes the access token
 * through the symlink and the rewritten file is reported back as `_sessionboxer/gemini/auth/changed`),
 * or a Gemini API key handed to the Agent process as `GEMINI_API_KEY`. The rest of `~/.gemini`
 * (settings, `GEMINI.md`, the saved chats) stays on the container disk. Gemini CLI picks its auth
 * method at start, so a changed login restarts the Agent (its environment changes).
 */
export class GeminiLogin {
  private readonly file: AuthFile;

  constructor(
    private readonly geminiHome: string,
    tmpfsDir: string,
    private readonly log: (msg: string) => void,
    onChanged: (authJson: string) => void,
  ) {
    this.file = new AuthFile("gemini", `${geminiHome}/oauth_creds.json`, tmpfsDir, log, onChanged);
  }

  /** Puts `login` in place (empty removes it) and returns the Agent's environment for it. */
  apply(login: string): Record<string, string> {
    const file = login.trimStart().startsWith("{");
    this.file.set(file ? login : "");
    this.setAuthType(file ? "oauth-personal" : login === "" ? null : "gemini-api-key");
    if (file || login === "") return {};
    this.log("Gemini CLI login is an API key; handed to the Agent process as GEMINI_API_KEY");
    return { GEMINI_API_KEY: login };
  }

  /**
   * `security.auth.selectedType` in `~/.gemini/settings.json`, as "Login with Google" would record
   * it: under `--acp` Gemini CLI reads its login from there (a Google login file alone, or
   * `GOOGLE_GENAI_USE_GCA`, leaves it asking for an API key, verified on 0.62.0); the image's other
   * settings (no auto-update, no usage statistics) stay as they are.
   */
  private setAuthType(type: GeminiAuthType | null): void {
    const path = `${this.geminiHome}/settings.json`;
    let settings: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch {
      mkdirSync(this.geminiHome, { recursive: true });
    }
    const security = (settings.security ??= {}) as Record<string, unknown>;
    const auth = (security.auth ??= {}) as Record<string, unknown>;
    if (type === null) delete auth.selectedType;
    else auth.selectedType = type;
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  }
}
