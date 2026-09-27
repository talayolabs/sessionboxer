import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, promises as fs, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";
import { GUEST_BRIDGE_PORT, REPOS_MANIFEST_PATH } from "@sessionboxer/protocol";
import type { AgentTransport } from "./agent.js";
import type { BuiltinMcp } from "./mcp-config.js";
import { GUEST_BRIDGE_JS, guestAgentLauncherCmd, guestAgentLauncherSh } from "./guest-scripts.js";
import type { RepoHost } from "./repos.js";
import { workspaceDir } from "./workspace-sync.js";

const execFileAsync = promisify(execFile);

/** Connects the VM to a bridged service here (`node sessionboxer-bridge.js desktop`). */
const GUEST_BRIDGE_SCRIPT = "sessionboxer-bridge.js";
/** Names the ACP `desktop` MCP entry gets when it has to cross to the Linux side. */
export const BRIDGE_SERVICE_DESKTOP = "desktop";
export const BRIDGE_SERVICE_SESSIONBOXER = "sessionboxer";
export const BRIDGE_SERVICE_CREDENTIAL = "credential";
/** Commands Windows has as `.exe`, which the Agent can start directly; anything else is an npm/uv shim (`.cmd`) that needs `cmd /c`. */
const GUEST_EXECUTABLES = new Set(["node", "npm", "python", "python3", "uv", "uvx", "git", "cmd", "powershell", "pwsh", "docker", "dotnet", "java"]);

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=30",
];
/** Sessionboxer's own files in the VM (`~/.sessionboxer`): the launcher, the bridge client, `bridge.json`, the Agent's environment. */
const GUEST_STATE_DIR = ".sessionboxer";
const READY_POLL_MS = 3_000;
const DEFAULT_READY_TIMEOUT_MS = 15 * 60_000;
/** Where the POSIX launcher and the Daemon's scripts find the tools the base install put in the guest (ADR-0061). */
const POSIX_TOOL_PATH = "/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export interface GuestConfig {
  host: string;
  sshPort: number;
  user: string;
  /** The guest account's password; used by `sshpass -e` when there is no `identityFile`. */
  password: string;
  /** A private key file here that the guest account authorizes (macOS bases provision one): no `sshpass` then. */
  identityFile?: string;
  /** The Workspace in the VM, e.g. `C:\workspace` or `/Users/agent/workspace`. */
  workspace: string;
  /** The Workspace on this Linux side that mirrors it (`/workspace`). */
  localWorkspace: string;
  /** Where the Daemon spools the files it exchanges with the VM (on tmpfs, the Daemon's user). */
  spoolDir: string;
  log: (msg: string) => void;
}

export interface GuestRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GuestError extends Error {}

export type GuestOs = "windows" | "macos";

interface SshInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * The VM of a `qemu-windows` or `qemu-macos` Session, seen from the Sandbox Daemon: the machine
 * the Agent, its MCP servers, the repositories and the Terminal live on (ADR-0060, ADR-0061).
 * Everything goes over SSH to the guest's server: the Agent's ACP stdio (JSON lines, UTF-8)
 * passes through the channel untouched, scripts travel base64-encoded so no quoting reaches the
 * remote shell. This class is the transport (ssh, scp, tar, the bridge back here); what the
 * guest's shell, paths and process model look like is the subclass's (`WindowsGuest`, `MacGuest`).
 * The guest password only ever travels as `SSHPASS` in the environment of `sshpass -e`, never on
 * a command line; with an identity file, `ssh -i` and no password at all.
 */
export abstract class Guest {
  abstract readonly os: GuestOs;
  /** How the guest is called in log lines, e.g. `Windows VM`. */
  abstract readonly label: string;
  private readyPromise: Promise<void> | null = null;
  private readonly bridge = new GuestBridge(this);
  private readonly bridgeToken = randomBytes(24).toString("hex");
  private bridgeConfigured = false;

  constructor(readonly cfg: GuestConfig) {}

  get workspace(): string {
    return this.cfg.workspace;
  }

  protected get target(): string {
    return `${this.cfg.user}@${this.cfg.host}`;
  }

