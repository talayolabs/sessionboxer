# ADR 0068: Repositories named anywhere are remembered for suggestions

## Status

Accepted

## Context

A repository is typed into Sessionboxer in several places: the New Session form and a Session's *Repositories* dialog (a clone URL or a host folder), the *Follow* dialog of the Pull requests page (`owner/repo`, `PROJECT/slug` or a URL), the *New Session* action of an automation, and — after the pull request trigger — the Automations form itself. It is nearly always one of a handful of repositories the owner works on, yet each input started blank and knew nothing of the others: a URL cloned in ten Sessions had to be typed an eleventh time, and a repository followed on the Pull requests page was not offered when an automation needed one.

A pull request trigger also required a trip to the Pull requests page first: the trigger was greyed out until something was followed, so "review every PR of this repository" took two pages.

## Decision

**One `repositories` table, written by every place that names a repository, read only for suggestions.** The Control Plane remembers (`RepoStore`, `repositories`) each clone URL and host folder it is given — a Session's repositories at creation or when one is added, a repository follow, a PR attached to a Session, an automation's *New Session* repositories — with how many times and where (`session`, `follow`, `pr`, `automation`) it was last named. A row is one location, case-insensitive; a git URL is read into provider, host, owner and repository when it is a github.com or Bitbucket Data Center remote (`parseRepoRemote` in the protocol; canonical form `https://github.com/o/r`, `https://host/scm/KEY/slug.git`), so the same repository reached as `git@github.com:o/r.git` and `https://github.com/o/r` is one row. Other hosts keep the URL as given with its `owner/repo` tail; folders are their path. The first start with the table empty backfills it from the Sessions, attached PRs, follows and automations already there, dated as they were.

`GET /api/repositories` lists them most recently named first; `DELETE /api/repositories/:id` forgets one. Nothing else reads the table: it is not polled, not cloned, not a list of connectors' repositories — a repository the owner never named is not in it.

**Every repository input suggests from it.** The web client fetches the list once per form (`useKnownRepos`) and attaches a native `<datalist>` to each input: clone URLs (labelled `owner/repo`) on the git URL of the repository editor, host folders on its folder field, and `owner/repo` of the picked provider and host on the follow dialog. A `<datalist>` is what the schedule form already uses for cron expressions and time zones; it filters as you type, costs no component, and leaves the input free text.

**The Automations form follows a repository on the spot.** The pull request trigger is never greyed out. Under the list of follows to listen to, one row — the login to read with when there are several, the repository with suggestions, *Follow* — creates the repository follow (`POST /api/prs/follows`, the same call as the Pull requests page; an existing follow is reused and re-enabled) and ticks it in the trigger. *My PRs* and *Reviews asked of me* stay on the Pull requests page, where their meaning is explained; the form says so.

## Consequences

- Repositories are typed once. The suggestions are the owner's own history, in their own spelling of the URL when the host is not one Sessionboxer knows.
- The list can hold a repository the owner does not want offered (a one-off clone); *forget* removes it, and it comes back only when named again.
- The table is a by-product: dropping it loses suggestions, nothing else, and the next start rebuilds it from what the other tables name.
- A follow created from the Automations form is an ordinary follow: it shows on the Pull requests page, polls on its own, and outlives the automation.
