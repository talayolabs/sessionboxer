import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoxCredential } from "@sessionboxer/protocol";

/**
 * GitHub logins for the Sandbox itself: `gh` reads `$GH_CONFIG_DIR/hosts.yml` on every
 * invocation and git is configured (image) to ask `gh auth git-credential`, so writing
 * this file is all it takes for `gh pr create` and `git push` to work as the account, with
 * no process restart. The dir is on tmpfs: Snapshots and stopped containers keep nothing.
 * Several accounts can be listed; the first is the active one (`gh auth switch` changes it).
 */
export class GhCredentials {
  private last: string | null = null;

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
    if (github.length === 0) {
      rmSync(hostsFile, { force: true });
      this.log("github: no login in the Sandbox");
      return;
    }
    const active = github[0]!;
    const users = github.map((c) => `        ${yamlKey(c.account)}:\n            oauth_token: ${yamlString(c.token)}\n`).join("");
    const yaml =
      `github.com:\n    git_protocol: https\n    user: ${yamlString(active.account)}\n    oauth_token: ${yamlString(active.token)}\n    users:\n${users}`;
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    writeFileSync(hostsFile, yaml, { mode: 0o600 });
    this.log(`github: Sandbox logged in as ${github.map((c) => `@${c.account}`).join(", ")} (active: @${active.account})`);
  }
}

function yamlKey(s: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(s) ? s : yamlString(s);
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}
