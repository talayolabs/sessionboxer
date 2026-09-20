import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  AskResult,
  type CompactionDetails,
  type CompactionDetailsRequest,
  type ContextBreakdown,
  DAEMON_METHODS,
  DaemonCompactionDetailsResult,
  DaemonContextReportResult,
  DAEMON_PORT,
  DaemonClaudeModelsSetResult,
  DaemonRecordingPrefsSetResult,
  type DaemonRecordingPrefsSetParams,
  DaemonLlmInspectSetResult,
  type DaemonLlmInspectSetParams,
  DaemonLlmCallsResult,
  DaemonLlmCallBodyResult,
  type DaemonLlmCallBodyParams,
  type LlmCall,
  type LlmCallBody,
  DaemonMcpSetResult,
  DaemonModelSetResult,
  DaemonOptionSetResult,
  type DaemonOptionSetParams,
  DaemonSessionForkResult,
  DaemonSessionSwitchResult,
  CodeOpenParams,
  CodeServerStatus,
  DaemonStatus,
  NOVNC_PORT,
  PtyAttachResult,
  PtyInfo,
  PtyListResult,
  ROOT_BRANCH_ID,
  FS_TAR_PATH,
  SyncManifest,
  type SyncPlan,
  type SyncRequest,
  type SyncResult,
  branchScope,
  inBranchScope,
  type Branch,
  type CreateSessionRequest,
  type DaemonEvent,
  type DaemonPromptParams,
  type DeleteSnapshotsResult,
  type DockerMode,
  type ForkSessionRequest,
  type OptionValues,
  type PromptRequest,
  type PushMessage,
  sessionRoute,
  type ProviderModels,
  type ProviderOptions,
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
import { countCerts, sandboxCaBundle } from "./ca-certs.js";
import {
  PROVIDER_ENV_KEYS,
  defaultMcpEnabled,
  knownMcpIds,
  providerEnv,
  providerReady,
  providerSetupHint,
  resolveBoxCredentials,
  resolveGitIdentity,
  resolveMcpServers,
} from "./config.js";
import { parseContextReport } from "./context-report.js";
import { cloneFailureHint, planClone } from "./git-clone.js";
import { DaemonClient, DaemonRpcError } from "./daemon-client.js";
import { branchTitle, type Db, type SessionPatch } from "./db.js";
import { MissingImageContentError, SNAPSHOT_REPO, type SandboxDocker } from "./docker.js";
import { HostDirError, packHostDir, planHostDir, resolveHostDir } from "./host-dir.js";
import { SyncBaselines, applySync, hostManifest, nextBaseline, planSync, selectEntries } from "./host-sync.js";
import { HttpError } from "./http-error.js";
import { PullRequests } from "./pull-requests.js";

export { HttpError };

