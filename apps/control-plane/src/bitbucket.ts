/**
 * Bitbucket Data Center (self-hosted, `bitbucket.example.com`) as seen by the Control Plane:
 * host normalisation, HTTP access token verification and remote URL shapes. The Sandbox side
 * is `bb` (github.com/talayolabs/bb), the `gh`-like CLI the image ships; this module only needs
 * what the Connector login and the clone step do on the host.
 */

const USER_AGENT = "sessionboxer";
/** Checks are fast; a Data Center behind a VPN that is off should fail quickly, not hang the dialog. */
const VERIFY_TIMEOUT_MS = 15_000;

/** `bitbucket.example.com`, `https://bitbucket.example.com/`, `BITBUCKET.example.com:443` → `bitbucket.example.com`. */
export function normalizeBitbucketHost(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/\/.*$/, "");
  s = s.replace(/:443$/, "");
  if (s === "" || /[\s@/]/.test(s)) throw new Error("Enter the Bitbucket host, e.g. bitbucket.example.com");
  if (s === "bitbucket.org" || s.endsWith(".bitbucket.org")) {
    throw new Error("bitbucket.org is Bitbucket Cloud; this login is for a self-hosted Bitbucket Data Center / Server.");
  }
  return s;
}

/** Where a user creates an HTTP access token on Data Center 8.x/9.x (works without the username). */
export function bitbucketTokenPageUrl(host: string): string {
  return `https://${host}/plugins/servlet/access-tokens/`;
}

export interface BitbucketUser {
  /** Login name (`j.perelli`), what git and the REST API take as the user. */
  name: string;
  slug: string;
  displayName: string;
  id: number;
}

/**
 * Verifies an HTTP access token against `host` and tells whose it is. Data Center has no
 * `/me`; any authenticated REST call answers with `X-AUSERNAME`, which `/users/{slug}` turns
 * into the account record. Errors are messages for the dialog and never contain the token.
 */
export async function verifyBitbucketToken(host: string, token: string, fetchImpl: typeof fetch = fetch): Promise<BitbucketUser> {
  const base = `https://${host}/rest/api/latest`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": USER_AGENT };
  const probe = await get(fetchImpl, `${base}/inbox/pull-requests/count`, headers, host);
  if (probe.status === 401) throw new Error(`${host} rejected the token (401). Check that it was copied whole and has not expired.`);
  if (!probe.ok) throw new Error(`${host} answered ${probe.status} to a REST call; is this a Bitbucket Data Center?`);
  const username = probe.headers.get("x-ausername");
  if (!username) throw new Error(`${host} did not say whose token this is (no X-AUSERNAME header); is this a Bitbucket Data Center?`);
  const userRes = await get(fetchImpl, `${base}/users/${encodeURIComponent(username)}`, headers, host);
  if (!userRes.ok) throw new Error(`${host} answered ${userRes.status} when asked about ${username}.`);
  const user = (await userRes.json()) as Partial<BitbucketUser>;
  if (typeof user.name !== "string" || typeof user.id !== "number") throw new Error(`${host} returned an unexpected user record for ${username}.`);
  return { name: user.name, slug: user.slug ?? user.name, displayName: user.displayName ?? user.name, id: user.id };
}

async function get(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, host: string): Promise<Response> {
  try {
    return await fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`Could not reach ${host}: ${describeNetworkError(e)}`);
  }
}

function describeNetworkError(e: unknown): string {
  const codes: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    const code = (cur as Error & { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    cur = cur.cause;
  }
  const code = codes[codes.length - 1] ?? codes[0];
  if (e instanceof Error && e.name === "TimeoutError") return "no answer within 15 s (VPN off?)";
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) {
    return `TLS certificate not trusted (${code}); add the CA under Settings → TLS certificates or NODE_EXTRA_CA_CERTS`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host name not found";
  if (code) return code;
  return e instanceof Error ? e.message : String(e);
}

export interface BitbucketRepoRef {
  host: string;
  project: string;
  slug: string;
}

/** `ssh://git@host[:7999]/KEY/slug.git` (Data Center's SSH clone URL). */
const DC_SSH = /^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
/** `https://host/scm/KEY/slug.git` and `https://host/projects/KEY/repos/slug[/browse]`. */
const DC_HTTPS = /^https?:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?(?:\/[^\s]*?)?\/(?:scm\/([^/\s]+)\/([^/\s]+?)(?:\.git)?|projects\/([^/\s]+)\/repos\/([^/\s]+?)(?:\/[^\s]*)?)\/?$/i;

/** Project key and repository slug of a Data Center clone URL, or `null` for anything else (GitHub, Cloud, scp-style). */
export function parseBitbucketRemote(url: string): BitbucketRepoRef | null {
  const s = url.trim();
  const ssh = DC_SSH.exec(s);
  if (ssh) return { host: ssh[1]!.toLowerCase(), project: ssh[2]!, slug: ssh[3]! };
  const https = DC_HTTPS.exec(s);
  if (https) return { host: https[1]!.toLowerCase(), project: (https[2] ?? https[4])!, slug: (https[3] ?? https[5])! };
  return null;
}

/** The HTTPS clone URL git (through `bb auth git-credential`) can use for `ref`. */
export function bitbucketHttpsCloneUrl(ref: BitbucketRepoRef): string {
  return `https://${ref.host}/scm/${ref.project}/${ref.slug}.git`;
}
