# Pull requests attached to a Session, watched by the Control Plane through `gh api` run in the Sandbox

A Session's work usually ends up in one or more pull requests, and the review then happens on GitHub while the Session sits idle. The user asked to attach PRs to a Session (from a URL in a prompt, or when the agent opens one), be told when a comment or review arrives, and hand feedback back to the agent: one item or many at once, either into the prompt box for editing, or straight to the agent, with or without public replies on GitHub. The research note `docs/research/pull-requests-attached-to-a-session.md` records the exploration; this ADR records what was built.

## Who talks to GitHub

The Control Plane holds a GitHub token only when a GitHub Connector is set up (ADR-0016), and that account may not see the repository the agent is working in: the box can have a different login (`gh auth login` in a terminal, `GH_TOKEN`, a Connector enabled for that Session only). The user pointed this out and asked for the watcher to use the box's login.

Options considered:

- **Control Plane polls with the Connector token** (rejected as the only path): wrong or missing credential for many Sessions.
- **A watcher inside the Daemon** with its own timers, cursors and state, reporting items up (considered): uses the right login, but every box would run its own scheduler, keep state that dies with the container, and duplicate the parsing; and nothing watches while the box is stopped.
- **Control Plane owns the schedule and state, the Daemon runs one stateless `gh api` per request** (chosen; the user suggested it): the Control Plane decides *when* and *what* to fetch and parses the result; each request is a Daemon RPC `_sessionboxer/gh/api {method, path, headers, account?}` → `{status, headers, body}` that runs `gh api --include …` inside the container as the agent user. The box's own login is used, the box holds no watcher logic or durable state, and the same parsing code runs against `fetch` with a Connector token when the box is stopped.

The RPC is deliberately narrow: only relative `api.github.com` paths (`repos/…`, `graphql`), so it cannot become a generic HTTP client; `gh` picks the account (`GH_TOKEN` in the environment, or `gh auth token --user <account>` inside the box when a specific login is asked for); the token never leaves the box. `_sessionboxer/gh/logins` lists the box's logins (names only) so the Control Plane can try each until one sees the PR; the login that worked is stored as `viaAccount` and shown in the UI. As a side fix, the Daemon now *merges* Connector credentials into `gh`'s `hosts.yml` instead of rewriting it, so a manual `gh auth login` in the box survives a Connector refresh.

## Decision

**Store (Control Plane SQLite).** `pull_requests` (one row per Session × PR: metadata from GitHub, `attached_by` = prompt | agent | manual, `watch`, `via_account`, per-endpoint ETags, `synced_at`, `sync_error` + detail, `retry_at`) and `pr_items` (conversation comments, inline review comments, submitted reviews; author, `self`, body, `path`/`line`/`diff_hunk`, thread id and GraphQL thread node id, resolved/outdated, `seen`, `notified`, `address` = none | in_prompt | addressing | addressed). Both are new tables, created with the rest of the schema.

**Attach.** A PR URL in a user prompt (`github.com/{owner}/{repo}/pull/{n}`) attaches with `attached_by: prompt`; a URL in the agent's messages or tool output during a turn (`gh pr create` prints one) attaches at `turn_ended` with `attached_by: agent`; the PRs pane accepts a URL, `owner/repo#n`, or `#n` resolved against the Workspace's clone URL (`attached_by: manual`). The same PR is never attached twice to one Session.

**Poll.** One scheduler tick every 10 s picks the PRs due: 60 s after the last sync when the Session is idle, 5 min while the agent is running (GitHub can wait; the reply should not compete for attention), 5 min for a stopped box without a usable credential. Polls run one at a time (GitHub asks for serial requests). Each poll fetches, with `If-None-Match`, the PR (`/pulls/{n}`), issue comments, review comments and reviews, paginating on `Link`, then one GraphQL query for `reviewThreads` (resolved/outdated per thread, node ids for `resolveReviewThread`) and `reviewDecision` when anything changed. 304 is the normal case and costs nothing against the rate limit. Errors map to `unauthorized`, `not_found`, `rate_limited` (with `retry_at` from the headers), `box_stopped` and `error`, shown as one line per PR in the UI. Closed or merged PRs stop being watched 24 h after closing. PR state comes only from GitHub's answers, never from the agent's prose.

**Notify.** Items by other logins arrive `seen = 0`, `notified = 0`; the Session's PR counts (`prs` broadcast) update immediately. A `pr_activity` broadcast (toast, optional browser notification) is sent when the Session is not running; while the agent works, `notify()` is deferred and runs at `turn_ended`, so a burst of review comments does not talk over the reply. Opening a PR's tab marks its items seen.

**Act.** Three actions, per item and for any selection of items (also across PRs of the Session):

- `prompt`: build the prompt and return it; the Web puts it in the composer. Items become `in_prompt`.
- `address`: send the prompt to the agent now; if a turn is running, save it to *Saved for later* and start the queue so it goes out at `turn_ended` (ADR-0009's queue, so it is visible and can be edited or dropped meanwhile). The agent is asked to edit, verify and commit on the PR's branch and *not* to reply or push.
- `address_reply`: as above, plus push, reply per item with `gh api` from the box (`…/pulls/{n}/comments/{id}/replies` for inline comments, an issue comment mentioning the author otherwise) and resolve the review threads it addressed (`resolveReviewThread` with the stored node id). The Web asks for confirmation when more than one item is involved.

The prompt quotes each item (`>`), with PR, author, kind, `path:line`, its URL, and a header telling the agent that the quoted text was written by reviewers on GitHub and is feedback to evaluate, not instructions from the user; quotes are capped at 4000 characters. `address*` is refused (HTTP 400) when a PR is not the Workspace's repository (owner/repo of the clone URL, followed through forks), since the agent has nowhere to make the change; `prompt` still works so the user can tell it where. An item settles to `addressed` when its thread is resolved, when a later item by the watched login appears in the same thread, or (for conversation items) when a later issue comment by that login appears.

**UI.** A **PRs** pane (overview table: state, review decision, unread, open threads, activity, watch toggle, refresh, detach, GitHub link; attach field; browser-notification permission) and one dynamic pane per PR (`pr:<id>`): header with title, branch and sync line, a bulk bar (`n selected`, three buttons), and the item table with checkbox, kind, author, body (Markdown, clamped with *more*), `path:line` as a link into the Code pane (ADR-0023), status (new / resolved / address state / GitHub link) and the three per-row buttons. Sidebar and tab labels carry the unread count.

## Consequences

- No image rebuild: the Daemon gains two RPCs and `gh` was already in the image; existing Sessions need Stop → Resume for the new Daemon.
- A box with no login of its own and no Connector shows *no GitHub login can read this PR* and is not polled until that changes (retry every idle interval).
- Watching a stopped box depends on a Connector the Control Plane holds for the account that last read the PR; otherwise the row says *watching paused — Sandbox stopped*.
- The Control Plane never learns a token from the box: it sees login *names* and HTTP responses only.
- Cross-PR bulk actions are supported by the API (`itemIds` from several PRs) but the Web only offers selection within one PR's tab for now.
- Auto-addressing (acting without a click) is deliberately not built; the notification plus one-click **Address** is the intended loop.
