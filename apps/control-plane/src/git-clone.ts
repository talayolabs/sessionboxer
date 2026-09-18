import type { BoxCredential } from "@sessionboxer/protocol";

/** `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo`. */
const GITHUB_SSH = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/;
const GITHUB_HTTPS = /^https:\/\/(?:[^@/]+@)?github\.com\//i;

export interface ClonePlan {
  url: string;
  env: Record<string, string>;
  /** Set when the clone runs with a GitHub login from an enabled connector entry. */
  account: string | null;
}

/**
 * How to clone `url` inside a fresh Sandbox. The box has no SSH keys, but while a GitHub
 * entry is enabled for the Session it has that account's token (`gh auth git-credential` is
 * git's credential helper for github.com in the image), so GitHub SSH URLs are cloned over
 * HTTPS as that account and HTTPS ones get the same login for private repositories.
 */
export function planClone(url: string, credentials: BoxCredential[]): ClonePlan {
  const github = credentials.find((c) => c.kind === "github") ?? null;
  const ssh = GITHUB_SSH.exec(url.trim());
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (github === null) {
    if (ssh) {
      throw new Error(
        `${url} is an SSH URL and the Sandbox has no SSH keys. Enable a GitHub entry for this Session ` +
          "(Settings → MCP servers → Add GitHub) to clone it as that account, or use the HTTPS URL of a public repository.",
      );
    }
    return { url, env, account: null };
  }
  env.GH_TOKEN = github.token;
  return { url: ssh ? `https://github.com/${ssh[1]}.git` : url, env, account: github.account };
}

/** Adds the likely cause to git's own error when a GitHub HTTPS clone failed without a login. */
export function cloneFailureHint(url: string, plan: ClonePlan): string {
  if (plan.account === null && GITHUB_HTTPS.test(url)) {
    return " If the repository is private, enable a GitHub entry for this Session (Settings → MCP servers → Add GitHub) so the Sandbox clones it as your account.";
  }
  return "";
}
