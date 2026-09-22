import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAIR_FRAGMENT_KEY, type AuthPairing } from "@sessionboxer/protocol";

/**
 * `sessionboxer service …`: the Control Plane as a background service of the logged-in user —
 * a launchd agent on macOS, a systemd user unit on Linux — started at login and restarted if
 * it dies, so nobody has to keep a terminal open on `sessionboxer serve`. The unit runs the
 * same `apps/control-plane/dist/index.js` with the same Node as the CLI, with `~/.sessionboxer`
 * and the `SESSIONBOXER_*` / `DOCKER_HOST` variables of the shell that ran `install` baked in.
 */

export class ServiceError extends Error {}

const LABEL = "com.talayolabs.sessionboxer";
const UNIT = "sessionboxer";
const HOME = process.env.SESSIONBOXER_HOME ?? path.join(homedir(), ".sessionboxer");
const LOG_FILE = path.join(HOME, "logs", "control-plane.log");
const HOST = process.env.SESSIONBOXER_HOST ?? "127.0.0.1";
const PORT = process.env.SESSIONBOXER_PORT ?? "4000";
const SERVER_URL = `http://${HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST}:${PORT}`;

const USAGE = `Usage:
  sessionboxer service install     Run the Control Plane in the background, now and at every login
  sessionboxer service uninstall   Stop it and remove the service
  sessionboxer service start|stop|restart
  sessionboxer service status
  sessionboxer service log         Follow the server log

macOS: a launchd agent (~/Library/LaunchAgents/${LABEL}.plist), log in ${LOG_FILE}.
Linux: a systemd user unit (~/.config/systemd/user/${UNIT}.service), log in the journal.
Windows: not yet; the desktop app's "Start at login" does the same there.
The SESSIONBOXER_* and DOCKER_HOST variables of the shell that runs \`install\` are baked in.
`;

export async function service(args: string[]): Promise<void> {
  const [command] = args;
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  const backend = pickBackend();
  switch (command) {
    case "install": {
      if (!backend.installed() && (await healthy())) {
        throw new ServiceError(`something already answers at ${SERVER_URL} (a \`sessionboxer serve\` in a terminal, Compose, the desktop app?); stop it first`);
      }
      backend.install();
      await started(backend);
      return;
    }
    case "uninstall":
      backend.uninstall();
      process.stdout.write("service removed\n");
      return;
    case "start":
      requireInstalled(backend);
      backend.start();
      await started(backend);
      return;
    case "stop":
      requireInstalled(backend);
      backend.stop();
      process.stdout.write(`stopped; \`sessionboxer service start\` starts it again${backend.stopsUntilLogin ? " (so does the next login)" : ""}\n`);
      return;
    case "restart":
      requireInstalled(backend);
      backend.restart();
      await started(backend);
      return;
    case "status": {
      if (!backend.installed()) {
        process.stdout.write(`not installed (\`sessionboxer service install\`)${(await healthy()) ? `; something else answers at ${SERVER_URL}` : ""}\n`);
        process.exitCode = 3;
        return;
      }
      const pid = backend.pid();
      const ok = await healthy();
      process.stdout.write(`${pid === null ? "not running" : `running (pid ${pid})`}${ok ? `, ${SERVER_URL} answers` : pid === null ? "" : `, ${SERVER_URL} not answering yet`}\n${backend.describe()}\n`);
      if (pid === null) process.exitCode = 3;
      return;
    }
    case "log":
      requireInstalled(backend);
      backend.log();
      return;
    default:
      throw new ServiceError(`unknown service command "${command}"\n\n${USAGE}`);
  }
}

interface Backend {
  readonly stopsUntilLogin: boolean;
  installed(): boolean;
  install(): void;
  uninstall(): void;
  start(): void;
  stop(): void;
  restart(): void;
  pid(): number | null;
  describe(): string;
  log(): void;
}

function pickBackend(): Backend {
  if (process.platform === "darwin") return launchd;
  if (process.platform === "linux") return systemd;
  throw new ServiceError(
    `\`sessionboxer service\` is not available on ${process.platform} yet; run \`sessionboxer serve\` in a terminal, or use the desktop app's "Start at login"`,
  );
}

