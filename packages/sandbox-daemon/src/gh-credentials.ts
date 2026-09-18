import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoxCredential } from "@sessionboxer/protocol";

/**
 * GitHub logins for the Sandbox itself: `gh` reads `$GH_CONFIG_DIR/hosts.yml` on every
 * invocation and git is configured (image) to ask `gh auth git-credential`, so writing
 * this file is all it takes for `gh pr create` and `git push` to work as the account, with
 * no process restart. The dir is on tmpfs: Snapshots and stopped containers keep nothing.
 * Several accounts can be listed; the first is the active one (`gh auth switch` changes it).
 * Logins added inside the box (`gh auth login` in the Terminal) are kept when the Connector
 * set changes; only accounts this class wrote are replaced.
 */
export class GhCredentials {
  private last: string | null = null;
  private managed = new Set<string>();

  constructor(
    private readonly configDir: string,
    private readonly log: (msg: string) => void,
  ) {}

  apply(credentials: BoxCredential[]): void {
    const github = credentials.filter((c) => c.kind === "github");
    const key = JSON.stringify(github.map((c) => [c.account, c.token]));
    if (key === this.last) return;
    this.last = key;
    const hostsFile = join(this.configDir, "hosts.yml");
    const existing = readHosts(hostsFile);
    const manual = existing.users.filter((u) => !this.managed.has(u.account) && !github.some((c) => c.account === u.account));
    this.managed = new Set(github.map((c) => c.account));
    const users = [...github.map((c) => ({ account: c.account, token: c.token })), ...manual];
    if (users.length === 0) {
      rmSync(hostsFile, { force: true });
      this.log("github: no login in the Sandbox");
      return;
    }
    const active =
      github[0] ?? users.find((u) => u.account === existing.active) ?? users[0]!;
    const list = users.map((u) => `        ${yamlKey(u.account)}:\n            oauth_token: ${yamlString(u.token)}\n`).join("");
    const yaml =
      `github.com:\n    git_protocol: https\n    user: ${yamlString(active.account)}\n    oauth_token: ${yamlString(active.token)}\n    users:\n${list}`;
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(hostsFile, yaml, { mode: 0o600 });
    const names = users.map((u) => `@${u.account}${manual.includes(u) ? " (box)" : ""}`).join(", ");
    this.log(`github: Sandbox logged in as ${names} (active: @${active.account})`);
  }
}

interface HostsFile {
  active: string | null;
  users: { account: string; token: string }[];
}

/** Reads the `github.com` section of a `hosts.yml` written by `gh` or by this class. */
function readHosts(file: string): HostsFile {
  const out: HostsFile = { active: null, users: [] };
  if (!existsSync(file)) return out;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  let inHost = false;
  let inUsers = false;
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      inHost = body === "github.com:";
      inUsers = false;
      continue;
    }
    if (!inHost) continue;
    if (indent === 4) {
      inUsers = body === "users:";
      current = null;
      const m = /^user:\s*(.+)$/.exec(body);
      if (m) out.active = unquote(m[1]!);
      continue;
    }
    if (!inUsers) continue;
    if (indent === 8 && body.endsWith(":")) {
      current = unquote(body.slice(0, -1));
      continue;
    }
    if (indent === 12 && current) {
      const m = /^oauth_token:\s*(.+)$/.exec(body);
      if (m) out.users.push({ account: current, token: unquote(m[1]!) });
    }
  }
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"')) {
    try {
      return String(JSON.parse(t));
    } catch {
      return t;
    }
  }
  return t.replace(/^'(.*)'$/, "$1");
}

function yamlKey(s: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(s) ? s : yamlString(s);
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}
