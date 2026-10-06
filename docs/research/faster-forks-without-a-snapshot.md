# Research: faster forks when the Session has no Snapshot to fork from

Question (2026-10-06): forking a Session that has no Snapshot (or whose fork point is "now") is slow.
Where does the time go, and does a fork need a Snapshot at all — is there another way to get an
isolated copy of the Sandbox?

## Short answer

Almost all of the time is `docker commit`, and almost all of `docker commit` is **gzip**. With the
containerd image store (the default of Docker Engine 29 and Docker Desktop) a commit compresses the
container's whole writable layer into the content store before the new image exists
([moby `image_commit.go`](https://github.com/moby/moby/blob/v28.0.0/daemon/containerd/image_commit.go)
asks the differ for `MediaTypeImageLayerGzip`). Measured here: 1.1 GB written in the Sandbox →
30 s commit, of which tar alone is 0.6 s and `tar | gzip -1` is 25 s. Starting the fork's container
from the committed image is then 0.6 s and its Desktop is ready 0.4 s later.

A fork does not need an image. An isolated copy is a **new container from the origin's own image
plus the origin's delta** (`docker diff` → tar out of the paused origin → tar into the stopped fork,
deletions applied). Measured on the same data: **5.5 s instead of 30 s** for 1.1 GB, **0.8 s instead
of 8.9 s** for an `npm install` of 285 MB. No image is written, no disk is doubled, nothing to GC.
What it gives up: a fork point that can be forked from again later — that is what a Snapshot is for,
and the dialog keeps offering it.

Side finding: a commit diffs the container against the image it was **created from**, not against
the previous Snapshot. The second commit of the benchmark, after 10 MB more, produced a 1.14 GB layer
again (22 s). Every automatic Snapshot of a Session therefore re-compresses everything the Sandbox
has ever written and stores a full copy; ADR-0009's "shared layers between Snapshots … counted once
per Snapshot, not once physically" does not hold on this store. See §5.

## 1. Where a "fork now" spends its time

`SessionManager.fork` (`apps/control-plane/src/sessions.ts`): with no `snapshotId`, `snapshotPolicy.take(id,
"manual")` runs first and `provision()` afterwards. Measured on this VM (8 vCPU, Docker 29.7.2, containerd
store, `sessionboxer/sandbox:dev` = 1.6.0, 2.32 GB unpacked), scripts in the commit message of this file:

| Step | 1.1 GB rw layer (100 × 10 MB random + 20 000 small files) | 285 MB rw layer (`npm i typescript vite react eslint`, a few dotfiles) |
| --- | ---: | ---: |
| `docker commit -p` (origin paused meanwhile) | **30.3 s** (22.3 s when the files are in page cache) | **8.9 s** |
| `tar -cf - workspace \| cat` inside the Sandbox | 0.6 s | — |
| `tar -cf - workspace \| gzip -1` inside the Sandbox | 25.0 s | — |
| `docker create` from the commit image | 0.5 s | — |
| `docker start` (sleep entrypoint) | 0.1 s | — |
| Real entrypoint to `[entrypoint] desktop ready` | 0.4 s | — |
| **Delta copy instead (§2), origin paused meanwhile** | **5.5 s** | **0.8 s** |