  /** `ssh`/`scp` with the key when the Session has one, through `sshpass -e` (password in the environment) otherwise. */
  protected sshInvocation(tool: "ssh" | "scp"): SshInvocation {
    if (this.cfg.identityFile) {
      return { command: tool, args: ["-i", this.cfg.identityFile, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", ...SSH_OPTS], env: process.env };
    }
    return { command: "sshpass", args: ["-e", tool, ...SSH_OPTS], env: { ...process.env, SSHPASS: this.cfg.password } };
  }

  /** Path inside the VM of a Workspace-relative path (`foo/bar.txt` -> `C:\workspace\foo\bar.txt` or `/Users/agent/workspace/foo/bar.txt`). */
  guestPath(rel: string): string {
    const clean = posix.normalize(rel.replace(/\\/g, "/")).replace(/^\.(\/|$)/, "").replace(/\/+$/, "");
    if (clean === "" || clean === ".") return this.cfg.workspace;
    if (clean.startsWith("../") || clean === "..") throw new GuestError(`path escapes the Workspace: ${rel}`);
    return this.joinGuest(this.cfg.workspace, clean);
  }

  /** `base/rel` in the guest's own notation (`rel` has forward slashes). */
  protected abstract joinGuest(base: string, rel: string): string;

  /** Whether `p` is an absolute path in the guest's notation. */
  abstract isAbsolute(p: string): boolean;

  /** Local (Linux) path a guest path under the Workspace maps to, or `null` when it is outside it. */
  localPathOf(guestPath: string): string | null {
    const root = this.cfg.workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const p = guestPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p.toLowerCase() === root) return this.cfg.localWorkspace;
    if (!p.toLowerCase().startsWith(root + "/")) return null;
    const rel = p.slice(root.length + 1);
    const abs = resolve(this.cfg.localWorkspace, rel);
    if (abs !== this.cfg.localWorkspace && !abs.startsWith(this.cfg.localWorkspace + sep)) return null;
    return abs;
  }

  /** Spawns `ssh` to the VM running `remoteCommand` (a line for the guest account's login shell) with piped stdio. */
  spawnSsh(remoteCommand: string, extra: string[] = []): ChildProcess {
    const ssh = this.sshInvocation("ssh");
    return spawn(ssh.command, [...ssh.args, ...extra, "-p", String(this.cfg.sshPort), this.target, remoteCommand], {
      stdio: ["pipe", "pipe", "pipe"],
      env: ssh.env,
    });
  }

  /** The command line and environment a PTY should run for an interactive shell in the VM. */
  terminalCommand(): { command: string; args: string[]; env: Record<string, string> } {
    const ssh = this.sshInvocation("ssh");
    return {
      command: ssh.command,
      args: [...ssh.args, "-t", "-p", String(this.cfg.sshPort), this.target, this.terminalShell()],
      env: this.cfg.identityFile ? {} : { SSHPASS: this.cfg.password },
    };
  }

  /** The remote command an interactive Terminal runs: the guest's shell in the Workspace. */
  protected abstract terminalShell(): string;

  /** The remote command line that runs `script` in the guest's scripting shell (PowerShell, bash). */
  protected abstract remoteScript(script: string): string;

  /** Runs a script in the VM; resolves with its output, rejects on a non-zero exit unless `lenient`. */
  async run(script: string, opts: { lenient?: boolean; timeoutMs?: number } = {}): Promise<GuestRunResult> {
    return new Promise((resolvePromise, reject) => {
      const child = this.spawnSsh(this.remoteScript(script));
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
      child.stdout?.on("data", (d: Buffer) => out.push(d));
      child.stderr?.on("data", (d: Buffer) => err.push(d));
      child.stdin?.end();
      child.on("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const result = { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code: code ?? -1 };
        if (result.code !== 0 && !opts.lenient) {
          reject(new GuestError(`${firstLine(script)} failed in the VM (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 600)}`));
        } else resolvePromise(result);
      });
    });
  }

