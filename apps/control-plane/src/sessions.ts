import { randomBytes } from "node:crypto";
import {
  DAEMON_METHODS,
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
  type FsChange,
  type Session,
  type SessionBroadcast,
  type SessionEvent,
  type SessionStatus,
  type Settings,
  type WorkspaceSource,
} from "@sessionboxer/protocol";
import { claudeToken } from "./config.js";
import { DaemonClient, DaemonRpcError } from "./daemon-client.js";
import type { Db } from "./db.js";
import type { SandboxDocker } from "./docker.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CANCEL_GRACE_MS = 8000;
const DAEMON_WAIT_MS = 15_000;

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

  /** websockify endpoint of a live Sandbox's Desktop, reachable only from the host. */
  async desktopUrl(id: string): Promise<string> {
    const s = this.get(id);
    if (!s.containerId || (s.status !== "idle" && s.status !== "running")) {
      throw new HttpError(409, `session ${id} is ${s.status}; the Desktop is only available while the Sandbox runs`);
    }
    const host = await this.docker.address(s.containerId);
    return `ws://${host}:${NOVNC_PORT}/websockify`;
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

  private async daemonCall(id: string, method: string, params: unknown): Promise<unknown> {
    try {
      const client = await this.liveClient(id);
      return await client.request(method, params);
    } catch (e) {
      if (e instanceof DaemonRpcError) {
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
    await this.docker.ensureNetwork();
    await this.docker.watchDeaths((containerId, sessionId, exitCode) => {
      if (this.stopping.has(sessionId)) return;
      const s = this.db.getSession(sessionId);
      if (!s || s.containerId !== containerId || s.status === "stopped") return;
      this.disconnect(sessionId);
      this.setStatus(sessionId, "error", `Sandbox exited unexpectedly (exit code ${exitCode})`);
    });
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
    if (req.provider === "claude-code" && !claudeToken(settings)) {
      throw new HttpError(400, "No Claude token configured. Run `claude setup-token` and paste it in Settings.");
    }
    if (req.workspaceSource.type === "copy") {
      throw new HttpError(400, "Copying a host directory is not available yet (planned for M5).");
    }
    await this.docker.ensureImage();

    const id = randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    const session: Session = {
      id,
      title: req.title ?? titleFromPrompt(req.prompt) ?? `Session ${id.slice(0, 6)}`,
      provider: req.provider,
      status: "creating",
      workspaceSource: req.workspaceSource,
      containerId: null,
      error: null,
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

  private async provision(session: Session, settings: Settings): Promise<void> {
    const env: Record<string, string> = {
      SESSIONBOXER_SESSION_ID: session.id,
      CLAUDE_CODE_OAUTH_TOKEN: claudeToken(settings),
    };
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
    });
    this.update(session.id, { containerId });
    await this.docker.start(containerId);
    await this.seedWorkspace(containerId, session.workspaceSource);
    this.setStatus(session.id, "idle");
    await this.connect(session.id, containerId);
  }

  private async seedWorkspace(containerId: string, source: WorkspaceSource): Promise<void> {
    if (source.type !== "git") return;
    const args = ["git", "clone", "--", source.url, "."];
    if (source.ref) args.splice(2, 0, "--branch", source.ref);
    await this.docker.exec(containerId, args);
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

  async cancel(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client?.connected) throw new HttpError(503, "Sandbox Daemon is not connected.");
    await client.request(DAEMON_METHODS.cancel, {});
  }

  async stop(id: string): Promise<Session> {
    const s = this.get(id);
    if (!s.containerId) throw new HttpError(409, "Session has no Sandbox.");
    if (s.status === "stopped") return s;
    this.stopping.add(id);
    try {
      if (s.status === "running") await this.cancelAndWait(id);
      this.disconnect(id);
      await this.docker.stop(s.containerId);
      return this.setStatus(id, "stopped");
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
    await this.docker.start(s.containerId);
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
    this.db.deleteSession(id);
    this.broadcast({ type: "session_deleted", id });
  }

  rename(id: string, title: string): Session {
    return this.update(id, { title });
  }

  private async connect(id: string, containerId: string): Promise<void> {
    this.disconnect(id);
    const host = await this.docker.address(containerId);
    const client = new DaemonClient(host, {
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

  private update(id: string, patch: Partial<Pick<Session, "title" | "status" | "containerId" | "error">>): Session {
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