The rest of a fork — `syncDaemon` (the checkout's Daemon build, a few MB), CA certificates, the Daemon
connecting, the Agent's `session/load` — is the same for every new Session and is not what makes a
fork slow. Docker-mode `privileged` Sandboxes carry `/var/lib/docker` as an anonymous volume, so their
images are not in the commit either way.

The gzip is not optional: the Engine API's commit endpoint has no compression parameter, and
containerd's differ defaults to gzip. The classic `overlay2` graphdriver stores commit layers
uncompressed (inference from its code path, not measured here); most installs no longer use it.

## 2. An isolated copy without an image: copy the delta

What makes a fork isolated is its own container. The container's filesystem has two parts: the image
the origin was created from (`Session.image.reference` — a Sandbox image or a Snapshot image, both
already present on the host) and the origin's writable layer. The fork can start from the same image
and receive only the writable layer:

1. `docker diff <origin>` lists every path the writable layer adds (`A`), changes (`C`) or deletes
   (`D`) relative to the image — 3 935 entries for the `npm install` case.
2. Collapse the list to **archive roots**: a path whose parent is itself `A` is covered by the
   parent (a new directory is copied whole); a `C` entry that is the parent of another entry is a
   directory something changed under, and is skipped (only its children are copied). The `npm
   install` case collapses to 4 roots (`/workspace/proj`, `/home/agent/.npm`,
   `/home/agent/.claude/projects`, `/home/agent/.claude.json`) and 1 deletion (`.bashrc`); the 1.1 GB
   case to 2 roots.
3. `docker pause <origin>`; for each root, `getArchive` from the origin streamed into `putArchive`
   on the created-but-not-started fork (`copyUIDGID`, so `agent` stays the owner); `docker unpause`.
   The pause is what `commit -p` does today, for the same reason (a consistent copy); it is held
   for 0.8–5.5 s instead of 9–30 s.
4. Apply the deletions in the fork before it starts (`rm -rf` through a one-shot exec, or by
   putting an archive of whiteout-free empty parents — the exec is simpler).
5. `startSandbox` as today.

Edge cases, and what the existing code already knows about them:

- Hard links: Docker's `getArchive` emits a repeated inode as a tar `link` entry with an
  archive-relative linkname (found in ADR-0088 step 4, `provider-payload.ts`). Within one root
  `putArchive` restores them; a link whose target is in another root cannot be restored by tar, so
  roots are copied **largest-first in one tar stream per root and links across roots fall back to a
  file copy** — or simpler: collapse further so that a hard link and its target share a root
  (they are in the same Provider payload or `node_modules` in every case seen).
- Changed directories (`C`) keep the image's mode/owner/mtime in the fork; the content under them is
  copied. Acceptable (a commit preserves them, nobody depends on it).
- Sockets, FIFOs and lock files under `/tmp` and `/run` are skipped (tar cannot carry sockets; the
  entrypoint already removes the X lock on boot).
- fx's state volume is a named volume and is not in a commit either; a fork copies nothing of it today
  and would copy nothing of it with the delta.
- Cross-Provider forks (ADR-0052/0088 §9) work unchanged: `payloads.need()` looks at the fork's image
  reference, which is the origin's image.
- `docker diff` on a big writable layer walks it (included in the 5.5 s).
- A Session created from a Snapshot image whose base layers went missing cannot be committed today
  (`MissingImageContentError` → "Rebuild Sandbox"); a delta copy from it works as long as the image
  itself can still start a container, which is the same condition the origin is already meeting.

### What the fork loses without a Snapshot

A Snapshot is a fork point that can be used again: fork twice from the same moment, start a new Session
from it (ADR-0069), or an Automation from it. A delta-copied fork has none of that; its
`workspaceSource` records the origin and the `eventSeq` of the fork point, nothing else. That is the
right trade for "fork now, I want a second line of work": whoever wants to come back to the moment can
take a Snapshot (it is the same cost as today, taken explicitly, and the dialog says so).

## 3. Options

- **A. Fork now by delta copy** (§2). 4–11× faster on the measurements above, no image, no disk, no GC;
  the fork point is not reusable. Changes: `SandboxDocker.copyDelta(originId, forkId)` + a pure
  `archiveRoots(diff)` in `docker.ts` (unit-tested), `fork()` takes the delta path when `existing` is
  undefined, `WorkspaceSource.fork.snapshotId` becomes optional (protocol, UI's `forkedFrom`, the
  "Snapshot some fork references cannot be deleted" rule, the pruning rule), the dialog's "Now" label
  stops saying "a snapshot is taken with the fork".
- **B. Default the dialog to the newest Snapshot when it is current.** `autoSnapshot` is on by default,
  so an idle Session usually has a Snapshot taken at the end of its last turn (`eventSeq` = last
  `turn_ended`). Preselect it instead of "Now"; the fork then starts in ~1 s. It misses what was
  changed by hand after the turn (terminal, Code pane, Desktop); the label has to say "as of the last
  turn". A cheap staleness hint exists — `SizeRw` of the container now vs `Session.diskBytes` refreshed
  after that Snapshot — but it is a hint, not proof. Pairs with A: A for "now", B as the default when
  nothing happened since.
- **C. Keep committing, hide the wait.** Start the fork's row and the UI immediately and run the commit
  in the background (the fork shows "copying the Sandbox…"). Nothing gets faster; the origin is still
  paused for the whole commit, which is the part users feel.
- **D. Fork inside the same Sandbox, CRIU, overlayfs tricks.** ADR-0009 rejected an in-Sandbox fork
  (one Sandbox per Session). `docker checkpoint` (CRIU) is experimental, Linux-only, and copies
  process state, not the filesystem. Cloning the origin's overlayfs upper directory as a new lower
  layer needs root on the Docker host and a containerd snapshot that Docker does not expose; impossible
  behind Docker Desktop's VM. Not pursued.

Recommendation: **A, then B.** A removes the commit from the fork path; B makes the common case free.

## 4. Plan for A

1. `docker.ts`: `archiveRoots(diff: Array<{ kind: "A" | "C" | "D"; path: string }>): { roots: string[]; deleted: string[] }`
   (pure, ~25 lines, the collapse of §2 step 2), `diff(containerId)`, `copyDelta(fromId, toId, { onProgress })`
   doing pause → stream each root (`getArchive` piped to `putArchive` with `copyUIDGID`) → unpause in a
   `finally`, and `removePaths(containerId, paths)` for the deletions. One test file,
   `scripts/archive-roots.test.mjs`, wired into `package.json` and `ci.yml` like the other `test:*`.
2. `protocol`: `workspaceSource` fork variant gains `snapshotId?: string` and `eventSeq: number`;
   `Session.forkedFrom.snapshotId` nullable. `db.ts`: the "fork references this Snapshot" queries tolerate
   null. Size budget: `sessions.ts` is already listed in `scripts/size-budget.mjs`; the delta path
   belongs in a new `apps/control-plane/src/fork-delta.ts` rather than growing it.
3. `sessions.ts` `fork()`: `existing ?? delta`; `provision()` gets an `origin` to copy from instead of
   an image; the `forked` event and the fork's title say "fork now" instead of "fork 3". The
   `handoff` conversation keeps working (the hidden turn runs on the origin first, then the delta is
   copied — later than today's commit, which is actually more correct: the handoff document's files are
   in the fork).
4. Web: `ForkDialog` "Now · copies the Sandbox, no snapshot"; `forkedFrom` without a Snapshot link;
   the Snapshots pane's "forked from" marker for a delta fork.
5. Docs: ADR-0089 "A fork now copies the origin's delta into a new Sandbox instead of committing an
   image" (ADR-0009 amended: Snapshots stay the reusable fork points), GUIDE "Fork" section, CHANGELOG.
6. Verification: the headless recipe in `docs/research/sandbox-image-per-provider-variants.md` §10
   (dummy Codex credential, `POST /fork` without `snapshotId`); timings logged like Snapshots are
   (`fork <id>: copied N MB in M roots in T ms`); a 1 GB `/workspace` as the regression number
   (≤ 8 s on this VM where the commit takes 30 s).

## 5. Follow-up worth its own decision: Snapshot cost grows with the Session's age

Because a commit diffs against the container's image, Snapshot #n of a Session that has written 1 GB
takes ~25 s and stores ~1 GB compressed, however little changed since Snapshot #n−1, and
`snapshotKeep = 10` keeps ten full copies. Two ways out, neither free:

- Recreate the container from the newest Snapshot image on **Resume** (its writable layer restarts
  empty; later commits are small). Stop → Resume today reuses the container; the change is visible
  (new container id, `/tmp` gone, Docker-mode state lives in a volume and survives).
- Let the Agent's turn-end Snapshot be the delta copy's twin: commit only every k-th turn.

Not part of A; recorded so the sizes in the sidebar are read with this in mind.

## Open questions (defaults in bold)

- Should "Now" stay available when the origin is `running` (mid-turn)? **Yes**, as today: the pause makes
  the copy consistent; the fork's Agent sees a mid-turn filesystem exactly as with a commit.
- Deletions through `exec rm -rf` on the stopped fork (needs a start) or by starting the fork with a
  one-shot command? **Apply them after `start`, before the Daemon connects**, through the Daemon's
  `fs` RPC the Code pane already uses — no new mechanism.
- Progress in the UI while the delta copies? **Bytes copied so far on the fork's row**, from
  `onProgress`, like image pulls.

## References

- `apps/control-plane/src/sessions.ts` `fork()`, `provision()`; `apps/control-plane/src/snapshots.ts`
  `doSnapshot()`; `apps/control-plane/src/docker.ts` `commit()`.
- ADR-0009 (Snapshots via `docker commit`, forks as new Sandboxes), ADR-0052 (forks with another Agent),
  ADR-0069 (new Sessions from a Snapshot), ADR-0088 §9 (payload injection, `getArchive` hard links).
- moby `daemon/containerd/image_commit.go` (`createDiff`, `MediaTypeImageLayerGzip`).
