import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import {
  AskResult,
  DAEMON_METHODS,
  DAEMON_PORT,
  DaemonMcpSetResult,
  DaemonModelSetResult,
  FsListResult,
  FsReadResult,
  FsWriteResult,
  NOVNC_PORT,
  PtyAttachResult,
  PtyInfo,
  PtyListResult,
  type CreateSessionRequest,
  type DaemonEvent,
  type DaemonStatus,
  type DeleteSnapshotsResult,
  type DockerMode,
  type ForkSessionRequest,
  type FsChange,
  type ProviderModels,
  type SavedMessage,
  type Session,
  type SessionBroadcast,
  type SessionEvent,
  type SessionStatus,
  type Settings,
  type Snapshot,
  type SnapshotReason,
  type UpdateSessionRequest,
  type WorkspaceSource,
} from "@sessionboxer/protocol";
import { defaultMcpEnabled, knownMcpIds, providerEnv, providerSetupHint, resolveMcpServers } from "./config.js";
import { DaemonClient, DaemonRpcError } from "./daemon-client.js";
import type { Db, SessionPatch } from "./db.js";
import { SNAPSHOT_REPO, type SandboxDocker } from "./docker.js";
import { HostDirError, packHostDir, planHostDir, resolveHostDir } from "./host-dir.js";
import { HttpError } from "./http-error.js";

export { HttpError };

const CANCEL_GRACE_MS = 8000;
const DAEMON_WAIT_MS = 15_000;
/** A one-shot ask spawns a fresh ACP session, which is slow on cold Providers. */
const ASK_TIMEOUT_MS = 120_000;

/** One UI connection attached to a terminal. */
export interface TerminalSink {
  output: (data: Buffer) => void;
  exit: (exitCode: number) => void;
  /** The Sandbox went away (stop/delete/daemon loss); the UI should drop the terminal. */
  detached: (reason: string) => void;
}

