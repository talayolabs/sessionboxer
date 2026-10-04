# One Sandbox image per Provider

**Status: Proposed** — 2026-10-04. Implementation waits for owner approval.

A Sandbox runs one Provider, but the Linux image installs all 13 Agents. A build of `main` at `31b82ce`
measures 2.319 GB of compressed layers and 6.027 GB unpacked; this machine's containerd store displays
8.35 GB because it retains both. Provider installs account for 1.107 GB compressed / 2.943 GB unpacked.
The shared desktop, tools, Node, uv, editor, speech model and Sessionboxer runtime account for
1.212 GB / 3.084 GB. See [the research and measured layer tables](../research/sandbox-image-per-provider-variants.md).

The Control Plane uses one `SANDBOX_IMAGE` for Sessions, Provider sign-in containers and VM host helpers.
Snapshots capture a whole filesystem; forks can change Provider with a new conversation or a handoff.
That behavior must survive image selection. Windows/macOS install their Agents in the guest and need no
Agent in their Linux helper image.

## Decision

**Publish versioned Provider variants with preinstalled Agents**, not a runtime package installer. The suffix
is the exact ID from `PROVIDERS`: `<version>-claude-code`, `<version>-codex`, and the other 11 IDs. Publish
`<version>-base` for agent-free helpers. Keep plain `<version>` as an alias of `<version>-all` for compatibility;
keep plain `latest` as `latest-all`, with `latest-<providerId>` and `latest-base` convenience aliases. The
Control Plane selects versioned references, not convenience tags. The plain tag's retirement, if any, is a
separate compatibility decision, not part of this rollout.

**Use one multi-stage Dockerfile with named targets.** Stable common downloads form `toolchain`;
source-independent Agent stages produce isolated, manifest-listed runtime payloads. The common `base`
adds Sessionboxer dependencies, code and configuration. Each final Provider target starts from that same
base and copies only its payload. The `all` target copies every payload and remains the no-target default.
Split the combined Claude/Codex install. Preserve pins, update suppression, the `extra-ca` BuildKit secret,
`EXTRA_CA_FINGERPRINT`, and the existing cache-ordering intent. Preserve ADR-0015's deliberate installation
of custom CA certificates in local images; do not publish those local trust/cache inputs as public release layers.
Verify payload launchers, adapter dependencies,
ownership, environment and relocatability on both architectures. Do not copy a builder's entire filesystem.

**Generate the release matrix from `PROVIDERS`.** Keep native amd64 and arm64 runners: two common-base
builds, 26 Provider builds and two all-Providers assemblies. Import architecture/Provider-scoped registry
caches, with one writer per ref. Use the exact base digest in every final target and assert common layer
identity; a cache hit alone does not prove sharing. Merge two-architecture manifests from tested digests,
validate the complete set, then promote tags. No partial matrix advances `latest-*`.

**Resolve images by purpose and pull lazily.** `sandboxImageFor(provider)` selects a Linux Agent or sign-in
image; VM probes/helpers and guest-Agent sidecars use the base. Track status and in-flight pulls by resolved
reference, retaining `SandboxImageStatus` progress fields and adding a validated selector to status/retry
routes and their callers. No eager all-Providers pull at Control Plane startup. Thread selection through
Docker helpers and Settings sign-in, not only Session creation.

**Preserve exact overrides and local defaults.** `SESSIONBOXER_IMAGE` remains one exact custom reference,
never an automatically suffixed string; validate that it supports the requested Provider/helper purpose.
No-argument `npm run build:image` retains all Providers and `sessionboxer/sandbox:dev`. Add an explicit
`--provider` option for a versioned variant and `sessionboxer/sandbox:dev-<providerId>`, without overwriting
`:dev`. Recognize missing local variant tags and show their build command instead of pulling Docker Hub.