  /** Resolves once the VM answers over SSH (a minute or two after a boot); shared by every caller. */
  waitReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.pollReady(timeoutMs).catch((e: unknown) => {
        this.readyPromise = null;
        throw e;
      });
    }
    return this.readyPromise;
  }

  /** A script that prints `ready` when the guest's scripting shell works. */
  protected abstract readonly readyProbe: string;

  private async pollReady(timeoutMs: number): Promise<void> {
    const started = Date.now();
    let announced = false;
    for (;;) {
      const probe = await this.run(this.readyProbe, { lenient: true, timeoutMs: 20_000 }).catch(() => null);
      if (probe && probe.code === 0 && probe.stdout.includes("ready")) {
        this.cfg.log(`${this.label.toLowerCase()} ${this.cfg.host} answers over ssh${announced ? ` after ${Math.round((Date.now() - started) / 1000)} s` : ""}`);
        return;
      }
      if (!announced) {
        this.cfg.log(`waiting for the ${this.label.toLowerCase()} ${this.cfg.host} to answer over ssh`);
        announced = true;
      }
      if (Date.now() - started > timeoutMs) throw new GuestError(`the ${this.label} ${this.cfg.host} did not answer over SSH within ${Math.round(timeoutMs / 60_000)} min`);
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }

  /** A script that creates `dir` (and its parents) in the VM, quietly, succeeding when it exists. */
  abstract mkdirScript(dir: string): string;

  /** Copies a local file into the VM (`guestPath` with forward or back slashes). */
  async putFile(localPath: string, guestPath: string): Promise<void> {
    const dir = posix.dirname(guestPath.replace(/\\/g, "/"));
    await this.run(this.mkdirScript(dir));
    await this.scp(localPath, `${this.target}:${scpPath(guestPath)}`);
  }

  /** Writes `content` to a file in the VM (UTF-8, no BOM), through a tmpfs file here and scp. */
  async writeFile(guestPath: string, content: string): Promise<void> {
    mkdirSync(this.cfg.spoolDir, { recursive: true, mode: 0o700 });
    const tmp = join(this.cfg.spoolDir, `${randomBytes(6).toString("hex")}.tmp`);
    try {
      await fs.writeFile(tmp, content, { mode: 0o600 });
      await this.putFile(tmp, guestPath);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** Copies a file out of the VM to `localPath`. */
  async getFile(guestPath: string, localPath: string): Promise<void> {
    mkdirSync(resolve(localPath, ".."), { recursive: true });
    await this.scp(`${this.target}:${scpPath(guestPath)}`, localPath);
  }

  private async scp(from: string, to: string): Promise<void> {
    const scp = this.sshInvocation("scp");
    await execFileAsync(scp.command, [...scp.args, "-P", String(this.cfg.sshPort), from, to], { env: scp.env, maxBuffer: 1024 * 1024 });
  }

  /** A script that prints `yes` when `path` exists in the VM, `no` otherwise. */
  protected abstract existsScript(path: string): string;

  /** Whether a path exists in the VM. */
  async exists(guestPath: string): Promise<boolean> {
    const r = await this.run(this.existsScript(guestPath));
    return r.stdout.includes("yes");
  }

  /** A script that creates `dir`, unpacks `tar` (a guest path) into it and removes the tar, exiting with tar's code. */
  protected abstract untarScript(tar: string, dir: string): string;

  /**
   * Copies a local directory tree into the VM at `guestDir` (created if needed): one tar over
   * scp, unpacked by the guest's own `tar` (bsdtar on Windows and macOS). Symlinks travel as-is.
   */
  async pushDir(localDir: string, guestDir: string): Promise<void> {
    mkdirSync(this.cfg.spoolDir, { recursive: true, mode: 0o700 });
    const tar = join(this.cfg.spoolDir, `${randomBytes(6).toString("hex")}.tar`);
    try {
      await execFileAsync("tar", ["-cf", tar, "-C", localDir, "."], { maxBuffer: 1024 * 1024 });
      const guestTar = `${this.tempDir()}/${posix.basename(tar)}`;
      await this.putFile(tar, guestTar);
      await this.run(this.untarScript(guestTar, guestDir), { timeoutMs: 20 * 60_000 });
    } finally {
      rmSync(tar, { force: true });
    }
  }

  /**
   * A script that packs `dir` into `tar` (a guest path): the files git lists (tracked and
   * untracked-but-not-ignored) plus `.git` when `dir` is a repository's top, everything but
   * `.sessionboxer` otherwise; prints `git` or `plain` accordingly.
   */
  protected abstract pullDirScript(dir: string, tar: string): string;

  /** A script that removes the file `path` in the VM, succeeding when it is gone. */
  abstract rmScript(path: string): string;

  /**
   * Makes the local directory an exact copy of the guest's, for the files git would list
   * (tracked and untracked-but-not-ignored) plus `.git` itself when `withGit`: what "Pull to
   * folder" and the repository state need. Everything else in the local copy is dropped.
   */
  async pullDir(guestDir: string, localDir: string): Promise<void> {
    mkdirSync(this.cfg.spoolDir, { recursive: true, mode: 0o700 });
    const name = `${randomBytes(6).toString("hex")}.tar`;
    const tar = join(this.cfg.spoolDir, name);
    const guestTar = `${this.tempDir()}/${name}`;
    try {
      const r = await this.run(this.pullDirScript(guestDir, guestTar), { timeoutMs: 20 * 60_000 });
      await this.getFile(guestTar, tar);
      await this.run(this.rmScript(guestTar), { lenient: true });
      await clearDir(localDir);
      await execFileAsync("tar", ["-xf", tar, "-C", localDir], { maxBuffer: 1024 * 1024 });
      this.cfg.log(`mirrored ${guestDir} (${r.stdout.trim()}) back to ${localDir}`);
    } finally {
      rmSync(tar, { force: true });
    }
  }

  /** A per-user temporary directory in the VM (forward slashes). */
  protected abstract tempDir(): string;

  /** The guest account's home (forward slashes). */
  abstract homeDir(): string;

  /** Sessionboxer's directory in the VM, in the guest's own notation. */
  protected abstract stateDir(): string;

  /** The remote command line that starts `command args` through the launcher, with untouched stdio. */
  abstract agentCommandLine(command: string, args: string[]): string;

  /** A built-in MCP (`desktop`, `sessionboxer`) as a command the Agent starts in the VM: the bridge client, piped to the MCP here. */
  abstract bridgeMcp(service: string): { command: string; args: string[] };

  /** git's `credential.helper` value that asks this side for the account's credentials through the bridge. */
  abstract credentialHelper(account: string): string;

  /** Writes the environment the Agent (and everything it starts) runs with in the VM: a file the launcher loads and deletes. */
  abstract writeAgentEnv(env: Record<string, string>): Promise<void>;

  /** Ends every Agent launched through the launcher that is still running in the VM (and its children). */
  abstract killAgents(): Promise<void>;

  /** The launcher's file name and content, generated for this Session's Workspace. */
  protected abstract launcher(): { name: string; content: string };

  /** A user's stdio MCP entry as the Agent can start it in the guest. */
  abstract stdioForGuest(s: McpServerStdio): McpServer;

  /** A script that prints the canonical form of the directory `path` (following links). */
  abstract realpathScript(path: string): string;

  /** The canonical form `realpathScript` printed, normalized so two spellings of one directory compare equal. */
  abstract canonicalPath(printed: string): string;

  /** A script that runs `git args` in `cwd` with git's stdout and stderr as the script's, exiting with git's code. */
  abstract gitScript(cwd: string, args: string[]): string;

  /** A script that removes the directory `path` and everything in it, succeeding when it is gone. */
  abstract rmDirScript(path: string): string;

  /**
   * Starts the bridge (once), puts the launcher and the bridge client in the VM and tells it where
   * the bridge is; the Agent's MCP entry and git's credential helper read that file.
   */
  async configureBridge(): Promise<void> {
    if (this.bridgeConfigured) return;
    const port = await this.bridge.listen();
    const host = sandboxAddress();
    const dir = `${this.homeDir()}/${GUEST_STATE_DIR}`;
    const launcher = this.launcher();
    await this.writeFile(`${dir}/${launcher.name}`, launcher.content);
    await this.writeFile(`${dir}/${GUEST_BRIDGE_SCRIPT}`, GUEST_BRIDGE_JS);
    await this.writeFile(`${dir}/bridge.json`, JSON.stringify({ host, port, token: this.bridgeToken }) + "\n");
    this.bridgeConfigured = true;
    this.cfg.log(`guest bridge at ${host}:${port} announced to the VM`);
  }

  /** Registers what a bridged service does with a fresh connection that presented the token. */
  onBridge(service: string, handler: (socket: Socket, args: string[]) => void): void {
    this.bridge.register(service, handler);
  }

  authorizeBridge(token: string): boolean {
    return token.length > 0 && token === this.bridgeToken;
  }
}

/** Runs the Agent in the Windows VM: loads the environment file, `cd`s to the Workspace, runs its arguments (in `%USERPROFILE%\.sessionboxer`). */
const WINDOWS_AGENT_LAUNCHER = "sessionboxer-agent.cmd";

/**
 * The Windows VM of a `qemu-windows` Session (ADR-0057, ADR-0060): OpenSSH with `cmd.exe` as
 * its default shell, PowerShell scripts sent `-EncodedCommand` so no quoting reaches cmd, Windows
 * paths under `C:\workspace`, npm's `.cmd` shims through `cmd /c`.
 */
export class WindowsGuest extends Guest {
  readonly os = "windows" as const;
  readonly label = "Windows VM";
  protected readonly readyProbe = "Write-Output ready";

  protected joinGuest(base: string, rel: string): string {
    return `${base}\\${rel.replace(/\//g, "\\")}`;
  }

  isAbsolute(p: string): boolean {
    return /^[A-Za-z]:/.test(p);
  }

  /** The same path with forward slashes, which every tool in the VM accepts and cmd does not mangle. */
  guestPathFwd(rel: string): string {
    return this.guestPath(rel).replace(/\\/g, "/");
  }

  protected terminalShell(): string {
    return `powershell -NoLogo -NoExit -Command "Set-Location -LiteralPath '${this.cfg.workspace}'"`;
  }

  protected remoteScript(script: string): string {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  }

  mkdirScript(dir: string): string {
    return `New-Item -ItemType Directory -Force -Path '${psQuote(dir)}' | Out-Null`;
  }

  protected existsScript(path: string): string {
    return `if (Test-Path -LiteralPath '${psQuote(path)}') { Write-Output yes } else { Write-Output no }`;
  }

  protected untarScript(tar: string, dir: string): string {
    return [
      `New-Item -ItemType Directory -Force -Path '${psQuote(dir)}' | Out-Null`,
      `& tar.exe -xf '${psQuote(tar)}' -C '${psQuote(dir)}'`,
      `$code = $LASTEXITCODE`,
      `Remove-Item -Force -LiteralPath '${psQuote(tar)}'`,
      `exit $code`,
    ].join("\n");
  }

  protected pullDirScript(dir: string, tar: string): string {
    return [
      `Set-Location -LiteralPath '${psQuote(dir)}'`,
      `$list = '${psQuote(tar)}.list'`,
      `$isGit = $false`,
      `try { $top = (& git.exe rev-parse --show-toplevel 2>$null); if ($LASTEXITCODE -eq 0 -and $top -and ((Resolve-Path -LiteralPath $top).Path -ieq (Get-Location).Path)) { $isGit = $true } } catch {}`,
      `if ($isGit) {`,
      `  $files = (& git.exe ls-files -z --cached --others --exclude-standard) -split "\`0" | Where-Object { $_ -ne '' -and $_ -ne '.git' -and -not $_.StartsWith('.git/') -and -not $_.StartsWith('.sessionboxer/') }`,
      `  $files = @($files | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })`,
      `  [IO.File]::WriteAllText($list, (($files + '.git') -join "\`n") + "\`n", (New-Object System.Text.UTF8Encoding $false))`,
      `  & tar.exe -cf '${psQuote(tar)}' -T $list`,
      `  Write-Output "git"`,
      `} else {`,
      `  & tar.exe -cf '${psQuote(tar)}' --exclude .sessionboxer .`,
      `  Write-Output "plain"`,
      `}`,
      `$code = $LASTEXITCODE`,
      `Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $list`,
      `exit $code`,
    ].join("\n");
  }

  rmScript(path: string): string {
    return `Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath '${psQuote(path)}'; exit 0`;
  }

  rmDirScript(path: string): string {
    return `Remove-Item -LiteralPath '${psQuote(path)}' -Recurse -Force -ErrorAction SilentlyContinue; exit 0`;
  }

  protected tempDir(): string {
    return `C:/Users/${this.cfg.user}/AppData/Local/Temp`;
  }

  /** `%USERPROFILE%` of the guest account (forward slashes). */
  homeDir(): string {
    return `C:/Users/${this.cfg.user}`;
  }

  /** Sessionboxer's directory in the VM, with back slashes (a Windows path for cmd and the Agent). */
  protected stateDir(): string {
    return `${this.homeDir().replace(/\//g, "\\")}\\${GUEST_STATE_DIR}`;
  }

  /** The launcher the Agent starts through: `sessionboxer-agent.cmd <command> [args]`. */
  agentCommandLine(command: string, args: string[]): string {
    return [`${this.stateDir()}\\${WINDOWS_AGENT_LAUNCHER}`, command, ...args].map(cmdArg).join(" ");
  }

  bridgeMcp(service: string): { command: string; args: string[] } {
    return { command: "node", args: [`${this.stateDir()}\\${GUEST_BRIDGE_SCRIPT}`, service] };
  }

  credentialHelper(account: string): string {
    return `!node ${this.homeDir()}/${GUEST_STATE_DIR}/${GUEST_BRIDGE_SCRIPT} ${BRIDGE_SERVICE_CREDENTIAL} ${account}`;
  }

  /**
   * `%USERPROFILE%\.sessionboxer\agent-env.cmd`, `call`ed (then deleted) by the launcher next to it.
   * Values are set through `set "K=V"` with `%` doubled so cmd takes them literally.
   */
  async writeAgentEnv(env: Record<string, string>): Promise<void> {
    const lines = ["@echo off"];
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\r\n]/.test(v)) continue;
      lines.push(`set "${k}=${v.replace(/%/g, "%%")}"`);
    }
    await this.writeFile(`${this.homeDir()}/${GUEST_STATE_DIR}/agent-env.cmd`, lines.join("\r\n") + "\r\n");
  }

  async killAgents(): Promise<void> {
    await this.run(
      [
        `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*${WINDOWS_AGENT_LAUNCHER}*' } | ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId 2>$null | Out-Null }`,
        `exit 0`,
      ].join("\n"),
      { lenient: true, timeoutMs: 60_000 },
    ).catch((e: unknown) => this.cfg.log(`could not end the previous Agent in the VM: ${String(e)}`));
  }

  protected launcher(): { name: string; content: string } {
    return { name: WINDOWS_AGENT_LAUNCHER, content: guestAgentLauncherCmd(this.cfg.workspace) };
  }

  /** A bare command that is neither an `.exe`/`.cmd`/`.bat` nor a known executable is an npm/uv shim: `cmd /c` resolves it. */
  stdioForGuest(s: McpServerStdio): McpServer {
    const base = posix.basename(s.command.replace(/\\/g, "/")).toLowerCase();
    const hasExt = /\.(exe|cmd|bat|com)$/.test(base);
    if (hasExt || GUEST_EXECUTABLES.has(base) || /[\\/]/.test(s.command)) return s;
    return { ...s, command: "cmd", args: ["/c", s.command, ...s.args] };
  }

  realpathScript(path: string): string {
    return `(Resolve-Path -LiteralPath '${psQuote(path)}').ProviderPath`;
  }

  canonicalPath(printed: string): string {
    return printed.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  gitScript(cwd: string, args: string[]): string {
    const list = ["-C", cwd, ...args].map((a) => `'${psQuote(a)}'`).join(", ");
    return [
      `$env:GIT_TERMINAL_PROMPT = '0'`,
      `$out = & git.exe @(${list}) 2>&1`,
      `$code = $LASTEXITCODE`,
      `$out | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { [Console]::Error.WriteLine($_.ToString()) } else { [Console]::Out.WriteLine($_) } }`,
      `exit $code`,
    ].join("\n");
  }
}