export class SessionManager {
  private readonly clients = new Map<string, DaemonClient>();
  private readonly terminalSinks = new Map<string, Set<TerminalSink>>();
  private readonly stopping = new Set<string>();
  private readonly pendingPrompts = new Map<string, string>();
  private readonly listeners = new Set<(msg: SessionBroadcast) => void>();
  /** Per-Session chain so Snapshots of one Sandbox never overlap. */
  private readonly snapshotChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly docker: SandboxDocker,
    private readonly settings: () => Settings,
    private readonly log: (msg: string) => void,
  ) {}

  subscribe(fn: (msg: SessionBroadcast) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(msg: SessionBroadcast): void {
    for (const fn of this.listeners) fn(msg);
  }

  list(): Session[] {
    return this.db.listSessions();
  }

  get(id: string): Session {
    const s = this.db.getSession(id);
    if (!s) throw new HttpError(404, `session ${id} not found`);
    return s;
  }

  events(id: string, afterSeq = 0): SessionEvent[] {
    this.get(id);
    return this.db.listEvents(id, afterSeq);
  }

  /** Docker mode a Docker-enabled Session gets on this host (ADR-0008). */
  async dockerModeAvailable(): Promise<Exclude<DockerMode, "none">> {
    return (await this.docker.hasSysbox()) ? "sysbox" : "privileged";
  }

  /** websockify endpoint of a live Sandbox's Desktop, reachable only from the host. */
  async desktopUrl(id: string): Promise<string> {
    const s = this.get(id);
    if (!s.containerId || (s.status !== "idle" && s.status !== "running")) {
      throw new HttpError(409, `session ${id} is ${s.status}; the Desktop is only available while the Sandbox runs`);
    }
    const { host, port } = await this.docker.endpoint(s.containerId, NOVNC_PORT);
    return `ws://${host}:${port}/websockify`;
  }

  // --- Workspace files -----------------------------------------------------

  /** The Daemon of a live Session, waiting a little for it to come up right after create/resume. */
  private async liveClient(id: string): Promise<DaemonClient> {
    const s = this.get(id);
    if (s.status !== "idle" && s.status !== "running") {
      throw new HttpError(409, `session ${id} is ${s.status}; files and terminals are only available while the Sandbox runs`);
    }
    const client = this.clients.get(id);
    if (!client || !(await client.waitConnected(DAEMON_WAIT_MS))) {
      throw new HttpError(503, "Sandbox Daemon is not connected yet; retry in a moment.");
    }
    return client;
  }

  private async daemonCall(id: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    try {
      const client = await this.liveClient(id);
      return await client.request(method, params, timeoutMs);
    } catch (e) {
      if (e instanceof DaemonRpcError) {
        if (e.code === -32601) {
          throw new HttpError(502, `${e.message}: the Sandbox runs an older Daemon; Stop and Resume the session to refresh it.`);
        }
        const status =
          e.code === -32001 ? 404 : e.code === -32002 ? 403 : e.code === -32003 ? 409 : e.code === -32602 ? 400 : 502;
        throw new HttpError(status, e.message);
      }
      throw e;
    }
  }

  async fsList(id: string, path: string): Promise<FsListResult> {
    return FsListResult.parse(await this.daemonCall(id, DAEMON_METHODS.fsList, { path }));
  }

  async fsRead(id: string, path: string): Promise<FsReadResult> {
    return FsReadResult.parse(await this.daemonCall(id, DAEMON_METHODS.fsRead, { path }));
  }

  async fsWrite(id: string, path: string, content: string): Promise<FsWriteResult> {
    return FsWriteResult.parse(await this.daemonCall(id, DAEMON_METHODS.fsWrite, { path, content }));
  }

  // --- Terminals -----------------------------------------------------------

  async terminalList(id: string): Promise<PtyListResult> {
    return PtyListResult.parse(await this.daemonCall(id, DAEMON_METHODS.ptyList, {}));
  }

  async terminalOpen(id: string, cols: number, rows: number): Promise<PtyInfo> {
    return PtyInfo.parse(await this.daemonCall(id, DAEMON_METHODS.ptyOpen, { cols, rows }));
  }

  async terminalClose(id: string, ptyId: string): Promise<void> {
    await this.daemonCall(id, DAEMON_METHODS.ptyClose, { id: ptyId });
    this.detachTerminal(id, ptyId, "terminal closed");
  }

  /** Attach a UI connection; returns the current scrollback and a function to detach. */
  async terminalAttach(id: string, ptyId: string, sink: TerminalSink): Promise<{ attached: PtyAttachResult; detach: () => void }> {
    const attached = PtyAttachResult.parse(await this.daemonCall(id, DAEMON_METHODS.ptyAttach, { id: ptyId }));
    const key = `${id}/${ptyId}`;
    let sinks = this.terminalSinks.get(key);
    if (!sinks) {
      sinks = new Set();
      this.terminalSinks.set(key, sinks);
    }
    sinks.add(sink);
    const detach = (): void => {
      const set = this.terminalSinks.get(key);
      if (!set) return;
      set.delete(sink);
      if (set.size === 0) this.terminalSinks.delete(key);
    };
    return { attached, detach };
  }

  async terminalInput(id: string, ptyId: string, data: Buffer): Promise<void> {
    await this.daemonCall(id, DAEMON_METHODS.ptyInput, { id: ptyId, data: data.toString("base64") });
  }

  async terminalResize(id: string, ptyId: string, cols: number, rows: number): Promise<void> {
    await this.daemonCall(id, DAEMON_METHODS.ptyResize, { id: ptyId, cols, rows });
  }

  private sinksOf(id: string, ptyId: string): TerminalSink[] {
    return [...(this.terminalSinks.get(`${id}/${ptyId}`) ?? [])];
  }

  private detachTerminal(id: string, ptyId: string, reason: string): void {
    for (const sink of this.sinksOf(id, ptyId)) sink.detached(reason);
    this.terminalSinks.delete(`${id}/${ptyId}`);
  }

  private detachAllTerminals(id: string, reason: string): void {
    for (const key of [...this.terminalSinks.keys()]) {
      if (key.startsWith(`${id}/`)) this.detachTerminal(id, key.slice(id.length + 1), reason);
    }
  }

  async boot(): Promise<void> {
    this.log(`sandbox reach: ${await this.docker.detectReach()}`);
    await this.docker.ensureNetwork();
    await this.docker.watchDeaths(
      (containerId, sessionId, exitCode) => {
        if (this.stopping.has(sessionId)) return;
        const s = this.db.getSession(sessionId);
        if (!s || s.containerId !== containerId) return;
        this.disconnect(sessionId);
        this.setStatus(sessionId, "error", `Sandbox exited unexpectedly (exit code ${exitCode})`);
      },
      (error) => this.log(`docker event stream lost (${error}); retrying in 5s`),
    );
    void this.collectSnapshotImages().catch((e: unknown) => this.log(`snapshot gc failed: ${String(e)}`));
    for (const s of this.db.listSessions()) {
      if (!s.containerId) {
        if (s.status !== "error") this.setStatus(s.id, "error", "Sandbox was never created");
        continue;
      }
      const state = await this.docker.state(s.containerId);
      if (state === "missing") this.setStatus(s.id, "error", "Sandbox container is missing");
      else if (state === "stopped") {
        if (s.status !== "stopped") this.setStatus(s.id, "stopped");
      } else {
        if (s.status !== "idle" && s.status !== "running") this.setStatus(s.id, "idle");
        await this.connect(s.id, s.containerId);
      }
    }
  }

  async create(req: CreateSessionRequest): Promise<Session> {
    const settings = this.settings();
    if (Object.values(providerEnv(req.provider, settings)).some((v) => v === "")) {
      throw new HttpError(400, providerSetupHint(req.provider));
    }
    let workspaceSource: WorkspaceSource = req.workspaceSource;
    if (workspaceSource.type === "copy") {
      try {
        workspaceSource = { type: "copy", path: await resolveHostDir(workspaceSource.path) };
      } catch (e) {
        if (e instanceof HostDirError) throw new HttpError(400, e.message);
        throw e;
      }
    }
    await this.docker.ensureImage();
    const dockerMode: DockerMode = (req.docker ?? settings.dockerInSandbox) ? await this.dockerModeAvailable() : "none";

    const id = randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    const session: Session = {
      id,
      title: req.title ?? titleFromPrompt(req.prompt) ?? titleFromSource(workspaceSource) ?? `Session ${id.slice(0, 6)}`,
      provider: req.provider,
      status: "creating",
      workspaceSource,
      dockerMode,
      containerId: null,
      error: null,
      queueRunning: false,
      autoSnapshot: null,
      diskBytes: null,
      mcpEnabled: req.mcpEnabled ? knownMcpIds(settings, req.mcpEnabled) : defaultMcpEnabled(settings),
      mcpPending: false,
      model: req.model ?? null,
      modelPending: false,
      snapshotBytes: 0,
      snapshotCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertSession(session);
    this.broadcast({ type: "session", session });
    if (req.prompt) this.pendingPrompts.set(id, req.prompt);

    void this.provision(session, settings).catch((e: unknown) => {
      this.log(`provision ${id} failed: ${String(e)}`);
      this.setStatus(id, "error", e instanceof Error ? e.message : String(e));
    });
    return session;
  }

  /**
   * New Session whose Sandbox starts from one of `fromId`'s Snapshot images: same
   * filesystem as the origin at that moment (Workspace, installed tools, the
   * Agent's own session files), with the transcript up to the Snapshot copied
   * over. The origin Session, its Sandbox and its saved messages are untouched.
   */
  async fork(fromId: string, req: ForkSessionRequest): Promise<Session> {
    const origin = this.get(fromId);
    const snapshot = this.db.getSnapshot(fromId, req.snapshotId);
    if (!snapshot) throw new HttpError(404, `snapshot ${req.snapshotId} not found`);
    const settings = this.settings();
    if (Object.values(providerEnv(origin.provider, settings)).some((v) => v === "")) {
      throw new HttpError(400, providerSetupHint(origin.provider));
    }
    if (!(await this.docker.imageExists(snapshot.imageId))) {
      throw new HttpError(409, `The image of snapshot ${snapshot.ordinal} is gone from Docker; delete the snapshot.`);
    }
    if (origin.dockerMode !== "none" && (await this.dockerModeAvailable()) !== origin.dockerMode) {
      throw new HttpError(409, `The origin ran with ${origin.dockerMode} Docker, which this host no longer offers.`);
    }

    const id = randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    const session: Session = {
      id,
      title: req.title ?? `${origin.title} (fork ${snapshot.ordinal})`,
      provider: origin.provider,
      status: "creating",
      workspaceSource: {
        type: "fork",
        sessionId: origin.id,
        snapshotId: snapshot.id,
        label: `${origin.title} @ snapshot ${snapshot.ordinal}`,
      },
      dockerMode: origin.dockerMode,
      containerId: null,
      error: null,
      queueRunning: false,
      autoSnapshot: origin.autoSnapshot,
      diskBytes: null,
      mcpEnabled: knownMcpIds(settings, origin.mcpEnabled),
      mcpPending: false,
      model: origin.model,
      modelPending: false,
      snapshotBytes: 0,
      snapshotCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertSession(session);
    this.db.copyEvents(origin.id, id, snapshot.eventSeq);
    const marker = this.db.appendEvent(id, {
      type: "forked",
      fromSessionId: origin.id,
      fromTitle: origin.title,
      snapshotId: snapshot.id,
      snapshotOrdinal: snapshot.ordinal,
    });
    for (const text of req.savedMessages) this.db.insertSavedMessage(id, text);
    this.broadcast({ type: "session", session });
    this.broadcast({ type: "event", event: marker });
    if (req.prompt) this.pendingPrompts.set(id, req.prompt);

    void this.provision(session, settings, snapshot.imageId).catch((e: unknown) => {
      this.log(`provision fork ${id} failed: ${String(e)}`);
      this.setStatus(id, "error", e instanceof Error ? e.message : String(e));
    });
    return session;
  }

  private async provision(session: Session, settings: Settings, image?: string): Promise<void> {
    const env: Record<string, string> = {
      SESSIONBOXER_SESSION_ID: session.id,
      SESSIONBOXER_PROVIDER: session.provider,
      ...providerEnv(session.provider, settings),
    };
    if (session.dockerMode !== "none") env.SESSIONBOXER_DOCKER = session.dockerMode;
    if (settings.gitUserName) {
      env.GIT_AUTHOR_NAME = settings.gitUserName;
      env.GIT_COMMITTER_NAME = settings.gitUserName;
    }
    if (settings.gitUserEmail) {
      env.GIT_AUTHOR_EMAIL = settings.gitUserEmail;
      env.GIT_COMMITTER_EMAIL = settings.gitUserEmail;
    }
    const containerId = await this.docker.create({
      sessionId: session.id,
      env,
      cpus: settings.sandboxCpus,
      memoryGb: settings.sandboxMemoryGb,
      dockerMode: session.dockerMode,
      image,
    });
    this.update(session.id, { containerId });
    await this.startSandbox(containerId);
    await this.seedWorkspace(containerId, session.workspaceSource);
    this.setStatus(session.id, "idle");
    await this.connect(session.id, containerId);
    void this.refreshDiskUsage(session.id);
  }

  /** Refreshes the Daemon inside the Sandbox to this checkout's build, then starts it. */
  private async startSandbox(containerId: string): Promise<void> {
    try {
      await this.docker.syncDaemon(containerId);
    } catch (e) {
      this.log(
        `could not refresh the Sandbox Daemon in ${containerId.slice(0, 12)} (${e instanceof Error ? e.message : String(e)}); using the image's copy`,
      );
    }
    await this.docker.start(containerId);
    if ((await this.docker.state(containerId)) !== "running") {
      throw new HttpError(502, "Sandbox exited right after starting; see `docker logs` for the container.");
    }
  }

  private async seedWorkspace(containerId: string, source: WorkspaceSource): Promise<void> {
    if (source.type === "git") {
      const args = ["git", "clone", "--", source.url, "."];
      if (source.ref) args.splice(2, 0, "--branch", source.ref);
      await this.docker.exec(containerId, args);
    } else if (source.type === "copy") {
      const dir = await resolveHostDir(source.path);
      const entries = await planHostDir(dir);
      if (entries && entries.length === 0) return;
      this.log(`copying ${dir} (${entries ? `${entries.length} git entries` : "everything"}) into ${containerId.slice(0, 12)}`);
      await this.docker.putArchive(containerId, packHostDir(dir, entries), "/workspace");
      await this.docker.exec(containerId, ["chown", "-R", "agent:agent", "/workspace"], "/", "root");
    }
  }

  async prompt(id: string, text: string): Promise<void> {
    const s = this.get(id);
    if (s.status === "stopped") throw new HttpError(409, "Session is stopped; resume it first.");
    if (s.status === "running") throw new HttpError(409, "The Agent is still working on the previous prompt.");
    if (s.status === "error") throw new HttpError(409, `Session is in error state: ${s.error ?? "unknown"}`);
    const client = this.clients.get(id);
    if (!client?.connected) {
      if (s.status === "creating") {
        this.pendingPrompts.set(id, text);
        return;
      }
      throw new HttpError(503, "Sandbox Daemon is not connected yet; retry in a moment.");
    }
    await client.request(DAEMON_METHODS.prompt, { text });
    this.setStatus(id, "running");
  }

  /** Context-free question to the Session's Provider; nothing is recorded in the transcript. */
  async ask(id: string, text: string): Promise<AskResult> {
    return AskResult.parse(await this.daemonCall(id, DAEMON_METHODS.ask, { text }, ASK_TIMEOUT_MS));
  }

  async cancel(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client?.connected) throw new HttpError(503, "Sandbox Daemon is not connected.");
    await client.request(DAEMON_METHODS.cancel, {});
  }

  // --- Saved messages and the queue ------------------------------------------

  savedMessages(id: string): SavedMessage[] {
    this.get(id);
    return this.db.listSavedMessages(id);
  }

  saveMessage(id: string, text: string): SavedMessage {
    this.get(id);
    const saved = this.db.insertSavedMessage(id, text);
    this.broadcastSaved(id);
    return saved;
  }

  updateSavedMessage(id: string, messageId: string, patch: { text?: string; position?: number }): SavedMessage {
    this.get(id);
    const saved = this.db.updateSavedMessage(id, messageId, patch);
    if (!saved) throw new HttpError(404, `saved message ${messageId} not found`);
    this.broadcastSaved(id);
    return saved;
  }

  deleteSavedMessage(id: string, messageId: string): void {
    this.get(id);
    if (!this.db.deleteSavedMessage(id, messageId)) throw new HttpError(404, `saved message ${messageId} not found`);
    this.broadcastSaved(id);
  }

  /** Sends a saved message now and drops it from the list. */
  async sendSavedMessage(id: string, messageId: string): Promise<void> {
    this.get(id);
    const saved = this.db.getSavedMessage(id, messageId);
    if (!saved) throw new HttpError(404, `saved message ${messageId} not found`);
    await this.prompt(id, saved.text);
    this.db.deleteSavedMessage(id, messageId);
    this.broadcastSaved(id);
  }

  /**
   * Play/pause the queue. While playing, the first saved message is sent as soon as
   * the Agent is idle and again after every `turn_ended`, until the list is empty.
   * Pausing lets the current turn finish.
   */
  async setQueueRunning(id: string, running: boolean): Promise<Session> {
    const s = this.get(id);
    if (running && this.db.listSavedMessages(id).length === 0) throw new HttpError(409, "No saved messages to play.");
    if (running && (s.status === "stopped" || s.status === "error")) {
      throw new HttpError(409, `Session is ${s.status}; resume it before playing the queue.`);
    }
    const next = s.queueRunning === running ? s : this.update(id, { queueRunning: running });
    if (running && next.status === "idle") await this.pumpQueue(id);
    return this.get(id);
  }

  /** Sends the next saved message if the queue is playing and the Agent is idle. */
  private async pumpQueue(id: string): Promise<void> {
    const s = this.db.getSession(id);
    if (!s?.queueRunning || s.status !== "idle") return;
    const next = this.db.listSavedMessages(id)[0];
    if (!next) {
      this.update(id, { queueRunning: false });
      return;
    }
    try {
      await this.prompt(id, next.text);
    } catch (e) {
      this.log(`queue ${id} paused: ${e instanceof Error ? e.message : String(e)}`);
      this.update(id, { queueRunning: false });
      return;
    }
    this.db.deleteSavedMessage(id, next.id);
    this.broadcastSaved(id);
  }

  private broadcastSaved(id: string): void {
    this.broadcast({ type: "saved_messages", sessionId: id, messages: this.db.listSavedMessages(id) });
  }

  // --- Snapshots -------------------------------------------------------------

  snapshots(id: string): Snapshot[] {
    this.get(id);
    return this.db.listSnapshots(id);
  }

  /**
   * `docker commit` of the Sandbox as it is now. Serialized per Session; the
   * container is paused for the few seconds the commit takes. Automatic
   * Snapshots (`reason: "turn"`) are pruned to `Settings.snapshotKeep`.
   */
  snapshot(id: string, reason: SnapshotReason, eventSeq?: number): Promise<Snapshot> {
    const prev = this.snapshotChains.get(id) ?? Promise.resolve();
    const run = prev.then(
      () => this.doSnapshot(id, reason, eventSeq),
      () => this.doSnapshot(id, reason, eventSeq),
    );
    this.snapshotChains.set(id, run);
    const settle = (): void => {
      if (this.snapshotChains.get(id) === run) this.snapshotChains.delete(id);
    };
    run.then(settle, settle);
    return run;
  }

  private async doSnapshot(id: string, reason: SnapshotReason, eventSeq?: number): Promise<Snapshot> {
    const s = this.get(id);
    if (!s.containerId || (s.status !== "idle" && s.status !== "running")) {
      throw new HttpError(409, `Session is ${s.status}; Snapshots need a running Sandbox.`);
    }
    const snapshotId = randomBytes(6).toString("hex");
    const ordinal = this.db.nextSnapshotOrdinal(id);
    const tag = `${id}-${ordinal}`;
    this.broadcast({ type: "snapshotting", sessionId: id, active: true });
    try {
      const started = Date.now();
      const { imageId, sizeBytes } = await this.docker.commit(s.containerId, {
        snapshotId,
        tag,
        stripEnv: Object.keys(providerEnv(s.provider, this.settings())),
      });
      const snapshot: Snapshot = {
        id: snapshotId,
        sessionId: id,
        ordinal,
        reason,
        imageTag: `${SNAPSHOT_REPO}:${tag}`,
        imageId,
        eventSeq: eventSeq ?? this.db.lastEventSeq(id),
        sizeBytes,
        queuedMessages: this.db.listSavedMessages(id).map((m) => m.text),
        createdAt: new Date().toISOString(),
      };
      this.db.insertSnapshot(snapshot);
      this.log(`snapshot ${id}#${ordinal} ${(sizeBytes / 1024 ** 2).toFixed(1)} MB in ${Date.now() - started} ms`);
      await this.pruneSnapshots(id);
      this.broadcastSnapshots(id);
      await this.refreshDiskUsage(id);
      return snapshot;
    } finally {
      this.broadcast({ type: "snapshotting", sessionId: id, active: false });
    }
  }

  async deleteSnapshot(id: string, snapshotId: string): Promise<void> {
    this.get(id);
    const snapshot = this.db.getSnapshot(id, snapshotId);
    if (!snapshot) throw new HttpError(404, `snapshot ${snapshotId} not found`);
    const forks = this.db.countForksOf(snapshotId);
    if (forks > 0) throw new HttpError(409, `Snapshot ${snapshot.ordinal} is the origin of ${forks} Session(s); delete them first.`);
    await this.docker.removeImage(snapshot.imageId);
    this.db.deleteSnapshot(id, snapshotId);
    this.broadcastSnapshots(id);
  }

  /** Deletes every Snapshot of the Session except those a fork was started from. */
  async deleteAllSnapshots(id: string): Promise<DeleteSnapshotsResult> {
    this.get(id);
    let deleted = 0;
    let kept = 0;
    for (const snapshot of this.db.listSnapshots(id)) {
      if (this.db.countForksOf(snapshot.id) > 0) {
        kept++;
        continue;
      }
      await this.docker.removeImage(snapshot.imageId);
      this.db.deleteSnapshot(id, snapshot.id);
      deleted++;
    }
    this.broadcastSnapshots(id);
    return { deleted, kept };
  }

  /** Drops the oldest automatic Snapshots beyond `snapshotKeep`, never one a fork was started from. */
  private async pruneSnapshots(id: string): Promise<void> {
    const keep = this.settings().snapshotKeep;
    if (keep <= 0) return;
    const auto = this.db.listSnapshots(id).filter((s) => s.reason === "turn");
    for (const old of auto.slice(0, Math.max(0, auto.length - keep))) {
      if (this.db.countForksOf(old.id) > 0) continue;
      await this.docker.removeImage(old.imageId);
      this.db.deleteSnapshot(id, old.id);
    }
  }

  /** Removes Snapshot images no Session references any more (deleted Sessions, failed prunes). */
  private async collectSnapshotImages(): Promise<void> {
    const known = this.db.listAllSnapshotImageIds();
    for (const imageId of await this.docker.listSnapshotImageIds()) {
      if (known.has(imageId)) continue;
      if (await this.docker.removeImage(imageId)) this.log(`removed orphan snapshot image ${imageId.slice(7, 19)}`);
    }
  }

  private broadcastSnapshots(id: string): void {
    this.broadcast({ type: "snapshots", sessionId: id, snapshots: this.db.listSnapshots(id) });
    const s = this.db.getSession(id);
    if (s) this.broadcast({ type: "session", session: s });
  }

  /** Re-measures the Sandbox's writable layer; cheap for small layers, so done after every Snapshot. */
  private async refreshDiskUsage(id: string): Promise<void> {
    const s = this.db.getSession(id);
    if (!s?.containerId) return;
    try {
      const diskBytes = await this.docker.diskUsage(s.containerId);
      if (diskBytes !== null && diskBytes !== s.diskBytes) this.update(id, { diskBytes });
    } catch (e) {
      this.log(`disk usage ${id} failed: ${String(e)}`);
    }
  }

  async stop(id: string): Promise<Session> {
    const s = this.get(id);
    if (!s.containerId) throw new HttpError(409, "Session has no Sandbox.");
    if (s.status === "stopped") return s;
    this.stopping.add(id);
    try {
      if (s.queueRunning || s.mcpPending || s.modelPending) this.update(id, { queueRunning: false, mcpPending: false, modelPending: false });
      if (s.status === "running") await this.cancelAndWait(id);
      this.disconnect(id);
      await this.docker.stop(s.containerId);
      const stopped = this.setStatus(id, "stopped");
      void this.refreshDiskUsage(id);
      return stopped;
    } finally {
      this.stopping.delete(id);
    }
  }

  private async cancelAndWait(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client?.connected) return;
    try {
      await client.request(DAEMON_METHODS.cancel, {});
    } catch (e) {
      this.log(`cancel ${id} failed: ${String(e)}`);
      return;
    }
    const deadline = Date.now() + CANCEL_GRACE_MS;
    while (Date.now() < deadline && this.db.getSession(id)?.status === "running") {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async resume(id: string): Promise<Session> {
    const s = this.get(id);
    if (!s.containerId) throw new HttpError(409, "Session has no Sandbox to resume.");
    if (s.status !== "stopped" && s.status !== "error") return s;
    if ((await this.docker.state(s.containerId)) === "missing") {
      throw new HttpError(409, "Sandbox container is missing; delete the session.");
    }
    await this.startSandbox(s.containerId);
    const next = this.setStatus(id, "idle");
    await this.connect(id, s.containerId);
    return next;
  }

  async delete(id: string): Promise<void> {
    const s = this.get(id);
    this.stopping.add(id);
    this.disconnect(id);
    this.pendingPrompts.delete(id);
    try {
      if (s.containerId) await this.docker.remove(s.containerId);
    } finally {
      this.stopping.delete(id);
    }
    const snapshots = this.db.listSnapshots(id);
    this.db.deleteSession(id);
    this.broadcast({ type: "session_deleted", id });
    // Images a fork still runs on stay (removeImage returns false); the GC picks them up later.
    for (const snap of snapshots) await this.docker.removeImage(snap.imageId).catch(() => false);
  }

  async edit(id: string, req: UpdateSessionRequest): Promise<Session> {
    const s = this.update(id, {
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.autoSnapshot !== undefined ? { autoSnapshot: req.autoSnapshot } : {}),
      ...(req.mcpEnabled !== undefined ? { mcpEnabled: knownMcpIds(this.settings(), req.mcpEnabled) } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
    });
    if (req.mcpEnabled !== undefined) await this.pushMcpServers(id);
    if (req.model !== undefined) return this.pushModel(id);
    return req.mcpEnabled !== undefined ? this.get(id) : s;
  }

  /**
   * Sends the Session's model to its Daemon, which switches the Agent right away when idle
   * or once the current turn ends. A no-op without a chosen model or a live Daemon (the
   * model is pushed again when the Sandbox comes back, after the MCP set).
   */
  async pushModel(id: string): Promise<Session> {
    const s = this.get(id);
    const client = this.clients.get(id);
    if (!s.model || !client?.connected) return s;
    try {
      const result = DaemonModelSetResult.parse(await client.request(DAEMON_METHODS.modelSet, { model: s.model }));
      return this.update(id, { modelPending: !result.applied });
    } catch (e) {
      if (e instanceof DaemonRpcError && e.code === -32601) {
        throw new HttpError(502, "The Sandbox runs an older Daemon without model selection; Stop and Resume the session to refresh it.");
      }
      throw e;
    }
  }

  /** Last model list each Provider's Agent reported (what New Session can offer). */
  providerModels(): ProviderModels {
    return this.db.providerModels();
  }

  /**
   * Sends the Session's enabled MCP servers (resolved, secrets included) to its Daemon,
   * which restarts the Agent with them once idle. Called after every Daemon connect and
   * whenever the set or the registry changes; a no-op for Sessions without a live Daemon
   * (they get the current set when their Sandbox comes back).
   */
  async pushMcpServers(id: string): Promise<Session> {
    const s = this.get(id);
    const client = this.clients.get(id);
    if (!client?.connected) return s;
    const servers = resolveMcpServers(this.settings(), s.mcpEnabled);
    try {
      const result = DaemonMcpSetResult.parse(await client.request(DAEMON_METHODS.mcpSet, { servers }));
      return this.update(id, { mcpPending: !result.applied });
    } catch (e) {
      if (e instanceof DaemonRpcError && e.code === -32601) {
        throw new HttpError(502, "The Sandbox runs an older Daemon without MCP support; Stop and Resume the session to refresh it.");
      }
      throw e;
    }
  }

  /** The registry changed: every live Session gets its set resolved again. */
  async pushMcpServersToAll(): Promise<void> {
    for (const s of this.list()) {
      if (s.status !== "idle" && s.status !== "running") continue;
      await this.pushMcpServers(s.id).catch((e: unknown) => this.log(`mcp push ${s.id} failed: ${String(e)}`));
    }
  }

  private async connect(id: string, containerId: string): Promise<void> {
    this.disconnect(id);
    const { host, port } = await this.docker.endpoint(containerId, DAEMON_PORT);
    const client = new DaemonClient(`ws://${host}:${port}`, {
      cursor: () => this.db.getDaemonCursor(id) ?? {},
      onConnected: (status) => this.onDaemonConnected(id, status),
      onStatus: (status) => this.onDaemonStatus(id, status),
      onEvent: (event) => this.onDaemonEvent(id, event),
      onFsChanged: (changes: FsChange[]) => this.broadcast({ type: "fs_changed", sessionId: id, changes }),
      onPtyOutput: (ptyId, data) => {
        for (const sink of this.sinksOf(id, ptyId)) sink.output(data);
      },
      onPtyExit: (ptyId, exitCode) => {
        for (const sink of this.sinksOf(id, ptyId)) sink.exit(exitCode);
      },
      onDisconnected: () => {
        this.log(`daemon ${id} disconnected`);
        this.detachAllTerminals(id, "Sandbox Daemon disconnected");
      },
      log: (msg) => this.log(`daemon ${id}: ${msg}`),
    });
    this.clients.set(id, client);
  }

  private disconnect(id: string): void {
    this.clients.get(id)?.close();
    this.clients.delete(id);
    this.detachAllTerminals(id, "Sandbox stopped");
  }

  private onDaemonConnected(id: string, status: DaemonStatus): void {
    this.log(`daemon ${id} connected epoch=${status.epoch} lastSeq=${status.lastSeq} ready=${status.ready}`);
    const cursor = this.db.getDaemonCursor(id);
    if (!cursor || cursor.epoch !== status.epoch) this.db.setDaemonCursor(id, status.epoch, 0);
    this.onDaemonStatus(id, status);
    // The Daemon waits for the MCP set before it starts the Agent; older Daemons ignore the call.
    this.pushMcpServers(id)
      .then(() => this.pushModel(id))
      .catch((e: unknown) => this.log(`mcp/model push ${id} failed: ${String(e)}`));
    const pending = this.pendingPrompts.get(id);
    if (pending && !status.turnActive) {
      this.pendingPrompts.delete(id);
      this.prompt(id, pending).catch((e: unknown) => this.log(`pending prompt ${id} failed: ${String(e)}`));
    }
  }

  private onDaemonStatus(id: string, status: DaemonStatus): void {
    const s = this.db.getSession(id);
    if (!s || s.status === "stopped" || s.status === "error") return;
    if (status.turnActive && s.status !== "running") this.setStatus(id, "running");
    else if (!status.turnActive && s.status === "running") this.setStatus(id, "idle");
    if (status.mcpPending !== s.mcpPending) this.update(id, { mcpPending: status.mcpPending });
    if (status.models && this.db.setProviderModels(s.provider, status.models)) {
      this.broadcast({ type: "models", provider: s.provider, models: status.models });
    }
    if (status.model !== null && (status.model !== s.model || status.modelPending !== s.modelPending)) {
      this.update(id, { model: status.model, modelPending: status.modelPending });
    }
  }

  private onDaemonEvent(id: string, ev: DaemonEvent): void {
    const cursor = this.db.getDaemonCursor(id);
    if (cursor && cursor.epoch === ev.epoch && ev.seq <= cursor.lastSeq) return;
    const stored = this.db.appendEvent(id, ev.body, ev.ts);
    this.db.setDaemonCursor(id, ev.epoch, ev.seq);
    this.broadcast({ type: "event", event: stored });
    if (ev.body.type === "turn_ended" || ev.body.type === "agent_error") {
      const s = this.db.getSession(id);
      if (s?.status === "running") this.setStatus(id, "idle");
      if (ev.body.type === "turn_ended" && ev.body.stopReason === "end_turn") {
        void this.afterTurn(id, stored.seq).catch((e: unknown) => this.log(`after turn ${id} failed: ${String(e)}`));
      } else {
        if (s?.queueRunning) {
          this.log(`queue ${id} paused after ${ev.body.type}`);
          this.update(id, { queueRunning: false });
        }
        if (ev.body.type === "turn_ended") void this.autoSnapshot(id, stored.seq);
      }
    }
  }

  /** A completed turn: Snapshot first (so the next queued prompt does not land in it), then pump the queue. */
  private async afterTurn(id: string, eventSeq: number): Promise<void> {
    await this.autoSnapshot(id, eventSeq);
    await this.pumpQueue(id);
  }

  private async autoSnapshot(id: string, eventSeq: number): Promise<void> {
    const s = this.db.getSession(id);
    if (!s || s.status !== "idle") return;
    if (!(s.autoSnapshot ?? this.settings().autoSnapshot)) return;
    try {
      await this.snapshot(id, "turn", eventSeq);
    } catch (e) {
      this.log(`auto snapshot ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private setStatus(id: string, status: SessionStatus, error: string | null = null): Session {
    const current = this.db.getSession(id);
    if (!current) throw new HttpError(404, `session ${id} not found`);
    if (current.status === status && current.error === error) return current;
    const s = this.update(id, { status, error });
    const stored = this.db.appendEvent(id, error ? { type: "status", status, error } : { type: "status", status });
    this.broadcast({ type: "event", event: stored });
    return s;
  }

  private update(id: string, patch: SessionPatch): Session {
    const s = this.db.updateSession(id, patch);
    if (!s) throw new HttpError(404, `session ${id} not found`);
    this.broadcast({ type: "session", session: s });
    return s;
  }

  async shutdown(): Promise<void> {
    for (const id of this.clients.keys()) this.disconnect(id);
  }
}

function titleFromPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function titleFromSource(source: WorkspaceSource): string | undefined {
  if (source.type === "copy") return basename(source.path) || undefined;
  if (source.type === "git") return basename(source.url).replace(/\.git$/, "") || undefined;
  if (source.type === "fork") return source.label;
  return undefined;
}
