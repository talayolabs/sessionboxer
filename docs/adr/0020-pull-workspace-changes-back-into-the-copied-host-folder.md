# Pull Workspace changes back into the copied host folder

A Session started from **Copy a host directory** got a one-way copy: the agent's work stayed in the Sandbox, and getting it back meant committing and pushing from the box or copying files by hand, which is the main reason people reach for worktree-based tools instead. Users want a button that brings the box's changes into the folder they started from, without touching what they were doing there meanwhile. The questions were how to move the files, how to tell "the agent changed it" from "I changed it", and how far to go towards worktrees and branches.

## Considered Options

### How the files move

- **Manifest + tar of the selected files, applied by the Control Plane (chosen)**: the Daemon answers `_sessionboxer/fs/manifest` with every eligible Workspace path and its SHA-256, executable bit and symlink target (`git ls-files --cached --others --exclude-standard` when `/workspace` is a git repository, a directory walk otherwise; never `.git`, `node_modules`, `.venv`, `__pycache__`), and `POST /fs/tar` on its HTTP port streams a tar of exactly the paths asked for. The Control Plane builds the same manifest of the host folder, plans, pulls one tar of the additions and updates and extracts it with `tar-fs` (which refuses symlinks leaving the destination and refuses to write through an existing symlink), then removes the deletions and now-empty directories. Symlinks are copied as symlinks, modes as modes; nothing is dereferenced on either side. Ignored files are neither hashed nor sent, so a `node_modules` in the box never lands on the host and a host-only one is never deleted.
- `rsync` between host and container: needs `rsync` on both ends and an ssh or `docker exec` transport; the daemon-side listing is what rsync would compute anyway, and doing it ourselves keeps the same containment checks as the raw-file and terminal routes.
- `git diff` in the box applied as a patch on the host: only works for git Workspaces, breaks on untracked and binary files and on a host tree that moved on, and says nothing about non-git folders.
- Bind-mounting the host folder into the Sandbox instead of copying: continuous, but every agent mistake hits the real folder immediately and the box would no longer be a snapshot-able unit; rejected in ADR-0005's spirit (the Sandbox is disposable, the host folder is not).

### Telling the agent's changes from the user's

- **Three-way against a recorded baseline (chosen)**: after the initial copy the Control Plane records the manifest under `~/.sessionboxer/sync/<session id>.json` (the common ancestor). A pull compares box and host with it: box changed only → apply (add, update, delete); host changed only → keep, counted as "changed only on your machine"; both changed → conflict, listed but skipped by default; identical → nothing. The baseline is rewritten after each pull from the state actually applied, so a skipped conflict stays a conflict and a host-only change stays host-only next time. Sessions created before this feature have no baseline: additions and updates apply over whatever is there and deletions are all shown as conflicts, with a notice in the dialog; the first pull records one.
- Two-way (box vs. host, no baseline): cannot tell a host addition from a box deletion; would either never delete or delete the user's new files.
- Comparing against the snapshot image: the snapshot is the box's state, not the host's, so it does not know what the user did on the host either, and the initial copy is not a snapshot.

### Conflicts and safety

- **Skip by default, explicit overwrite (chosen)**: `POST /api/sessions/:id/sync` takes `{ overwriteLocal }`; the dialog shows the plan first (`GET` is a dry run), the checkbox says how many files it would overwrite, and the button asks to confirm. Symlinks whose target resolves outside the folder are `blocked` in the plan and never written, even with overwrite on, so a hostile or careless `ln -s /etc/passwd` in the box cannot reach the host. The destination is always the canonical path stored on the Session (`resolveHostDir`, symlinks resolved), never a client-supplied path; ancestors that are symlinks escaping it are refused. A pull is refused while the agent's turn is running (files would be half-written) and while another pull is in progress; it needs the Sandbox running.
- Always overwrite, git-style "theirs": loses host edits silently; the whole point of the feature is that the folder is the user's working copy.
- Writing a `.orig`/`.rej` next to conflicts: leaves junk in a folder that is often a git checkout; the plan view plus the checkbox is enough for the case at hand.

### Worktrees and branches

- **Not now (chosen)**: "apply as a patch to a new host branch or worktree" is a different product decision (where does the worktree go, who commits, what about non-git folders) and the pull as designed already gives a git user the equivalent: pull into the checkout, `git stash`/`git checkout -b` on the host as they like. Left for a later ADR if asked.

## Consequences

- Protocol: `SyncFile`, `SyncManifest`, `FsTarRequest`, `SyncEntry` (`action`, `conflict`, `blocked`), `SyncPlan`, `SyncRequest`, `SyncResult`, `FS_TAR_PATH`, `DAEMON_METHODS.fsManifest`. No image change is required beyond the Daemon build (Stop → Resume picks it up).
- Daemon: `workspace-sync.ts` (`workspaceManifest`, `serveTar`); `POST /fs/tar` shares the HTTP port with raw files and the VS Code proxy.
- Control Plane: `host-sync.ts` (`hostManifest`, `SyncBaselines`, `planSync`, `selectEntries`, `nextBaseline`, `applySync`); `SessionManager.syncPlan|syncPull`, baseline recorded after `seedWorkspace` and removed with the Session; `GET|POST /api/sessions/:id/sync`. New dependency `tar-fs`.
- Web: `SyncDialog.tsx` (plan, conflicts, overwrite, result), **Pull to folder…** in the Session header for copy Sessions only, `SourceIcon.tsx` (folder / git / fork) next to the Provider icon in the list and in the header with the source as tooltip.
- Not done: pulling into a new branch or worktree, pulling automatically after each turn, a per-file pick in the dialog, pulling for Sessions forked from a copy Session (the fork's source is the snapshot, not the folder).
