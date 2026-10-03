import { randomBytes } from "node:crypto";
import {
  type DeleteSnapshotsResult,
  type Environment,
  PROVIDER_ENV_KEYS,
  resolveSessionSettings,
  type Session,
  type SessionBroadcast,
  type Settings,
  type Snapshot,
  type SnapshotReason,
  VM_NO_SNAPSHOT,
} from "@sessionboxer/protocol";
import type { Db, SessionPatch } from "./db.js";
import { MissingImageContentError, SNAPSHOT_REPO, type SandboxDocker } from "./docker.js";
import { HttpError } from "./http-error.js";
import type { GuestVms } from "./vm-host.js";

const REBUILD_HINT = "This Sandbox needs a rebuild before it can be snapshotted again (Snapshots \u2192 Rebuild Sandbox)";

/** What the Snapshot policy needs from the rest of the Control Plane; no back-reference to `SessionManager`. */
export interface SnapshotPolicyDeps {
  db: Db;
  docker: Pick<SandboxDocker, "commit" | "removeImage" | "listSnapshotImageIds" | "diskUsage">;
  settings: () => Settings;
  /** The Session, or a 404 `HttpError`. */
  get: (id: string) => Session;
  /** Patches the Session and broadcasts it (`diskBytes`). */
  update: (id: string, patch: SessionPatch) => Session;
  broadcast: (msg: SessionBroadcast) => void;
  log: (msg: string) => void;
  /** The VMs of a VM Environment (their disk counts towards the Session's); null for `docker-linux`. */
  vms: (environment: Environment) => GuestVms | null;
  /** Tells the Session's Daemon what changed about it (the Snapshot count, for the Agent's tools). */
  pushSessionInfo: (id: string) => Promise<void>;
}

/**
 * Snapshots of the Sandboxes: taking one (`docker commit`, serialized per Session), the automatic
 * one after a turn, pruning to `snapshotKeep`, deleting, and collecting orphan images.
 * Extracted from `SessionManager` (docs/TECH-DEBT.md, fix 7); rebuilds stay there and only
 * share the per-Session chain.
 */
export class SnapshotPolicy {
  /** Per-Session chain so Snapshots of one Sandbox never overlap. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SnapshotPolicyDeps) {}

  list(id: string): Snapshot[] {
    this.deps.get(id);
    return this.deps.db.listSnapshots(id);
  }

  /**
   * `docker commit` of the Sandbox as it is now. Serialized per Session; the
   * container is paused for the few seconds the commit takes. Automatic
   * Snapshots (`reason: "turn"`) are pruned to `Settings.snapshotKeep`.
   */
  take(id: string, reason: SnapshotReason, eventSeq?: number): Promise<Snapshot> {
    return this.chain(id, () => this.doSnapshot(id, reason, eventSeq));
  }

  /** Runs `op` after the Session's Snapshots (and rebuilds) in flight, and before the next. */
  chain<T>(id: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const run = prev.then(op, op);
    this.chains.set(id, run);
    const settle = (): void => {
      if (this.chains.get(id) === run) this.chains.delete(id);
    };
    run.then(settle, settle);
    return run;
  }

  /** Resolves once the Session's Snapshot in flight, if any, is over (whatever its outcome). */
  async whenIdle(id: string): Promise<void> {
    await this.chains.get(id)?.catch(() => undefined);
  }

  /** Snapshots, forks and rebuilds need the whole Workspace in the Sandbox's image, which VM Environments do not have. */
  assertSnapshottable(environment: Environment): void {
    const reason = VM_NO_SNAPSHOT[environment];
    if (reason) throw new HttpError(409, reason);
  }

  private async doSnapshot(id: string, reason: SnapshotReason, eventSeq?: number): Promise<Snapshot> {
    const s = this.deps.get(id);
    this.assertSnapshottable(s.settings.sandbox.environment);
    if (!s.containerId || (s.status !== "idle" && s.status !== "running")) {
      throw new HttpError(409, `Session is ${s.status}; Snapshots need a running Sandbox.`);
    }
    const snapshotId = randomBytes(6).toString("hex");
    const ordinal = this.deps.db.nextSnapshotOrdinal(id);
    const tag = `${id}-${ordinal}`;
    this.deps.broadcast({ type: "snapshotting", sessionId: id, active: true });
    try {
      const started = Date.now();
      const { imageId, sizeBytes } = await this.deps.docker
        .commit(s.containerId, { snapshotId, tag, stripEnv: [...PROVIDER_ENV_KEYS[s.provider]] })
        .catch((e: unknown) => {
          if (e instanceof MissingImageContentError) throw new HttpError(409, `${REBUILD_HINT}: ${e.message}.`);
          throw e;
        });
      const snapshot: Snapshot = {
        id: snapshotId,
        sessionId: id,
        ordinal,
        reason,
        imageTag: `${SNAPSHOT_REPO}:${tag}`,
        imageId,
        eventSeq: eventSeq ?? this.deps.db.lastEventSeq(id),
        branchId: s.activeBranchId,
        sizeBytes,
        queuedMessages: this.deps.db.listSavedMessages(id).map((m) => m.text),
        createdAt: new Date().toISOString(),
      };
      this.deps.db.insertSnapshot(snapshot);
      this.deps.log(`snapshot ${id}#${ordinal} ${(sizeBytes / 1024 ** 2).toFixed(1)} MB in ${Date.now() - started} ms`);
      await this.prune(id);
      this.broadcastSnapshots(id);
      await this.refreshDiskUsage(id);
      void this.deps.pushSessionInfo(id);
      return snapshot;
    } finally {
      this.deps.broadcast({ type: "snapshotting", sessionId: id, active: false });
    }
  }

