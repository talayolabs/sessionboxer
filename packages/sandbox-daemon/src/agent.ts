import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  type ClientConnection,
  type InitializeRequest,
  type NewSessionRequest,
  type NewSessionResponse,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import type { McpServerSpec, ModelOption, SessionUpdate, StopReason } from "@sessionboxer/protocol";
import { acpMcpServers } from "./mcp-config.js";

export interface AgentConfig {
  command: string;
  args: string[];
  cwd: string;
  mcpCommand: string;
  stateFile: string;
  /** Runs before every spawn with the user MCP servers (Devin reads them from a file, not over ACP). */
  writeMcpConfig?: (servers: McpServerSpec[]) => void;
  log: (msg: string) => void;
}

export interface AgentEvents {
  onUpdate: (update: SessionUpdate) => void;
  onTurnEnded: (stopReason: StopReason) => void;
  onError: (message: string) => void;
  /** The Agent was restarted with another user MCP server set (names). */
  onMcpChanged: (servers: string[]) => void;
  /** The Agent now runs another model. */
  onModelChanged: (model: ModelOption) => void;
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

/** The ACP config option that selects the model (claude-agent-acp and devin acp both use id `model`, category `model`). */
function modelOption(options: SessionConfigOption[] | null | undefined): (SessionConfigOption & { type: "select" }) | null {
  if (!options) return null;
  const found = options.find((o) => o.type === "select" && (o.category === "model" || o.id === "model"));
  return found?.type === "select" ? found : null;
}

function toModelOptions(option: SessionConfigOption & { type: "select" }): ModelOption[] {
  return option.options.flatMap((entry): ModelOption[] =>
    "group" in entry
      ? entry.options.map((v) => ({ value: v.value, name: v.name, description: v.description ?? null, group: entry.name }))
      : [{ value: entry.value, name: entry.name, description: entry.description ?? null, group: null }],
  );
}

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
  /** Throwaway ACP sessions of `ask()`, kept forever so their late updates never reach the transcript. */
  private readonly oneShotIds = new Set<string>();
  private readonly oneShotSinks = new Map<string, (update: SessionUpdate) => void>();
  /** While an `ask()` is in session/new, updates from not-yet-known sessions are its. */
  private creatingOneShots = 0;

  /** User MCP servers to start the Agent with; `null` until the Control Plane has sent them. */
  private mcpServers: McpServerSpec[] | null = null;
  /** Set received while a turn was active; applied when it ends. */
  private mcpPendingServers: McpServerSpec[] | null = null;
  /** Fingerprint of the set the running (or last started) Agent got; `null` before the first start. */
  private mcpStartedKey: string | null = null;
  private mcpApplyChain: Promise<void> = Promise.resolve();

  /** Model the Control Plane asked for; `null` means "whatever the Agent defaults to". */
  private model: string | null = null;
  /** Requested while a turn was active; applied when it ends. */
  private modelPendingValue: string | null = null;
  private modelApplyChain: Promise<void> = Promise.resolve();
  /** Id of the Agent's model config option, its choices and what it currently runs; `null` until advertised. */
  private modelConfigId: string | null = null;
  private modelOptions: ModelOption[] | null = null;
  private currentModel: string | null = null;

  acpSessionId: string | null = null;
  agentInfo: { name: string; version: string } | null = null;
  turnActive = false;
  ready = false;
  error: string | null = null;

  get mcpServerNames(): string[] | null {
    return this.mcpServers?.map((s) => s.name) ?? null;
  }

  get mcpPending(): boolean {
    return this.mcpPendingServers !== null;
  }

  get models(): ModelOption[] | null {
    return this.modelOptions;
  }

  /** What the Control Plane should show: the requested model wins over the reported one until applied. */
  get modelValue(): string | null {
    return this.modelPendingValue ?? this.model ?? this.currentModel;
  }

  get modelPending(): boolean {
    return this.modelPendingValue !== null;
  }

