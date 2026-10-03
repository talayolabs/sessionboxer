import { mkdirSync, writeFileSync } from "node:fs";
import { AuthFile } from "./auth-file.js";
import { validateVibeEnv, vibeEnvFile, vibeTrustedFolders } from "./provider-files.js";

/** The image pins Vibe, so its update check is off; and with no keyring, a sign-in from inside the Agent lands in `.env`, where it is synced from. */
export const VIBE_AGENT_ENV = { VIBE_ENABLE_AUTO_UPDATE: "false", VIBE_TEST_DISABLE_KEYRING: "1" };

/**
 * Mistral Vibe's login in the Sandbox (ADR-0085): the dotenv file it reads `MISTRAL_API_KEY` from,
 * `~/.vibe/.env`, kept on tmpfs behind that path — Vibe follows the symlink, and when a sign-in from
 * inside the Agent rewrites it as a regular file the sweep moves it back and reports it as
 * `_sessionboxer/vibe/auth/changed`. Vibe reads `.env` when it starts, so a changed login restarts the
 * Agent (its environment changes). Vibe runs tools and reads AGENTS.md only in folders it trusts; the
 * Sandbox is the isolation, so the Workspace is trusted. The rest of `~/.vibe` (AGENTS.md from the
 * image, saved sessions for `session/load`) stays on the container disk.
 */
export class VibeLogin {
  private readonly file: AuthFile;
  private generation = 0;

  constructor(vibeHome: string, tmpfsDir: string, log: (msg: string) => void, onChanged: (authJson: string) => void, workspace: string) {
    mkdirSync(vibeHome, { recursive: true, mode: 0o700 });
    writeFileSync(`${vibeHome}/trusted_folders.toml`, vibeTrustedFolders(workspace));
    this.file = new AuthFile("vibe", `${vibeHome}/.env`, tmpfsDir, log, onChanged, false, validateVibeEnv);
  }

  /** Puts `login` in place (empty removes it) and returns the Agent's environment for it. */
  apply(login: string): Record<string, string> {
    this.file.set(login === "" ? "" : vibeEnvFile(login));
    this.generation += 1;
    return login === "" ? {} : { SESSIONBOXER_VIBE_LOGIN: `env-file-${this.generation}` };
  }
}
