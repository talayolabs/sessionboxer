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
import { GUEST_BRIDGE_JS, guestAgentLauncherCmd } from "./guest-scripts.js";
import type { RepoHost } from "./repos.js";
import { workspaceDir } from "./workspace-sync.js";

const execFileAsync = promisify(execFile);

/** Runs the Agent in the VM: loads the environment file, `cd`s to the Workspace, runs its arguments (in `%USERPROFILE%\.sessionboxer`). */
const GUEST_AGENT_LAUNCHER = "sessionboxer-agent.cmd";
/** Connects the VM to a bridged service here (`node sessionboxer-bridge.js desktop`). */
const GUEST_BRIDGE_SCRIPT = "sessionboxer-bridge.js";
/** Names the ACP `desktop` MCP entry gets when it has to cross to the Linux side. */
export const BRIDGE_SERVICE_DESKTOP = "desktop";
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
/** Sessionboxer's own files in the VM (`%USERPROFILE%\.sessionboxer`): the launcher, the bridge client, `bridge.json`, the Agent's environment. */
const GUEST_STATE_DIR = ".sessionboxer";
const READY_POLL_MS = 3_000;
const DEFAULT_READY_TIMEOUT_MS = 15 * 60_000;

export interface GuestConfig {
  host: string;
  sshPort: number;
  user: string;
  password: string;
  /** The Workspace in the VM, e.g. `C:\workspace`. */
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

/**
 * The Windows VM of a `qemu-windows` Session, seen from the Sandbox Daemon: the machine the
 * Agent, its MCP servers, the repositories and the Terminal live on (ADR-0057). Everything
 * goes over SSH to the VM's OpenSSH server, whose default shell is `cmd.exe` so that the
 * Agent's ACP stdio (JSON lines, UTF-8) passes through untouched; PowerShell commands are
 * sent `-EncodedCommand`, so no quoting reaches cmd. The guest password only ever travels
 * as `SSHPASS` in the environment of `sshpass -e`, never on a command line.
 */
export class WindowsGuest {
  private readyPromise: Promise<void> | null = null;
  private readonly bridge = new GuestBridge(this);
  private readonly bridgeToken = randomBytes(24).toString("hex");
  private bridgeConfigured = false;

  constructor(readonly cfg: GuestConfig) {}

  get workspace(): string {
    return this.cfg.workspace;
  }

  private get target(): string {
    return `${this.cfg.user}@${this.cfg.host}`;
  }

  private get sshEnv(): NodeJS.ProcessEnv {
    return { ...process.env, SSHPASS: this.cfg.password };
  }

  /** Path inside the VM of a Workspace-relative path (`foo/bar.txt` -> `C:\workspace\foo\bar.txt`). */
  guestPath(rel: string): string {
    const clean = posix.normalize(rel.replace(/\\/g, "/")).replace(/^\.(\/|$)/, "").replace(/\/+$/, "");
    if (clean === "" || clean === ".") return this.cfg.workspace;
    if (clean.startsWith("../") || clean === "..") throw new GuestError(`path escapes the Workspace: ${rel}`);
    return `${this.cfg.workspace}\\${clean.replace(/\//g, "\\")}`;
  }

  /** The same path with forward slashes, which every tool in the VM accepts and cmd does not mangle. */
  guestPathFwd(rel: string): string {
    return this.guestPath(rel).replace(/\\/g, "/");
  }

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

  /** Spawns `ssh` to the VM running `remoteCommand` (a cmd.exe command line) with piped stdio. */
  spawnSsh(remoteCommand: string, extra: string[] = []): ChildProcess {
    return spawn("sshpass", ["-e", "ssh", ...SSH_OPTS, ...extra, "-p", String(this.cfg.sshPort), this.target, remoteCommand], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.sshEnv,
    });
  }

  /** The command line and environment a PTY should run for an interactive PowerShell in the VM. */
  terminalCommand(): { command: string; args: string[]; env: Record<string, string> } {
    return {
      command: "sshpass",
      args: ["-e", "ssh", "-t", ...SSH_OPTS, "-p", String(this.cfg.sshPort), this.target, `powershell -NoLogo -NoExit -Command "Set-Location -LiteralPath '${this.cfg.workspace}'"`],
      env: { SSHPASS: this.cfg.password },
    };
  }

