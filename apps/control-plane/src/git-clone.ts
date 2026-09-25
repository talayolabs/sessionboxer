import type { BoxCredential } from "@sessionboxer/protocol";
import { bitbucketHttpsCloneUrl, parseBitbucketRemote } from "./bitbucket.js";

/** `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo`. */
const GITHUB_SSH = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/;
const GITHUB_HTTPS = /^https:\/\/(?:[^@/]+@)?github\.com\//i;
/** Any SSH URL the box cannot use (no keys): scp-style or `ssh://`. */
const ANY_SSH = /^(?:ssh:\/\/|[^@/\s]+@[^:/\s]+:)/i;

export interface ClonePlan {
  url: string;
  env: Record<string, string>;
  /** Set when the clone runs with a login from an enabled connector entry. */
  account: string | null;
}

/**
 * How to clone `url` inside a fresh Sandbox. The box has no SSH keys, but while a GitHub
 * entry is enabled for the Session it has that account's token (`gh auth git-credential` is
 * git's credential helper for github.com in the image), so GitHub SSH URLs are cloned over
 * HTTPS as that account and HTTPS ones get the same login for private repositories. A
 * Bitbucket entry does the same for its Data Center host through `bb auth git-credential`:
 * `ssh://git@host:7999/KEY/slug.git` becomes `https://host/scm/KEY/slug.git`.
 */
export function planClone(url: string, credentials: BoxCredential[], account: string | null = null): ClonePlan {
  const trimmed = url.trim();
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  const github = credentials.find((c) => c.kind === "github" && (account === null || c.account === account)) ?? null;
  if (account !== null && github === null && isGitHubUrl(trimmed)) {
    throw new Error(`@${account} is bound to this repository but no enabled GitHub entry of this Session is logged in as it.`);
  }
  const ssh = GITHUB_SSH.exec(trimmed);
  if (ssh || GITHUB_HTTPS.test(trimmed)) {
    if (github === null) {
      if (ssh) {
        throw new Error(
          `${url} is an SSH URL and the Sandbox has no SSH keys. Enable a GitHub entry for this Session ` +
            "(Settings → Git accounts → Connect GitHub) to clone it as that account, or use the HTTPS URL of a public repository.",
        );
      }
      return { url, env, account: null };
    }
    env.GH_TOKEN = github.token;
    return { url: ssh ? `https://github.com/${ssh[1]}.git` : url, env, account: github.account };
  }
  const bitbucket = parseBitbucketRemote(trimmed);
  const login = bitbucket ? (credentials.find((c) => c.kind === "bitbucket" && c.host === bitbucket.host) ?? null) : null;
  // SSH and browser (`/projects/KEY/repos/slug/browse`) URLs become the HTTPS clone URL; `/scm/` ones stay as typed.
  const httpsUrl = bitbucket && !/^https?:\/\/[^/]+(?:\/[^\s]*?)?\/scm\//i.test(trimmed) ? bitbucketHttpsCloneUrl(bitbucket) : url;
  if (bitbucket && login) {
    env.BB_HOST = login.host;
    env.BB_TOKEN = login.token;
    env.BB_GIT_USER = login.account;
    return { url: httpsUrl, env, account: login.account };
  }
  if (ANY_SSH.test(trimmed)) {
    throw new Error(
      `${url} is an SSH URL and the Sandbox has no SSH keys. ` +
        (bitbucket
          ? `If ${bitbucket.host} is a Bitbucket (Data Center), enable an entry for it for this Session (Settings → Git accounts → Connect Bitbucket) to clone as that account; otherwise use the HTTPS URL.`
          : "Use an HTTPS URL instead."),
    );
  }
  return { url: httpsUrl, env, account: null };
}

export function isGitHubUrl(url: string): boolean {
  const trimmed = url.trim();
  return GITHUB_SSH.test(trimmed) || GITHUB_HTTPS.test(trimmed);
}

/** Adds the likely cause to git's own error when an HTTPS clone of a known host failed without a login. */
export function cloneFailureHint(url: string, plan: ClonePlan): string {
  if (plan.account !== null) return "";
  if (GITHUB_HTTPS.test(url)) {
    return " If the repository is private, enable a GitHub entry for this Session (Settings → Git accounts → Connect GitHub) so the Sandbox clones it as your account.";
  }
  const bitbucket = parseBitbucketRemote(url);
  if (bitbucket) {
    return ` If the repository is private, enable a Bitbucket entry for ${bitbucket.host} for this Session (Settings → Git accounts → Connect Bitbucket) so the Sandbox clones it as your account.`;
  }
  return "";
}