  /**
   * Switches the Agent's model with ACP `session/set_config_option`, right away when idle
   * (no restart: the Agent keeps its session) or once the active turn ends. Returns
   * whether it was applied right away.
   */
  setModel(model: string): boolean {
    if (this.turnActive) {
      this.modelPendingValue = model;
      this.events.onStateChange();
      return false;
    }
    this.modelPendingValue = null;
    const previous = this.model;
    this.model = model;
    this.modelApplyChain = this.modelApplyChain
      .then(() => this.applyModel())
      .catch((e: unknown) => {
        this.cfg.log(`model switch failed: ${String(e)}`);
        if (this.model === model) this.model = previous ?? this.currentModel;
        this.events.onError(`Could not switch model to ${model}: ${e instanceof Error ? e.message : String(e)}`);
        this.events.onStateChange();
      });
    this.events.onStateChange();
    return true;
  }

  private async applyModel(): Promise<void> {
    await this.mcpApplyChain.catch(() => undefined);
    await this.ensureStarted();
    if (this.turnActive) {
      this.modelPendingValue = this.model;
      this.events.onStateChange();
      return;
    }
    if (!this.conn || !this.acpSessionId) throw new Error("agent not ready");
    await this.applyRequestedModel(this.conn, this.acpSessionId);
  }

  /** Sends the requested model to the Agent when it differs from what it runs; a no-op without a model option. */
  private async applyRequestedModel(conn: ClientConnection, sessionId: string): Promise<void> {
    const model = this.model;
    if (!model || !this.modelConfigId || model === this.currentModel) return;
    if (this.modelOptions && !this.modelOptions.some((o) => o.value === model)) {
      throw new Error(`the Agent does not offer model "${model}"`);
    }
    const previous = this.currentModel;
    const result = await conn.agent.request("session/set_config_option", { sessionId, configId: this.modelConfigId, value: model });
    this.captureConfigOptions(result.configOptions);
    if (this.currentModel === null) this.currentModel = model;
    this.cfg.log(`model ${previous ?? "?"} -> ${this.currentModel}`);
    if (previous !== null && previous !== this.currentModel) {
      const option = this.modelOptions?.find((o) => o.value === this.currentModel);
      this.events.onModelChanged(option ?? { value: this.currentModel, name: this.currentModel, description: null, group: null });
    }
    this.events.onStateChange();
  }

  /** Remembers the model option (choices + current value) from session/new, session/load, set_config_option or an update. */
  private captureConfigOptions(options: SessionConfigOption[] | null | undefined): boolean {
    const option = modelOption(options);
    if (!option) return false;
    this.modelConfigId = option.id;
    this.modelOptions = toModelOptions(option);
    this.currentModel = option.currentValue;
    return true;
  }

  /**
   * Replaces the user MCP server set. Restarts the Agent in place (the ACP session is
   * loaded back, so the conversation is kept) unless a turn is active, in which case
   * the change waits for the turn to end. Returns whether it was applied right away.
   */
  setMcpServers(servers: McpServerSpec[]): boolean {
    if (this.turnActive) {
      this.mcpPendingServers = servers;
      this.events.onStateChange();
      return false;
    }
    this.mcpPendingServers = null;
    this.mcpServers = [...servers].sort((a, b) => a.name.localeCompare(b.name));
    this.mcpApplyChain = this.mcpApplyChain
      .then(() => this.applyMcpServers())
      .catch((e: unknown) => this.cfg.log(`agent start failed: ${String(e)}`));
    this.events.onStateChange();
    return true;
  }

