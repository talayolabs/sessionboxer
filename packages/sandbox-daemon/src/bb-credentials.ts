import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoxCredential } from "@sessionboxer/protocol";
import { unquote, yamlKey, yamlString } from "./yaml-lite.js";

/**
 * Bitbucket logins (Data Center hosts, bitbucket.org) for the Sandbox itself, the twin of `GhCredentials`: `bb`
 * (github.com/talayolabs/bb) reads `$BB_CONFIG_DIR/hosts.yml` on every invocation and git is
 * configured (image) to ask `bb auth git-credential`, so writing this file is all it takes for
 * `bb pr create` and `git push` to a Bitbucket host to work as the account, with no process
 * restart. The dir is on tmpfs: Snapshots and stopped containers keep nothing. One section per
 * host; several accounts of one host are listed with the first as the active one (`bb auth
 * switch` changes it). A Cloud API token goes with its Atlassian `email` and the static git user
 * `x-bitbucket-api-token-auth`. Hosts logged in inside the box (`bb auth login` in the Terminal) are kept
 * when the Connector set changes; only hosts this class wrote are replaced.
 */
export class BbCredentials {
  private last: string | null = null;
  private managed = new Set<string>();

  constructor(
    private readonly configDir: string,
    private readonly log: (msg: string) => void,
  ) {}

  apply(credentials: BoxCredential[]): void {
    const bitbucket = credentials.filter((c) => c.kind === "bitbucket");
    const key = JSON.stringify(bitbucket.map((c) => [c.host, c.account, c.token, c.email]));
    if (key === this.last) return;
    this.last = key;
    const hostsFile = join(this.configDir, "hosts.yml");
    const byHost = new Map<string, BoxCredential[]>();
    for (const c of bitbucket) byHost.set(c.host, [...(byHost.get(c.host) ?? []), c]);
    const manual = readHostBlocks(hostsFile).filter(({ host }) => !this.managed.has(host) && !byHost.has(host));
    this.managed = new Set(byHost.keys());
    if (byHost.size === 0 && manual.length === 0) {
      rmSync(hostsFile, { force: true });
      this.log("bitbucket: no login in the Sandbox");
      return;
    }
    let yaml = "";
    for (const [host, users] of byHost) {
      const active = users[0]!;
      yaml += `${yamlKey(host)}:\n    user: ${yamlString(active.account)}\n${userFields(active, "    ")}    users:\n`;
      for (const u of users) yaml += `        ${yamlKey(u.account)}:\n${userFields(u, "            ")}`;
    }
    for (const block of manual) yaml += block.text;
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(hostsFile, yaml, { mode: 0o600 });
    const names = [...byHost].map(([host, users]) => `${users.map((u) => `@${u.account}`).join(", ")} on ${host}`);
    for (const m of manual) names.push(`${m.host} (box)`);
    this.log(`bitbucket: Sandbox logged in as ${names.join("; ")}`);
  }
}

/** `git_user`, `oauth_token` and (Cloud API token) `email` lines of one login. */
function userFields(c: BoxCredential, indent: string): string {
  const gitUser = c.email ? CLOUD_API_TOKEN_GIT_USER : c.account;
  let out = `${indent}git_user: ${yamlString(gitUser)}\n${indent}oauth_token: ${yamlString(c.token)}\n`;
  if (c.email) out += `${indent}email: ${yamlString(c.email)}\n`;
  return out;
}

const CLOUD_API_TOKEN_GIT_USER = "x-bitbucket-api-token-auth";

interface HostBlock {
  host: string;
  /** The section's lines, verbatim, ending with a newline. */
  text: string;
}

/** Splits a `hosts.yml` into its top-level host sections without interpreting them. */
function readHostBlocks(file: string): HostBlock[] {
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: HostBlock[] = [];
  let current: HostBlock | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      if (current) out.push(current);
      const body = line.trim();
      current = body.endsWith(":") ? { host: unquote(body.slice(0, -1)).toLowerCase(), text: `${line}\n` } : null;
      continue;
    }
    if (current) current.text += `${line}\n`;
  }
  if (current) out.push(current);
  return out;
}
