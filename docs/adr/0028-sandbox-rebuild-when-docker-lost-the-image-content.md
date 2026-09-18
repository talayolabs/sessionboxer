# Sandbox rebuild when Docker lost part of the image the box runs on

A user's snapshots started failing with `(HTTP code 404) no such container - NotFound: content digest sha256:a7bf…: not found` right after the WSL disk holding Docker had dropped and been repaired with `e2fsck`. The box itself was fine: the agent worked, terminals worked, only **Snapshot** (a `docker commit`) failed, after every turn.

## What the error is

With the containerd image store (Docker 29, `io.containerd.snapshotter.v1`), `docker commit` reads the container's *image* — its manifest, config and layer blobs in `/var/lib/containerd/io.containerd.content.v1.content/` — to write the new image on top of it. A running or stopped container does not need those blobs (its rootfs is a snapshot on disk), so a blob lost to a disk failure, or to `docker image prune` removing a Snapshot image a fork still runs on, goes unnoticed until the next commit. Reproduced here by deleting the config blob of a live box's image: `docker exec`, `docker stop`/`start` and `docker export` keep working; `docker commit` fails with `blob sha256:… expected at …: blob not found`; Docker reports both shapes (`content digest … not found` and `blob … not found`) as a 404, which dockerode surfaces as "no such container".

Stop → Resume does not help: it starts the same container (`docker start`), whose image is still the broken one. Nothing in Docker rebuilds a missing blob; the only way out is a new image that does not depend on the broken chain.

## Options

- **Tell the user to delete the Session** (rejected): the box holds work and the agent's memory.
- **`docker commit` with a different base** (impossible): commit always builds on the container's image.
- **`docker export | docker import`** (chosen): exports the container's whole filesystem as a tar and imports it as a fresh single-layer image with no parent, then a new container starts from it. Measured on a real box (~3.2 GB): 2m20s. Loses the layer history (the image is one layer the size of the full box) and the image config, which is put back with `--change` (USER, WORKDIR, ENTRYPOINT, CMD and the image's own ENV; the Session's own env — token, ids, git identity — is set on the new container as for any Sandbox, and never baked into the image).

## Decision

- `DockerManager.commit` recognises Docker's two missing-content messages and throws `MissingImageContentError`; the snapshot route turns it into a 409 with the digest and the fix (*This Sandbox needs a rebuild… (Snapshots → Rebuild Sandbox)*) instead of the raw `no such container`. Automatic snapshot failures, previously only logged, are broadcast as `snapshot_failed` so the UI shows them.
- `POST /sessions/:id/rebuild` (`SessionManager.rebuild`, serialised with the Session's snapshots): requires idle/stopped/error; stops the box; `flatten`s it into `sessionboxer/snapshot:<id>-<n>` recorded as a Snapshot with reason `rebuild`; renames the old container to `sbx-<id>-old`; creates and starts a new Sandbox from that image with the Session's current env and settings; reconnects the Daemon; removes the old container only then. On any failure the new container is removed, the old one renamed back, `containerId` restored and the Session set to `error: Rebuild failed: …` — Resume still starts the old box. The old box's death during a rebuild is expected and not reported as a crash.
- The latest `rebuild` Snapshot is the image the Sandbox runs on: it cannot be deleted (single or *Delete all*) while it is; the GC already keeps images containers use.
- UI: **Rebuild Sandbox** in the Snapshots dialog (confirmation names the cost: minutes, Session unavailable meanwhile), `rebuild` rows labelled in the list; the sidebar shows the Session as *creating* with the snapshot spinner while it runs.

Verified on a live box with its config blob deleted: snapshot → actionable 409; rebuild → 2m20s, marker file present, the agent answers from its previous context (Claude's session is on the filesystem), Snapshot works again (1 MB on top of the new image), a second rebuild on the rebuilt box also succeeds with no spurious *Sandbox exited unexpectedly*.

## Consequences

- A rebuilt Session costs a full-box image (GBs) that stays until the next rebuild. Earlier Snapshots stay usable for forks as long as *their* image chain is intact — which, when a base blob is gone, it may not be; forking such a Snapshot fails at `docker create`/`start` with the same missing-content error and is left as is.
- `flatten` recreates the container from Sessionboxer's own `create`, so runtime settings (limits, Docker mode, network) come from the current Settings and Session, not from the old container.
- Not covered: a missing *layer* blob may also break `docker export` (the rootfs snapshot is usually still on disk, but this was not reproduced); the rebuild then fails cleanly and the old box is kept.