const CANCEL_GRACE_MS = 8000;
const DAEMON_WAIT_MS = 15_000;
/** A one-shot ask spawns a fresh ACP session, which is slow on cold Providers. */
const ASK_TIMEOUT_MS = 120_000;
/** Rewinding the Agent may replay the whole transcript into a fresh session. */
const BRANCH_TIMEOUT_MS = 300_000;
/** Longest transcript handed to an Agent that cannot fork (the tail is kept). */
const REPLAY_MAX_CHARS = 60_000;
/** openvscode-server's first start unpacks its extensions; generous on slow disks. */
const CODE_START_TIMEOUT_MS = 120_000;
/** Hashing a big Workspace in the box. */
const MANIFEST_TIMEOUT_MS = 300_000;
const REBUILD_HINT = "This Sandbox needs a rebuild before it can be snapshotted again (Snapshots \u2192 Rebuild Sandbox)";

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
  private readonly pendingPrompts = new Map<string, PromptRequest>();
  /** Turns ended per Session, to notice a turn that was over before the prompt RPC even returned. */
  private readonly turnEnds = new Map<string, number>();
  private readonly listeners = new Set<(msg: SessionBroadcast) => void>();
  /** Per-Session chain so Snapshots of one Sandbox never overlap. */
  private readonly snapshotChains = new Map<string, Promise<unknown>>();
  private readonly syncBaselines = new SyncBaselines();
  /** Sessions with a pull in flight (one at a time per host folder). */
  private readonly syncing = new Set<string>();
  /** Pull Requests attached to Sessions: watching, notifications, actions. */
  readonly prs: PullRequests;

  constructor(
    private readonly db: Db,
    private readonly docker: SandboxDocker,
    private readonly settings: () => Settings,
    private readonly log: (msg: string) => void,
    /** Web Push to devices that are not watching (see `PushNotifier`). */
    private readonly push: (msg: PushMessage) => void = () => undefined,
  ) {
    this.prs = new PullRequests({
      db,
      getSession: (id) => db.getSession(id),
      daemonGhApi: (id, params, timeoutMs) => this.daemonCall(id, DAEMON_METHODS.ghApi, params, timeoutMs),
      daemonGhLogins: (id, timeoutMs) => this.daemonCall(id, DAEMON_METHODS.ghLogins, {}, timeoutMs),
      connectorCredentials: (s) => resolveBoxCredentials(settings(), s.mcpEnabled),
      prompt: (id, text) => this.prompt(id, { text }),
      enqueue: (id, text) => {
        this.saveMessage(id, text);
        const s = this.db.getSession(id);
        if (s && !s.queueRunning) this.update(id, { queueRunning: true });
      },
      broadcast: (msg) => this.broadcast(msg),
      push: (msg) => this.push(msg),
      log,
    });
  }

  subscribe(fn: (msg: SessionBroadcast) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(msg: SessionBroadcast): void {
    for (const fn of this.listeners) fn(msg);
  }

  /** Sends a message unrelated to a Session (remote-access changes) to every UI socket. */
  notify(msg: SessionBroadcast): void {
    this.broadcast(msg);
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

  /** HTTP base URL of a live Sandbox's Daemon (raw Workspace files, VS Code), reachable only from the host. */
  async daemonHttpUrl(id: string): Promise<string> {
    const s = this.get(id);
    if (!s.containerId || (s.status !== "idle" && s.status !== "running")) {
      throw new HttpError(409, `session ${id} is ${s.status}; Workspace files are only available while the Sandbox runs`);
    }
    const { host, port } = await this.docker.endpoint(s.containerId, DAEMON_PORT);
    return `http://${host}:${port}`;
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

  // --- Pull changes to my folder ("copy" Sessions) -----------------------------

  private hostFolder(s: Session): string {
    if (s.workspaceSource.type !== "copy") {
      throw new HttpError(400, "Only Sessions started from a copy of a host folder can be pulled back into it.");
    }
    return s.workspaceSource.path;
  }

  private async syncState(id: string): Promise<{ dir: string; box: SyncManifest; host: SyncManifest; baseline: SyncManifest | null; plan: SyncPlan }> {
    const s = this.get(id);
    let dir: string;
    try {
      dir = await resolveHostDir(this.hostFolder(s));
    } catch (e) {
      if (e instanceof HostDirError) throw new HttpError(409, `The host folder is gone or unreadable: ${e.message}`);
      throw e;
    }
    const [box, host, baseline] = await Promise.all([
      this.daemonCall(id, DAEMON_METHODS.fsManifest, {}, MANIFEST_TIMEOUT_MS).then((r) => SyncManifest.parse(r)),
      hostManifest(dir),
      this.syncBaselines.read(id),
    ]);
    return { dir, box, host, baseline, plan: planSync(dir, box, host, baseline) };
  }

  /** Dry run: what a pull would do to the host folder right now. */
  async syncPlan(id: string): Promise<SyncPlan> {
    return (await this.syncState(id)).plan;
  }

  /**
   * Applies the box's changes to the host folder: fetches the added/updated files as one tar
   * from the Daemon, unpacks them, deletes what the box deleted, then records the new common state.
   */
  async syncPull(id: string, req: SyncRequest): Promise<SyncResult> {
    if (this.syncing.has(id)) throw new HttpError(409, "A pull is already running for this Session.");
    if (this.get(id).status === "running") throw new HttpError(409, "The Agent is still working; pull when the turn has ended.");
    this.syncing.add(id);
    try {
      const { dir, box, host, baseline, plan } = await this.syncState(id);
      const { apply, skipped } = selectEntries(plan, req.overwriteLocal);
      const writes = apply.filter((e) => e.action !== "delete").map((e) => e.path);
      let tar: ReadableStream<Uint8Array> | null = null;
      if (writes.length > 0) {
        const res = await fetch(new URL(FS_TAR_PATH, await this.daemonHttpUrl(id)), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: writes }),
        });
        if (!res.ok || !res.body) throw new HttpError(502, `the Sandbox refused to send its files: ${res.status} ${(await res.text()).slice(0, 300)}`);
        tar = res.body;
      }
      this.log(`pulling ${apply.length} change(s) from ${id.slice(0, 8)} into ${dir}${skipped.length ? ` (${skipped.length} conflict(s) skipped)` : ""}`);
      const result = await applySync(dir, apply, tar ? Readable.fromWeb(tar as NodeReadableStream) : null);
      await this.syncBaselines.write(id, nextBaseline(box, host, baseline, apply));
      return { ...result, skipped: skipped.length };
    } finally {
      this.syncing.delete(id);
    }
  }

  // --- Code pane (VS Code in the Sandbox) ----------------------------------

  async codeStart(id: string): Promise<CodeServerStatus> {
    return CodeServerStatus.parse(await this.daemonCall(id, DAEMON_METHODS.codeStart, {}, CODE_START_TIMEOUT_MS));
  }

  async codeStatus(id: string): Promise<CodeServerStatus> {
    return CodeServerStatus.parse(await this.daemonCall(id, DAEMON_METHODS.codeStatus, {}));
  }

  async codeStop(id: string): Promise<CodeServerStatus> {
    return CodeServerStatus.parse(await this.daemonCall(id, DAEMON_METHODS.codeStop, {}));
  }

  /** Shows a Workspace file in the Session's VS Code (starting it if needed). */
  async codeOpen(id: string, params: CodeOpenParams): Promise<void> {
    await this.daemonCall(id, DAEMON_METHODS.codeOpen, params, CODE_START_TIMEOUT_MS);
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
    this.prs.start();
  }

  async create(req: CreateSessionRequest): Promise<Session> {
    const settings = this.settings();
    if (!providerReady(req.provider, settings)) {
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
      gitIdentity: resolveGitIdentity(settings, req.gitIdentity),
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
      options: req.options ?? {},
      optionsPending: false,
      availableOptions: [],
      instructions: (req.instructions ?? settings.instructions).trim(),
      inspectLlm: req.provider === "claude-code" && (req.inspectLlm ?? false),
      inspectLlmPending: false,
      snapshotBytes: 0,
      snapshotCount: 0,
      branches: [],
      activeBranchId: ROOT_BRANCH_ID,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertSession(session);
    this.broadcast({ type: "session", session });
    if (req.prompt) this.pendingPrompts.set(id, { text: req.prompt });

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
    if (!providerReady(origin.provider, settings)) {
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
      gitIdentity: origin.gitIdentity,
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
      options: origin.options,
      optionsPending: false,
      availableOptions: [],
      instructions: origin.instructions,
      inspectLlm: origin.inspectLlm,
      inspectLlmPending: false,
      snapshotBytes: 0,
      snapshotCount: 0,
      branches: [],
      activeBranchId: ROOT_BRANCH_ID,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insertSession(session);
    this.db.copyEvents(origin.id, id, snapshot.eventSeq, branchScope(origin.branches, snapshot.branchId));
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
    if (req.prompt) this.pendingPrompts.set(id, { text: req.prompt });

    void this.provision(session, settings, snapshot.imageId).catch((e: unknown) => {
      this.log(`provision fork ${id} failed: ${String(e)}`);
      this.setStatus(id, "error", e instanceof Error ? e.message : String(e));
    });
    return session;
  }

  /** Environment a Session's Sandbox is created with. */
  private sandboxEnv(session: Session, settings: Settings): Record<string, string> {
    const env: Record<string, string> = {
      SESSIONBOXER_SESSION_ID: session.id,
      SESSIONBOXER_PROVIDER: session.provider,
      SESSIONBOXER_INSTRUCTIONS: session.instructions,
      ...providerEnv(session.provider, settings),
    };
    if (session.dockerMode !== "none") env.SESSIONBOXER_DOCKER = session.dockerMode;
    if (session.inspectLlm) env.SESSIONBOXER_INSPECT_LLM = "1";
    if (session.gitIdentity.name) {
      env.GIT_AUTHOR_NAME = session.gitIdentity.name;
      env.GIT_COMMITTER_NAME = session.gitIdentity.name;
    }
    if (session.gitIdentity.email) {
      env.GIT_AUTHOR_EMAIL = session.gitIdentity.email;
      env.GIT_COMMITTER_EMAIL = session.gitIdentity.email;
    }
    return env;
  }

  private createSandbox(session: Session, settings: Settings, image?: string): Promise<string> {
    return this.docker.create({
      sessionId: session.id,
      env: this.sandboxEnv(session, settings),
      cpus: settings.sandboxCpus,
      memoryGb: settings.sandboxMemoryGb,
      dockerMode: session.dockerMode,
      image,
    });
  }

  private async provision(session: Session, settings: Settings, image?: string): Promise<void> {
    const containerId = await this.createSandbox(session, settings, image);
    this.update(session.id, { containerId });
    await this.startSandbox(containerId, settings);
    await this.seedWorkspace(containerId, session, settings);
    await this.recordSyncBaseline(session.id, session.workspaceSource);
    this.setStatus(session.id, "idle");
    await this.connect(session.id, containerId);
    void this.refreshDiskUsage(session.id);
  }

  /**
   * Refreshes the Daemon inside the Sandbox to this checkout's build and its trust store to
   * the host's extra CA certificates, then starts it.
   */
  private async startSandbox(containerId: string, settings: Settings): Promise<void> {
    const short = containerId.slice(0, 12);
    try {
      for (const skipped of await this.docker.syncDaemon(containerId)) this.log(`${short}: not refreshed: ${skipped}`);
    } catch (e) {
      this.log(`could not refresh the Sandbox Daemon in ${short} (${e instanceof Error ? e.message : String(e)}); using the image's copy`);
    }
    const caBundle = sandboxCaBundle(settings);
    try {
      await this.docker.stageCaCerts(containerId, caBundle);
    } catch (e) {
      this.log(`could not copy the extra CA certificates into ${short}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.docker.start(containerId);
    if ((await this.docker.state(containerId)) !== "running") {
      throw new HttpError(502, "Sandbox exited right after starting; see `docker logs` for the container.");
    }
    try {
      await this.docker.activateCaCerts(containerId, caBundle);
      if (caBundle !== "") this.log(`${short} trusts ${countCerts(caBundle)} extra CA certificate(s)`);
    } catch (e) {
      this.log(`could not install the extra CA certificates in ${short}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async seedWorkspace(containerId: string, session: Session, settings: Settings): Promise<void> {
    const source = session.workspaceSource;
    if (source.type === "git") {
      const plan = planClone(source.url, resolveBoxCredentials(settings, session.mcpEnabled));
      const args = ["git", "clone", "--", plan.url, "."];
      if (source.ref) args.splice(2, 0, "--branch", source.ref);
      if (plan.account !== null) {
        this.log(`cloning ${plan.url} into ${containerId.slice(0, 12)} as @${plan.account}`);
      }
      try {
        await this.docker.exec(containerId, args, "/workspace", "agent", plan.env);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(message + cloneFailureHint(source.url, plan));
      }
    } else if (source.type === "copy") {
      const dir = await resolveHostDir(source.path);
      const entries = await planHostDir(dir);
      if (entries && entries.length === 0) return;
      this.log(`copying ${dir} (${entries ? `${entries.length} git entries` : "everything"}) into ${containerId.slice(0, 12)}`);
      await this.docker.putArchive(containerId, packHostDir(dir, entries), "/workspace");
      await this.docker.exec(containerId, ["chown", "-R", "agent:agent", "/workspace"], "/", "root");
    }
  }

  /** Records the copied host folder so a later pull can tell box changes from host changes. */
  private async recordSyncBaseline(id: string, source: WorkspaceSource): Promise<void> {
    if (source.type !== "copy") return;
    try {
      await this.syncBaselines.write(id, await hostManifest(source.path));
    } catch (e) {
      this.log(`could not record the copied state of ${source.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async prompt(id: string, req: PromptRequest): Promise<void> {
    const s = this.get(id);
    if (s.status === "stopped") throw new HttpError(409, "Session is stopped; resume it first.");
    if (s.status === "running") throw new HttpError(409, "The Agent is still working on the previous prompt.");
    if (s.status === "error") throw new HttpError(409, `Session is in error state: ${s.error ?? "unknown"}`);
    const client = this.clients.get(id);
    if (!client?.connected) {
      if (s.status === "creating") {
        this.pendingPrompts.set(id, req);
        this.prs.onPrompt(id, req.text);
        return;
      }
      throw new HttpError(503, "Sandbox Daemon is not connected yet; retry in a moment.");
    }
    const params: DaemonPromptParams = req.attachments?.length ? { text: req.text, attachments: req.attachments } : { text: req.text };
    const endedBefore = this.turnEnds.get(id) ?? 0;
    await client.request(DAEMON_METHODS.prompt, params);
    // A slash command answered locally ends its turn within the same batch of Daemon messages
    // as the RPC reply; the Daemon's own status notifications are authoritative then.
    if ((this.turnEnds.get(id) ?? 0) === endedBefore) this.setStatus(id, "running");
    this.prs.onPrompt(id, req.text);
  }

  /** Context-free question to the Session's Provider; nothing is recorded in the transcript. */
  async ask(id: string, text: string): Promise<AskResult> {
    return AskResult.parse(await this.daemonCall(id, DAEMON_METHODS.ask, { text }, ASK_TIMEOUT_MS));
  }

  /**
   * Asks the Agent for its `/context` report outside the conversation and records the parsed
   * breakdown as a `context_breakdown` event (the transcript shows a small marker; the Context
   * pane shows the tables). Needs an idle Session.
   */
  async contextReport(id: string): Promise<ContextBreakdown> {
    const s = this.get(id);
    if (s.status === "running") throw new HttpError(409, "The Agent is still working; ask again when the turn has ended.");
    const result = DaemonContextReportResult.parse(await this.daemonCall(id, DAEMON_METHODS.contextReport, {}, ASK_TIMEOUT_MS));
    if (result.text.trim() === "") throw new HttpError(502, "The Agent returned an empty context report.");
    const breakdown = parseContextReport(s.provider, result.text);
    const ev = this.db.appendEvent(id, { type: "context_breakdown", breakdown });
    this.broadcast({ type: "event", event: ev });
    return breakdown;
  }

  /** The Provider's own record of one compaction, read in the Sandbox (nothing is asked of the Agent). */
  async compactionDetails(id: string, req: CompactionDetailsRequest): Promise<CompactionDetails> {
    const s = this.get(id);
    if (s.status !== "idle" && s.status !== "running") {
      throw new HttpError(409, `The Sandbox is ${s.status}; the Provider's records are only readable while it runs.`);
    }
    return DaemonCompactionDetailsResult.parse(await this.daemonCall(id, DAEMON_METHODS.compactionDetails, req, DAEMON_WAIT_MS));
  }

  async cancel(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client?.connected) throw new HttpError(503, "Sandbox Daemon is not connected.");
    await client.request(DAEMON_METHODS.cancel, {});
  }

  // --- Branches ---------------------------------------------------------------

  /**
   * Continues the conversation from the `turn_ended` at `seq`. What followed stays on the
   * current branch (it can be switched back to), a new branch becomes active, and the
   * Agent's memory is rewound: ACP `session/fork` at the last assistant message before
   * `seq` when the Agent offers it, else a fresh session fed the transcript. Branches share
   * the Sandbox and only the active one talks to the Agent; refused while a turn runs.
   */
  async revert(id: string, seq: number): Promise<Session> {
    const s = this.requireIdleForBranching(id);
    const scope = this.db.activeScope(id);
    const target = this.db.getEvent(id, seq);
    if (!target || target.body.type !== "turn_ended" || !inBranchScope(scope, target.branchId, seq)) {
      throw new HttpError(400, "Revert points must be a turn boundary of the current branch.");
    }
    const visible = this.db.listEvents(id, 0, 100_000, scope);
    if (!visible.some((e) => e.seq > seq && isConversational(e))) {
      throw new HttpError(409, "This is already the end of the conversation; just send the next message.");
    }
    const before = visible.filter((e) => e.seq <= seq);
    await this.snapshotChains.get(id)?.catch(() => undefined);
    const status = DaemonStatus.parse(await this.daemonCall(id, DAEMON_METHODS.status, {}));
    if (status.turnActive) throw new HttpError(409, "The Agent is still working on the previous prompt.");
    const fromBranch = s.activeBranchId;
    this.ensureRootBranch(id);
    if (status.acpSessionId) this.db.setBranchAcpSessionId(id, fromBranch, status.acpSessionId);

    const result = DaemonSessionForkResult.parse(
      await this.daemonCall(
        id,
        DAEMON_METHODS.sessionFork,
        { messageId: lastAssistantMessageId(before), replay: replayPrompt(before) },
        BRANCH_TIMEOUT_MS,
      ),
    );
    const branch: Branch = {
      id: randomBytes(4).toString("hex"),
      sessionId: id,
      name: `branch ${this.db.listBranches(id).length}`,
      parentId: target.branchId,
      forkedAtSeq: seq,
      method: result.method,
      createdAt: new Date().toISOString(),
    };
    this.db.insertBranch(branch, result.acpSessionId);
    this.log(`branch ${id}/${branch.id} from ${fromBranch}@${seq} (${result.method}, ACP ${result.acpSessionId})`);
    return this.update(id, { activeBranchId: branch.id });
  }

  /** Makes another branch the active one: its transcript shows and the Agent loads its session. */
  async switchBranch(id: string, branchId: string): Promise<Session> {
    const s = this.requireIdleForBranching(id);
    if (s.activeBranchId === branchId) return s;
    if (!s.branches.some((b) => b.id === branchId)) throw new HttpError(404, `branch ${branchId} not found`);
    const acpSessionId = this.db.branchAcpSessionId(id, branchId);
    if (!acpSessionId) throw new HttpError(409, "This branch has no Agent session on record; it cannot be resumed.");
    await this.snapshotChains.get(id)?.catch(() => undefined);
    const status = DaemonStatus.parse(await this.daemonCall(id, DAEMON_METHODS.status, {}));
    if (status.turnActive) throw new HttpError(409, "The Agent is still working on the previous prompt.");
    if (status.acpSessionId) this.db.setBranchAcpSessionId(id, s.activeBranchId, status.acpSessionId);

    const result = DaemonSessionSwitchResult.parse(
      await this.daemonCall(id, DAEMON_METHODS.sessionSwitch, { acpSessionId }, BRANCH_TIMEOUT_MS),
    );
    if (result.acpSessionId !== acpSessionId) {
      this.log(`branch ${id}/${branchId}: ACP session ${acpSessionId} could not be loaded; the Agent starts over on ${result.acpSessionId}`);
      this.db.setBranchAcpSessionId(id, branchId, result.acpSessionId);
    }
    return this.update(id, { activeBranchId: branchId });
  }

  private requireIdleForBranching(id: string): Session {
    const s = this.get(id);
    if (s.status === "running") throw new HttpError(409, "The Agent is still working on the previous prompt.");
    if (s.status !== "idle") throw new HttpError(409, `Session is ${s.status}; branching needs a running Sandbox.`);
    return s;
  }

  private ensureRootBranch(id: string): void {
    if (this.db.listBranches(id).length > 0) return;
    const s = this.get(id);
    this.db.insertBranch(
      { id: ROOT_BRANCH_ID, sessionId: id, name: "main", parentId: null, forkedAtSeq: null, method: null, createdAt: s.createdAt },
      null,
    );
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
    await this.prompt(id, { text: saved.text });
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
      await this.prompt(id, { text: next.text });
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
    return this.chainSnapshot(id, () => this.doSnapshot(id, reason, eventSeq));
  }

  /** Runs `op` after every Snapshot operation already queued for the Session. */
  private chainSnapshot<T>(id: string, op: () => Promise<T>): Promise<T> {
    const prev = this.snapshotChains.get(id) ?? Promise.resolve();
    const run = prev.then(op, op);
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
      const { imageId, sizeBytes } = await this.docker
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
        eventSeq: eventSeq ?? this.db.lastEventSeq(id),
        branchId: s.activeBranchId,
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

  /**
   * Moves the Session onto a new Sandbox created from a full image of the current one's
   * filesystem (`docker export | docker import`, recorded as a `rebuild` Snapshot), for a
   * Sandbox whose image lost content in Docker's store and can no longer be committed.
   * The Sandbox is stopped for the duration (minutes for a big filesystem); the old
   * container is removed once the new one runs, and stays as the fallback if the rebuild fails.
   */
  rebuild(id: string): Promise<Session> {
    return this.chainSnapshot(id, () => this.doRebuild(id));
  }

  private async doRebuild(id: string): Promise<Session> {
    const s = this.get(id);
    const old = s.containerId;
    if (!old) throw new HttpError(409, "Session has no Sandbox to rebuild.");
    if (s.status !== "idle" && s.status !== "stopped" && s.status !== "error") {
      throw new HttpError(409, `Session is ${s.status}; wait for the turn to finish.`);
    }
    if ((await this.docker.state(old)) === "missing") {
      throw new HttpError(409, "Sandbox container is missing; delete the session.");
    }
    const settings = this.settings();
    if (!providerReady(s.provider, settings)) {
      throw new HttpError(400, providerSetupHint(s.provider));
    }
    // The old Sandbox's death (stopped here, or reported late by Docker) is expected until the new one runs.
    this.stopping.add(id);
    if (s.status !== "stopped") await this.stop(id);
    const snapshotId = randomBytes(6).toString("hex");
    const ordinal = this.db.nextSnapshotOrdinal(id);
    const tag = `${id}-${ordinal}`;
    this.setStatus(id, "creating");
    this.broadcast({ type: "snapshotting", sessionId: id, active: true });
    let renamed = false;
    let created: string | null = null;
    try {
      const started = Date.now();
      const { imageId, sizeBytes } = await this.docker.flatten(old, {
        snapshotId,
        tag,
        stripEnv: [...PROVIDER_ENV_KEYS[s.provider]],
        keepEnv: Object.keys(this.sandboxEnv(s, settings)),
      });
      this.stopping.delete(id);
      this.db.insertSnapshot({
        id: snapshotId,
        sessionId: id,
        ordinal,
        reason: "rebuild",
        imageTag: `${SNAPSHOT_REPO}:${tag}`,
        imageId,
        eventSeq: this.db.lastEventSeq(id),
        branchId: s.activeBranchId,
        sizeBytes,
        queuedMessages: this.db.listSavedMessages(id).map((m) => m.text),
        createdAt: new Date().toISOString(),
      });
      this.log(`rebuild ${id}: flattened ${old.slice(0, 12)} into snapshot #${ordinal} (${(sizeBytes / 1024 ** 2).toFixed(1)} MB) in ${Date.now() - started} ms`);
      this.broadcastSnapshots(id);
      await this.docker.rename(old, `sbx-${id}-old`);
      renamed = true;
      created = await this.createSandbox(s, settings, imageId);
      this.update(id, { containerId: created });
      await this.startSandbox(created, settings);
      const next = this.setStatus(id, "idle");
      await this.connect(id, created);
      await this.docker.remove(old);
      void this.refreshDiskUsage(id);
      return next;
    } catch (e) {
      // Back to the old Sandbox, which Resume can still start.
      if (created) await this.docker.remove(created).catch((re: unknown) => this.log(`rebuild ${id}: could not remove the new Sandbox: ${String(re)}`));
      if (renamed) await this.docker.rename(old, `sbx-${id}`).catch((re: unknown) => this.log(`rebuild ${id}: rename back failed: ${String(re)}`));
      this.update(id, { containerId: old });
      this.setStatus(id, "error", `Rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    } finally {
      this.stopping.delete(id);
      this.broadcast({ type: "snapshotting", sessionId: id, active: false });
    }
  }

  async deleteSnapshot(id: string, snapshotId: string): Promise<void> {
    this.get(id);
    const snapshot = this.db.getSnapshot(id, snapshotId);
    if (!snapshot) throw new HttpError(404, `snapshot ${snapshotId} not found`);
    const forks = this.db.countForksOf(snapshotId);
    if (forks > 0) throw new HttpError(409, `Snapshot ${snapshot.ordinal} is the origin of ${forks} Session(s); delete them first.`);
    if (this.sandboxBase(id)?.id === snapshotId) throw new HttpError(409, `Snapshot ${snapshot.ordinal} is the image the Sandbox runs on.`);
    await this.docker.removeImage(snapshot.imageId);
    this.db.deleteSnapshot(id, snapshotId);
    this.broadcastSnapshots(id);
  }

  /** The `rebuild` Snapshot the Session's Sandbox was created from, if any (its image is in use). */
  private sandboxBase(id: string): Snapshot | undefined {
    return this.db
      .listSnapshots(id)
      .filter((s) => s.reason === "rebuild")
      .at(-1);
  }

  /** Deletes every Snapshot of the Session except those a fork was started from or the Sandbox runs on. */
  async deleteAllSnapshots(id: string): Promise<DeleteSnapshotsResult> {
    this.get(id);
    let deleted = 0;
    let kept = 0;
    const base = this.sandboxBase(id);
    for (const snapshot of this.db.listSnapshots(id)) {
      if (this.db.countForksOf(snapshot.id) > 0 || snapshot.id === base?.id) {
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
    const outerStop = this.stopping.has(id);
    this.stopping.add(id);
    try {
      if (s.queueRunning || s.mcpPending || s.modelPending || s.optionsPending || s.inspectLlmPending) {
        this.update(id, { queueRunning: false, mcpPending: false, modelPending: false, optionsPending: false, inspectLlmPending: false });
      }
      if (s.status === "running") await this.cancelAndWait(id);
      this.disconnect(id);
      await this.docker.stop(s.containerId);
      const stopped = this.setStatus(id, "stopped");
      void this.refreshDiskUsage(id);
      return stopped;
    } finally {
      if (!outerStop) this.stopping.delete(id);
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
    await this.startSandbox(s.containerId, this.settings());
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
    await this.syncBaselines.remove(id);
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
      ...(req.options !== undefined ? { options: { ...this.get(id).options, ...req.options } } : {}),
      ...(req.inspectLlm !== undefined ? { inspectLlm: req.inspectLlm && this.get(id).provider === "claude-code" } : {}),
    });
    if (req.mcpEnabled !== undefined) await this.pushMcpServers(id);
    if (req.model !== undefined) await this.pushModel(id);
    if (req.options !== undefined) await this.pushOptions(id, req.options);
    if (req.inspectLlm !== undefined) await this.pushLlmInspect(id);
    return req.mcpEnabled !== undefined || req.model !== undefined || req.options !== undefined || req.inspectLlm !== undefined
      ? this.get(id)
      : s;
  }

  /**
   * Tells the Session's Daemon whether the Agent's model API calls go through the inspector; the
   * Daemon restarts the Agent in place when idle, after the turn otherwise. Older Daemons ignore it.
   */
  async pushLlmInspect(id: string): Promise<void> {
    const s = this.get(id);
    const client = this.clients.get(id);
    if (s.provider !== "claude-code" || !client?.connected) return;
    try {
      const params: DaemonLlmInspectSetParams = { enabled: s.inspectLlm };
      const result = DaemonLlmInspectSetResult.parse(await client.request(DAEMON_METHODS.llmInspectSet, params));
      this.update(id, { inspectLlmPending: !result.applied });
    } catch (e) {
      if (e instanceof DaemonRpcError && e.code === -32601) {
        if (s.inspectLlm) throw new HttpError(502, "The Sandbox runs an older Daemon without the LLM inspector; Stop and Resume the session to refresh it.");
        return;
      }
      throw e;
    }
  }

  /**
   * The model API calls recorded for the Session: the summaries the Control Plane stored (numbered,
   * every Daemon epoch) with, for the running Daemon's own calls, whether the bodies are still there.
   */
  llmCalls(id: string): { calls: LlmCall[]; withBodies: string[] } {
    const scope = this.db.activeScope(id);
    const calls: LlmCall[] = [];
    for (const ev of this.db.listEvents(id, 0, 100000, scope)) if (ev.body.type === "llm_call") calls.push(ev.body.call);
    return { calls, withBodies: [] };
  }

  /** Ids of the recorded calls whose bodies the live Daemon still holds (none when the Sandbox is not running). */
  async llmCallsWithBodies(id: string): Promise<string[]> {
    const client = this.clients.get(id);
    if (!client?.connected) return [];
    try {
      return DaemonLlmCallsResult.parse(await client.request(DAEMON_METHODS.llmCalls, {})).withBodies;
    } catch (e) {
      if (e instanceof DaemonRpcError && e.code === -32601) return [];
      throw e;
    }
  }

  /** The exact bodies of one call, from the Sandbox's tmpfs; `request`/`response` are `null` once evicted or after a restart. */
  async llmCallBody(id: string, callId: string): Promise<LlmCallBody> {
    const s = this.get(id);
    const known = this.llmCalls(id).calls.find((c) => c.id === callId) ?? null;
    if (!known) throw new HttpError(404, `call ${callId} not found`);
    if (s.status !== "idle" && s.status !== "running") return { call: known, request: null, response: null };
    const params: DaemonLlmCallBodyParams = { id: callId };
    try {
      const body = DaemonLlmCallBodyResult.parse(await this.daemonCall(id, DAEMON_METHODS.llmCallBody, params, DAEMON_WAIT_MS));
      return { ...body, call: known };
    } catch (e) {
      if (e instanceof DaemonRpcError && e.code === -32601) return { call: known, request: null, response: null };
      throw e;
    }
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

  /**
   * Sends option values to the Session's Daemon (`values`, or everything the Session asked for
   * when omitted, as after a Daemon connect; that restore is lenient, since the current model may
   * not offer every stored option). Same timing and fallbacks as `pushModel`.
   */
  async pushOptions(id: string, values?: OptionValues): Promise<Session> {
    const s = this.get(id);
    const client = this.clients.get(id);
    const options = values ?? s.options;
    if (Object.keys(options).length === 0 || !client?.connected) return s;
    try {
      const params: DaemonOptionSetParams = { options, lenient: values === undefined };
      const result = DaemonOptionSetResult.parse(await client.request(DAEMON_METHODS.optionSet, params));
      return this.update(id, { optionsPending: !result.applied });
    } catch (e) {
      if (e instanceof DaemonRpcError && e.code === -32601) {
        throw new HttpError(502, "The Sandbox runs an older Daemon without option selection; Stop and Resume the session to refresh it.");
      }
      throw e;
    }
  }

  /**
   * Sends the Claude model allowlist (`Settings.claudeModels`) to a Claude Session's Daemon, which
   * writes it to the Sandbox's Claude settings before the Agent (re)starts. Older Daemons ignore it.
   */
  async pushClaudeModels(id: string): Promise<void> {
    const s = this.get(id);
    const client = this.clients.get(id);
    if (s.provider !== "claude-code" || !client?.connected) return;
    try {
      DaemonClaudeModelsSetResult.parse(await client.request(DAEMON_METHODS.claudeModelsSet, { models: this.settings().claudeModels }));
    } catch (e) {
      if (e instanceof DaemonRpcError && e.code === -32601) {
        this.log(`daemon ${id} predates the Claude model allowlist; Stop and Resume the session to refresh it`);
        return;
      }
      throw e;
    }
  }

  /** `Settings.claudeModels` changed: every live Claude Session gets the new allowlist (applied once idle). */
  async pushClaudeModelsToAll(): Promise<void> {
    for (const s of this.list()) {
      if (s.provider !== "claude-code" || (s.status !== "idle" && s.status !== "running")) continue;
      await this.pushClaudeModels(s.id).catch((e: unknown) => this.log(`claude models push ${s.id} failed: ${String(e)}`));
    }
  }

  /** Hands `Settings.recordingNarration` to a Session's Daemon (tmpfs, read at `stop_recording`). Older Daemons ignore it. */
  async pushRecordingPrefs(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client?.connected) return;
    try {
      const params: DaemonRecordingPrefsSetParams = { narration: this.settings().recordingNarration };
      DaemonRecordingPrefsSetResult.parse(await client.request(DAEMON_METHODS.recordingPrefsSet, params));
    } catch (e) {
      if (e instanceof DaemonRpcError && e.code === -32601) {
        this.log(`daemon ${id} predates recording preferences; Stop and Resume the session to refresh it`);
        return;
      }
      throw e;
    }
  }

  /** `Settings.recordingNarration` changed: every live Session gets it. */
  async pushRecordingPrefsToAll(): Promise<void> {
    for (const s of this.list()) {
      if (s.status !== "idle" && s.status !== "running") continue;
      await this.pushRecordingPrefs(s.id).catch((e: unknown) => this.log(`recording prefs push ${s.id} failed: ${String(e)}`));
    }
  }

  /** Last model list each Provider's Agent reported (what New Session can offer). */
  providerModels(): ProviderModels {
    return this.db.providerModels();
  }

  /** Every option each Provider's Agent has advertised (what New Session can offer). */
  providerOptions(): ProviderOptions {
    return this.db.providerOptions();
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
    const credentials = resolveBoxCredentials(this.settings(), s.mcpEnabled);
    try {
      const result = DaemonMcpSetResult.parse(await client.request(DAEMON_METHODS.mcpSet, { servers, credentials }));
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
    // The Daemon waits for the MCP set before it starts the Agent (so the allowlist goes first); older Daemons ignore the calls.
    this.pushClaudeModels(id)
      .then(() => this.pushLlmInspect(id))
      .then(() => this.pushMcpServers(id))
      .then(() => this.pushModel(id))
      .then(() => this.pushOptions(id))
      .then(() => this.pushRecordingPrefs(id))
      .catch((e: unknown) => this.log(`mcp/model/options push ${id} failed: ${String(e)}`));
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
    if (status.llmInspectPending !== s.inspectLlmPending) this.update(id, { inspectLlmPending: status.llmInspectPending });
    if (status.models && this.db.setProviderModels(s.provider, status.models)) {
      this.broadcast({ type: "models", provider: s.provider, models: status.models });
    }
    if (status.model !== null && (status.model !== s.model || status.modelPending !== s.modelPending)) {
      this.update(id, { model: status.model, modelPending: status.modelPending });
    }
    if (status.options) {
      const merged = this.db.mergeProviderOptions(s.provider, status.options);
      if (merged) this.broadcast({ type: "options", provider: s.provider, options: merged });
      const options = { ...s.options, ...status.optionValues };
      if (
        JSON.stringify(options) !== JSON.stringify(s.options) ||
        status.optionsPending !== s.optionsPending ||
        JSON.stringify(status.options) !== JSON.stringify(s.availableOptions)
      ) {
        this.update(id, { options, optionsPending: status.optionsPending, availableOptions: status.options });
      }
    }
  }

  private onDaemonEvent(id: string, ev: DaemonEvent): void {
    const cursor = this.db.getDaemonCursor(id);
    if (cursor && cursor.epoch === ev.epoch && ev.seq <= cursor.lastSeq) return;
    const body = ev.body.type === "llm_call" ? { ...ev.body, call: { ...ev.body.call, ordinal: this.db.countLlmCalls(id) + 1 } } : ev.body;
    const stored = this.db.appendEvent(id, body, ev.ts);
    this.db.setDaemonCursor(id, ev.epoch, ev.seq);
    this.broadcast({ type: "event", event: stored });
    if (ev.body.type === "user_prompt" && stored.branchId !== ROOT_BRANCH_ID && this.db.countBranchPrompts(id, stored.branchId) === 1) {
      this.db.renameBranch(id, stored.branchId, branchTitle(ev.body.text));
      const s = this.db.getSession(id);
      if (s) this.broadcast({ type: "session", session: s });
    }
    if (ev.body.type === "turn_ended" || ev.body.type === "agent_error") {
      this.turnEnds.set(id, (this.turnEnds.get(id) ?? 0) + 1);
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
      const turn = this.turnEvents(id, stored.seq);
      if (ev.body.type === "turn_ended") this.prs.onTurnEnded(id, turn);
      if (s) {
        const body = ev.body.type === "agent_error" ? `Error: ${ev.body.message}` : ev.body.stopReason === "cancelled" ? "Turn stopped." : (lastAgentText(turn) ?? "Turn ended.");
        this.push({ title: s.title, body: body.length > 200 ? `${body.slice(0, 197)}…` : body, tag: `sessionboxer-turn-${id}`, url: sessionRoute(id) });
      }
    }
  }

  /** The events of the turn that ended at `endSeq`: from its `user_prompt` on. */
  private turnEvents(id: string, endSeq: number): SessionEvent[] {
    const recent = this.db.listEvents(id, Math.max(0, endSeq - 2000)).filter((e) => e.seq <= endSeq);
    const start = recent.map((e) => e.body.type).lastIndexOf("user_prompt");
    return start === -1 ? recent : recent.slice(start);
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
      const message = e instanceof Error ? e.message : String(e);
      this.log(`auto snapshot ${id} failed: ${message}`);
      this.broadcast({ type: "snapshot_failed", sessionId: id, message: `Automatic snapshot failed. ${message}` });
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
    this.prs.stop();
    for (const id of this.clients.keys()) this.disconnect(id);
  }
}

/** Something was said or done (not status/usage/title bookkeeping). */
function isConversational({ body }: SessionEvent): boolean {
  if (body.type === "user_prompt") return true;
  if (body.type !== "update") return false;
  switch (body.update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "plan":
      return true;
    default:
      return false;
  }
}

/** The text of the Agent's last message in a turn, collapsed to one line (what a notification shows). */
function lastAgentText(events: SessionEvent[]): string | null {
  let text = "";
  let lastId: string | null | undefined;
  for (const { body } of events) {
    if (body.type !== "update" || body.update.sessionUpdate !== "agent_message_chunk" || body.update.content.type !== "text") continue;
    if (body.update.messageId !== lastId) {
      text = "";
      lastId = body.update.messageId;
    }
    text += body.update.content.text;
  }
  const line = text.replace(/\s+/g, " ").trim();
  return line === "" ? null : line;
}

/** `messageId` of the last assistant message in the transcript prefix: where an ACP point-fork cuts. */
function lastAssistantMessageId(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const body = events[i]?.body;
    if (body?.type === "update" && body.update.sessionUpdate === "agent_message_chunk" && body.update.messageId) {
      return body.update.messageId;
    }
  }
  return null;
}

/** The transcript prefix as one prompt that primes a fresh Agent session (Providers without `session/fork`). */
function replayPrompt(events: SessionEvent[]): string | null {
  const parts: string[] = [];
  let agent: string[] = [];
  const flushAgent = (): void => {
    if (agent.length > 0) parts.push(`Assistant:\n${agent.join("")}`);
    agent = [];
  };
  for (const { body } of events) {
    if (body.type === "user_prompt") {
      flushAgent();
      parts.push(`User:\n${body.text}`);
    } else if (body.type === "update") {
      const u = body.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") agent.push(u.content.text);
      else if (u.sessionUpdate === "tool_call") {
        flushAgent();
        parts.push(`[Assistant used a tool: ${u.title}]`);
      }
    }
  }
  flushAgent();
  if (parts.length === 0) return null;
  let transcript = parts.join("\n\n");
  if (transcript.length > REPLAY_MAX_CHARS) transcript = `[earlier part omitted]\n\n${transcript.slice(-REPLAY_MAX_CHARS)}`;
  return (
    "We are resuming an earlier conversation between you (Assistant) and the user, transcribed below. " +
    "Treat it as your own memory of what was said and done; the files in the workspace are in the state that conversation left them. " +
    'Do not repeat or redo any of it now: reply with exactly "OK" and wait for the user\'s next message.\n\n' +
    transcript
  );
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
