import { AuthFile } from "./auth-file.js";

/** The image pins Grok Build; no update check at start (also `cli.auto_update = false` in its config, for the guests). */
export const GROK_AGENT_ENV = { GROK_DISABLE_AUTOUPDATER: "1" };

/**
 * Grok Build's login (ADR-0086): the `auth.json` a `grok login` wrote, on tmpfs behind `~/.grok/auth.json`
 * (Grok Build follows the symlink and reloads the file when it changes), or an xAI API key handed over in the
 * Agent's environment as `XAI_API_KEY`. Grok Build refreshes the session's tokens in place and the rewritten
 * file is reported back. The rest of `~/.grok` (config, rules, saved sessions) stays on disk so `session/load`
 * finds the conversation after Stop/Resume.
 */
export class GrokLogin {
  readonly authPath: string;
  private readonly auth: AuthFile;

  constructor(
    readonly home: string,
    tmpfsDir: string,
    private readonly log: (msg: string) => void,
    onChanged: (authJson: string) => void,
  ) {
    this.authPath = `${home}/auth.json`;
    this.auth = new AuthFile("grok", this.authPath, tmpfsDir, log, onChanged);
  }

  /** Puts a login in place (the file on tmpfs, or nothing) and returns what the Agent's environment needs on top of `GROK_AGENT_ENV`. */
  set(login: string): Record<string, string> {
    const isFile = login.trimStart().startsWith("{");
    this.auth.set(isFile ? login : "");
    if (isFile || login === "") return {};
    this.log("Grok Build login is an API key; handed to the Agent process as XAI_API_KEY");
    return { XAI_API_KEY: login };
  }
}

/** What a guest's `~/.grok` mirrors from the Daemon's: the config, the briefing as a rule, and the login (pulled back when it changes). */
export function grokGuestFiles(grokHome: string, briefingFile: string) {
  return [
    { local: `${grokHome}/config.toml`, guest: ".grok/config.toml" },
    { local: briefingFile, guest: ".grok/rules/sandbox-briefing.md" },
    { local: `${grokHome}/auth.json`, guest: ".grok/auth.json", pullBack: true, mode: 0o600 },
  ];
}