**Preserve whole-filesystem forks, with a compatibility gate.** Same-Provider forks use the Snapshot image.
For cross-Provider `new`/`handoff`, augment the stopped fork with only the target's verified immutable payload
from a compatible, normally same-release variant. Copy through Docker archive APIs before Agent startup;
do not run a package installer or transfer donor credentials. Check runtime compatibility, collisions and
the target executable; persist installed Provider/payload metadata through commits and flatten/rebuild.
Strip all installed Providers' secret environment keys. Missing or incompatible donors fail clearly, without
falling back to a latest Agent. This can leave two installed Providers in a fork, but only one runs. A fresh
target Workspace is an explicit alternative with different semantics, not a silent fallback. Automatic variant
selection must not ship until cross-Provider compatibility is proved or the owner explicitly changes that contract.

**Do not migrate existing filesystems automatically.** Stop → Resume starts the existing container and can
refresh Sessionboxer/Daemon files; it does not replace the image or Agent. Rebuild flattens the existing
filesystem. Existing monolithic Sessions/Snapshots remain so; clean new Sessions get variants. Do not prune
images referenced by Sessions/Snapshots. Guest Agent provisioning and guest Provider limitations are unchanged.

## Considered Options

- **Install at Session boot:** fewer published images, but adds network-policy exceptions, installer failures,
  mutable dependency resolution and latency to the offline/local-first path. Useful for explicit experiments,
  not the default. Pulling a prepared variant once is still required when it is not local.
- **Keep only the monolith:** simplest compatibility, but every user downloads all Agent payloads.
- **Make plain `<version>` agent-free or drop it:** saves a compatibility artifact, but breaks older Control
  Planes and custom-image users. The PostgreSQL suffix analogy supports explicit variants, not silently
  redefining the plain tag. Add `-base` instead.
- **Conditional `PROVIDER` build argument:** less target boilerplate, but mixes independent installers/pins
  and makes cache isolation and coverage harder to inspect. Named stages expose those boundaries.
- **BuildKit Bake:** useful orchestration, not a substitute for shared layers. Defer it unless it replaces
  matrix duplication and remains derived from `PROVIDERS`.
- **Fresh target image for every cross-Provider handoff:** easy image selection, but loses the source's
  installed tools and non-Workspace filesystem changes. Requires an explicit owner-approved semantic change.

## Consequences

- Most variants project to 1.217–1.394 GB compressed, 40–48% below the measured monolith. Those are
  projections, not built variants. Claude/Codex need separate layer measurements; their combined-layer
  ceiling is 1.561 GB. The shared 1.212 GB base remains the dominant first-use transfer.
- Switching Providers at one release pulls additional Agent blobs, not another identical base. Multiple
  releases, Snapshot deltas and build caches still consume space. Distinct final blobs should approach one
  monolith per architecture; do not add per-tag displayed sizes or promise a GHCR billing discount.
- Release validation grows from two builds to a generated matrix plus base/all jobs. The research estimates
  a 27–65 minute cold path under stated concurrency assumptions; actual arm64 sizes and CI timings remain
  implementation measurements. Keep cache retention and size budgets explicit.
- Snapshot payload augmentation is real extra work, with runtime compatibility, credential isolation and
  cleanup requirements. It is a separate implementation step and a rollout gate, not an incidental suffix fix.
- The research defines five implementation steps: Dockerfile/local builder, release matrix, Control Plane/UI,
  Snapshot compatibility, then documentation and measured release validation. Initial amd64 budgets are
  base ≤3.20 GB unpacked/1.27 GB gzip, ordinary variants ≤3.60/1.47 GB, and Claude/Codex each ≤4.10/1.65 GB
  until separately measured. Tighten budgets from evidence; do not hide growth in alternate size accounting.
- At implementation, update CHANGELOG, GUIDE, README and the Auto QA CI research, including truthful
  Stop/Resume behavior. Research-only commits do not announce shipped behavior in CHANGELOG.
- Owner approval is still needed for plain-tag retention, whole-filesystem fork augmentation versus a reduced
  handoff contract, local defaults, old-release donor retention and the CI budget. This Proposed ADR changes
  no build, image, Control Plane or runtime behavior.