  private async applyMcpServers(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    const key = JSON.stringify(this.mcpServers);
    const previous = this.mcpStartedKey;
    if (this.child && previous === key) return;
    if (this.turnActive) {
      // A prompt slipped in while we waited for the previous start; the turn end re-applies.
      this.mcpPendingServers = this.mcpServers;
      this.events.onStateChange();
      return;
    }
    if (this.child) this.kill();
    await this.ensureStarted();
    if (previous !== null && previous !== key) this.events.onMcpChanged(this.mcpServerNames ?? []);
  }

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
    this.currentModel = null;
    const userServers = this.mcpServers ?? [];
    this.cfg.writeMcpConfig?.(userServers);
    this.cfg.log(
      `spawning ${[this.cfg.command, ...this.cfg.args].join(" ")} (MCP: desktop${userServers.map((s) => `, ${s.name}`).join("")})`,
    );
    const child = spawn(this.cfg.command, this.cfg.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd: this.cfg.cwd,
    });
    this.child = child;
    child.stderr?.on("data", (d: Buffer) => this.cfg.log(`[agent] ${d.toString().trimEnd()}`));
    child.on("exit", (code, signal) => {
      this.cfg.log(`agent exited code=${code} signal=${signal}`);
      if (this.child === child) this.onAgentGone(`agent process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
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
        const { sessionId, update } = ctx.params;
        if (this.oneShotIds.has(sessionId)) {
          this.oneShotSinks.get(sessionId)?.(update);
          return;
        }
        if (update.sessionUpdate === "config_option_update" && (sessionId === this.acpSessionId || this.acpSessionId === null)) {
          // Devin advertises its models this way, after session/new has already returned.
          if (this.captureConfigOptions(update.configOptions)) {
            this.events.onStateChange();
            if (this.ready && !this.turnActive && this.model && this.model !== this.currentModel) {
              this.modelApplyChain = this.modelApplyChain
                .then(() => this.applyModel())
                .catch((e: unknown) => this.cfg.log(`model switch failed: ${String(e)}`));
            }
          }
          return;
        }
        if (this.creatingOneShots > 0 && sessionId !== this.acpSessionId) return;
        if (this.replaying) return;
        this.events.onUpdate(ctx.params.update);
      });
    const conn = app.connect(stream);
    this.conn = conn;
    conn.closed.then(() => {
      if (this.conn === conn) this.onAgentGone("ACP connection closed");
    });

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
      const mcpServers = acpMcpServers(this.cfg.mcpCommand, userServers);

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
          this.captureConfigOptions(result?.configOptions);
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
        this.captureConfigOptions(created.configOptions);
        await this.ensureBypassMode(conn, created.sessionId, created.modes);
      }
      if (this.acpSessionId) {
        await this.applyRequestedModel(conn, this.acpSessionId).catch((e: unknown) => {
          this.cfg.log(`model switch at start failed: ${String(e)}`);
          this.events.onError(`Could not switch model to ${this.model}: ${e instanceof Error ? e.message : String(e)}`);
          this.model = null;
        });
      }
      this.mcpStartedKey = JSON.stringify(userServers);
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
      if (this.mcpPendingServers) this.setMcpServers(this.mcpPendingServers);
      if (this.modelPendingValue) this.setModel(this.modelPendingValue);
    }
  }

  /**
   * One question, one answer, no memory: a fresh ACP session without the desktop
   * MCP, prompted once; resolves with the concatenated agent text. Independent of
   * the main session, so it also works while a turn is active.
   */
  async ask(text: string): Promise<string> {
    await this.ensureStarted();
    const conn = this.conn;
    if (!conn) throw new Error("agent not ready");
    this.creatingOneShots++;
    let sessionId: string;
    let modes: NewSessionResponse["modes"];
    try {
      const created = await this.newSessionWithRetry(conn, { cwd: this.cfg.cwd, mcpServers: [] });
      sessionId = created.sessionId;
      modes = created.modes;
      this.oneShotIds.add(sessionId);
    } finally {
      this.creatingOneShots--;
    }
    await this.ensureBypassMode(conn, sessionId, modes);
    const chunks: string[] = [];
    this.oneShotSinks.set(sessionId, (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") chunks.push(update.content.text);
    });
    try {
      const result = await conn.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      if (result.stopReason !== "end_turn") throw new Error(`agent stopped early (${result.stopReason})`);
      return chunks.join("");
    } finally {
      this.oneShotSinks.delete(sessionId);
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