  async delete(id: string, snapshotId: string): Promise<void> {
    this.deps.get(id);
    const snapshot = this.deps.db.getSnapshot(id, snapshotId);
    if (!snapshot) throw new HttpError(404, `snapshot ${snapshotId} not found`);
    const forks = this.deps.db.countForksOf(snapshotId);
    if (forks > 0) throw new HttpError(409, `Snapshot ${snapshot.ordinal} is the origin of ${forks} Session(s); delete them first.`);
    if (this.sandboxBase(id)?.id === snapshotId) throw new HttpError(409, `Snapshot ${snapshot.ordinal} is the image the Sandbox runs on.`);
    await this.deps.docker.removeImage(snapshot.imageId);
    this.deps.db.deleteSnapshot(id, snapshotId);
    this.broadcastSnapshots(id);
  }

  /** The `rebuild` Snapshot the Session's Sandbox was created from, if any (its image is in use). */
  private sandboxBase(id: string): Snapshot | undefined {
    return this.deps.db
      .listSnapshots(id)
      .filter((s) => s.reason === "rebuild")
      .at(-1);
  }

  /** Deletes every Snapshot of the Session except those a fork was started from or the Sandbox runs on. */
  async deleteAll(id: string): Promise<DeleteSnapshotsResult> {
    this.deps.get(id);
    let deleted = 0;
    let kept = 0;
    const base = this.sandboxBase(id);
    for (const snapshot of this.deps.db.listSnapshots(id)) {
      if (this.deps.db.countForksOf(snapshot.id) > 0 || snapshot.id === base?.id) {
        kept++;
        continue;
      }
      await this.deps.docker.removeImage(snapshot.imageId);
      this.deps.db.deleteSnapshot(id, snapshot.id);
      deleted++;
    }
    this.broadcastSnapshots(id);
    return { deleted, kept };
  }

  /** Drops the oldest automatic Snapshots beyond `snapshotKeep` (the Session's, else the global), never one a fork was started from. */
  private async prune(id: string): Promise<void> {
    const keep = resolveSessionSettings(this.deps.get(id).settings, this.deps.settings()).snapshotKeep;
    if (keep <= 0) return;
    const auto = this.deps.db.listSnapshots(id).filter((s) => s.reason === "turn");
    for (const old of auto.slice(0, Math.max(0, auto.length - keep))) {
      if (this.deps.db.countForksOf(old.id) > 0) continue;
      await this.deps.docker.removeImage(old.imageId);
      this.deps.db.deleteSnapshot(id, old.id);
    }
  }

  /** Removes Snapshot images no Session references any more (deleted Sessions, failed prunes). */
  async collectImages(): Promise<void> {
    const known = this.deps.db.listAllSnapshotImageIds();
    for (const imageId of await this.deps.docker.listSnapshotImageIds()) {
      if (known.has(imageId)) continue;
      if (await this.deps.docker.removeImage(imageId)) this.deps.log(`removed orphan snapshot image ${imageId.slice(7, 19)}`);
    }
  }

  broadcastSnapshots(id: string): void {
    this.deps.broadcast({ type: "snapshots", sessionId: id, snapshots: this.deps.db.listSnapshots(id) });
    const s = this.deps.db.getSession(id);
    if (s) this.deps.broadcast({ type: "session", session: s });
  }

  /** Re-measures the Sandbox's writable layer; cheap for small layers, so done after every Snapshot. */
  async refreshDiskUsage(id: string): Promise<void> {
    const s = this.deps.db.getSession(id);
    if (!s?.containerId) return;
    try {
      let diskBytes = await this.deps.docker.diskUsage(s.containerId);
      const vms = this.deps.vms(s.settings.sandbox.environment);
      if (diskBytes !== null && vms) diskBytes += (await vms.diskUsage(id)) ?? 0;
      if (diskBytes !== null && diskBytes !== s.diskBytes) this.deps.update(id, { diskBytes });
    } catch (e) {
      this.deps.log(`disk usage ${id} failed: ${String(e)}`);
    }
  }

  /** The Snapshot after a completed turn, for an idle Session whose `autoSnapshot` setting asks for one; a failure is announced, not thrown. */
  async auto(id: string, eventSeq: number): Promise<void> {
    const s = this.deps.db.getSession(id);
    if (!s || s.status !== "idle" || VM_NO_SNAPSHOT[s.settings.sandbox.environment]) return;
    if (!resolveSessionSettings(s.settings, this.deps.settings()).autoSnapshot) return;
    try {
      await this.take(id, "turn", eventSeq);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log(`auto snapshot ${id} failed: ${message}`);
      this.deps.broadcast({ type: "snapshot_failed", sessionId: id, message: `Automatic snapshot failed. ${message}` });
    }
  }
}
