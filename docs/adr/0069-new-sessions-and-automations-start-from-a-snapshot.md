# ADR 0069: New Sessions and automations can start from a snapshot

## Status

Accepted

## Context

A snapshot (ADR-0009) is an image of a whole Sandbox — files, installed tools, browser state, the agent's own session files — and the only way to start something from one was **Fork** on that Session: continue its conversation, or start a new one, from that point. That is the right shape when you are inside the Session. It is the wrong shape for two other cases: the New session screen, where you know you want "the box I set up yesterday, with the toolchain installed and the repositories cloned" but with a new task, and an automation's *New Session* action, which today clones its repositories fresh on every run and pays the setup (dependencies, builds, logins) every time.

## Decision

**A new Session can start from a snapshot; a snapshot is picked where the Environment is.** `POST /api/sessions` takes an optional `snapshotId`: the Control Plane then runs the fork path with a *new* conversation (`SessionManager.createFromSnapshot` → `fork(origin, { conversation: "new", … })`), so the Sandbox starts from that image with the agent asked for, the settings asked for (Docker, CPUs, memory, instructions, MCP servers…) and the Snapshot's Environment — a snapshot is a disk of one kind — while the request's prompt and attached files land as the first message like in any new Session. `repos` must be empty: the repositories are in the image, and can be added once the Session runs. The title defaults to the prompt's, then to `<origin> (from snapshot N)`.

**One dropdown, two groups.** The Environment pick of the New session toolbar, of its Advanced → Environment section and of an automation's New Session action is one `EnvironmentPicker`: under **New**, Docker · Linux, QEMU · Windows, QEMU · macOS as before; under **Recent snapshots**, the newest twenty snapshots of every Session (`GET /api/snapshots/recent`, with the Session's title, agent and Environment; Windows and macOS Sessions have none) plus the ones picked lately on this browser (`?include=`, so a pick older than the twenty still shows). Picking a snapshot sets the Environment to the snapshot's and takes the repository editor away (the button reads *Snapshot's repositories*); picking an Environment clears the snapshot. The picker is the form's own state (`SessionSettingsDraft.snapshotId`), not a Session setting: it exists only at creation.

**Automations.** `NewSessionAction.snapshotId` makes every run start from that image instead of cloning the template's repositories; the run goes through the same `create` request. With a pull request trigger, *checkout the PR head* cannot clone into an image, so it becomes the first line of the prompt instead: which PR, its head commit, and the `git fetch origin pull/N/head` / `refs/pull-requests/N/from` to run in the repository's directory.

## Consequences

- The setup of a Sandbox is done once and reused: pick the snapshot, type the task. An automation on a snapshot skips the clone and the install on every run — and runs against the code as it was in the snapshot until the prompt (or the PR head line) tells the agent to pull.
- A snapshot's image must still be in Docker; a Session from a deleted image fails to start with the same message a fork does. Automatic snapshots are pruned (`snapshotKeep`); a snapshot meant to be started from should be a manual one (kept), or its Session's keep count raised.
- The origin Session is untouched, as with a fork; the new Session shows *forked from origin @ snapshot N* in its transcript marker, and the origin's snapshot cannot be deleted while a Session started from it exists.
- The MCP `session_create` tool keeps starting from a fresh Sandbox; `session_fork` with `conversation: "new"` is the agent's way to the same result.
