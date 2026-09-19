#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  DOCKER_MODE_LABELS,
  PAIR_FRAGMENT_KEY,
  PROVIDERS,
  Provider,
  type AuthPairing,
  type CreateSessionRequest,
  type Session,
  type WorkspaceSource,
} from "@sessionboxer/protocol";

const BASE_URL = (process.env.SESSIONBOXER_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const CONFIG_FILE = path.join(process.env.SESSIONBOXER_HOME ?? path.join(homedir(), ".sessionboxer"), "config.json");

/** `SESSIONBOXER_TOKEN`, else the token of the Control Plane on this machine (its config.json / `SESSIONBOXER_ACCESS_TOKEN`). */
function accessToken(): string {
  const env = process.env.SESSIONBOXER_TOKEN?.trim() || process.env.SESSIONBOXER_ACCESS_TOKEN?.trim();
  if (env) return env;
  if (!existsSync(CONFIG_FILE)) return "";
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as { accessToken?: unknown };
    return typeof parsed.accessToken === "string" ? parsed.accessToken : "";
  } catch {
    return "";
  }
}

const USAGE = `sessionboxer - one Docker Sandbox with a Desktop per agent Session

Usage:
  sessionboxer serve                       Run the Control Plane (http://127.0.0.1:4000)
  sessionboxer new [dir] [options]         Create a Session from a copy of <dir> (default: .)
  sessionboxer new --git <url> [--ref r]   Create a Session from a git clone
  sessionboxer new --empty                 Create a Session with an empty Workspace
  sessionboxer ls                          List Sessions
  sessionboxer open <id>                   Open a Session in the browser (logs it in when needed)
  sessionboxer stop|resume|rm <id>         Manage a Session
  sessionboxer token                       Print the access token of the Control Plane on this machine
  sessionboxer pair                        Print a one-time login link for another browser or phone

Options for new:
  -t, --title <title>    Session title (defaults to the first prompt / directory name)
  -p, --prompt <text>    First prompt, sent once the Sandbox is ready
      --provider <id>    Provider: ${PROVIDERS.join(" | ")} (default claude-code)
      --model <id>       Model to run, as the Provider names it (e.g. sonnet, fable);
                         see the New Session page for the list. Default: the Provider's default
      --option <id=val>  Other Agent option (repeatable), e.g. --option effort=high --option fast=on
      --instructions <text|@file>
                         Standing instructions for the Agent (system prompt for Claude, first-prompt
                         prefix for Devin); "" for none. Default: the Settings text
      --git-name <name>, --git-email <email>
                         Git author/committer for commits made in the Sandbox. Default: the
                         Settings identity, else this machine's git config
      --docker           Private Docker daemon inside the Sandbox (Sysbox, or --privileged
                         with a warning when Sysbox is not installed); --no-docker to disable.
                         Default: the "Docker inside Sandboxes" setting
      --no-open          Do not open the browser

Environment:
  SESSIONBOXER_URL       Control Plane URL (default http://127.0.0.1:4000)
  SESSIONBOXER_TOKEN     Access token, for a Control Plane on another machine (default: the one
                         in ~/.sessionboxer/config.json, i.e. the Control Plane run here)
`;

class CliError extends Error {}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    case "serve":
      return serve(rest);
    case "new":
      return newSession(rest);
    case "ls":
    case "list":
      return list();
    case "open":
      return open(requireId(rest));
    case "stop":
      return show(await api<Session>("POST", `/sessions/${requireId(rest)}/stop`));
    case "resume":
      return show(await api<Session>("POST", `/sessions/${requireId(rest)}/resume`));
    case "rm":
    case "delete":
      await api<void>("DELETE", `/sessions/${requireId(rest)}`);
      return;
    case "token": {
      const token = accessToken();
      if (token === "") throw new CliError(`no access token found in ${CONFIG_FILE}; run \`sessionboxer serve\` once`);
      process.stdout.write(`${token}\n`);
      return;
    }
    case "pair": {
      const pairing = await api<AuthPairing>("POST", "/auth/pair");
      process.stdout.write(`${pairUrl(pairing, null)}\n(one use, valid until ${new Date(pairing.expiresAt).toLocaleTimeString()})\n`);
      return;
    }
    default:
      throw new CliError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

function serve(args: string[]): Promise<void> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@sessionboxer/control-plane/dist/index.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