/** Runs the Agent in the macOS VM: sources the environment file, `cd`s to the Workspace, `exec`s its arguments (in `~/.sessionboxer`). */
const POSIX_AGENT_LAUNCHER = "sessionboxer-agent.sh";

/**
 * The macOS VM of a `qemu-macos` Session (ADR-0059, ADR-0061): Apple's OpenSSH with zsh as the
 * account's shell, scripts run by `/bin/bash` from a base64 argument, POSIX paths under
 * `/Users/agent/workspace`, the tools the base install put in `/usr/local/bin` and `~/.local/bin`
 * on `PATH` for everything the Daemon and the Agent run. A Linux box with sshd, an `agent` user
 * whose home is `/Users/agent`, bash, git and tar behaves the same, which is how the transport is
 * tested without a Mac.
 */
export class MacGuest extends Guest {
  readonly os = "macos" as const;
  readonly label = "macOS VM";
  protected readonly readyProbe = "echo ready";

  protected joinGuest(base: string, rel: string): string {
    return `${base}/${rel}`;
  }

  isAbsolute(p: string): boolean {
    return p.startsWith("/");
  }

  protected terminalShell(): string {
    return `cd ${shQuote(this.cfg.workspace)} 2>/dev/null; exec zsh -l`;
  }

  /** `bash -c "$(echo <base64> | base64 --decode)"`: the script reaches bash byte for byte, whatever the login shell. */
  protected remoteScript(script: string): string {
    const prologue = `export PATH="${POSIX_TOOL_PATH}:$PATH" GIT_TERMINAL_PROMPT=0\n`;
    const encoded = Buffer.from(prologue + script, "utf8").toString("base64");
    return `bash -c "$(echo ${encoded} | base64 --decode)"`;
  }