function requireInstalled(backend: Backend): void {
  if (!backend.installed()) throw new ServiceError("the service is not installed; `sessionboxer service install` first");
}

/** The command line the service runs: this Node, the Control Plane entry next to the CLI (checkout and npm package alike). */
function program(): { node: string; entry: string } {
  const entry = fileURLToPath(new URL("../../control-plane/dist/index.js", import.meta.url));
  if (!existsSync(entry)) throw new ServiceError(`Control Plane not found at ${entry}; run \`npm run build\` first`);
  if (/[\\/]_npx[\\/]/.test(entry)) {
    throw new ServiceError("this copy of sessionboxer lives in npx's cache, which npm clears; install it (`npm i -g sessionboxer`) and run `sessionboxer service install` from that");
  }
  return { node: process.execPath, entry };
}

/** Variables the Control Plane reads, as set in this shell; the service gets no shell of its own. PATH so that git, ssh and docker are found under launchd/systemd. */
function environment(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "DOCKER_HOST" || (key.startsWith("SESSIONBOXER_") && key !== "SESSIONBOXER_URL" && key !== "SESSIONBOXER_TOKEN")) env[key] = value;
  }
  return env;
}

function run(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) throw new ServiceError(`cannot run ${cmd}: ${res.error.message}`);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function must(cmd: string, args: string[]): string {
  const res = run(cmd, args);
  if (res.status !== 0) throw new ServiceError(`${cmd} ${args.join(" ")} failed (${res.status}): ${(res.stderr || res.stdout).trim()}`);
  return res.stdout;
}

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Wait for the server to answer, then print where it is and how to log in. */
async function started(backend: Backend): Promise<void> {
  const t0 = Date.now();
  while (!(await healthy())) {
    const elapsed = Date.now() - t0;
    if (elapsed > 3000 && backend.pid() === null) {
      throw new ServiceError(`the Control Plane is not running; see \`sessionboxer service log\`\n${backend.describe()}`);
    }
    if (elapsed > 30_000) throw new ServiceError(`${SERVER_URL} did not answer within 30 s; see \`sessionboxer service log\``);
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stdout.write(`Sessionboxer is running at ${SERVER_URL}\n${backend.describe()}\n`);
  const login = await pairingUrl();
  process.stdout.write(login ? `log in at ${login} (one use)\n` : `open ${SERVER_URL} — or \`sessionboxer pair\` for a login link\n`);
}

async function pairingUrl(): Promise<string | null> {
  let token = process.env.SESSIONBOXER_ACCESS_TOKEN?.trim() ?? "";
  if (token === "") {
    try {
      const parsed = JSON.parse(readFileSync(path.join(HOME, "config.json"), "utf8")) as { accessToken?: unknown };
      if (typeof parsed.accessToken === "string") token = parsed.accessToken;
    } catch {
      return null;
    }
  }
  if (token === "") return null;
  try {
    const res = await fetch(`${SERVER_URL}/api/auth/pair`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const pairing = (await res.json()) as AuthPairing;
    return `${SERVER_URL}/#${PAIR_FRAGMENT_KEY}=${pairing.code}`;
  } catch {
    return null;
  }
}

// --- macOS: launchd agent ---------------------------------------------------------------------

const PLIST = path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function uid(): number {
  const id = process.getuid?.();
  if (id === undefined) throw new ServiceError("cannot tell the current user id");
  return id;
}

const domain = (): string => `gui/${uid()}`;

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plist(): string {
  const { node, entry } = program();
  const env = Object.entries(environment())
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(node)}</string>
      <string>${xml(entry)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xml(LOG_FILE)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(LOG_FILE)}</string>
  </dict>
</plist>
`;
}

/** `launchctl print` of the agent, or null when it is not loaded. */
function launchdPrint(): string | null {
  const res = run("launchctl", ["print", `${domain()}/${LABEL}`]);
  return res.status === 0 ? res.stdout : null;
}

const launchd: Backend = {
  stopsUntilLogin: true,
  installed: () => existsSync(PLIST),
  install() {
    mkdirSync(path.dirname(PLIST), { recursive: true });
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (launchdPrint() !== null) run("launchctl", ["bootout", `${domain()}/${LABEL}`]);
    writeFileSync(PLIST, plist(), { mode: 0o644 });
    run("launchctl", ["enable", `${domain()}/${LABEL}`]);
    must("launchctl", ["bootstrap", domain(), PLIST]);
  },
  uninstall() {
    if (launchdPrint() !== null) run("launchctl", ["bootout", `${domain()}/${LABEL}`]);
    rmSync(PLIST, { force: true });
  },
  start() {
    if (launchdPrint() === null) {
      run("launchctl", ["enable", `${domain()}/${LABEL}`]);
      must("launchctl", ["bootstrap", domain(), PLIST]);
    } else if (this.pid() === null) {
      must("launchctl", ["kickstart", `${domain()}/${LABEL}`]);
    }
  },
  stop() {
    // bootout unloads the agent: KeepAlive would otherwise start it again right away.
    if (launchdPrint() !== null) must("launchctl", ["bootout", `${domain()}/${LABEL}`]);
  },
  restart() {
    if (launchdPrint() === null) this.start();
    else must("launchctl", ["kickstart", "-k", `${domain()}/${LABEL}`]);
  },
  pid() {
    const pid = launchdPrint()?.match(/^\s*pid = (\d+)/m)?.[1];
    return pid ? Number(pid) : null;
  },
  describe: () => `launchd agent ${LABEL} (${PLIST})\nlog: ${LOG_FILE}`,
  log() {
    spawnSync("tail", ["-n", "50", "-F", LOG_FILE], { stdio: "inherit" });
  },
};

// --- Linux: systemd user unit -----------------------------------------------------------------

const UNIT_FILE = path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "systemd", "user", `${UNIT}.service`);

/** systemd's quoting for Environment=: double quotes, backslash-escaped. */
function unitValue(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unit(): string {
  const { node, entry } = program();
  const env = Object.entries(environment())
    .map(([k, v]) => `Environment=${unitValue(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=Sessionboxer Control Plane
Documentation=https://github.com/talayolabs/sessionboxer

[Service]
ExecStart=${unitValue(node)} ${unitValue(entry)}
${env}
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=default.target
`;
}

function systemctl(args: string[]): string {
  const res = run("systemctl", ["--user", ...args]);
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    throw new ServiceError(
      /Failed to connect to bus|not been booted with systemd|Failed to connect to user scope bus/.test(detail)
        ? `no systemd user manager for this login (${detail}); \`sessionboxer service\` needs one — run \`sessionboxer serve\` instead`
        : `systemctl --user ${args.join(" ")} failed (${res.status}): ${detail}`,
    );
  }
  return res.stdout;
}

const systemd: Backend = {
  stopsUntilLogin: false,
  installed: () => existsSync(UNIT_FILE),
  install() {
    mkdirSync(path.dirname(UNIT_FILE), { recursive: true });
    writeFileSync(UNIT_FILE, unit(), { mode: 0o644 });
    systemctl(["daemon-reload"]);
    systemctl(["enable", UNIT]);
    systemctl(["restart", UNIT]);
    const linger = run("loginctl", ["show-user", String(uid()), "--property=Linger", "--value"]);
    if (linger.status === 0 && linger.stdout.trim() === "no") {
      process.stdout.write("note: it runs while you are logged in; `loginctl enable-linger` keeps it up after logout (a headless machine).\n");
    }
  },
  uninstall() {
    if (existsSync(UNIT_FILE)) {
      run("systemctl", ["--user", "disable", "--now", UNIT]);
      rmSync(UNIT_FILE, { force: true });
      systemctl(["daemon-reload"]);
    }
  },
  start: () => void systemctl(["start", UNIT]),
  stop: () => void systemctl(["stop", UNIT]),
  restart: () => void systemctl(["restart", UNIT]),
  pid() {
    const res = run("systemctl", ["--user", "show", UNIT, "--property=MainPID", "--value"]);
    const pid = Number(res.stdout.trim());
    return res.status === 0 && pid > 0 ? pid : null;
  },
  describe: () => `systemd user unit ${UNIT} (${UNIT_FILE})\nlog: journalctl --user -u ${UNIT} -f`,
  log() {
    spawnSync("journalctl", ["--user", "-u", UNIT, "-n", "50", "-f"], { stdio: "inherit" });
  },
};