async function newSession(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    allowNegative: true,
    options: {
      git: { type: "string" },
      ref: { type: "string" },
      empty: { type: "boolean", default: false },
      title: { type: "string", short: "t" },
      prompt: { type: "string", short: "p" },
      provider: { type: "string", default: "claude-code" },
      model: { type: "string" },
      option: { type: "string", multiple: true },
      instructions: { type: "string" },
      "git-name": { type: "string" },
      "git-email": { type: "string" },
      docker: { type: "boolean" },
      open: { type: "boolean", default: true },
    },
  });
  if (positionals.length > 1) throw new CliError("new: expected at most one directory");
  if ((values.git ? 1 : 0) + (values.empty ? 1 : 0) + (positionals.length > 0 ? 1 : 0) > 1) {
    throw new CliError("new: pass a directory, --git <url> or --empty (not several)");
  }

  const workspaceSource: WorkspaceSource = values.git
    ? { type: "git", url: values.git, ...(values.ref ? { ref: values.ref } : {}) }
    : values.empty
      ? { type: "empty" }
      : { type: "copy", path: path.resolve(positionals[0] ?? ".") };

  const provider = Provider.safeParse(values.provider);
  if (!provider.success) throw new CliError(`new: --provider must be one of ${PROVIDERS.join(", ")}`);

  const options: Record<string, string> = {};
  for (const raw of values.option ?? []) {
    const eq = raw.indexOf("=");
    if (eq <= 0 || eq === raw.length - 1) throw new CliError(`new: --option expects id=value, got "${raw}"`);
    options[raw.slice(0, eq)] = raw.slice(eq + 1);
  }

  const instructions =
    values.instructions === undefined
      ? undefined
      : values.instructions.startsWith("@")
        ? readFileSync(values.instructions.slice(1), "utf8")
        : values.instructions;

  const body: CreateSessionRequest = {
    provider: provider.data,
    workspaceSource,
    ...(values.docker !== undefined ? { docker: values.docker } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(values["git-name"] !== undefined || values["git-email"] !== undefined
      ? {
          gitIdentity: {
            ...(values["git-name"] !== undefined ? { name: values["git-name"] } : {}),
            ...(values["git-email"] !== undefined ? { email: values["git-email"] } : {}),
          },
        }
      : {}),
    ...(values.title ? { title: values.title } : {}),
    ...(values.prompt ? { prompt: values.prompt } : {}),
  };
  const session = await api<Session>("POST", "/sessions", body);
  show(session);
  if (session.dockerMode === "privileged") {
    process.stderr.write(
      "warning: Sysbox runtime not installed; this Sandbox runs with --privileged (the Agent can escape to the host).\n",
    );
  }
  if (values.open) await open(session.id);
}

async function list(): Promise<void> {
  const sessions = await api<Session[]>("GET", "/sessions");
  if (sessions.length === 0) {
    process.stdout.write("no sessions\n");
    return;
  }
  for (const s of sessions) show(s);
}

async function open(id: string): Promise<void> {
  // A pairing code in the URL logs the browser in if it is not yet; a logged-in one ignores it.
  const url = pairUrl(await api<AuthPairing>("POST", "/auth/pair"), `/sessions/${id}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  await new Promise<void>((resolve) => {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => {
      process.stderr.write(`could not launch a browser; open ${url}\n`);
      resolve();
    });
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function show(s: Session): void {
  const source =
    s.workspaceSource.type === "git"
      ? `${s.workspaceSource.url}${s.workspaceSource.ref ? `@${s.workspaceSource.ref}` : ""}`
      : s.workspaceSource.type === "copy"
        ? s.workspaceSource.path
        : s.workspaceSource.type === "fork"
          ? `fork of ${s.workspaceSource.label}`
          : "empty";
  const docker = s.dockerMode === "none" ? "" : `  [${DOCKER_MODE_LABELS[s.dockerMode]}]`;
  process.stdout.write(`${s.id}  ${s.status.padEnd(8)}  ${s.title}${docker}\n    ${source}\n    ${sessionUrl(s.id)}\n`);
}

function sessionUrl(id: string): string {
  return `${BASE_URL}/#/sessions/${id}`;
}

function pairUrl(pairing: AuthPairing, next: string | null): string {
  return `${BASE_URL}/#${PAIR_FRAGMENT_KEY}=${pairing.code}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
}

function requireId(args: string[]): string {
  const id = args[0];
  if (!id) throw new CliError("expected a session id");
  return id;
}

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    const token = accessToken();
    res = await fetch(`${BASE_URL}/api${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CliError(`cannot reach the Control Plane at ${BASE_URL}; start it with \`sessionboxer serve\``);
  }
  if (res.status === 401) {
    throw new CliError(
      accessToken() === ""
        ? `the Control Plane at ${BASE_URL} needs an access token; set SESSIONBOXER_TOKEN (run \`sessionboxer token\` on the machine that runs it)`
        : `the Control Plane at ${BASE_URL} refused the access token; check SESSIONBOXER_TOKEN`,
    );
  }
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // not JSON
    }
    throw new CliError(`${method} ${route} failed (${res.status}): ${message}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`sessionboxer: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