  mkdirScript(dir: string): string {
    return `mkdir -p -- ${shQuote(dir)}`;
  }

  protected existsScript(path: string): string {
    return `if [ -e ${shQuote(path)} ]; then echo yes; else echo no; fi`;
  }

  protected untarScript(tar: string, dir: string): string {
    return [`mkdir -p -- ${shQuote(dir)}`, `tar -xf ${shQuote(tar)} -C ${shQuote(dir)}`, `code=$?`, `rm -f -- ${shQuote(tar)}`, `exit $code`].join("\n");
  }

  protected pullDirScript(dir: string, tar: string): string {
    return [
      `cd ${shQuote(dir)} || exit 1`,
      `list=${shQuote(tar)}.list`,
      `: > "$list"`,
      `if top=$(git rev-parse --show-toplevel 2>/dev/null) && [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$(pwd -P)" ]; then`,
      `  while IFS= read -r -d '' f; do`,
      `    case "$f" in .git|.git/*|.sessionboxer/*) continue ;; esac`,
      `    [ -f "$f" ] && printf '%s\\n' "$f" >> "$list"`,
      `  done < <(git ls-files -z --cached --others --exclude-standard)`,
      `  printf '.git\\n' >> "$list"`,
      `  tar -cf ${shQuote(tar)} -T "$list"`,
      `  code=$?`,
      `  echo git`,
      `else`,
      `  tar -cf ${shQuote(tar)} --exclude .sessionboxer .`,
      `  code=$?`,
      `  echo plain`,
      `fi`,
      `rm -f -- "$list"`,
      `exit $code`,
    ].join("\n");
  }

