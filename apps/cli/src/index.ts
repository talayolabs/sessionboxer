#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { PROVIDERS, Provider, type CreateSessionRequest, type Session, type WorkspaceSource } from "@sessionboxer/protocol";

const BASE_URL = (process.env.SESSIONBOXER_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

const USAGE = `sessionboxer - one Docker Sandbox with a Desktop per agent Session

Usage:
  sessionboxer serve                       Run the Control Plane (http://127.0.0.1:4000)
  sessionboxer new [dir] [options]         Create a Session from a copy of <dir> (default: .)
  sessionboxer new --git <url> [--ref r]   Create a Session from a git clone
  sessionboxer new --empty                 Create a Session with an empty Workspace
  sessionboxer ls                          List Sessions
  sessionboxer open <id>                   Open a Session in the browser
  sessionboxer stop|resume|rm <id>         Manage a Session

Options for new:
  -t, --title <title>    Session title (defaults to the first prompt / directory name)
  -p, --prompt <text>    First prompt, sent once the Sandbox is ready
      --provider <id>    Provider: ${PROVIDERS.join(" | ")} (default claude-code)
      --no-open          Do not open the browser

Environment:
  SESSIONBOXER_URL       Control Plane URL (default http://127.0.0.1:4000)
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

  const body: CreateSessionRequest = {
    provider: provider.data,
    workspaceSource,
    ...(values.title ? { title: values.title } : {}),
    ...(values.prompt ? { prompt: values.prompt } : {}),
  };
  const session = await api<Session>("POST", "/sessions", body);
  show(session);
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
  const url = sessionUrl(id);
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
        : "empty";
  process.stdout.write(`${s.id}  ${s.status.padEnd(8)}  ${s.title}\n    ${source}\n    ${sessionUrl(s.id)}\n`);
}

function sessionUrl(id: string): string {
  return `${BASE_URL}/#/sessions/${id}`;
}

function requireId(args: string[]): string {
  const id = args[0];
  if (!id) throw new CliError("expected a session id");
  return id;
}

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api${route}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CliError(`cannot reach the Control Plane at ${BASE_URL}; start it with \`sessionboxer serve\``);
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
