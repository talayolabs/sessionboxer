import { copilotToken, parseCopilotConfig } from "@sessionboxer/protocol";
import { AuthFile } from "./auth-file.js";

/** `COPILOT_ALLOW_ALL=true` also trusts the Workspace (its skills, agents, MCP servers and hooks load); the version is the image's. */
export const COPILOT_AGENT_ENV = { COPILOT_ALLOW_ALL: "true", COPILOT_AUTO_UPDATE: "false" };

/**
 * GitHub Copilot CLI's login in the Sandbox (ADR-0082). The stored login is a GitHub token or the
 * `~/.copilot/config.json` that `copilot login` writes; either way the token goes to the Agent process
 * as `COPILOT_GITHUB_TOKEN`, which Copilot reads before any stored credential. A pasted `config.json`
 * is also put on tmpfs behind the path Copilot reads it from, so `copilot` in the terminal is signed in
 * too; a `copilot login` done in the box writes through that symlink (the image's `settings.json`
 * allows plaintext storage) and the rewritten file is reported as `_sessionboxer/copilot/auth/changed`.
 */
export class CopilotLogin {
  private readonly file: AuthFile;

  constructor(copilotHome: string, tmpfsDir: string, log: (msg: string) => void, onChanged: (authJson: string) => void) {
    this.file = new AuthFile("copilot", `${copilotHome}/config.json`, tmpfsDir, log, onChanged);
  }

  /** Puts `login` in place (empty removes it) and returns the Agent's environment for it. */
  apply(login: string): Record<string, string> {
    const token = copilotToken(login);
    this.file.set(parseCopilotConfig(login) ? login : "");
    return token === "" ? {} : { COPILOT_GITHUB_TOKEN: token };
  }
}
