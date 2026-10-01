/**
 * The files the Daemon puts in the VM (`%USERPROFILE%\.sessionboxer` on Windows, `~/.sessionboxer`
 * on macOS) before the Agent starts there (ADR-0060, ADR-0061): a launcher for the guest's shell and
 * the bridge client. They ship with the Daemon rather than with the base disk's install script so
 * an image rebuild updates them; the base install only has to provide Node, git and the Provider CLIs.
 */

/** The Windows account's `PATH` may miss what the base install added after login: the launcher adds the known places. */
const GUEST_TOOL_DIRS = [
  "C:\\Program Files\\nodejs",
  "%APPDATA%\\npm",
  "C:\\Program Files\\Git\\cmd",
  "%USERPROFILE%\\.local\\bin",
  "%LOCALAPPDATA%\\devin\\cli\\bin",
  "%LOCALAPPDATA%\\Programs\\cursor-agent",
  "%LOCALAPPDATA%\\Programs\\opencode",
];

/**
 * `sessionboxer-agent.cmd <command> [args]`: loads the environment file the Daemon wrote (and
 * deletes it, so the Provider login does not stay on the VM disk), `cd`s to the Workspace and
 * runs the command with its stdio untouched: the ACP stream flows through the SSH channel.
 * The command runs with `call`: the Provider CLIs are npm `.cmd` shims, and a batch file that
 * chains into another one without `call` ends first, taking its `setlocal` environment (the
 * login, the PATH) with it.
 */
export function guestAgentLauncherCmd(workspace: string): string {
  return [
    "@echo off",
    "setlocal",
    `set "PATH=${GUEST_TOOL_DIRS.join(";")};%PATH%"`,
    'set "SBX_AGENT_ENV=%USERPROFILE%\\.sessionboxer\\agent-env.cmd"',
    'if exist "%SBX_AGENT_ENV%" (',
    '  call "%SBX_AGENT_ENV%"',
    '  del /q "%SBX_AGENT_ENV%"',
    ")",
    `if not exist "${workspace}" mkdir "${workspace}"`,
    `cd /d "${workspace}"`,
    "call %*",
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

/**
 * `sh sessionboxer-agent.sh <command> [args]`, the macOS launcher: puts the tools of the base
 * install on `PATH` (an SSH command runs in a non-interactive shell that reads no `.zprofile`),
 * sources the environment file the Daemon wrote and deletes it (so the Provider login does not
 * stay on the VM disk), records its process group for `killAgents`, `cd`s to the Workspace and
 * `exec`s the command with its stdio untouched: the ACP stream flows through the SSH channel.
 * A POSIX `sh` script (macOS ships bash 3.2 and zsh; the Linux stand-in dash), nothing more.
 */
export function guestAgentLauncherSh(workspace: string, toolPath: string): string {
  return [
    "#!/bin/sh",
    `PATH="${toolPath}\${PATH:+:$PATH}"; export PATH`,
    'SBX_DIR="$HOME/.sessionboxer"',
    'if [ -f "$SBX_DIR/agent-env.sh" ]; then',
    '  . "$SBX_DIR/agent-env.sh"',
    '  rm -f "$SBX_DIR/agent-env.sh"',
    "fi",
    `ps -o pgid= -p $$ 2>/dev/null | tr -dc '0-9' > "$SBX_DIR/agent.pgid"`,
    `mkdir -p '${workspace.replace(/'/g, `'\\''`)}'`,
    `cd '${workspace.replace(/'/g, `'\\''`)}' || exit 1`,
    'exec "$@"',
    "",
  ].join("\n");
}

/**
 * `node sessionboxer-bridge.js <service> [args]`: connects to the Sandbox's bridge (address and
 * token in `bridge.json`), announces the service and pipes its own stdio to the connection. The
 * Agent starts it as the `desktop` MCP server; git runs it as a credential helper (`credential
 * <account> get`), where git appends the operation.
 */
export const GUEST_BRIDGE_JS = `"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");

const [service, ...args] = process.argv.slice(2);
if (!service) {
  process.stderr.write("usage: sessionboxer-bridge.js <service> [args]\\n");
  process.exit(2);
}

const home = process.env.USERPROFILE || process.env.HOME || "";
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(home, ".sessionboxer", "bridge.json"), "utf8"));
} catch (e) {
  process.stderr.write("sessionboxer-bridge: no bridge.json (" + e.message + "); is this a Sessionboxer VM Session?\\n");
  process.exit(1);
}

const socket = net.connect({ host: config.host, port: config.port });
socket.setNoDelay(true);
socket.on("connect", () => {
  socket.write([service, config.token, ...args].join(" ") + "\\n");
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("error", (e) => {
  process.stderr.write("sessionboxer-bridge: " + e.message + "\\n");
  process.exit(1);
});
socket.on("close", () => {
  process.stdout.write("", () => process.exit(0));
});
process.stdin.on("end", () => socket.end());
process.stdin.on("error", () => socket.end());
process.stdout.on("error", () => socket.destroy());
`;
