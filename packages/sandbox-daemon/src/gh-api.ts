import { spawn } from "node:child_process";
import type { DaemonGhApiParams, DaemonGhApiResult, DaemonGhLoginsResult } from "@sessionboxer/protocol";

const MAX_BODY = 8 * 1024 * 1024;

/**
 * GitHub API requests made with the Sandbox's own `gh` (whatever it is logged in as: Connector
 * entries, a `gh auth login` done in the Terminal, `GH_TOKEN`). `gh api --include` prints the
 * status line, the headers and the body whatever the status, so `304`/`4xx` come back as data
 * rather than as errors; the Control Plane interprets them. Tokens never leave the process.
 */
export class GhApi {
  constructor(private readonly log: (msg: string) => void) {}

  async request(p: DaemonGhApiParams): Promise<DaemonGhApiResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
    if (p.account) {
      const token = await run("gh", ["auth", "token", "--hostname", "github.com", "--user", p.account], env, null);
      if (token.code !== 0 || !token.stdout.trim()) throw new Error(`gh: no token for @${p.account}`);
      env.GH_TOKEN = token.stdout.trim();
    }
    const args = ["api", "--include", "--method", p.method];
    for (const [name, value] of Object.entries(p.headers)) args.push("-H", `${name}: ${value}`);
    if (p.body !== null) args.push("--input", "-");
    args.push(p.path);
    const out = await run("gh", args, env, p.body);
    const parsed = parseResponse(out.stdout);
    if (!parsed) {
      const detail = out.stderr.trim().split("\n")[0] ?? "";
      throw new Error(`gh api ${p.method} ${p.path}: no response (${detail || `exit ${out.code}`})`);
    }
    return parsed;
  }

  /** Accounts the box can act as, from `gh auth status` (the token lines are never logged). */
  async logins(): Promise<DaemonGhLoginsResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
    const out = await run("gh", ["auth", "status", "--hostname", "github.com"], env, null);
    const logins: string[] = [];
    let active: string | null = null;
    let current: string | null = null;
    for (const line of `${out.stdout}\n${out.stderr}`.split("\n")) {
      const m = /Logged in to github\.com account (\S+)/.exec(line);
      if (m) {
        current = m[1]!;
        if (!logins.includes(current)) logins.push(current);
        continue;
      }
      if (/Active account: true/.test(line) && current) active = current;
    }
    if (logins.length === 0 && out.code !== 0) this.log("gh: no github.com login in the Sandbox");
    return { active: active ?? logins[0] ?? null, logins };
  }
}

function parseResponse(text: string): DaemonGhApiResult | null {
  const statusLine = /^HTTP\/[\d.]+ (\d{3})/.exec(text);
  if (!statusLine) return null;
  const headers: Record<string, string> = {};
  let i = text.indexOf("\n") + 1;
  for (;;) {
    const end = text.indexOf("\n", i);
    const line = (end === -1 ? text.slice(i) : text.slice(i, end)).replace(/\r$/, "");
    i = end === -1 ? text.length : end + 1;
    if (line === "") break;
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    if (end === -1) break;
  }
  return { status: Number(statusLine[1]), headers, body: text.slice(i) };
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string | null,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Outside every repository: the account is chosen here, not by a directory's binding.
    const child = spawn(cmd, args, { env, cwd: "/", stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size <= MAX_BODY) stdout.push(d);
    });
    child.stderr.on("data", (d: Buffer) => stderr.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }),
    );
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
