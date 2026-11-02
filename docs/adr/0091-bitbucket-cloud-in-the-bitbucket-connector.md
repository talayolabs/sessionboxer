# Bitbucket Cloud in the Bitbucket Connector: email + Atlassian API token

ADR-0038 made Bitbucket a Connector kind for a self-hosted Data Center and refused `bitbucket.org` because Cloud's REST 2.0 and git users differ. Since then `bb` (pinned in the image since 1.7.0) speaks Cloud too: host `bitbucket.org` picks REST 2.0 at `api.bitbucket.org`, `next` paging, and an Atlassian API token sent with the account email as HTTP Basic (`email:token`), with `x-bitbucket-api-token-auth` as the git username. Users still had to log in by hand in each box's Terminal, losing the login at every Stop.

## Decision

**Same Connector, host decides.** `normalizeBitbucketHost` accepts `bitbucket.org` (and maps `www.`/`api.bitbucket.org` to it); every other host stays Data Center. `ConnectorDialog` shows an **Atlassian account email** field, the Atlassian API tokens page and the six Bitbucket scopes when the host is `bitbucket.org`, and its Data Center copy otherwise.

**Email next to the token.** `ConnectorStartRequest.email`, `McpConnector.email` and `BoxCredential.email` (nullable, `null` for GitHub and Data Center) carry it. The email is not a secret and lives on the Connector; the token stays the secret `Authorization: Bearer …` header like Data Center's, so `resolveBoxCredentials`, Disconnect and the secret masking are unchanged. `verifyBitbucketCloudToken` checks the pair with `GET https://api.bitbucket.org/2.0/user` and stores the `username`; a 503 gets a message that mentions a wrong pair, since bitbucket.org has been seen answering bad credentials with an HTML 503.

**Into the box.** `BbCredentials` writes `email:` and `git_user: x-bitbucket-api-token-auth` for credentials with an email; `planClone` recognises `https://bitbucket.org/ws/repo[.git]`, `git@bitbucket.org:ws/repo.git` and `ssh://git@bitbucket.org/ws/repo.git`, clones over HTTPS and sets `BB_EMAIL` and that git user next to `BB_HOST`/`BB_TOKEN`.

## Consequences

- Private Cloud clones at session start, `git push`, `bb pr …` (including `bb pr merge`) and `bb api` work as the connected account, and the login survives Stop → Resume like Data Center's.
- The PRs pane, **Pull requests** follows and Auto-merge stay Data Center/GitHub-only: `parsePullRequestUrl` still refuses `bitbucket.org` and `FollowedPrs.accounts()` leaves Cloud logins out. Supporting them means a REST 2.0 backend behind the PR provider code.
- Workspace/project/repository access tokens (Bearer, `x-token-auth`) are not offered by the dialog; they still work with `bb auth login --skip-verify` in the box.
- Entries saved before this have `email: null` through the schema default; nothing migrates.
