import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  type ClientConnection,
  type InitializeRequest,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import type { SessionUpdate, StopReason } from "@sessionboxer/protocol";

export interface AgentConfig {
  command: string;
  args: string[];
  cwd: string;
  mcpCommand: string;
  stateFile: string;
  log: (msg: string) => void;
}

export interface AgentEvents {
  onUpdate: (update: SessionUpdate) => void;
  onTurnEnded: (stopReason: StopReason) => void;
  onError: (message: string) => void;
  onStateChange: () => void;
}

interface PersistedState {
  acpSessionId: string;
}

const CLIENT_INFO = { name: "sessionboxer-daemon", version: "0.0.0" };

/** Mode ids that mean "auto-approve every tool call", per adapter (claude-agent-acp, devin acp). */
const BYPASS_MODE_IDS = ["bypassPermissions", "bypass"];

/** session/new can fail on transient upstream fetches (Devin's team settings); retry before giving up. */
const NEW_SESSION_ATTEMPTS = 3;
const NEW_SESSION_RETRY_MS = 3000;

/**
 * Owns the Agent child process and its ACP connection. Creates a new ACP
 * session on first start and loads the persisted one on later starts, so the
 * Agent's own history survives Sandbox stop/resume.
 */
export class AgentManager {
  private child: ChildProcess | null = null;
  private conn: ClientConnection | null = null;
  private starting: Promise<void> | null = null;
  private replaying = false;

  acpSessionId: string | null = null;
  agentInfo: { name: string; version: string } | null = null;
  turnActive = false;
  ready = false;
  error: string | null = null;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly events: AgentEvents,
  ) {
    this.acpSessionId = this.readState()?.acpSessionId ?? null;
  }

  async ensureStarted(): Promise<void> {
    if (this.ready) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    this.error = null;
    this.cfg.log(`spawning ${[this.cfg.command, ...this.cfg.args].join(" ")}`);
    const child = spawn(this.cfg.command, this.cfg.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd: this.cfg.cwd,
    });
    this.child = child;
    child.stderr?.on("data", (d: Buffer) => this.cfg.log(`[agent] ${d.toString().trimEnd()}`));
    child.on("exit", (code, signal) => {
      this.cfg.log(`agent exited code=${code} signal=${signal}`);
      this.onAgentGone(`agent process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    });
    if (!child.stdin || !child.stdout) throw new Error("agent stdio unavailable");

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const app = client(CLIENT_INFO)
      .onRequest("session/request_permission", (ctx) => {
        const { options } = ctx.params;
        const allow =
          options.find((o) => o.kind === "allow_always") ??
          options.find((o) => o.kind === "allow_once") ??
          options[0];
        if (!allow) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      })
      .onNotification("session/update", (ctx) => {
        if (this.replaying) return;
        this.events.onUpdate(ctx.params.update);
      });
    const conn = app.connect(stream);
    this.conn = conn;
    conn.closed.then(() => this.onAgentGone("ACP connection closed"));

    try {
      const initParams: InitializeRequest = {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: CLIENT_INFO,
      };
      const init = await conn.agent.request("initialize", initParams);
      this.agentInfo = init.agentInfo
        ? { name: init.agentInfo.name, version: init.agentInfo.version ?? "" }
        : null;
      const mcpServers: McpServer[] = [{ name: "desktop", command: this.cfg.mcpCommand, args: [], env: [] }];

      let loaded = false;
      if (this.acpSessionId && init.agentCapabilities?.loadSession) {
        this.replaying = true;
        try {
          const result = await conn.agent.request("session/load", {
            sessionId: this.acpSessionId,
            cwd: this.cfg.cwd,
            mcpServers,
          });
          loaded = true;
          this.cfg.log(`loaded ACP session ${this.acpSessionId}`);
          await this.ensureBypassMode(conn, this.acpSessionId, result?.modes);
        } catch (e) {
          this.cfg.log(`session/load failed, creating a new session: ${String(e)}`);
        } finally {
          this.replaying = false;
        }
      }
      if (!loaded) {
        const newParams: NewSessionRequest = { cwd: this.cfg.cwd, mcpServers };
        const created = await this.newSessionWithRetry(conn, newParams);
        this.acpSessionId = created.sessionId;
        this.writeState({ acpSessionId: created.sessionId });
        this.cfg.log(`created ACP session ${created.sessionId}`);
        await this.ensureBypassMode(conn, created.sessionId, created.modes);
      }
      this.ready = true;
      this.events.onStateChange();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.events.onError(this.error);
      this.events.onStateChange();
      this.kill();
      throw e;
    }
  }

  private async newSessionWithRetry(
    conn: ClientConnection,
    params: NewSessionRequest,
  ): Promise<NewSessionResponse> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await conn.agent.request("session/new", params);
      } catch (e) {
        if (attempt >= NEW_SESSION_ATTEMPTS || !this.child) throw e;
        const delay = NEW_SESSION_RETRY_MS * attempt;
        this.cfg.log(`session/new failed (attempt ${attempt}), retrying in ${delay}ms: ${String(e)}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async ensureBypassMode(
    conn: ClientConnection,
    sessionId: string,
    modes: SessionModeState | null | undefined,
  ): Promise<void> {
    const bypass = modes?.availableModes.find((m) => BYPASS_MODE_IDS.includes(m.id));
    if (!modes || !bypass || modes.currentModeId === bypass.id) return;
    await conn.agent.request("session/set_mode", { sessionId, modeId: bypass.id });
    this.cfg.log(`switched to mode ${bypass.id}`);
  }

  async prompt(text: string): Promise<void> {
    if (this.turnActive) throw new Error("a turn is already active");
    this.turnActive = true;
    this.events.onStateChange();
    try {
      await this.ensureStarted();
      if (!this.conn || !this.acpSessionId) throw new Error("agent not ready");
      const result = await this.conn.agent.request("session/prompt", {
        sessionId: this.acpSessionId,
        prompt: [{ type: "text", text }],
      });
      this.events.onTurnEnded(result.stopReason);
    } catch (e) {
      this.events.onError(e instanceof Error ? e.message : String(e));
    } finally {
      this.turnActive = false;
      this.events.onStateChange();
    }
  }

  async cancel(): Promise<void> {
    if (!this.conn || !this.acpSessionId || !this.turnActive) return;
    await this.conn.agent.notify("session/cancel", { sessionId: this.acpSessionId });
  }

  private onAgentGone(reason: string): void {
    if (!this.child && !this.conn) return;
    const wasActive = this.turnActive;
    this.child = null;
    this.conn = null;
    this.ready = false;
    this.turnActive = false;
    if (wasActive) this.events.onError(reason);
    this.events.onStateChange();
  }

  kill(): void {
    const child = this.child;
    this.conn?.close();
    this.conn = null;
    this.child = null;
    this.ready = false;
    child?.kill();
  }

  private readState(): PersistedState | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.cfg.stateFile, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { acpSessionId?: unknown }).acpSessionId === "string"
      ) {
        return parsed as PersistedState;
      }
    } catch {
      // first start
    }
    return null;
  }

  private writeState(state: PersistedState): void {
    mkdirSync(dirname(this.cfg.stateFile), { recursive: true });
    writeFileSync(this.cfg.stateFile, JSON.stringify(state), { mode: 0o600 });
  }
}
