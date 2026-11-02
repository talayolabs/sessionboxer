/**
 * Bitbucket as seen by the Control Plane: a self-hosted Data Center (`bitbucket.example.com`,
 * HTTP access token) or Bitbucket Cloud (`bitbucket.org`, Atlassian API token + email): host
 * normalisation, token verification and remote URL shapes. The Sandbox side
 * is `bb` (github.com/talayolabs/bb), the `gh`-like CLI the image ships; this module only needs
 * what the Connector login and the clone step do on the host.
 */

const USER_AGENT = "sessionboxer";
/** Checks are fast; a Data Center behind a VPN that is off should fail quickly, not hang the dialog. */
const VERIFY_TIMEOUT_MS = 15_000;

export const BITBUCKET_CLOUD_HOST = "bitbucket.org";
const CLOUD_API = "https://api.bitbucket.org/2.0";
/** The static git username Bitbucket Cloud takes with an Atlassian API token. */
export const CLOUD_API_TOKEN_GIT_USER = "x-bitbucket-api-token-auth";

/** `bitbucket.example.com`, `https://bitbucket.example.com/`, `BITBUCKET.example.com:443` → `bitbucket.example.com`; `www.`/`api.bitbucket.org` → `bitbucket.org`. */
export function normalizeBitbucketHost(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/\/.*$/, "");
  s = s.replace(/:443$/, "");
  if (s === "" || /[\s@/]/.test(s)) throw new Error("Enter the Bitbucket host, e.g. bitbucket.example.com or bitbucket.org");
  if (s === "www.bitbucket.org" || s === "api.bitbucket.org") return BITBUCKET_CLOUD_HOST;
  if (s !== BITBUCKET_CLOUD_HOST && s.endsWith(".bitbucket.org")) throw new Error(`${s} is not a Bitbucket host; Bitbucket Cloud is bitbucket.org.`);
  return s;
}

export function isBitbucketCloud(host: string): boolean {
  return host.toLowerCase() === BITBUCKET_CLOUD_HOST;
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

/**
 * Verifies an Atlassian API token (with its account email) against Bitbucket Cloud's `GET /2.0/user`
 * and tells whose it is; `name` is the Bitbucket username. api.bitbucket.org has been seen answering
 * a wrong email/token pair with an HTML 503 instead of 401, so a 503 says that too.
 */
export async function verifyBitbucketCloudToken(email: string, token: string, fetchImpl: typeof fetch = fetch): Promise<BitbucketUser> {
  const headers = {
    authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
    accept: "application/json",
    "user-agent": USER_AGENT,
  };
  const res = await get(fetchImpl, `${CLOUD_API}/user`, headers, "api.bitbucket.org");
  if (res.status === 401) throw new Error("bitbucket.org rejected the email and API token (401). Check the email of the Atlassian account and that the token was copied whole.");
  if (res.status === 403) throw new Error("bitbucket.org refused the token (403); it needs at least the read:user:bitbucket scope.");
  if (res.status === 503) throw new Error("api.bitbucket.org answered 503. It does so for a wrong email or token too: check both, or retry in a minute.");
  if (!res.ok) throw new Error(`api.bitbucket.org answered ${res.status} to GET /2.0/user.`);
  const user = (await res.json()) as { username?: unknown; display_name?: unknown; account_id?: unknown };
  if (typeof user.username !== "string") throw new Error("api.bitbucket.org returned an unexpected user record.");
  const displayName = typeof user.display_name === "string" ? user.display_name : user.username;
  return { name: user.username, slug: user.username, displayName, id: 0 };
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

/** Cloud: `https://[user@]bitbucket.org/ws/repo[.git]`, `git@bitbucket.org:ws/repo.git`, `ssh://git@bitbucket.org/ws/repo.git`. */
const CLOUD_REMOTE = /^(?:https?:\/\/(?:[^@/\s]+@)?(?:www\.)?|ssh:\/\/(?:[^@/\s]+@)?|[^@/\s]+@)bitbucket\.org[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/**
 * Project key (Cloud: workspace) and repository slug of a Bitbucket clone URL, or `null` for
 * anything else (GitHub, a Data Center scp-style URL).
 */
export function parseBitbucketRemote(url: string): BitbucketRepoRef | null {
  const s = url.trim();
  const cloud = CLOUD_REMOTE.exec(s);
  if (cloud) return { host: BITBUCKET_CLOUD_HOST, project: cloud[1]!, slug: cloud[2]! };
  const ssh = DC_SSH.exec(s);
  if (ssh) return { host: ssh[1]!.toLowerCase(), project: ssh[2]!, slug: ssh[3]! };
  const https = DC_HTTPS.exec(s);
  if (https) return { host: https[1]!.toLowerCase(), project: (https[2] ?? https[4])!, slug: (https[3] ?? https[5])! };
  return null;
}

/** The HTTPS clone URL git (through `bb auth git-credential`) can use for `ref`. */
export function bitbucketHttpsCloneUrl(ref: BitbucketRepoRef): string {
  if (isBitbucketCloud(ref.host)) return `https://${BITBUCKET_CLOUD_HOST}/${ref.project}/${ref.slug}.git`;
  return `https://${ref.host}/scm/${ref.project}/${ref.slug}.git`;
}
