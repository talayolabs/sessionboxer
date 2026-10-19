// The Claude API credential minted by a command on this machine (Claude Code's `apiKeyHelper`, ADR-0090):
// what `~/.claude/settings.json` here configures, and the runner that keeps the Sandboxes' copy fresh.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ClaudeHostSettings, type Settings, type UpdateSettingsRequest } from "@sessionboxer/protocol";
import { HttpError } from "./http-error.js";

/** Claude Code re-runs its helper after five minutes; a value this old is minted again before it is pushed. */
export const CLAUDE_CREDENTIAL_MAX_AGE_MS = 4 * 60 * 1000;
/** How long the command may take; corporate helpers may refresh a token over the network. */
const COMMAND_TIMEOUT_MS = 60 * 1000;

type HostFile = { env?: Record<string, unknown>; apiKeyHelper?: unknown };

function readHostFile(home: string): HostFile | null {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as HostFile) : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The Claude API configuration `~/.claude/settings.json` holds on this machine; null when it holds none. */
export function readClaudeHostSettings(home = homedir()): ClaudeHostSettings | null {
  const file = readHostFile(home);
  if (!file) return null;
  const env = typeof file.env === "object" && file.env !== null ? file.env : {};
  const baseUrl = str(env.ANTHROPIC_BASE_URL);
  const credentialCommand = str(file.apiKeyHelper);
  const authTokenSet = str(env.ANTHROPIC_AUTH_TOKEN) !== "";
  const apiKeySet = str(env.ANTHROPIC_API_KEY) !== "";
  if (baseUrl === "" && credentialCommand === "" && !authTokenSet && !apiKeySet) return null;
  return { baseUrl: baseUrl || null, credentialCommand: credentialCommand || null, authTokenSet, apiKeySet };
}

/** The Settings update that copies that configuration into the Claude API section (secrets included). */
export function claudeHostSettingsUpdate(home = homedir()): NonNullable<UpdateSettingsRequest["claudeApi"]> {
  const file = readHostFile(home);
  const found = readClaudeHostSettings(home);
  if (!file || !found) throw new HttpError(404, "This machine's ~/.claude/settings.json configures no Claude API base URL or credential.");
  const env = typeof file.env === "object" && file.env !== null ? file.env : {};
  return {
    baseUrl: found.baseUrl ?? "",
    credentialCommand: found.credentialCommand ?? "",
    authToken: str(env.ANTHROPIC_AUTH_TOKEN),
    apiKey: str(env.ANTHROPIC_API_KEY),
  };
}

/** Runs the command the way Claude Code runs `apiKeyHelper` (`/bin/sh -c`, `cmd /c` on Windows) and returns its trimmed output. */
export function runClaudeCredentialCommand(command: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
  const [shell, flag] = process.platform === "win32" ? ["cmd", "/c"] : ["/bin/sh", "-c"];
  return new Promise((resolve, reject) => {
    execFile(shell, [flag, command], { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`credential command failed: ${error.message.split("\n")[0]}${stderr.trim() ? ` (${stderr.trim().split("\n")[0]})` : ""}`));
        return;
      }
      const credential = stdout.trim();
      if (credential === "") reject(new Error("credential command printed nothing"));
      else resolve(credential);
    });
  });
}

/** Mints the credential on demand and caches it briefly, so the Sessions connecting together share one run. */
export class ClaudeApiCredential {
  private cached: { command: string; value: string; at: number } | null = null;
  private last: string | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly settings: () => Settings,
    private readonly log: (msg: string) => void,
    private readonly run: (command: string) => Promise<string> = runClaudeCredentialCommand,
  ) {}

  /** Whether a command is configured; without one there is nothing to push. */
  configured(): boolean {
    return this.settings().claudeApi.credentialCommand !== "";
  }

  /** The current credential, "" when no command is configured. Throws when the command fails. */
  current(): Promise<string> {
    const command = this.settings().claudeApi.credentialCommand;
    if (command === "") return Promise.resolve("");
    const c = this.cached;
    if (c && c.command === command && Date.now() - c.at < CLAUDE_CREDENTIAL_MAX_AGE_MS) return Promise.resolve(c.value);
    if (this.pending) return this.pending;
    this.pending = this.run(command)
      .then((value) => {
        if (this.last !== value) this.log(this.last === null ? "claude api credential minted" : "claude api credential rotated");
        this.last = value;
        this.cached = { command, value, at: Date.now() };
        return value;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** Forgets the cached value (the command changed). */
  invalidate(): void {
    this.cached = null;
  }
}
