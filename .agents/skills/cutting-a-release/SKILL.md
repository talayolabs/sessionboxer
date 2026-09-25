---
name: cutting-a-release
description: Cut a Sessionboxer release — bump every version, write the short CHANGELOG section, pass over README/GUIDE, tag so the release workflow publishes images, installers and the GitHub Release, then update sessionboxer.talayolabs.com (features, agents, logos, install refs, synced guide) and report. Use when the user asks to cut, tag, ship or publish a release, or a new version.
---

# Cutting a release

Two repos are involved: `talayolabs/sessionboxer` (this one) and the site,
`talayolabs/sessionboxer-site` (checked out next to it as `../sessionboxer-site`,
deployed by Coolify from `main`). Commit directly to `main` in both unless the
user says otherwise. Versions are plain semver: features → minor, fixes only →
patch.

## 1. Know what goes in

```sh
git pull
git log --oneline v<previous>..HEAD
```

Sort the commits into: user-facing features/changes (they go in the changelog),
fixes (one line each, or grouped), noise (CHANGELOG/docs/CI-only commits, skip).
Note whether anything under `images/sandbox/` changed: then the Sandbox image
changed and the changelog says so.

## 2. Versions

The tag must equal `package.json`'s version (the workflow checks). Bump all of
them together, including the internal `@sessionboxer/*` dependency ranges:

- `package.json`
- `apps/cli`, `apps/control-plane`, `apps/desktop`, `apps/web`
- `packages/protocol`, `packages/sandbox-daemon`, `packages/computer-use-mcp`

`sed -i 's/"<old>"/"<new>"/'` over those files works, then check with
`rg '"<old>"' --glob '*/package.json' --glob package.json`. Refresh the lockfile
without touching `node_modules`:

```sh
npm install --package-lock-only --ignore-scripts
```

Versioned references elsewhere (grep for the old version, minus lockfile and
CHANGELOG):

- `docker-compose.yml`: `SESSIONBOXER_VERSION:-<version>`
- `docs/GUIDE.md`: the `raw.githubusercontent.com/.../v<version>/docker-compose.yml` URL
- `README.md`: only if it names a version (the demo caption names the version it was recorded on; leave it)

## 3. CHANGELOG

The Release job cuts the `## <version>` section out of `CHANGELOG.md` for the
release notes, so it must exist and be in this shape:

```md
## <version> — <YYYY-MM-DD>

Install: `npx sessionboxer@<version> serve`, the installers on the release, `docker compose up`, or
`curl -fsSL https://sessionboxer.talayolabs.com/install.sh | sh`. The Sandbox image changed:
Stop → Resume existing sessions.

