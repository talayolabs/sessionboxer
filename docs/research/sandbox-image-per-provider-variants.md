# Research: one Sandbox image per Provider

Question (2026-10-04): can Sessionboxer stop making every user download all 13 Agents, without moving
installation into Session boot? This is a design for the owner and implementation sessions, not a shipped
feature. [ADR-0088](../adr/0088-one-sandbox-image-per-provider.md) is **Proposed**; implementation waits for approval.

Short answer: **publish `<version>-<providerId>` variants, with one shared runtime and one Agent payload.**
The amd64 image built from `31b82ce` measures **2.319 GB compressed + 6.027 GB unpacked = 8.346 GB** in this
machine's containerd image store. The shared portion is **1.212 GB compressed / 3.084 GB unpacked**. Most
single-Provider images project to **1.217–1.394 GB compressed / 3.097–3.459 GB unpacked**; Claude Code and
Codex share a 900 MB install layer that must be split before measuring them independently. Keep the plain
version tag as the all-Providers compatibility image, add an explicit `-base` for VM helpers, and pull only
the variant needed by a Session or sign-in flow. Preserve cross-Provider snapshot forks: their whole-filesystem
semantics are the main complication, not the tag suffix. Do not silently replace them with a fresh Workspace.

## 1. What was measured

The checkout is `main` at [31b82ce](https://github.com/talayolabs/sessionboxer/commit/31b82cebea4a87c0290e32dd9b9f64b54b6e7ecc),
with package version `1.5.0` and the six additional Providers already merged. `npm i && npm run build` and
`npm run build:image` succeeded. The latter runs `scripts/build-image.mjs`, including its `extra-ca` BuildKit
secret and `EXTRA_CA_FINGERPRINT`. This is a build of that checkout using the available cache, not a clean,
cache-disabled build, not the published 1.5.0 image, and not an arm64 measurement. The local `:1.5.0` tag
therefore must not be mistaken for the historical release.

The measurement commands after the build were:

```sh
docker history --no-trunc --human=false --format '{{json .}}' sessionboxer/sandbox:dev
docker image inspect sessionboxer/sandbox:dev
docker image ls sessionboxer/sandbox:dev
docker info --format '{{.Driver}} {{json .DriverStatus}}'
docker image save sessionboxer/sandbox:dev -o /home/ubuntu/sandbox-measurement.tar
```

The archive path is local measurement output, not a repository artifact. To reproduce the compressed column,
read `index.json` in the saved OCI archive, follow its index to the `linux/amd64` manifest, and read each layer's
`size`. Follow `config.digest`, discard history entries with `empty_layer: true`, and zip the remaining entries
with the manifest layers, oldest first. They match the nonzero `docker history` rows exactly. Exclude the
attestation manifest. The layers use `application/vnd.oci.image.layer.v1.tar+gzip`.

| Measured quantity | Bytes | Decimal GB |
| --- | ---: | ---: |
| Sum of gzip layer descriptors, amd64 manifest | 2,319,300,247 | 2.319 |
| `docker image inspect` `Size` on this containerd store | 2,319,376,370 | 2.319 |
| Sum of nonzero `docker history` `Size` values | 6,026,862,592 | 6.027 |
| Compressed layers + unpacked history | 8,346,162,839 | 8.346 |
| `docker image ls` display | Rounded display, not an exact byte count | 8.35 |

The image index digest is `sha256:99aa2feb468b312c7756bf3e32d819c5f6a4fc44e2cbe3b6d7e8733f10f95b77`;
the amd64 manifest is `sha256:0478dea9629c866168091b6b6c4cc5d93f7f3b76b3745ce850265d940873a08a`.
All MB/GB here are decimal. History sizes describe unpacked layer accounting, not a filesystem `du` of live
files, and shared layers must not be summed once per tag to calculate incremental host disk use.

Docker reports `overlayfs` with `io.containerd.snapshotter.v1` on this machine. Its image store keeps both
compressed blobs and unpacked layers; see [Docker's disk-space explanation](https://docs.docker.com/engine/storage/containerd/).
That explains the 8.35 GB display. It is **not an 8.35 GB network download**. A cold pull of these exact blobs
would transfer about 2.319 GB plus small manifests/configs; this session did not push or pull them from GHCR.
Another Docker storage backend can report only unpacked size. Compare like representations, not `inspect`
on one machine with `image ls` on another.

## 2. Which layers belong to the Agent

These are actual install-layer measurements, not package download sizes. A row can contain more than one
binary or adapter. The Provider IDs come from `PROVIDERS` in `packages/protocol/src/common.ts`.

| Provider ID | Install-layer contents | Unpacked MB | Gzip MB |
| --- | --- | ---: | ---: |
| `claude-code` + `codex` | Claude Code, Claude Agent ACP, Codex ACP, in one `RUN` | 899.998 | 349.151 |
| `devin` | Devin CLI | 183.038 | 61.451 |
| `cursor` | Cursor Agent | 301.277 | 92.711 |
| `pi` | pi + pi ACP | 186.302 | 30.883 |
| `opencode` | OpenCode | 185.201 | 61.835 |
| `fx` | fx | 12.464 | 5.527 |
| `kimi` | Kimi CLI | 96.563 | 95.748 |
| `copilot` | Copilot binary and pre-unpacked distribution | 374.739 | 182.030 |
| `vibe` | Mistral Vibe | 201.228 | 74.807 |
| `grok` | Grok Build | 175.833 | 74.086 |
| `gemini` | Gemini CLI and dependencies | 173.011 | 32.274 |
| `qwen` | Qwen Code and dependencies | 153.145 | 46.978 |
| **All Provider install layers** | Exact sums before rounding | **2,942.800** | **1,107.481** |

There is no honest independent `docker history` size for Claude Code or Codex in this image. A second
measurement inside a `docker run --rm --network none --entrypoint sh` container separates their installed
directories with `du -s -B1`:

| Directory under `/usr/lib/node_modules` | Allocated MB | Apparent bytes, from `du -sb` |
| --- | ---: | ---: |
| `@anthropic-ai/claude-code` | 227.353 | 227,299,893 |
| `@agentclientprotocol/claude-agent-acp` | 287.789 | 264,792,977 |
| `@agentclientprotocol/codex-acp` | 381.940 | 378,115,119 |

Thus Claude's two directories occupy about 515 MB, and Codex's about 382 MB, **not independent OCI layers**.
Do not divide the 349 MB gzip layer in proportion: compressibility differs. The implementation must build and
measure each independently. The premise that every Agent adds 90–200 MB is also too narrow: fx is 12 MB,
Cursor 301 MB, and Copilot 375 MB unpacked.

The shared-runtime accounting is everything except the Provider install rows:

| Common content | Unpacked MB | Gzip MB |
| --- | ---: | ---: |
| Ubuntu 24.04 filesystem | 87.634 | 29.764 |
| Desktop, tools, Node 22 and apt-installed dependencies | 2,097.160 | 705.755 |
| uv/uvx | 49.754 | 19.946 |
| openvscode-server | 255.169 | 77.999 |
| Kokoro TTS model | 385.405 | 339.339 |
| Sessionboxer dependencies, compiled code, user/layout and configuration | 208.941 | 39.016 |
| **Shared total** | **3,084.063** | **1,211.819** |

The desktop/tool layer includes Xvfb, XFCE, x11vnc/noVNC, Firefox, fonts, xdotool, ImageMagick, ffmpeg,
Docker tooling, build tools, Python, git, gh, bb and SSH tools. The Sessionboxer portion includes the Daemon,
protocol, computer-use MCP, Sessionboxer MCP, MCP tee, themes, skills, entrypoint and VM helper scripts.
Its larger dependency layers are 60.203, 26.665, 26.665 and 90.071 MB. Provider-specific config templates and
empty directories are included in the shared subtotal; moving those few small files into payloads changes
the split slightly. This is a derived grouping of the monolith's measured layers, **not a built `-base` image**.

## 3. Expected pull and disk savings

The following projections add each measured Agent install layer to the measured shared subtotal. They
assume unchanged packaging and identical shared blobs; final `COPY` layers and removal of duplicate installs
will change the exact sizes. No variant was built in this research session.

| Image or group | Cold download GB | Unpacked GB | Containerd combined GB |
| --- | ---: | ---: | ---: |
| Measured monolith | 2.319 | 6.027 | 8.346 |
| Agent-free base, projected | 1.212 | 3.084 | 4.296 |
| `fx`, projected | 1.217 | 3.097 | 4.314 |
| `devin`, projected | 1.273 | 3.267 | 4.540 |
| `pi`, projected | 1.243 | 3.270 | 4.513 |
| `opencode`, projected | 1.274 | 3.269 | 4.543 |
| `cursor`, projected | 1.305 | 3.385 | 4.690 |
| `kimi`, projected | 1.308 | 3.181 | 4.488 |
| `copilot`, projected | 1.394 | 3.459 | 4.853 |
| `vibe`, projected | 1.287 | 3.285 | 4.572 |
| `grok`, projected | 1.286 | 3.260 | 4.546 |
| `gemini`, projected | 1.244 | 3.257 | 4.501 |
| `qwen`, projected | 1.259 | 3.237 | 4.496 |
| Claude **and** Codex together, conservative ceiling before splitting | 1.561 | 3.984 | 5.545 |

Most variants remove **40–48% of compressed transfer** and **43–49% of unpacked layer size** versus this
checkout's monolith. The combined Claude/Codex ceiling still removes 33% of transfer. Once the common blobs
are local, another Provider at the same release adds roughly its own payload: for example, about 62 MB
compressed for Devin or 182 MB for Copilot, not another 1.2 GB base. Pulling all variants approaches one base
plus all Agents, not 13 complete bases, provided their actual layer digests match. Snapshots, writable layers,
multiple releases and build caches are additional storage.

[Auto QA in CI](auto-qa-in-ci.md) measured **4.31 GB on disk / 1.72 GB compressed**, with pull times of
**61.9–85.8 seconds**, on an older GitHub runner image. Do not relabel that historical 4.31 GB as today's
8.35 GB: both software contents and storage accounting differ. Compared with the 1.72 GB transfer baseline,
the projected 1.217–1.394 GB variants reduce transfer by **19–29%**. At the same effective throughput,
`time × variant_bytes / 1.72 GB` projects **44–70 seconds**: about **12–25 seconds saved per cold job**.
For a Claude QA job, the unsplit 1.561 GB ceiling projects **56–78 seconds**, or **6–8 seconds saved**;
splitting Claude and Codex should improve that, but needs a measurement. The historical roughly 150-second
fixed job overhead might become about 125–138 seconds for the smaller variants, not disappear. Registry
latency, extraction, runner CPU and caching make these estimates, not a benchmark. Append a dated rerun to
that research document at implementation; keep its original measurements intact.

## 4. Runtime installation versus image variants

Runtime installation saves published variants and unused Agent bytes, but puts an installer between **New
Session** and an idle Agent. It needs network access to npm/vendor hosts, retries, checksums, writable caches,
locks, cancellation and another progress/error surface. A pinned top-level package does not pin every
transitive dependency. It weakens the offline/local-first path and can conflict with Sandbox network policy.
Fetching on the host and copying in avoids Sandbox egress, but moves rather than removes that installer.

It remains useful for an explicit developer experiment with an unreleased Provider, or an opt-in BYO image
whose owner controls a prewarmed artifact cache. It is not the default Session boot path. Variants still need
one registry pull on first use; offline users must preload the needed variants. Once present, boot requires
no Agent download. Keep existing auto-update suppression and checksum/version pins in the build.

## 5. Tags and the compatibility contract

Use `ghcr.io/talayolabs/sessionboxer-sandbox` for all variants. The suffix is the **exact protocol ID**, not a
marketing abbreviation: `1.6.0-claude-code`, not `1.6.0-claude`. `1.6.0` here is an illustrative next version,
not a release decision. The 13 suffixes are:

`claude-code`, `devin`, `codex`, `cursor`, `pi`, `opencode`, `fx`, `kimi`, `copilot`, `vibe`, `grok`, `gemini`, `qwen`.

| Tag | Proposed meaning |
| --- | --- |
| `<version>-<providerId>` | Shared runtime + exactly that Provider's supported Agent payload |
| `<version>-base` | Same runtime, no Agent; VM host helpers and image development |
| `<version>-all` and plain `<version>` | The same all-Providers manifest; compatibility and explicit offline preload |
| `latest-<providerId>`, `latest-base`, `latest-all` | Convenience aliases for the latest complete stable release |
| Plain `latest` | Alias of `latest-all`, preserving existing expectations |

The PostgreSQL analogy is selection by a stable suffix, not a reason to silently redefine an unsuffixed
image. PostgreSQL's plain version has a documented usable default; so should ours. Making `<version>`
agent-free would break older Control Planes and explicit overrides. Dropping it also breaks those consumers.
Making it Claude-only silently changes other Providers' behavior. **Keep it all-Providers**, at least through
the compatibility window; any later removal needs a separately announced major-version policy.

The Control Plane uses only versioned Provider/base tags by default, never `latest`. All tags of one release
carry the same Sessionboxer revision and common-runtime identity. Record OCI revision/version plus
Sessionboxer labels for Provider set, payload format and runtime compatibility. Version tags are operationally
immutable: publish a new release for an Agent pin change. Preserve old versioned variants while their
Snapshots/clients remain supported.

## 6. One Dockerfile, a shared runtime and isolated payload stages

The choices are not all mutually exclusive:

| Structure | Benefit | Problem |
| --- | --- | --- |
| Shared `base`, named Provider targets | Explicit dependency graph; inspectable targets; BuildKit skips unrelated branches | Installing Agents after a code-bearing base invalidates their downloads on every code change |
| One `PROVIDER` build argument and a conditional install | Small target list | A long conditional mixes pins, install paths and validation; changing the argument invalidates the install branch; easier to ship a missing/incorrect Agent |
| BuildKit Bake (`docker-bake.hcl`) | Coordinates many targets and cache inputs; useful for local all-variant builds | An orchestrator, not an alternative to a correct Dockerfile graph; another matrix must not drift from `PROVIDERS` |

**Choose named targets in one multi-stage Dockerfile**, with a refinement that preserves both cache ordering
and identical common layers. Build a stable `toolchain` stage containing pinned common downloads. Branch
each `agent-<providerId>` payload builder from it, independently of Sessionboxer source. Separately build
`base` from `toolchain` plus Sessionboxer dependencies/code/configuration. Each final `<providerId>` target
is `FROM base` plus a small, explicit copy of its payload and its metadata. Add `all` by copying those same
payloads, without rerunning installers. Keep `all` the default final target for raw legacy builds.

The conceptual graph is:

```text
toolchain ── agent-claude-code ── isolated payload ─┐
          ├─ agent-codex ─────── isolated payload ├─ final Provider targets / all
          ├─ ...                                 │
          └─ base (+ Sessionboxer code/config) ───┘
```

This is **not** 13 Dockerfiles, nor 13 copies of the shared runtime. Provider-specific instructions remain
distinct because their installers differ. Split the initial Claude/Codex npm install. Payloads need a
documented, collision-free layout, preferably under `/opt/sessionboxer/providers/<providerId>`, with owned
launchers and per-Provider configuration. Copy only their runtime closure, never a builder's whole `/usr`
or `/home/agent`. Include adapter packages, symlink targets, shared-library requirements and settings such
as `COPILOT_CLI_DIST_DIR`; preserve UID, PATH and executable behavior. Relocatability is a release gate, not
an assumption that arbitrary vendor installers support a different prefix.

Keep the intent of the existing “Everything above changes only when a pinned version does” comment:
pinned Agent downloads live in source-independent branches, package dependency layers precede source,
and frequently changing Sessionboxer code comes last in the common branch. A source-only edit must not
rerun Agent downloads; a single Provider pin must not rebuild the other 12 payloads. A final payload copy
can need repacking when `base` changes; that is different from downloading/installing it again.

Preserve `RUN --mount=type=secret,id=extra-ca` and the existing trust behavior. The Node build stage reads
the mount through `NODE_EXTRA_CA_CERTS`; the runtime tooling stage deliberately installs its certificate
bundle as `sessionboxer-extra.crt` in the system trust store, so later downloads trust it. **The mount itself
is not persisted, but that explicitly installed certificate is**, as [ADR-0015](../adr/0015-host-extra-ca-certificates-copied-into-sandboxes.md)
documents. These are CA certificates, not private keys. Preserve that custom-build behavior and runtime
overwrite/removal; do not accidentally promise that the image contains no host CA.

Keep host-bundle extraction in `scripts/build-image.mjs` and pass `EXTRA_CA_FINGERPRINT` into consuming
stages because changed secret contents alone do not invalidate cache. Branch payload installers from the
trust-configured toolchain and preserve Node's build-time trust setting. Do not replace the secret input with
a plaintext build argument or disable TLS verification. Do not publish local/custom-CA caches to public CI
cache refs; release builds use the same approved trust input on every branch. Test a private custom build
with a test CA, its runtime overwrite/removal, and the absence of unapproved host CAs from release layers.

Do not introduce Bake in the first change unless it replaces, rather than duplicates, matrix generation.
The existing build script can select `--target`; CI can derive targets from built protocol exports.

## 7. Release matrix, cache and storage

`.github/workflows/release.yml` builds `linux/amd64` on `ubuntu-24.04` and `linux/arm64` on
`ubuntu-24.04-arm`, pushes per-architecture digests, then joins them in `tag_manifest`. Preserve native
runners and digest-based joins. The proposed release graph is:

1. Build/test/package as before. Read `PROVIDERS` from the built protocol and emit the matrix. Assert exact
   equality with Docker targets, payload metadata, size-budget rows and smoke-test coverage; reject an
   unknown or missing Provider before publishing.
2. Build the shared `base` **once per architecture**, publish immutable staging digests, and export a registry
   cache in `mode=max`. Pin the Ubuntu input and use the same source/trust/build arguments for that release.
3. Fan out **13 × 2 = 26** Provider jobs after those base jobs. Use the exact base digest as the final parent,
   through a named build context or explicit external base stage, and import both common and Provider caches.
   Cache alone is not proof of sharing: assert common layer descriptors are identical across final manifests.
4. Assemble `all` twice from the already-built payload artifacts, without reinstallation. These are additional
   compatibility jobs, not hidden inside the count of 26. The two base jobs also produce the `-base` outputs.
5. Smoke-test each architecture/Provider: expected executable/version, adapter initialization without real
   credentials where supported, no other Agent payloads, image metadata, desktop/Daemon startup, and sizes.
6. Merge a two-platform manifest for every Provider, `base`, and `all`. Validate completeness before publishing
   aliases and the release. GHCR has no atomic transaction across tags: stage digests first, publish version
   tags only after all jobs pass, and update `latest-*` last. A failed matrix must not advance convenience tags.

Use separate cache refs per architecture and Provider: conceptually `buildcache-base-amd64`,
`buildcache-codex-amd64`, and their arm64 peers. Only one job writes each ref. Import the common cache and
the same Provider's prior cache; never let 26 jobs race to overwrite one ref. See the
[registry cache backend](https://docs.docker.com/build/cache/backends/registry/) and its `mode=max` behavior.
Cache refs are separate from release tags. Retain recent caches with a bounded cleanup policy; do not delete
released images or Snapshot dependencies as “cache.” Local all-target builds can share one BuildKit builder.

**CI time is a planning estimate, not measured release performance.** With two parallel base builds taking
10–20 minutes, Provider jobs taking 3–8 minutes including import/export, a concurrency cap of six, and
2–5 minutes of assembly/manifest work, the cold critical path is roughly
`10–20 + ceil(26/6) × (3–8) + 2–5 = 27–65 minutes`. Aggregate runner work is roughly 100–260 minutes.
A warm-cache release could take 10–35 minutes; TODO(verify): benchmark cold and warm runs on both native
runner types before committing to that budget. Runner quotas and repeated 1.2 GB base/cache imports can
dominate; if matrix overhead is excessive, batch several Provider targets per native runner while retaining
the same matrix coverage and independent manifests. Do not claim a 13× speedup or 13× wall-clock penalty.

**Registry bytes are content-addressed, not one full base per tag.** With this amd64 accounting, distinct final
blobs should approach `base + sum(payloads)`, about **2.32 GB compressed**, not
`13 × base + sum(payloads)`, about **16.86 GB**. Adding `base` and `all` tags mostly adds manifests if their
blobs are reused exactly. The two-architecture final set might be **4.2–5.6 GB** if arm64 is similar; this is
an estimate, not a measurement. For planning, allow a further **6–12 GB** for both-architecture build caches
and intermediate payload packaging, then measure and trim it. Max-mode caches can retain alternate
representations, obsolete pins and source branches; a neat tag count is not a storage limit.

GHCR's displayed per-tag sizes need not represent distinct physical storage. Nor should blob sharing be
treated as a billing guarantee: [GitHub's billing documentation](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-packages/about-billing-for-github-packages)
says Container registry storage and bandwidth are free at the research date, with advance notice for policy
changes. Keep an inventory of distinct digests and retained releases anyway; verify package visibility and
actual usage before assigning a monetary budget.

## 8. Control Plane selection and local development

`apps/control-plane/src/config.ts` exposes one `SANDBOX_IMAGE`. `docker.ts` holds one status and one
in-flight pull and defaults every create to it; `SessionManager.boot()` starts an eager `ensureImage()`.
`routes/system.ts` exposes one `/api/sandbox-image` status/retry pair; `NewSession.tsx` polls it. Change the
contract deliberately rather than doing a string replacement in `create()`.

The proposed responsibilities are:

- Resolve `sandboxImageFor(provider)` for Linux Sessions and Provider sign-in containers. Resolve a
  separate base/helper image for `vm-host.ts` KVM probes, `macos.ts` seed/helper operations and Linux
  desktop/Daemon sidecars whose Agent runs in a Windows/macOS guest. Thread explicit references through
  Docker helper methods, including `runTty`; otherwise Settings sign-in still pulls or assumes the monolith.
- Remove the eager all-Providers pull. Inspect lazily, and ensure the resolved image when creating a Session,
  starting a container-backed sign-in, or performing a VM helper operation. Group status and in-flight promises
  by **resolved image reference**, not only Provider: two Providers can share an explicit override. Deduplicate
  same-image pulls; bound concurrent different-image pulls and isolate their failures/retries.
- Keep the `SandboxImageStatus` fields (`image`, `state`, `received`, `total`, `error`) per image. Add a validated
  Provider/base selector to the status and retry routes; omission selects the default Provider for compatibility.
  `GET` can inspect and return `checking` without starting a download; a selected form can explicitly request
  a prefetch. The server-side Session/sign-in path still ensures the image even without the web UI.
- Have **New Session** request status for its selected Provider/Machine, show that reference in the existing
  progress banner, and retry only it. Ignore stale responses after switching the selector. Add progress to
  container-backed sign-in and VM-helper flows too. Do not reset one image's progress when another completes.
  Persist no bogus `ready` status across Control Plane restarts; re-inspect Docker. Count progress per layer,
  respecting already-local shared layers rather than advertising the full manifest as remaining transfer.
- Track the resolved image ID/digest and supported Provider set in Session/Snapshot diagnostics. Preserve
  explicit Snapshot image IDs: never overwrite `spec.image` with the default variant during a fork.

`SESSIONBOXER_IMAGE` remains an **exact reference override** for compatibility, including custom registries,
digests and local monolithic images. Do not append a suffix to a user-supplied reference. It applies to
Provider and helper paths as the single override does today. A labelled single-Provider override must fail
clearly for another Provider; an agent-free override must not boot a Linux Agent. Legacy/unlabelled custom
images need executable/adapter preflight rather than an invented “all Providers” label. Offer a documented
all-Providers local override first; defer template/per-Provider override syntax until it is needed.

For development, preserve no-argument `npm run build:image` as **all Providers**, with the same plain version
tag and `sessionboxer/sandbox:dev`. This keeps existing custom-image workflows working. Add the user-facing
`--provider` option, consuming it in the script rather than passing it verbatim to Docker. The proposed
command `npm run build:image -- --provider codex` builds only Codex and tags `<version>-codex` plus
`sessionboxer/sandbox:dev-codex`; it must not overwrite `:dev`. Add explicit `--provider base` / `--provider all`
selectors. These flags do not exist at the researched revision. Continue forwarding unrelated Docker build
arguments and supplying the extra-CA secret. An exact `SESSIONBOXER_IMAGE` is an additional/primary tag as
documented by the script, never silently rewritten to a family of tags.

A developer normally builds the one Provider being changed; use no argument for broad regression tests.
With no override the Control Plane finds the local versioned variant; with an override it uses the exact local
tag. Extend `ensureImage()`'s local-tag detection to `sessionboxer/sandbox:dev-*`: it only recognizes `:dev`
today and must not try pulling those development tags from Docker Hub. A missing local variant should name
the matching build command. Local builds with a different trust bundle are not guaranteed to share every
blob with release builds; the sharing budget applies within the same release/build inputs.

## 9. Snapshots, forks, handoffs and guest Machines

The Provider of an existing Session is not editable through `UpdateSessionRequest`. A fork **can** choose
another Provider: `sessions.ts` rejects cross-Provider `conversation: "continue"`, but supports `"new"` and
`"handoff"`. The Sessionboxer MCP exposes this through its fork/handoff flow. `snapshots.ts` calls Docker
commit and a fork provisions from that Snapshot's `imageId`. It preserves the whole Sandbox filesystem,
not only the git checkout. A Provider variant Snapshot therefore contains its origin Agent, not the target.

Same-Provider forks need no additional Agent: use the Snapshot image exactly. Legacy monolithic Snapshots
can keep cross-Provider behavior when the target executable is present. A variant cross-Provider fork must
not point at the origin Snapshot and hope the target binary exists. OCI layers also cannot generally be
“rebased” by swapping their parent: a Snapshot delta may depend on or delete arbitrary parent files.

**Recommended compatibility path, subject to owner approval:** retain whole-filesystem forks and add a
verified target payload to the fork's filesystem before its Daemon starts. Pull the target's variant for the
Snapshot's recorded release/runtime compatibility, extract only its manifest-listed immutable payload from
a non-running helper container, and stage it into the stopped fork container using Docker archive APIs.
Do not run npm, curl, a vendor installer or arbitrary Snapshot code to do that copy. Do not copy credentials,
home directories or the donor's entire root filesystem. The new fork can contain two installed Providers,
but still runs only its selected Provider. Record its installed Provider set, payload digest and compatibility
identity so later Snapshots/forks know what is actually there.

This requires a self-contained payload format from §6. Preserve launchers, symlinks, modes and configuration
without overwriting unrelated source files; reject unexpected collisions. Use the same-release donor by
default, verify its required runtime/ABI, preflight the target executable, and fail with a clear explanation
if the donor is unavailable or the Snapshot modified required libraries. Never substitute the latest Agent
silently. If the payload is already local the operation must work without network access. Clean up donor
containers on success, failure and cancellation. The extra storage is bounded by the target payload, not
a duplicated base; it becomes part of subsequent Snapshot deltas. Strip all installed Providers' secret
environment keys when committing, not only the selected Provider's keys; preserve the existing tmpfs login
design. Provider/runtime labels must survive the explicit `flatten()` rebuild, which reconstructs image
configuration and does not automatically preserve arbitrary labels.

The simpler alternative is a fresh target-Provider Sandbox seeded with Workspace files and the handoff
document. That loses installed system tools, other files and parts of Agent history: it is **a different
feature**, not a transparent fork replacement. Offer it only as an explicit reset/migration choice. If payload
augmentation cannot pass the whole-filesystem/cross-Provider tests, keep automatic variant selection behind
an opt-in until the owner chooses that reduced semantic contract. Do not break supported forks to ship tags.

Windows/macOS **guest Agent provisioning is unchanged**: Agents are installed in the guest, not supplied by
the Linux variant. Guest architecture support and Provider-specific limitations remain as documented in their
ADRs. The Linux helper/desktop sidecar still needs the common runtime and VM scripts, so use `-base`, not an
arbitrary Provider. `vm-host.ts` and `macos.ts` must ensure that image before using it; their previous eager
global pull goes away. VM environments already reject Snapshots/forks/rebuilds in
`SnapshotManager.assertSnapshottable`; this proposal does not add VM snapshots or change guest toolchains.

## 10. Upgrade and documentation

**Stop → Resume does not recreate a Sandbox from the latest image.** At the researched revision,
`SessionManager.resume()` starts the existing `containerId`, rejects a missing container, and reconnects.
`startSandbox()` refreshes selected Daemon/Sessionboxer files and CA material; it does not replace the base
or install another Agent. Likewise, the explicit Rebuild path flattens the existing filesystem and recreates
from that flattened image, not from a clean current release.

Existing Sessions therefore keep their monolithic filesystem, including when stopped and resumed after an
upgrade. Existing Snapshots remain usable under the existing compatibility checks. Newly created Linux
Sessions select variants; same-Provider forks inherit the source Snapshot. Do not prune the old image while
containers/Snapshots reference it. There is no automatic disk reclaim or forced migration in this design.
To obtain a clean smaller base, create a new Session and explicitly transfer needed work, retaining the old
Session until verified. A lossless in-place image-base replacement is not part of this change. A rollback can
point `SESSIONBOXER_IMAGE` at the all-Providers image for future containers, but does not rewrite existing ones.

At implementation, update the following documentation together:

- **CHANGELOG:** name the first variant release, plain-tag compatibility, per-Provider first-use pulls, local
  build flags and the truthful existing-Session behavior. Do not repeat the existing image-refresh shorthand
  as a guarantee that Stop → Resume replaces binaries.
- **GUIDE:** explain first-use progress/retry and offline preload for each Provider, how Settings sign-in can
  pull a variant before a Session exists, what a fork preserves, and how to move work to a clean image. Use
  second person and distinguish guest provisioning from Linux helper images.
- **README:** update custom-image/local-build examples and image footprint claims; label download versus
  unpacked/storage size and link the detailed compatibility guide.
- **Auto QA research and CI examples:** select the QA Provider variant, preserve the original 4.31 GB/1.72 GB
  measurement, and append timed amd64/arm64 measurements rather than replacing evidence with estimates.

No CHANGELOG entry is added for this research alone. `git log -p --follow -- CHANGELOG.md` records implemented
features referencing ADRs, not a convention of Proposed ADR/research announcements. The Auto QA research
commit [7469f0c](https://github.com/talayolabs/sessionboxer/commit/7469f0c21635b15133f2e858266f550534c4a782)
and canvas research commit [d9d33af](https://github.com/talayolabs/sessionboxer/commit/d9d33af643a24562ccb521ea42a8011528e704aa)
change only their research documents. This commit follows that separation.

## 11. Risks and release gates

| Risk | Mitigation / acceptance test |
| --- | --- |
| 26 Agent builds plus base/all jobs cost more than two monolithic jobs | Native runners, shared base digests, isolated registry caches, bounded concurrency; record cold/warm runner minutes before rollout |
| “Shared” builds produce different base layers | Pin one base digest per architecture; assert identical common descriptors across every final image |
| A Provider is added without an image | Generate from `PROVIDERS`; equality test across targets, smoke tests and budgets; complete matrix before tag promotion |
| Several variants or many releases consume disk/GHCR space | Show exact references; count distinct blobs and cache retention; never automatically prune live Snapshot dependencies |
| Cross-Provider handoff loses tools or cannot launch | Whole-filesystem fixture, target payload compatibility checks, offline fork tests; gate default rollout on success |
| A label claims a Provider that is absent or broken | Binary/ACP preflight, copied-payload manifest and checksum, missing-Agent errors before provisioning |
| Global image override breaks sign-in or VM helpers | Test exact overrides, unlabelled legacy images, base-only rejection and all-Providers fallback |
| Incomplete release has npm/Control Plane consumers but missing variants | Stage and validate all digests before release publication; fail clearly, never silently switch to another Provider |
| Moved installers lose CA trust or publish host-specific trust | Preserve secret mounts/fingerprint and ADR-0015 behavior; isolate custom-CA caches and inspect public release layers |
| Source edits rerun downloads / package relocation breaks an Agent | Cache-reuse tests and per-architecture offline launch/ACP tests, including adapter dependencies and symlink targets |

## 12. Implementation split and owner decisions

These are future child-session-sized changes, **not sessions to start before approval**. Declare image tags,
payload metadata, resolver signatures and status-selector semantics first. The release and Control Plane
work can then proceed separately against those interfaces; integration is gated on all steps.

| Step | Scope and dependency | Size / acceptance budget |
| --- | --- | --- |
| 1. Dockerfile and local builder | Named stages, split Claude/Codex, isolated payload manifests, extra CA, proposed `--provider` selectors. No Control Plane/release logic. | Measured amd64 base ≤ **3.20 GB unpacked / 1.27 GB gzip**; fx ≤ **3.25 / 1.29 GB**; other independently measured Providers ≤ **3.60 / 1.47 GB**; Claude and Codex each initially ≤ **4.10 / 1.65 GB**, tightened after separate measurement. All-Providers ≤ **6.30 / 2.45 GB**. No Agent downloads on source-only edits. |
| 2. Release matrix and evidence | Depends on stage/payload contract; generated Provider × architecture matrix, per-arch base, caches, all/base outputs, manifests, smoke/size report. | Same amd64 budgets; establish measured arm64 baselines before release, provisional ≤ amd64 caps + **15%**, with explicit review for exceptions. One common base digest per architecture; final unique compressed blobs target ≤ **5.6 GB** across both; cache retention target ≤ **12 GB**. Record CI time against §7 estimates. |
| 3. Control Plane and progress | Depends on resolver/tag contract; lazy per-reference manager, selection for Sessions/login/VM helpers, web status/retry, exact overrides and local errors. | **Zero image download at idle Control Plane startup**; first Linux Session pulls one variant only, second same-Provider Session transfers **0** image bytes; second Provider pulls no duplicate common blobs. No shipped image-size growth from this step. |
| 4. Snapshot/fork compatibility | Depends on payload contract and step 3; whole-filesystem cross-Provider augmentation, metadata/flatten preservation, cleanup and credential isolation. Keep default rollout gated until complete. | Same-Provider forks add **0** Agent bytes; a cross-Provider fork adds at most target payload + **10 MB** metadata/config overhead, not another base. Test continued/new/handoff conversations, older monoliths, missing donors, offline paths and custom-image rejection. |
| 5. Documentation and release validation | Depends on measured results from 1–4; CHANGELOG/GUIDE/README, Auto QA rerun, update ADR status only after approval and implementation. | **Zero** production/image bytes from docs; report download/unpacked/store numbers separately. Demonstrate ≥ **35%** compressed saving versus the measured monolith for the ordinary ≤1.47 GB variants; separately report Claude/Codex rather than extrapolating their combined layer. |

The snapshot work is its own step rather than hiding a semantic migration inside “Control Plane selection.”
Run the full `.github/workflows/ci.yml` checks for implementation changes and add the Docker/architecture
checks above. UI-driven regression testing belongs to implementation, not this documentation-only session.

Owner decisions before implementation:

1. **Plain tag:** approve keeping `<version>`/`latest` as `-all`, plus `-base`; decide the compatibility retention
   policy. Recommendation: no removal in this rollout, no default use of `-all` by the upgraded Control Plane.
2. **Cross-Provider forks:** approve payload augmentation preserving the whole filesystem, or explicitly
   choose a separate fresh-Workspace handoff with reduced semantics. Recommendation: preserve forks and
   gate automatic variants on that compatibility step.
3. **Local defaults:** approve no-argument build = all Providers, opt-in `--provider`, and an exact global
   `SESSIONBOXER_IMAGE`. Recommendation: preserve existing overrides; avoid template syntax initially.
4. **Migration and retention:** approve no automatic replacement/pruning of existing Sessions or Snapshots.
   Decide how long old release variants remain available for donor pulls; offline use needs preloaded donors.
5. **CI budget:** approve native builds plus two base/two all jobs, initial concurrency six and a cold-run
   planning ceiling around 65 minutes; revise from the first measured workflow, not from tag count alone.

TODO(verify) at implementation: independent Claude/Codex layers, arm64 sizes, payload relocation/offline fork
behavior, distinct GHCR blob/cache storage, cold/warm release time, and a real GitHub-runner QA pull. None is
represented here as a completed measurement.