  rmScript(path: string): string {
    return `rm -f -- ${shQuote(path)}`;
  }

  rmDirScript(path: string): string {
    return `rm -rf -- ${shQuote(path)}`;
  }

  protected tempDir(): string {
    return `${this.homeDir()}/${GUEST_STATE_DIR}/tmp`;
  }

  homeDir(): string {
    return `/Users/${this.cfg.user}`;
  }

  protected stateDir(): string {
    return `${this.homeDir()}/${GUEST_STATE_DIR}`;
  }

  /** `sh ~/.sessionboxer/sessionboxer-agent.sh <command> [args]`, every argument single-quoted for the login shell. */
  agentCommandLine(command: string, args: string[]): string {
    return ["sh", `${this.stateDir()}/${POSIX_AGENT_LAUNCHER}`, command, ...args].map(shQuote).join(" ");
  }

  bridgeMcp(service: string): { command: string; args: string[] } {
    return { command: "/usr/local/bin/node", args: [`${this.stateDir()}/${GUEST_BRIDGE_SCRIPT}`, service] };
  }

  credentialHelper(account: string): string {
    return `!/usr/local/bin/node ${this.stateDir()}/${GUEST_BRIDGE_SCRIPT} ${BRIDGE_SERVICE_CREDENTIAL} ${account}`;
  }

  /** `~/.sessionboxer/agent-env.sh`, sourced (then deleted) by the launcher next to it: `export K='V'` lines. */
  async writeAgentEnv(env: Record<string, string>): Promise<void> {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\r\n]/.test(v)) continue;
      lines.push(`export ${k}=${shQuote(v)}`);
    }
    await this.writeFile(`${this.stateDir()}/agent-env.sh`, lines.join("\n") + "\n");
  }

  /**
   * The launcher records its process group (`agent.pgid`); the whole group — the Agent and the MCP
   * servers it started — gets TERM then KILL, if it still holds an `acp` process (a group id could
   * have been reused after a reboot).
   */
  async killAgents(): Promise<void> {
    await this.run(
      [
        `f=${shQuote(`${this.stateDir()}/agent.pgid`)}`,
        `if [ -f "$f" ]; then`,
        `  pg=$(tr -dc '0-9' < "$f")`,
        `  if [ -n "$pg" ] && [ "$pg" -gt 1 ] && pgrep -g "$pg" -f acp >/dev/null 2>&1; then`,
        `    kill -TERM -- "-$pg" 2>/dev/null; sleep 1; kill -KILL -- "-$pg" 2>/dev/null`,
        `  fi`,
        `  rm -f -- "$f"`,
        `fi`,
        `exit 0`,
      ].join("\n"),
      { lenient: true, timeoutMs: 60_000 },
    ).catch((e: unknown) => this.cfg.log(`could not end the previous Agent in the VM: ${String(e)}`));
  }

  protected launcher(): { name: string; content: string } {
    return { name: POSIX_AGENT_LAUNCHER, content: guestAgentLauncherSh(this.cfg.workspace, POSIX_TOOL_PATH) };
  }

  /** A POSIX guest resolves `npx`, `uvx` and binaries on the launcher's `PATH`: the entry runs as the user wrote it. */
  stdioForGuest(s: McpServerStdio): McpServer {
    return s;
  }

  realpathScript(path: string): string {
    return `cd ${shQuote(path)} && pwd -P`;
  }

  canonicalPath(printed: string): string {
    return printed.trim().replace(/\/+$/, "");
  }

  gitScript(cwd: string, args: string[]): string {
    return `exec git -C ${shQuote(cwd)} ${args.map(shQuote).join(" ")}`;
  }
}