- <One short line: the idea of the change, no details.> ([abc1234](https://github.com/talayolabs/sessionboxer/commit/abc1234))
```

Rules the user asked for:

- **Short.** One line per change, the general idea only; the commit link carries
  the detail. No sub-bullets, no "how it works", no option lists.
- Every line ends in a link to its commit (7-char sha). Group several small
  commits of one feature under one line with one link (the last or main one).
- Drop the "Sandbox image changed" sentence when nothing in `images/sandbox/`
  changed; otherwise keep it (users must Stop → Resume).
- Anything worth explaining goes in `docs/GUIDE.md` (and an ADR under
  `docs/adr/` for a decision), not in the changelog.
- Replace an existing `## Unreleased` heading; do not leave one behind.

## 4. Docs pass

Read `README.md` and `docs/GUIDE.md` against the changelog lines: every feature
in the release must be findable there in the user's words (a new agent in the
agents list, the quick-start login line, the compare table row, the limits
section, the model picker paragraph, and so on). Check every list of agents or
providers mentions all of them (`rg -n "Claude Code, Codex" README.md docs/GUIDE.md`).

## 5. Build, commit, tag

```sh
npm run typecheck && npm run build
git add CHANGELOG.md package.json package-lock.json apps/*/package.json packages/*/package.json docker-compose.yml docs README.md
git status --short          # nothing unintended, never .local/
git commit -m "Release <version>"
git tag -a v<version> -m "v<version>"
git push origin main && git push origin v<version>
```

The tag starts the **Release** workflow (`.github/workflows/release.yml`):
package → Sandbox + Control Plane images (amd64, arm64, native runners) →
manifests (`<version>` and `latest`) → desktop installers (Linux, macOS,
Windows) → npm publish → GitHub Release. It takes about 25–35 minutes; the
sandbox image and Windows installer are the slow jobs.

```sh
gh run list --limit 3
gh run view <id> --json status,conclusion,jobs --jq '"\(.status) \(.conclusion)", (.jobs[] | "\(.name): \(.conclusion)")'
```

Do not sit and wait: tell the user the tag is pushed and the workflow runs, do
the site (step 6), then come back. When it is done, verify:

```sh
gh release view v<version> --json url,assets --jq '.url, (.assets[] | .name)'
# expect: deb/AppImage ×2 archs, mac dmg/zip ×2, win exe/zip, sessionboxer-<version>.tgz, SHA256SUMS
npm view sessionboxer version    # fails while nobody publishes to npm — see below
```

`npm-publish` reports success even when it skips: it only publishes when the
`NPM_TOKEN` repository secret exists. It has never existed so far; say so in
the report ("npm publish skipped, no NPM_TOKEN") and offer to ask for a token,
do not request one unprompted.

If a job fails: `gh run view --log-failed`, fix on `main`, then move the tag
(`git tag -fa v<version> && git push -f origin v<version>`) only if nothing was
published yet (the images and the Release are the last jobs; if the Release
exists, cut a patch version instead).

## 6. The site

In `../sessionboxer-site` (`git pull` first). Everything is static HTML/JS;
`npm ci && npm run build` must pass (it runs `scripts/build-pages.mjs`, `tsc`,
`vite build`).

Update, in this order:

1. **Guide copy**: `node scripts/sync-guide.mjs main` refreshes
   `content/GUIDE.md` from this repo's `docs/GUIDE.md` (source of `/guide/`).
   `npm run pages` must still map every section (`pages/guide.mjs`); add a new
   chapter there if a new `##` section appeared.
2. **Version refs**: `public/install.sh` `FALLBACK_VERSION`, the compose URL in
   `index.html` (`#way-compose`). `rg -n '<old>' index.html public pages`.
3. **Features**: every changelog line that a visitor would care about needs a
   place — a card in the `#features` grid, a bullet on an existing card, or a
   page in `pages/features.mjs` (which also renders `/features/<slug>/` and the
   compare tables; keep the compare rows' claims about other products as they
   are unless verified against their docs).
4. **Agents** (when a provider was added or changed): the hero eyebrow, the
   `<meta>` descriptions, the `#agents` lede count ("All four…"), an agent card
   (`.card.agent`: how it runs, how you log in, three to five bullets), the
   requirements list, the "Connect your agent" step, the compare table's Agents
   row and its column header if the product is compared, `pages/features.mjs`
   `rows.agents` and the provider-tokens page text, the `section-more` line
   under Install. The `.agents` grid is 2 columns; adjust `src/styles.css` if
   the count no longer fits.
5. **Logos**: every mention of an agent or of Docker carries its inline logo:
   a `<symbol id="logo-<name>">` in the sprite at the top of `<body>` and
   `<svg class="logo" role="img" aria-label="<Name>"><use href="#logo-<name>" /></svg>`
   before the name. Take the same shape the web app uses
   (`apps/web/src/ProviderIcon.tsx`) so site and app match; brand colours only
   where the brand has one (Claude orange, Docker blue), else `currentColor`.
6. **Demo caption**: if the video predates the release's features, say so in
   the caption ("v1.1.0, before Cursor") rather than re-recording, unless the
   user asks for a new demo (that is its own task: `~/pw/demo/` scripts).

Check it renders (Playwright over the running Chrome at
`http://localhost:29229`, `vite preview`), then:

```sh
git add index.html pages src public content
git commit -m "<what changed for the site>"
git push origin main
curl -fsSL https://sessionboxer.talayolabs.com/install.sh | grep FALLBACK_VERSION=   # after Coolify deploys, ~1 min
```

## 7. Report

One message when the tag is pushed (release running, site commit link), one
when the workflow is done: release URL, the image tags
(`ghcr.io/talayolabs/sessionboxer:<version>`, `sessionboxer-sandbox:<version>`),
the site URL, and caveats (npm skipped; anything in the release that was not
verified live). No feature recap — the changelog is the recap.