  /** Runs a PowerShell script in the VM; resolves with its output, rejects on a non-zero exit unless `lenient`. */
  async run(script: string, opts: { lenient?: boolean; timeoutMs?: number } = {}): Promise<GuestRunResult> {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const remote = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
    return new Promise((resolvePromise, reject) => {
      const child = this.spawnSsh(remote);
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

  private async pollReady(timeoutMs: number): Promise<void> {
    const started = Date.now();
    let announced = false;
    for (;;) {
      const probe = await this.run("Write-Output ready", { lenient: true, timeoutMs: 20_000 }).catch(() => null);
      if (probe && probe.code === 0 && probe.stdout.includes("ready")) {
        this.cfg.log(`windows vm ${this.cfg.host} answers over ssh${announced ? ` after ${Math.round((Date.now() - started) / 1000)} s` : ""}`);
        return;
      }
      if (!announced) {
        this.cfg.log(`waiting for the windows vm ${this.cfg.host} to answer over ssh`);
        announced = true;
      }
      if (Date.now() - started > timeoutMs) throw new GuestError(`the Windows VM ${this.cfg.host} did not answer over SSH within ${Math.round(timeoutMs / 60_000)} min`);
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }

  /** Copies a local file into the VM (`guestPath` with forward or back slashes). */
  async putFile(localPath: string, guestPath: string): Promise<void> {
    const dir = posix.dirname(guestPath.replace(/\\/g, "/"));
    await this.run(`New-Item -ItemType Directory -Force -Path '${psQuote(dir)}' | Out-Null`);
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
    await execFileAsync("sshpass", ["-e", "scp", ...SSH_OPTS, "-P", String(this.cfg.sshPort), from, to], { env: this.sshEnv, maxBuffer: 1024 * 1024 });
  }

  /** Whether a path exists in the VM. */
  async exists(guestPath: string): Promise<boolean> {
    const r = await this.run(`if (Test-Path -LiteralPath '${psQuote(guestPath)}') { Write-Output yes } else { Write-Output no }`);
    return r.stdout.includes("yes");
  }

  /**
   * Copies a local directory tree into the VM at `guestDir` (created if needed): one tar over
   * scp, unpacked by Windows' own `tar` (bsdtar, in every Windows 10+). Symlinks travel as-is.
   */
  async pushDir(localDir: string, guestDir: string): Promise<void> {
    mkdirSync(this.cfg.spoolDir, { recursive: true, mode: 0o700 });
    const tar = join(this.cfg.spoolDir, `${randomBytes(6).toString("hex")}.tar`);
    try {
      await execFileAsync("tar", ["-cf", tar, "-C", localDir, "."], { maxBuffer: 1024 * 1024 });
      const guestTar = `${this.tempDir()}/${posix.basename(tar)}`;
      await this.putFile(tar, guestTar);
      await this.run(
        [
          `New-Item -ItemType Directory -Force -Path '${psQuote(guestDir)}' | Out-Null`,
          `& tar.exe -xf '${psQuote(guestTar)}' -C '${psQuote(guestDir)}'`,
          `$code = $LASTEXITCODE`,
          `Remove-Item -Force -LiteralPath '${psQuote(guestTar)}'`,
          `exit $code`,
        ].join("\n"),
        { timeoutMs: 20 * 60_000 },
      );
    } finally {
      rmSync(tar, { force: true });
    }
  }

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
      const r = await this.run(
        [
          `Set-Location -LiteralPath '${psQuote(guestDir)}'`,
          `$list = '${psQuote(guestTar)}.list'`,
          `$isGit = $false`,
          `try { $top = (& git.exe rev-parse --show-toplevel 2>$null); if ($LASTEXITCODE -eq 0 -and $top -and ((Resolve-Path -LiteralPath $top).Path -ieq (Get-Location).Path)) { $isGit = $true } } catch {}`,
          `if ($isGit) {`,
          `  $files = (& git.exe ls-files -z --cached --others --exclude-standard) -split "\`0" | Where-Object { $_ -ne '' -and $_ -ne '.git' -and -not $_.StartsWith('.git/') -and -not $_.StartsWith('.sessionboxer/') }`,
          `  $files = @($files | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })`,
          `  [IO.File]::WriteAllText($list, (($files + '.git') -join "\`n") + "\`n", (New-Object System.Text.UTF8Encoding $false))`,
          `  & tar.exe -cf '${psQuote(guestTar)}' -T $list`,
          `  Write-Output "git"`,
          `} else {`,
          `  & tar.exe -cf '${psQuote(guestTar)}' --exclude .sessionboxer .`,
          `  Write-Output "plain"`,
          `}`,
          `$code = $LASTEXITCODE`,
          `Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $list`,
          `exit $code`,
        ].join("\n"),
        { timeoutMs: 20 * 60_000 },
      );
      await this.getFile(guestTar, tar);
      await this.run(`Remove-Item -Force -LiteralPath '${psQuote(guestTar)}'`, { lenient: true });
      await clearDir(localDir);
      await execFileAsync("tar", ["-xf", tar, "-C", localDir], { maxBuffer: 1024 * 1024 });
      this.cfg.log(`mirrored ${guestDir} (${r.stdout.trim()}) back to ${localDir}`);
    } finally {
      rmSync(tar, { force: true });
    }
  }

  /** A per-user temporary directory in the VM (forward slashes). */
  private tempDir(): string {
    return `C:/Users/${this.cfg.user}/AppData/Local/Temp`;
  }

  /** `%USERPROFILE%` of the guest account (forward slashes). */
  homeDir(): string {
    return `C:/Users/${this.cfg.user}`;
  }

  /** Sessionboxer's directory in the VM, with back slashes (a Windows path for cmd and the Agent). */
  private stateDir(): string {
    return `${this.homeDir().replace(/\//g, "\\")}\\${GUEST_STATE_DIR}`;
  }

  /** The launcher the Agent starts through: `sessionboxer-agent.cmd <command> [args]`. */
  agentLauncher(): string {
    return `${this.stateDir()}\\${GUEST_AGENT_LAUNCHER}`;
  }

  /** The desktop MCP as a command the Agent starts in the VM: the bridge client, piped to the MCP here. */
  desktopMcp(): { command: string; args: string[] } {
    return { command: "node", args: [`${this.stateDir()}\\${GUEST_BRIDGE_SCRIPT}`, BRIDGE_SERVICE_DESKTOP] };
  }

  /** git's `credential.helper` value that asks this side for the account's credentials through the bridge. */
  credentialHelper(account: string): string {
    return `!node ${this.homeDir()}/${GUEST_STATE_DIR}/${GUEST_BRIDGE_SCRIPT} ${BRIDGE_SERVICE_CREDENTIAL} ${account}`;
  }

  /**
   * Writes the environment the Agent (and everything it starts) runs with in the VM:
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

  /** Ends every Agent launched through the launcher that is still running in the VM (and its children). */
  async killAgents(): Promise<void> {
    await this.run(
      [
        `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*sessionboxer-agent.cmd*' } | ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId 2>$null | Out-Null }`,
        `exit 0`,
      ].join("\n"),
      { lenient: true, timeoutMs: 60_000 },
    ).catch((e: unknown) => this.cfg.log(`could not end the previous Agent in the VM: ${String(e)}`));
  }

  /**
   * Starts the bridge (once), puts the launcher and the bridge client in the VM and tells it where
   * the bridge is; the Agent's MCP entry and git's credential helper read that file.
   */
  async configureBridge(): Promise<void> {
    if (this.bridgeConfigured) return;
    const port = await this.bridge.listen();
    const host = sandboxAddress();
    const dir = `${this.homeDir()}/${GUEST_STATE_DIR}`;
    await this.writeFile(`${dir}/${GUEST_AGENT_LAUNCHER}`, guestAgentLauncherCmd(this.cfg.workspace));
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

/**
 * The Sandbox-side end of the guest bridge: a TCP listener where the VM connects with one
 * line `<service> <token> [args...]`, then the connection is handed to the service, which
 * pipes it to a process here (the desktop MCP's stdio, `git credential fill`, ...).
 */
class GuestBridge {
  private server: Server | null = null;
  private readonly handlers = new Map<string, (socket: Socket, args: string[]) => void>();

  constructor(private readonly guest: WindowsGuest) {}

  register(service: string, handler: (socket: Socket, args: string[]) => void): void {
    this.handlers.set(service, handler);
  }

  listen(): Promise<number> {
    if (this.server) return Promise.resolve(GUEST_BRIDGE_PORT);
    const server = createServer((socket) => this.accept(socket));
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
  /** Path in the VM, relative to the guest account's profile (`.claude/settings.json`) or absolute. */
  guest: string;
  /** Copied back from the VM after each turn so refreshed tokens reach the Control Plane. */
  pullBack?: boolean;
}

export interface WindowsTransportConfig {
  guest: WindowsGuest;
  /** The Provider's environment this Sandbox was given (its login, base URL): it goes with the Agent into the VM. */
  env: Record<string, string>;
  files: GuestProviderFile[];
  /** The desktop MCP command on the Linux side (the ACP entry named `desktop` runs it). */
  desktopCommand: string;
  log: (msg: string) => void;
}

/**
 * Runs the ACP Agent inside the Windows VM (ADR-0057): `ssh vm C:\OEM\sessionboxer-agent.cmd <command>`
 * with the ACP stream on the SSH channel. Before each start the Agent's environment (Provider
 * login, base URL, options) goes to the VM as a file the launcher loads and deletes, and the
 * Provider's configuration files follow it. MCP servers are handed to the Agent as it can start
 * them in Windows: the desktop entry becomes the bridge client, user stdio entries stay as the
 * user wrote them for Windows (`.cmd` shims through `cmd /c`), URLs pass unchanged.
 */
export class WindowsAgentTransport implements AgentTransport {
  constructor(private readonly cfg: WindowsTransportConfig) {
    this.attachmentPath = this.attachmentPath.bind(this);
  }

  private get guest(): WindowsGuest {
    return this.cfg.guest;
  }

  async prepare(env: Record<string, string>): Promise<void> {
    await this.guest.waitReady();
    await this.guest.configureBridge();
    await this.guest.killAgents();
    await this.guest.run(`New-Item -ItemType Directory -Force -Path '${psQuote(this.guest.workspace)}' | Out-Null`);
    await this.pushFiles();
    await this.guest.writeAgentEnv({ ...this.cfg.env, ...env });
  }

  spawn(command: string, args: string[]): ChildProcess {
    const line = [this.guest.agentLauncher(), command, ...args].map(cmdArg).join(" ");
    this.cfg.log(`starting the Agent in the Windows VM: ${[command, ...args].join(" ")}`);
    return this.guest.spawnSsh(line);
  }

  attachmentPath(rel: string): string {
    return this.guest.guestPath(rel);
  }

  mcpServers(servers: McpServer[]): McpServer[] {
    return servers.map((s) => {
      if (!isStdio(s)) return s;
      if (s.name === BRIDGE_SERVICE_DESKTOP && s.command === this.cfg.desktopCommand) {
        const desktop = this.guest.desktopMcp();
        return { name: s.name, command: desktop.command, args: desktop.args, env: [] };
      }
      return guestStdio(s);
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
    return /^[A-Za-z]:/.test(f.guest) ? f.guest : `${this.guest.homeDir()}/${f.guest}`;
  }
}

function isStdio(s: McpServer): s is McpServerStdio {
  return !("type" in s) || s.type === undefined;
}

/** A user's stdio MCP entry as the Agent can start it in Windows. */
function guestStdio(s: McpServerStdio): McpServer {
  const base = posix.basename(s.command.replace(/\\/g, "/")).toLowerCase();
  const hasExt = /\.(exe|cmd|bat|com)$/.test(base);
  if (hasExt || GUEST_EXECUTABLES.has(base) || /[\\/]/.test(s.command)) return s;
  return { ...s, command: "cmd", args: ["/c", s.command, ...s.args] };
}

/** Quotes one argument for a cmd.exe command line (the launcher re-splits it). */
function cmdArg(a: string): string {
  return /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

/**
 * The repositories of a Windows Session live in the VM under `C:\workspace`; git runs there over
 * SSH and paths in the manifest and the briefing are Windows paths.
 */
export class WindowsRepoHost implements RepoHost {
  constructor(private readonly guest: WindowsGuest) {}

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
    const r = await this.guest.run(`(Resolve-Path -LiteralPath '${psQuote(path)}').ProviderPath`);
    return r.stdout.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  async git(cwd: string, args: string[]): Promise<string> {
    const list = ["-C", cwd, ...args].map((a) => `'${psQuote(a)}'`).join(", ");
    const r = await this.guest.run(
      [
        `$env:GIT_TERMINAL_PROMPT = '0'`,
        `$out = & git.exe @(${list}) 2>&1`,
        `$code = $LASTEXITCODE`,
        `$out | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { [Console]::Error.WriteLine($_.ToString()) } else { [Console]::Out.WriteLine($_) } }`,
        `exit $code`,
      ].join("\n"),
      { timeoutMs: 10 * 60_000 },
    );
    return r.stdout;
  }

  async rm(path: string): Promise<void> {
    await this.guest.run(`Remove-Item -LiteralPath '${psQuote(path)}' -Recurse -Force -ErrorAction SilentlyContinue; exit 0`);
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
    await this.guest.run(`New-Item -ItemType Directory -Force -Path '${psQuote(this.guest.workspace)}' | Out-Null`);
  }
}

/**
 * The services the VM reaches through the bridge: the desktop MCP (the Agent's screenshots and
 * input act on the RDP view of the VM, so the MCP stays on the Linux side) and git credentials
 * (the accounts the user connected are in `gh`/`bb` here; git in the VM asks through the bridge,
 * as the active login or as one account).
 */
export function registerBridgeServices(guest: WindowsGuest, desktopCommand: string, log: (msg: string) => void): void {
  guest.onBridge(BRIDGE_SERVICE_DESKTOP, (socket) => {
    const child = spawn(desktopCommand, [], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    bridgeToProcess(socket, child, log, "desktop mcp (vm)");
  });
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