/**
 * The Sandbox-side end of the guest bridge: a TCP listener where the VM connects with one
 * line `<service> <token> [args...]`, then the connection is handed to the service, which
 * pipes it to a process here (the desktop MCP's stdio, `git credential fill`, ...).
 */
class GuestBridge {
  private server: Server | null = null;
  private readonly handlers = new Map<string, (socket: Socket, args: string[]) => void>();

  constructor(private readonly guest: Guest) {}

  register(service: string, handler: (socket: Socket, args: string[]) => void): void {
    this.handlers.set(service, handler);
  }

  listen(): Promise<number> {
    if (this.server) return Promise.resolve(GUEST_BRIDGE_PORT);
    // Half-open: a helper that writes its request and closes its side (git's credential helper) still gets the answer.
    const server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    this.server = server;
    return new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(GUEST_BRIDGE_PORT, "0.0.0.0", () => resolvePromise(GUEST_BRIDGE_PORT));
    });
  }

  private accept(socket: Socket): void {
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 10_000);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(0x0a);
      if (nl === -1) {
        if (head.length > 4096) socket.destroy();
        return;
      }
      clearTimeout(timer);
      socket.off("data", onData);
      socket.pause();
      const [service = "", token = "", ...args] = head.subarray(0, nl).toString("utf8").trim().split(" ");
      const rest = head.subarray(nl + 1);
      const handler = this.handlers.get(service);
      if (!handler || !this.guest.authorizeBridge(token)) {
        this.guest.cfg.log(`guest bridge: refused ${service || "(empty)"} from ${socket.remoteAddress ?? "?"}`);
        socket.destroy();
        return;
      }
      if (rest.length > 0) socket.unshift(rest);
      handler(socket, args);
      socket.resume();
    };
    socket.on("data", onData);
    socket.on("error", () => undefined);
  }
}

/**
 * A file the Provider reads (or writes) in its own directory: kept on the Linux side as before
 * (the Control Plane and the tmpfs rules know these paths) and copied into the VM before every
 * Agent start; the ones the Provider rewrites (refreshed logins) are copied back after each turn.
 */
export interface GuestProviderFile {
  local: string;
  /** Path in the VM, relative to the guest account's home (`.claude/settings.json`) or absolute. */
  guest: string;
  /** Copied back from the VM after each turn so refreshed tokens reach the Control Plane. */
  pullBack?: boolean;
}

export interface GuestTransportConfig {
  guest: Guest;
  /** The Provider's environment this Sandbox was given (its login, base URL): it goes with the Agent into the VM. */
  env: Record<string, string>;
  files: GuestProviderFile[];
  /** The built-in MCPs as they run on the Linux side (the ACP entries with their names run them). */
  builtinMcps: () => BuiltinMcp[];
  log: (msg: string) => void;
}

/**
 * Runs the ACP Agent inside the VM (ADR-0060, ADR-0061): `ssh vm <launcher> <command>` with the
 * ACP stream on the SSH channel. Before each start the Agent's environment (Provider login, base
 * URL, options) goes to the VM as a file the launcher loads and deletes, and the Provider's
 * configuration files follow it. MCP servers are handed to the Agent as it can start them in the
 * guest: the built-in entries (`desktop`, `sessionboxer`) become the bridge client, user stdio entries are adapted by the guest
 * (`.cmd` shims through `cmd /c` on Windows, as written on macOS), URLs pass unchanged.
 */
export class GuestAgentTransport implements AgentTransport {
  constructor(private readonly cfg: GuestTransportConfig) {
    this.attachmentPath = this.attachmentPath.bind(this);
  }

  private get guest(): Guest {
    return this.cfg.guest;
  }

  async prepare(env: Record<string, string>): Promise<void> {
    await this.guest.waitReady();
    await this.guest.configureBridge();
    await this.guest.killAgents();
    await this.guest.run(this.guest.mkdirScript(this.guest.workspace));
    await this.pushFiles();
    await this.guest.writeAgentEnv({ ...this.cfg.env, ...env });
  }

  spawn(command: string, args: string[]): ChildProcess {
    this.cfg.log(`starting the Agent in the ${this.guest.label}: ${[command, ...args].join(" ")}`);
    return this.guest.spawnSsh(this.guest.agentCommandLine(command, args));
  }

  attachmentPath(rel: string): string {
    return this.guest.guestPath(rel);
  }

  mcpServers(servers: McpServer[]): McpServer[] {
    return servers.map((s) => {
      if (!isStdio(s)) return s;
      if (this.cfg.builtinMcps().some((b) => b.name === s.name && b.command === s.command)) {
        const bridged = this.guest.bridgeMcp(s.name);
        return { name: s.name, command: bridged.command, args: bridged.args, env: [] };
      }
      return this.guest.stdioForGuest(s);
    });
  }

  /** Copies the Provider's files into the VM (those that exist here). */
  private async pushFiles(): Promise<void> {
    for (const f of this.cfg.files) {
      let content: string;
      try {
        content = readFileSync(f.local, "utf8");
      } catch {
        continue;
      }
      await this.guest.writeFile(this.guestFilePath(f), content);
    }
  }

