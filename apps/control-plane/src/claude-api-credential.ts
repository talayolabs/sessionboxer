// The Claude API credential minted by a command on this machine (Claude Code's `apiKeyHelper`, ADR-0090):
// what `~/.claude/settings.json` here configures, and the runner that keeps the Sandboxes' copy fresh.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ClaudeHostSettings, type Settings, type UpdateSettingsRequest, type ClaudeApiLogin } from "@sessionboxer/protocol";
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

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_OUTPUT_MAX = 16 * 1024;

/**
 * The login command behind the credential command (the gateway's SSO), run the same way but in the
 * background: a device flow prints a code and a URL, then waits for the browser, so its output is
 * served while it runs (`current()`), and it can be cancelled. One run at a time; a command that
 * waits has five minutes. `onDone` gets the exit verdict.
 */
export class ClaudeApiLoginRun {
  private child: ChildProcess | null = null;
  private state: ClaudeApiLogin = { running: false, output: "", ok: null, startedAt: null, finishedAt: null };
  private settled: Promise<ClaudeApiLogin> = Promise.resolve(this.state);

  constructor(private readonly opts: { timeoutMs?: number; onDone?: (ok: boolean) => void | Promise<void> } = {}) {}

  current(): ClaudeApiLogin {
    return { ...this.state };
  }

  /** Resolves when the current run (or the last one) has exited. */
  finished(): Promise<ClaudeApiLogin> {
    return this.settled;
  }

  start(command: string): ClaudeApiLogin {
    if (this.child) return this.current();
    const timeoutMs = this.opts.timeoutMs ?? LOGIN_TIMEOUT_MS;
    const [shell, flag] = process.platform === "win32" ? ["cmd", "/c"] : ["/bin/sh", "-c"];
    const child = spawn(shell, [flag, command], { env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.child = child;
    this.state = { running: true, output: "", ok: null, startedAt: new Date().toISOString(), finishedAt: null };
    const append = (chunk: Buffer | string) => {
      const output = this.state.output + chunk.toString();
      this.state.output = output.length > LOGIN_OUTPUT_MAX ? output.slice(-LOGIN_OUTPUT_MAX) : output;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      append(`\n(login command stopped after ${Math.round(timeoutMs / 1000)} s)\n`);
      this.kill();
    }, timeoutMs);
    this.settled = new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.child = null;
        this.state = { ...this.state, running: false, ok, finishedAt: new Date().toISOString() };
        void Promise.resolve(this.opts.onDone?.(ok)).finally(() => resolve(this.current()));
      };
      child.on("error", (e) => {
        append(`${e.message}\n`);
        finish(false);
      });
      child.on("close", (code) => finish(code === 0 && this.state.ok !== false));
    });
    return this.current();
  }

  cancel(): ClaudeApiLogin {
    if (this.child) {
      this.state = { ...this.state, ok: false, output: `${this.state.output}\n(login command cancelled)\n` };
      this.kill();
    }
    return this.current();
  }

  private kill(): void {
    const child = this.child;
    if (!child?.pid) return;
    try {
      if (process.platform === "win32") child.kill();
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
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
