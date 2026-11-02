/** Bitbucket Cloud (bitbucket.org) part of the Connect Bitbucket form: the Atlassian email and where to get an API token. */
const CLOUD_TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";
const CLOUD_SCOPES = [
  "read:user:bitbucket",
  "read:repository:bitbucket",
  "write:repository:bitbucket",
  "read:pullrequest:bitbucket",
  "write:pullrequest:bitbucket",
  "read:workspace:bitbucket",
];

export function isBitbucketCloudHost(hostName: string): boolean {
  return hostName === "bitbucket.org" || hostName === "www.bitbucket.org";
}

export function isEmailLike(email: string): boolean {
  return /^[^@\s]+@[^@\s]+$/.test(email.trim());
}

export function BitbucketCloudFields({ email, onEmail }: { email: string; onEmail: (v: string) => void }) {
  return (
    <>
      <label>
        Atlassian account email
        <input type="email" value={email} autoComplete="off" spellCheck={false} placeholder="you@example.com" onChange={(e) => onEmail(e.target.value)} />
      </label>
      <p className="muted">
        1.{" "}
        <a href={CLOUD_TOKEN_PAGE} target="_blank" rel="noopener noreferrer">
          Open your Atlassian account's API tokens page
        </a>{" "}
        and click <em>Create API token with scopes</em> → <em>Bitbucket</em>, with the scopes{" "}
        {CLOUD_SCOPES.map((s, i) => (
          <span key={s}>
            {i > 0 && " "}
            <code>{s}</code>
          </span>
        ))}
        .
        <br />
        2. Paste it here; Sessionboxer checks it against bitbucket.org and keeps it as a secret header, never shown again.
      </p>
    </>
  );
}