  /** Copies back the files the Provider rewrites in the VM (refreshed logins); call after each turn. */
  async pullFiles(): Promise<void> {
    for (const f of this.cfg.files) {
      if (!f.pullBack) continue;
      const guestPath = this.guestFilePath(f);
      if (!(await this.guest.exists(guestPath))) continue;
      await this.guest.getFile(guestPath, f.local).catch((e: unknown) => this.cfg.log(`could not copy ${guestPath} back: ${String(e)}`));
    }
  }

  private guestFilePath(f: GuestProviderFile): string {
    return this.guest.isAbsolute(f.guest) ? f.guest : `${this.guest.homeDir()}/${f.guest}`;
  }
}

function isStdio(s: McpServer): s is McpServerStdio {
  return !("type" in s) || s.type === undefined;
}

/** Quotes one argument for a cmd.exe command line (the launcher re-splits it). */
function cmdArg(a: string): string {
  return /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

/** Single-quotes one word for a POSIX shell (sh, bash, zsh). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The repositories of a VM Session live in the guest under its Workspace; git runs there over
 * SSH and paths in the manifest and the briefing are the guest's.
 */
export class GuestRepoHost implements RepoHost {
  constructor(private readonly guest: Guest) {}

  get workspace(): string {
    return this.guest.workspace;
  }

  path(dir: string): string {
    return this.guest.guestPath(dir);
  }

  isDirectory(path: string): Promise<boolean> {
    return this.guest.exists(path);
  }

  async realpath(path: string): Promise<string> {
    const r = await this.guest.run(this.guest.realpathScript(path));
    return this.guest.canonicalPath(r.stdout);
  }

  async git(cwd: string, args: string[]): Promise<string> {
    const r = await this.guest.run(this.guest.gitScript(cwd, args), { timeoutMs: 10 * 60_000 });
    return r.stdout;
  }

  async rm(path: string): Promise<void> {
    await this.guest.run(this.guest.rmDirScript(path));
  }

  writeManifest(content: string): Promise<void> {
    return this.guest.writeFile(this.guest.guestPath(REPOS_MANIFEST_PATH), content);
  }

  credentialHelper(account: string): string {
    return this.guest.credentialHelper(account);
  }

  pushDir(dir: string): Promise<void> {
    return this.guest.pushDir(workspaceDir(this.guest.cfg.localWorkspace, dir), this.guest.guestPath(dir));
  }

  async ready(): Promise<void> {
    await this.guest.waitReady();
    await this.guest.configureBridge();
    await this.guest.run(this.guest.mkdirScript(this.guest.workspace));
  }
}

/**
 * The services the VM reaches through the bridge: the built-in MCPs (the desktop MCP's screenshots
 * and input act on the RDP/VNC view of the VM, and the `sessionboxer` MCP talks to the Daemon on
 * this side, so both stay on the Linux side) and git credentials (the accounts the user connected
 * are in `gh`/`bb` here; git in the VM asks through the bridge, as the active login or as one account).
 */
export function registerBridgeServices(guest: Guest, builtins: BuiltinMcp[], log: (msg: string) => void): void {
  for (const b of builtins) {
    guest.onBridge(b.name, (socket) => {
      const child = spawn(b.command, b.args ?? [], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      bridgeToProcess(socket, child, log, `${b.name} mcp (vm)`);
    });
  }
  guest.onBridge(BRIDGE_SERVICE_CREDENTIAL, (socket, args) => {
    const [account = "-", op = "get"] = args;
    if (op !== "get") {
      socket.end();
      return;
    }
    const child =
      account === "-"
        ? spawn("git", ["credential", "fill"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
        : spawn("git-credential-sessionboxer", [account, "get"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    bridgeToProcess(socket, child, log, `git credential (vm${account === "-" ? "" : `, @${account}`})`);
  });
}

/** Pipes a bridged connection to a process's stdio: the guest talks to it as if it ran there. */
export function bridgeToProcess(socket: Socket, child: ChildProcess, log: (msg: string) => void, label: string): void {
  if (!child.stdin || !child.stdout) {
    socket.destroy();
    return;
  }
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  child.stderr?.on("data", (d: Buffer) => log(`[${label}] ${d.toString().trimEnd()}`));
  socket.on("close", () => {
    if (child.exitCode === null) child.kill();
  });
  socket.on("error", () => child.kill());
  child.on("exit", () => socket.end());
  child.on("error", (e) => {
    log(`${label}: ${e.message}`);
    socket.destroy();
  });
}

/** This Sandbox's address on the Session network, the one the VM reaches it at. */
export function sandboxAddress(): string {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (name === "lo" || name.startsWith("docker") || name.startsWith("br-") || name.startsWith("veth")) continue;
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return "127.0.0.1";
}

/** Removes everything inside `dir` (keeping `dir` itself), creating it when missing. */
async function clearDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return;
  }
  for (const entry of await fs.readdir(dir)) await fs.rm(join(dir, entry), { recursive: true, force: true });
}

function psQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/** `scp` wants forward slashes and no drive-colon confusion: `C:/x/y` is fine. */
function scpPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function firstLine(script: string): string {
  const line = script.split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
