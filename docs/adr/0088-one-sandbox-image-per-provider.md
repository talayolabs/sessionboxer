# One Sandbox image per Provider

**Status: Accepted** — proposed 2026-10-04, implemented 2026-10-05 in
[27f106b](https://github.com/talayolabs/sessionboxer/commit/27f106b) (Dockerfile targets, `build:image -- --provider`),
[b6c0c17](https://github.com/talayolabs/sessionboxer/commit/b6c0c17) and [cd10ec8](https://github.com/talayolabs/sessionboxer/commit/cd10ec8)
(Control Plane selection and lazy pulls), [0e984c8](https://github.com/talayolabs/sessionboxer/commit/0e984c8)
(release matrix and tags) and [c695b51](https://github.com/talayolabs/sessionboxer/commit/c695b51) (payload
injection for forks into another Agent). Ships with 1.6.0.

A Sandbox runs one Provider, but the Linux image installed all 13 Agents. The monolith built from `31b82ce`
measured 2.319 GB of compressed layers and 6.027 GB unpacked, of which the Agents were 1.107 GB / 2.943 GB and
the shared desktop, tools, Node, uv, editor, speech model and Sessionboxer runtime 1.212 GB / 3.084 GB
([research and measured layer tables](../research/sandbox-image-per-provider-variants.md)). The Control Plane
used one `SANDBOX_IMAGE` for Sessions, Provider sign-in containers and VM host helpers. Snapshots capture a
whole filesystem and forks can change Provider with a new conversation or a handoff; that had to survive
image selection. Windows/macOS install their Agents in the guest and need no Agent in their Linux helper image.

## Decision

**Versioned Provider variants with preinstalled Agents, not a runtime package installer.** The suffix is the
exact id from `PROVIDERS`: `ghcr.io/talayolabs/sessionboxer-sandbox:<version>-claude-code`, `<version>-codex`
and the other 11 ids. `<version>-base` is the same runtime without an Agent; `<version>-all` and plain
`<version>` are the all-Providers image (what every Control Plane ≤ 1.5.0 expects). `latest-<target>` and
plain `latest` are convenience aliases; the Control Plane only ever asks for versioned references.

**One multi-stage Dockerfile with named targets** (`images/sandbox/Dockerfile`): `toolchain` (pinned common
downloads, trust configured) → `agent-<providerId>` payload builders branch from it → `base` = toolchain +
Sessionboxer dependencies, code and configuration → final `<providerId>` = `FROM base` + `COPY` of that one
payload → `all` = base + every payload, the default target. Claude Code and Codex, one install layer in the
monolith, are separate payloads. A payload is `/opt/sessionboxer/providers/<providerId>/` (the Agent's
runtime closure, launchers in `bin/`, `manifest.json` `{ provider, version, payloadFormat: 1, files }`);
`payload-manifest` refuses a payload with a symlink that leaves it, `link-providers` symlinks the launchers
into `/usr/local/bin`, so the Daemon's `provider-commands.ts` needs no change. Every final target carries
`org.opencontainers.image.version`, `io.sessionboxer.providers` (comma-separated ids, empty for base),
`io.sessionboxer.payload-format=1` and `io.sessionboxer.runtime`. Pins, update suppression, the `extra-ca`
BuildKit secret and `EXTRA_CA_FINGERPRINT` (ADR-0015) stay in the local build; release layers carry no local trust.

**The release matrix is generated from `PROVIDERS`** (`scripts/sandbox-image-targets.mjs --json`; the release
fails before building when the Dockerfile's `agent-*`/final stages and `PROVIDERS` disagree). Per architecture
on native runners: one `base` job (`fail-fast: true` — nothing else can proceed without it), 13 Provider jobs
and one `all` job (`fail-fast: false`, six Provider jobs at a time — one failing Agent install does not cancel
the others' evidence). Each job pushes by digest with a registry cache per target and architecture
(`buildcache-<target>-<arch>`, one writer per ref). Provider and `all` finals pin the base with
`--build-context base=docker-image://<repo>@<base digest>` — no Dockerfile change — and `verify` proves the
platform manifest starts with the base's exact layer descriptors (a cache hit alone proves nothing), checks the
labels, the §12 size budgets (arm64 = amd64 + 15%) and runs `release-sandbox-smoke.mjs`: payload directory and
manifest present, `<agent> --version`, an ACP `initialize`. fx has no ACP server without a credential, so its
smoke accepts only its no-credential error (`AI_GATEWAY_API_KEY` / `fx login`). `manifests` joins the verified
digests of both architectures into `<version>-<target>`, plain `<version>` from `all`, then the `latest-*`
aliases; no partial matrix advances a tag. Last, `prune-cache` (release time only, `continue-on-error`) deletes
GHCR package versions that are untagged BuildKit cache manifests and nothing else.

**The Control Plane resolves images by purpose and pulls lazily.** `sandboxImageFor(provider)` and
`sandboxBaseImage()` in `apps/control-plane/src/config.ts` return `<repo>:<version>-<suffix>`; Linux Sessions
and Provider sign-in containers use the Provider's image, VM probes/helpers and guest-Agent sidecars the base.
`SandboxImages` tracks status and in-flight pulls per exact reference, keeps the `SandboxImageStatus` progress
fields, and nothing is pulled at startup: the first Session, sign-in or VM helper that needs an image pulls it.
`GET/POST /api/sandbox-image?provider=<id>|base` (omitted = `claude-code`, the default Provider, for
compatibility) reports and retries the selected one; the New Session page shows the image of the chosen Agent.
A labelled image must list the requested Provider (a base image is refused for an Agent Session; a mismatch
reads *carries fx, not Codex*). An image without the labels is legacy — a pre-variant monolith or a custom
image — and is treated as all-Providers after a `preflight` helper container confirms the executable is on
`PATH`; the Control Plane never invents a label.

**Exact overrides and local defaults.** `SESSIONBOXER_IMAGE` is one exact reference that both resolvers return
verbatim (no suffix appended) and that is used for everything, so it must carry the Provider or be unlabelled
with the executable. No-argument `npm run build:image` still builds all Providers as `<repo>:<version>` and
`sessionboxer/sandbox:dev`; `--provider <id|base|all>` builds one target as `<repo>:<version>-<x>` and
`sessionboxer/sandbox:dev-<x>`, never overwriting `:dev`. A missing `sessionboxer/sandbox:dev-<x>` is reported
with its build command instead of a pull.

**Forks keep the whole filesystem, with a compatibility gate.** A same-Provider fork uses the Snapshot image
as before. A fork into another Agent (`new` or `handoff`) gets the target's payload from that Agent's image of
the same release — `<repo>:<version>-<id>` (or the `SESSIONBOXER_IMAGE`, which then must carry it), local or
pulled: a `payload-donor` container is created, never started, the payload is read through Docker's archive
API, every entry checked against the payload's `manifest.json` (regular files, symlinks inside the payload,
and hard links only to a payload file — Docker's `getArchive` emits same-inode files as hard links; unlisted,
missing, absolute or traversing paths refuse), then written into the stopped fork with its launchers before the
Daemon starts; the interpreter the launchers need must already be in the image. The runtime check is exact:
the Snapshot's `io.sessionboxer.runtime` must equal this Control Plane's version, so a Snapshot from another
release refuses with the reason. A missing donor, a `SESSIONBOXER_IMAGE` without the Agent or a legacy
Snapshot without the executable refuse too — never a fresh Workspace instead. `Session.image` is
`{ reference, id, providers, runtime, payloads }`; a Snapshot records `providers` and `payloads`, blanks the
credential variables of every Provider it carries, and a flatten/rebuild keeps the `io.sessionboxer.*` labels.
The transcript shows *<Agent> <version> added to this Sandbox* (`payload_injected`); `payloads` appear in the
API and that marker, not in the Snapshots popup. At boot the Control Plane sweeps `payload-donor` and
`preflight` helper containers left by a crash.

**No automatic migration.** Stop → Resume starts the existing container and refreshes Sessionboxer/Daemon
files; it does not replace the image or Agent, and pulls nothing. Rebuild flattens the existing filesystem.
Existing monolithic Sessions and Snapshots stay monolithic; new Sessions get variants. Nothing referenced by a
Session or Snapshot is pruned. Guest Agent provisioning and guest Provider limitations are unchanged.

## Considered Options

- **Install at Session boot:** fewer published images, but adds network-policy exceptions, installer failures,
  mutable dependency resolution and latency to the offline/local-first path. Useful for explicit experiments,
  not the default. Pulling a prepared variant once is still required when it is not local.
- **Keep only the monolith:** simplest compatibility, but every user downloads all Agent payloads.
- **Make plain `<version>` agent-free or drop it:** saves a compatibility artifact, but breaks older Control
  Planes and custom-image users. The PostgreSQL suffix analogy supports explicit variants, not silently
  redefining the plain tag. `-base` is the agent-free image instead.
- **Conditional `PROVIDER` build argument:** less target boilerplate, but mixes independent installers/pins
  and makes cache isolation and coverage harder to inspect. Named stages expose those boundaries.
- **BuildKit Bake:** useful orchestration, not a substitute for shared layers. Deferred unless it replaces
  matrix duplication and remains derived from `PROVIDERS`.
- **Fresh target image for every cross-Provider handoff:** easy image selection, but loses the source's
  installed tools and non-Workspace filesystem changes. Would be an owner-approved semantic change.
- **Suffixing `SESSIONBOXER_IMAGE`:** would let one override name a family of variants, but every existing
  override is one custom image; template syntax can come later if anyone needs it.

## Consequences

- Measured amd64 variants (unpacked / compressed): base 3.155 / 1.223 GB, fx 3.167 / 1.228, copilot
  3.528 / 1.404, codex 3.537 / 1.362, claude-code 3.671 / 1.432, all 6.025 / 2.318 — a Linux Session
  downloads 1.2–1.4 GB instead of 2.3 GB, 38–47% less; all within the §12 budgets, which `verify` enforces
  on every release. The distinct amd64 blobs of the whole set are 2.46 GB, about one monolith; the registry
  does not hold one base per tag. arm64 sizes and the release's CI minutes are not measured yet (the budgets
  for arm64 are provisional, amd64 + 15%).
- Switching Providers at one release pulls that Agent's layers on top of the shared base, not another base.
  Multiple releases, Snapshot deltas and build caches still consume space; nothing is pruned for you.
- The release runs 30 image jobs instead of two, and only verified digests become tags. Its cache lives in
  GHCR as `buildcache-*` and only its untagged, superseded versions are deleted, at release time.
- A fork into another Agent needs that Agent's image of the same release, local or pullable; offline use
  needs it preloaded. Donor images of old releases stay on GHCR as long as the release's tags do. A fork
  may hold two installed Providers; only one runs, and the Snapshot blanks the credentials of both.
- Owner decisions recorded as shipped: plain `<version>` and `latest` stay the all-Providers image; forks
  keep the whole filesystem; no-argument builds and exact overrides are unchanged; nothing is migrated or
  pruned; the fx smoke accepts its no-credential error; the omitted `/api/sandbox-image` selector means
  `claude-code`; donor runtime compatibility is exact version equality. Each can be revisited separately.
