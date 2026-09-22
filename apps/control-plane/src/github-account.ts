import type { BoxCredential } from "@sessionboxer/protocol";
import { parseGitHubRepo } from "./pull-requests.js";

const PROBE_TIMEOUT_MS = 8_000;

type Probe = { account: string; sees: boolean; pushes: boolean };

async function probe(cred: BoxCredential, owner: string, repo: string, fetchImpl: typeof fetch): Promise<Probe> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${cred.token}`,
        "user-agent": "sessionboxer",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { account: cred.account, sees: false, pushes: false };
    const body: unknown = await res.json();
    const permissions = typeof body === "object" && body !== null && "permissions" in body ? body.permissions : null;
    const pushes = typeof permissions === "object" && permissions !== null && "push" in permissions && permissions.push === true;
    return { account: cred.account, sees: true, pushes };
  } catch {
    return { account: cred.account, sees: false, pushes: false };
  }
}

/**
 * Which of the Session's GitHub logins a github.com repository should be bound to when none was
 * chosen: with one login there is nothing to decide; with several, each is asked whether it can
 * see the repository, and the first (in Settings order) that can push wins, else the first that
 * can see it, else the first login — today's behaviour, so a public repository or an API hiccup
 * never blocks the clone. `null` for non-GitHub URLs and Sessions without a GitHub login.
 */
export async function pickGitHubAccount(url: string, credentials: BoxCredential[], fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const github = credentials.filter((c) => c.kind === "github");
  if (github.length === 0) return null;
  const ref = parseGitHubRepo(url);
  if (!ref) return null;
  if (github.length === 1) return github[0]!.account;
  const probes = await Promise.all(github.map((c) => probe(c, ref.owner, ref.repo, fetchImpl)));
  return (probes.find((p) => p.pushes) ?? probes.find((p) => p.sees) ?? probes[0]!).account;
}
