import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  type ClientApp,
  type ClientConnection,
  type InitializeRequest,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptCapabilities,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import type {
  AgentOption,
  DaemonSessionForkParams,
  DaemonSessionForkResult,
  InstructionsDelivery,
  McpServerSpec,
  ModelOption,
  OptionChoice,
  OptionValues,
  PromptAttachment,
  SessionUpdate,
  StopReason,
  TurnUsage,
} from "@sessionboxer/protocol";
import { caEnv } from "./ca-env.js";
import { acpMcpServers } from "./mcp-config.js";
import { promptBlocks } from "./prompt-blocks.js";

export interface AgentConfig {
  command: string;
  args: string[];
  cwd: string;
  /** Fixed environment for the Agent process, on top of the Daemon's own. */
  env?: Record<string, string>;
  mcpCommand: string;
  stateFile: string;
  /** The Sessionboxer Session this Sandbox belongs to; recorded with the persisted state. */
  sessionId: string;
  /**
   * A persisted state written by another Session (a fork's Snapshot image carries the origin's) is
   * ignored, so the Agent starts a session of its own instead of loading the origin's conversation.
   */
  newConversation: boolean;
  /** Standing instructions for the Agent (the Session's); empty sends none. */
  instructions: string;
  instructionsDelivery: InstructionsDelivery;
  /** Read whenever the instructions are sent: what the Workspace holds right now (its repositories). */
  workspaceBriefing?: () => string;
  /** Runs before every spawn with the user MCP servers (Devin reads them from a file, not over ACP). */
  writeMcpConfig?: (servers: McpServerSpec[]) => void;
  /** Runs before every spawn with the model allowlist (Claude reads `availableModels` from its settings file). */
  writeModelAllowlist?: (models: string[]) => void;
  /**
   * A slash command the adapter answers locally with the Provider's usage meters (codex-acp's
   * `/status`); run at the end of every turn, while the turn is still held, its text goes to
   * `onUsageReport`.
   */
  usageCommand?: string;
  /** Registers the Provider's ACP extension methods (Cursor's ask/plan calls) on the client before it connects. */
  extensions?: (app: ClientApp) => void;
  /** Mode ids that mean "auto-approve every tool call" for this adapter, when not among the usual ones. */
  fullAccessModeIds?: string[];
  log: (msg: string) => void;
}

/** How long the usage command may take before the turn is reported ended without it. */
const USAGE_COMMAND_TIMEOUT_MS = 8000;

export interface AgentEvents {
  onUpdate: (update: SessionUpdate) => void;
  onTurnEnded: (stopReason: StopReason, usage: TurnUsage | undefined) => void;
  onError: (message: string) => void;
  /** The Agent was restarted with another user MCP server set (names). */
  onMcpChanged: (servers: string[]) => void;
  /** The Agent now runs another model. */
  onModelChanged: (model: ModelOption) => void;
  /** One of the Agent's other options now has another value. */
  onOptionChanged: (option: AgentOption, choice: OptionChoice) => void;
  /** The text `usageCommand` answered with, after a turn. */
  onUsageReport?: (text: string) => void;
  onStateChange: () => void;
}

interface PersistedState {
  acpSessionId: string;
  /** The Session the state was written for (absent in states written before forks could start a new conversation). */
  sessionId?: string;
  /** ACP sessions created here that have not had a prompt yet (`first-prompt` instructions go with it). */
  freshSessionIds?: string[];
}

/** The prompt response's `usage` as the event carries it, dropping ACP's `_meta`. */
function turnUsage(usage: PromptResponse["usage"]): TurnUsage | undefined {
  if (!usage) return undefined;
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    thoughtTokens: usage.thoughtTokens ?? null,
    cachedReadTokens: usage.cachedReadTokens ?? null,
    cachedWriteTokens: usage.cachedWriteTokens ?? null,
  };
}

/** Wraps the instructions for the `first-prompt` delivery, ahead of the user's text. */
function withInstructions(instructions: string, text: string): string {
  return (
    "Standing instructions from the user for this whole session; follow them in every turn, " +
    "together with any project instructions:\n\n" +
    `${instructions.trim()}\n\n---\n\n${text}`
  );
}

const CLIENT_INFO = { name: "sessionboxer-daemon", version: "0.0.0" };

/** Mode ids that mean "auto-approve every tool call", per adapter (claude-agent-acp, devin acp, codex-acp). */
const BYPASS_MODE_IDS = ["bypassPermissions", "bypass", "agent-full-access"];

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

/** The other `select` options: everything but the model and the permission mode (which the Daemon owns). */
function otherOptions(options: SessionConfigOption[]): AgentOption[] {
  return options.flatMap((o): AgentOption[] =>
    o.type !== "select" || o.category === "model" || o.id === "model" || o.category === "mode" || o.id === "mode"
      ? []
      : [
          {
            id: o.id,
            name: o.name,
            description: o.description ?? null,
            category: o.category ?? null,
            choices: o.options.flatMap((entry): OptionChoice[] =>
              "group" in entry
                ? entry.options.map((v) => ({ value: v.value, name: v.name, description: v.description ?? null }))
                : [{ value: entry.value, name: entry.name, description: entry.description ?? null }],
            ),
          },
        ],
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
  /** A fork/switch is rewiring the ACP session; prompts are refused but it is not a turn. */
  private branching = false;
  /** Throwaway ACP sessions of `ask()`, kept forever so their late updates never reach the transcript. */
  private readonly oneShotIds = new Set<string>();
  private readonly oneShotSinks = new Map<string, (update: SessionUpdate) => void>();
  /** While an `ask()` is in session/new, updates from not-yet-known sessions are its. */
  private creatingOneShots = 0;
  /** A `contextReport()` is running on the main session: its updates are collected here, not emitted. */
  private reportSink: ((update: SessionUpdate) => void) | null = null;
  get reporting(): boolean {
    return this.reportSink !== null;
  }

  /** User MCP servers to start the Agent with; `null` until the Control Plane has sent them. */
  private mcpServers: McpServerSpec[] | null = null;
  /** Set received while a turn was active; applied when it ends. */
  private mcpPendingServers: McpServerSpec[] | null = null;
  /** Fingerprints of the MCP set (and of it plus the model allowlist) the running (or last started) Agent got; `null` before the first start. */
  private mcpStartedServers: string | null = null;
  private mcpStartedKey: string | null = null;
  private mcpApplyChain: Promise<void> = Promise.resolve();

  /** Model allowlist for the Agent's settings file (Claude); `null` leaves the file alone. */
  private modelAllowlist: string[] | null = null;
  private modelAllowlistPending: string[] | null = null;

  /** Extra environment for the Agent process (the inspector's `ANTHROPIC_BASE_URL`); part of the start key. */
  private agentEnv: Record<string, string> = {};
  private agentEnvPending: Record<string, string> | null = null;

  /** Model the Control Plane asked for; `null` means "whatever the Agent defaults to". */
  private model: string | null = null;
  /** Requested while a turn was active; applied when it ends. */
  private modelPendingValue: string | null = null;
  private modelApplyChain: Promise<void> = Promise.resolve();
  /** Id of the Agent's model config option, its choices and what it currently runs; `null` until advertised. */
  private modelConfigId: string | null = null;
  private modelOptions: ModelOption[] | null = null;
  private currentModel: string | null = null;

  /** Values the Control Plane asked for on the Agent's other options, by id. */
  private optionValuesRequested: OptionValues = {};
  /** Requested while a turn was active; applied (merged) when it ends. */
  private optionsPendingValues: OptionValues | null = null;
  /** Options the Agent currently advertises and their current values; `null` until advertised. */
  private otherOptionDefs: AgentOption[] | null = null;
  private currentOptionValues: OptionValues = {};

  acpSessionId: string | null = null;
  agentInfo: { name: string; version: string } | null = null;
  /** The Agent advertised ACP `session/fork` (unstable; claude-agent-acp does, devin acp does not). */
  canFork = false;
  /** Which non-text prompt blocks the Agent takes (both claude-agent-acp and devin acp: images + embedded context). */
  private promptCaps: PromptCapabilities = {};
  turnActive = false;
  ready = false;
  error: string | null = null;

  get mcpServerNames(): string[] | null {
    return this.mcpServers?.map((s) => s.name) ?? null;
  }

  get mcpPending(): boolean {
    return this.mcpPendingServers !== null || this.modelAllowlistPending !== null;
  }

  /** The environment the running (or last started) Agent got; `{}` before the first start. */
  get startedAgentEnv(): Record<string, string> {
    return this.startedEnv;
  }

  get agentEnvPendingChange(): boolean {
    return this.agentEnvPending !== null;
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

  get options(): AgentOption[] | null {
    return this.otherOptionDefs;
  }

  /** Requested values win over reported ones until applied; options never requested show what the Agent reports. */
  get optionValues(): OptionValues {
    return { ...this.currentOptionValues, ...this.optionValuesRequested, ...this.optionsPendingValues };
  }

  get optionsPending(): boolean {
    return this.optionsPendingValues !== null;
  }

  /**
   * Sets other config options (effort, fast mode, …) with ACP `session/set_config_option`,
   * merged into the requested values; same timing as `setModel`. Returns whether it was
   * applied right away. Strict (a user's change) fails on options or values the Agent does not
   * offer right now; lenient (values restored after a connect) keeps them for a later model.
   */
  setOptions(values: OptionValues, strict = true): boolean {
    if (this.turnActive) {
      this.optionsPendingValues = { ...this.optionsPendingValues, ...values };
      this.events.onStateChange();
      return false;
    }
    this.optionsPendingValues = null;
    const previous = this.optionValuesRequested;
    this.optionValuesRequested = { ...previous, ...values };
    this.modelApplyChain = this.modelApplyChain
      .then(() => this.applyOptions(values, strict))
      .catch((e: unknown) => {
        this.cfg.log(`option change failed: ${String(e)}`);
        for (const id of Object.keys(values)) {
          if (this.optionValuesRequested[id] !== values[id]) continue;
          if (previous[id] !== undefined) this.optionValuesRequested[id] = previous[id];
          else delete this.optionValuesRequested[id];
        }
        this.events.onError(`Could not change ${Object.keys(values).join(", ")}: ${e instanceof Error ? e.message : String(e)}`);
        this.events.onStateChange();
      });
    this.events.onStateChange();
    return true;
  }

  private async applyOptions(values: OptionValues, strict: boolean): Promise<void> {
    await this.mcpApplyChain.catch(() => undefined);
    await this.ensureStarted();
    if (this.turnActive) {
      this.optionsPendingValues = { ...this.optionsPendingValues, ...values };
      this.events.onStateChange();
      return;
    }
    if (!this.conn || !this.acpSessionId) throw new Error("agent not ready");
    await this.applyRequestedOptions(this.conn, this.acpSessionId, Object.keys(values), strict);
  }

  /**
   * Sends the requested values of `ids` (all requested options when omitted) that differ from
   * what the Agent reports. Strict: options the Agent does not advertise (or values it does not
   * offer) fail; lenient: they are skipped, for re-applying after a restart or a model change.
   * `announce` emits `onOptionChanged` for effective changes (off when restoring after a restart).
   */
  private async applyRequestedOptions(
    conn: ClientConnection,
    sessionId: string,
    ids?: string[],
    strict = false,
    announce = true,
  ): Promise<void> {
    const defs = this.otherOptionDefs;
    if (!defs) {
      if (strict) throw new Error("the Agent advertises no options");
      return;
    }
    for (const id of ids ?? Object.keys(this.optionValuesRequested)) {
      const value = this.optionValuesRequested[id];
      if (value === undefined) continue;
      const def = defs.find((o) => o.id === id);
      if (!def) {
        if (strict) throw new Error(`the Agent does not offer an option "${id}" with the current model`);
        continue;
      }
      if (!def.choices.some((c) => c.value === value)) {
        if (strict) throw new Error(`the Agent does not offer "${value}" for ${def.name}`);
        this.cfg.log(`option ${id}=${value} not offered with the current model; skipped`);
        continue;
      }
      if (this.currentOptionValues[id] === value) continue;
      const previous = this.currentOptionValues[id];
      const result = await conn.agent.request("session/set_config_option", { sessionId, configId: id, value });
      this.captureConfigOptions(result.configOptions);
      const current = this.currentOptionValues[id] ?? value;
      this.cfg.log(`option ${id} ${previous ?? "?"} -> ${current}`);
      if (announce && previous !== undefined && previous !== current) {
        const choice = def.choices.find((c) => c.value === current) ?? { value: current, name: current, description: null };
        this.events.onOptionChanged(def, choice);
      }
    }
    this.events.onStateChange();
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

  /**
   * Sends the requested model to the Agent when it differs from what it runs; a no-op without a
   * model option. `announce` emits `onModelChanged` (off when restoring after a restart).
   */
  private async applyRequestedModel(conn: ClientConnection, sessionId: string, announce = true): Promise<void> {
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
    if (announce && previous !== null && previous !== this.currentModel) {
      const option = this.modelOptions?.find((o) => o.value === this.currentModel);
      this.events.onModelChanged(option ?? { value: this.currentModel, name: this.currentModel, description: null, group: null });
    }
    this.events.onStateChange();
    // The options on offer (and their values) can change with the model; re-apply what was asked for.
    await this.applyRequestedOptions(conn, sessionId, undefined, false, announce).catch((e: unknown) =>
      this.cfg.log(`option set after model switch failed: ${String(e)}`),
    );
  }

  /**
   * Remembers the model option (choices + current value) and the other options from
   * session/new, session/load, set_config_option or an update. Returns whether a model option was seen.
   */
  private captureConfigOptions(options: SessionConfigOption[] | null | undefined): boolean {
    if (options) {
      const others = otherOptions(options);
      this.otherOptionDefs = others;
      this.currentOptionValues = Object.fromEntries(
        options.flatMap((o) => (o.type === "select" && others.some((d) => d.id === o.id) ? [[o.id, o.currentValue]] : [])),
      );
    }
    const option = modelOption(options);
    if (!option) return false;
    this.modelConfigId = option.id;
    this.modelOptions = toModelOptions(option);
    this.currentModel = option.currentValue;
    return true;
  }

  /**
   * Sets the model allowlist the Agent starts with (Claude's `availableModels`). Restarts the
   * Agent in place like `setMcpServers` when it runs with another list, unless a turn is active,
   * in which case the change waits for the turn to end. Returns whether it was applied right away.
   */
  setModelAllowlist(models: string[]): boolean {
    if (!this.cfg.writeModelAllowlist) return true;
    if (this.turnActive) {
      this.modelAllowlistPending = models;
      this.events.onStateChange();
      return false;
    }
    this.modelAllowlistPending = null;
    this.modelAllowlist = models;
    if (this.mcpServers === null) {
      // The Agent has not been started yet (the MCP set is still to come); the start picks the list up.
      this.events.onStateChange();
      return true;
    }
    this.mcpApplyChain = this.mcpApplyChain
      .then(() => this.applyMcpServers())
      .catch((e: unknown) => this.cfg.log(`agent start failed: ${String(e)}`));
    this.events.onStateChange();
    return true;
  }

  /**
   * Sets extra environment variables for the Agent process. Same timing as `setModelAllowlist`:
   * restarts the Agent in place when it runs with another environment, after the turn when one
   * is active. Returns whether it was applied right away.
   */
  setAgentEnv(env: Record<string, string>): boolean {
    if (this.turnActive) {
      this.agentEnvPending = env;
      this.events.onStateChange();
      return false;
    }
    this.agentEnvPending = null;
    this.agentEnv = env;
    if (this.mcpServers === null) {
      this.events.onStateChange();
      return true;
    }
    this.mcpApplyChain = this.mcpApplyChain
      .then(() => this.applyMcpServers())
      .catch((e: unknown) => this.cfg.log(`agent start failed: ${String(e)}`));
    this.events.onStateChange();
    return true;
  }

  private startedEnv: Record<string, string> = {};

  private startKey(): string {
    return JSON.stringify({ servers: this.mcpServers, allow: this.modelAllowlist, env: this.agentEnv });
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
    const key = this.startKey();
    const previous = this.mcpStartedKey;
    if (this.child && previous === key) return;
    if (this.turnActive) {
      // A prompt slipped in while we waited for the previous start; the turn end re-applies.
      this.mcpPendingServers = this.mcpServers;
      this.events.onStateChange();
      return;
    }
    const serversChanged = this.mcpStartedServers !== null && this.mcpStartedServers !== JSON.stringify(this.mcpServers ?? []);
    if (this.child) this.kill();
    await this.ensureStarted();
    if (serversChanged) this.events.onMcpChanged(this.mcpServerNames ?? []);
  }

  constructor(
    private readonly cfg: AgentConfig,
    private readonly events: AgentEvents,
  ) {
    const state = this.readState();
    if (state && cfg.newConversation && state.sessionId !== cfg.sessionId) {
      cfg.log(`ignoring the Agent session ${state.acpSessionId} of ${state.sessionId ?? "the origin"}: this fork starts a new conversation`);
      this.acpSessionId = null;
    } else {
      this.acpSessionId = state?.acpSessionId ?? null;
      if (state && state.sessionId !== cfg.sessionId) this.writeState(state);
    }
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
    if (this.modelAllowlist) this.cfg.writeModelAllowlist?.(this.modelAllowlist);
    this.cfg.log(
      `spawning ${[this.cfg.command, ...this.cfg.args].join(" ")} (MCP: desktop${userServers.map((s) => `, ${s.name}`).join("")})`,
    );
    const agentEnv = { ...this.agentEnv };
    if (Object.keys(agentEnv).length > 0) this.cfg.log(`agent environment overrides: ${Object.keys(agentEnv).join(", ")}`);
    const child = spawn(this.cfg.command, this.cfg.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...caEnv(), ...this.cfg.env, ...agentEnv },
      cwd: this.cfg.cwd,
    });
    this.child = child;
    this.startedEnv = agentEnv;
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
    const base = client(CLIENT_INFO);
    this.cfg.extensions?.(base);
    const app = base
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
          } else {
            this.events.onStateChange();
          }
          return;
        }
        if (this.creatingOneShots > 0 && sessionId !== this.acpSessionId) return;
        if (this.replaying) return;
        if (this.reportSink) {
          this.reportSink(update);
          return;
        }
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
      this.canFork = Boolean(init.agentCapabilities?.sessionCapabilities?.fork);
      this.promptCaps = init.agentCapabilities?.promptCapabilities ?? {};
      const mcpServers = acpMcpServers(this.cfg.mcpCommand, userServers);

      let loaded = false;
      if (this.acpSessionId && init.agentCapabilities?.loadSession) {
        this.replaying = true;
        try {
          const result = await conn.agent.request("session/load", {
            sessionId: this.acpSessionId,
            cwd: this.cfg.cwd,
            mcpServers,
            ...this.systemPromptMeta(),
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
        const newParams: NewSessionRequest = { cwd: this.cfg.cwd, mcpServers, ...this.systemPromptMeta() };
        const created = await this.newSessionWithRetry(conn, newParams);
        this.acpSessionId = created.sessionId;
        this.writeState({ acpSessionId: created.sessionId, freshSessionIds: [...this.freshSessionIds(), created.sessionId] });
        this.cfg.log(`created ACP session ${created.sessionId}`);
        this.captureConfigOptions(created.configOptions);
        await this.ensureBypassMode(conn, created.sessionId, created.modes);
      }
      if (this.acpSessionId) {
        await this.applyRequestedModel(conn, this.acpSessionId, false).catch((e: unknown) => {
          this.cfg.log(`model switch at start failed: ${String(e)}`);
          this.events.onError(`Could not switch model to ${this.model}: ${e instanceof Error ? e.message : String(e)}`);
          this.model = null;
        });
        await this.applyRequestedOptions(conn, this.acpSessionId, undefined, false, false).catch((e: unknown) =>
          this.cfg.log(`option set at start failed: ${String(e)}`),
        );
      }
      this.mcpStartedServers = JSON.stringify(userServers);
      this.mcpStartedKey = this.startKey();
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
    const ids = this.cfg.fullAccessModeIds ?? BYPASS_MODE_IDS;
    const bypass = modes?.availableModes.find((m) => ids.includes(m.id));
    if (!modes || !bypass || modes.currentModeId === bypass.id) return;
    await conn.agent.request("session/set_mode", { sessionId, modeId: bypass.id });
    this.cfg.log(`switched to mode ${bypass.id}`);
  }

  async prompt(text: string, attachments: PromptAttachment[] = []): Promise<void> {
    if (this.turnActive) throw new Error("a turn is already active");
    if (this.reportSink) throw new Error("the Agent is reporting its context usage; retry in a moment");
    if (this.branching) throw new Error("the conversation is being branched; retry in a moment");
    this.turnActive = true;
    this.events.onStateChange();
    try {
      await this.ensureStarted();
      if (!this.conn || !this.acpSessionId) throw new Error("agent not ready");
      const built = await promptBlocks(text, attachments, this.cfg.cwd, this.promptCaps, this.cfg.log);
      if (attachments.length > 0) {
        this.cfg.log(`prompt carries ${attachments.length} attachment(s): ${built.blocks.map((b) => b.type).join(", ") || "none"} sent inline`);
      }
      this.markPrompted(this.acpSessionId);
      const result = await this.conn.agent.request("session/prompt", {
        sessionId: this.acpSessionId,
        prompt: [{ type: "text", text: this.firstPromptText(built.text) }, ...built.blocks],
      });
      await this.reportUsage();
      this.events.onTurnEnded(result.stopReason, turnUsage(result.usage));
    } catch (e) {
      this.cfg.log(`session/prompt on ${this.acpSessionId} failed: ${String(e)}`);
      this.events.onError(e instanceof Error ? e.message : String(e));
    } finally {
      this.turnActive = false;
      this.events.onStateChange();
      if (this.modelAllowlistPending) this.setModelAllowlist(this.modelAllowlistPending);
      if (this.agentEnvPending) this.setAgentEnv(this.agentEnvPending);
      if (this.mcpPendingServers) this.setMcpServers(this.mcpPendingServers);
      if (this.modelPendingValue) this.setModel(this.modelPendingValue);
      if (this.optionsPendingValues) this.setOptions(this.optionsPendingValues);
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

  /**
   * The Agent's `/context` report for the main session, as text. Both Providers answer the
   * command locally (no model call, nothing added to the conversation); the reply is captured
   * here instead of emitted, so the transcript shows nothing. Not a turn for the Control
   * Plane, but prompts are refused meanwhile.
   */
  async contextReport(): Promise<string> {
    if (this.turnActive) throw new Error("a turn is already active");
    if (this.reportSink) throw new Error("a context report is already running");
    if (this.branching) throw new Error("the conversation is being branched; retry in a moment");
    const text = await this.localCommand("/context");
    // claude-agent-acp delivers the report twice (as command output and as the result).
    const half = text.slice(0, Math.floor(text.length / 2)).trim();
    return half.length > 0 && text.slice(half.length).trim() === half ? half : text;
  }

  /** A slash command the adapter answers by itself, its reply captured instead of emitted. */
  private async localCommand(command: string): Promise<string> {
    await this.ensureStarted();
    if (!this.conn || !this.acpSessionId) throw new Error("agent not ready");
    const chunks: string[] = [];
    this.reportSink = (update) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") chunks.push(update.content.text);
    };
    try {
      const result = await this.conn.agent.request("session/prompt", {
        sessionId: this.acpSessionId,
        prompt: [{ type: "text", text: command }],
      });
      if (result.stopReason !== "end_turn") throw new Error(`agent stopped early (${result.stopReason})`);
      return chunks.join("").trim();
    } finally {
      this.reportSink = null;
    }
  }

  /** Runs `usageCommand` at the end of a turn (the turn is still held, so nothing else prompts meanwhile). */
  private async reportUsage(): Promise<void> {
    const command = this.cfg.usageCommand;
    if (!command || !this.events.onUsageReport || !this.conn || !this.acpSessionId) return;
    const conn = this.conn;
    const sessionId = this.acpSessionId;
    let timer: NodeJS.Timeout | null = null;
    try {
      const text = await Promise.race([
        this.localCommand(command),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Frees the session for the next prompt: the cancelled command resolves and releases the sink.
            void conn.agent.notify("session/cancel", { sessionId }).catch(() => undefined);
            reject(new Error("timed out"));
          }, USAGE_COMMAND_TIMEOUT_MS);
        }),
      ]);
      this.events.onUsageReport(text);
    } catch (e) {
      this.cfg.log(`${command} after the turn failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async cancel(): Promise<void> {
    if (!this.conn || !this.acpSessionId || !this.turnActive) return;
    await this.conn.agent.notify("session/cancel", { sessionId: this.acpSessionId });
  }

  /**
   * Continues the conversation from an earlier point on a new ACP session, which becomes
   * the Agent's session. `session/fork` when the Agent offers it (claude-agent-acp forks
   * up to `messageId` via its JetBrains `_meta`, whole history when `null`), otherwise a
   * fresh session primed with `replay`. Prompts are refused meanwhile.
   */
  async forkSession(params: DaemonSessionForkParams): Promise<DaemonSessionForkResult> {
    if (this.turnActive) throw new Error("a turn is already active");
    if (this.branching) throw new Error("another branch operation is in progress");
    this.branching = true;
    try {
      await this.mcpApplyChain.catch(() => undefined);
      await this.modelApplyChain.catch(() => undefined);
      await this.ensureStarted();
      const conn = this.conn;
      const from = this.acpSessionId;
      if (!conn || !from) throw new Error("agent not ready");
      const mcpServers = acpMcpServers(this.cfg.mcpCommand, this.mcpServers ?? []);
      this.replaying = true;
      try {
        if (this.canFork) {
          try {
            const forked = await conn.agent.request("session/fork", {
              sessionId: from,
              cwd: this.cfg.cwd,
              mcpServers,
              ...(params.messageId ? { _meta: { jetbrains: { air: { fork: { version: 1, messageId: params.messageId } } } } } : {}),
            });
            // claude-agent-acp registers the fork only on `session/load`; prompting before that is "Session not found".
            const loaded = await conn.agent.request("session/load", {
              sessionId: forked.sessionId,
              cwd: this.cfg.cwd,
              mcpServers,
              ...this.systemPromptMeta(),
            });
            await this.adoptSession(conn, forked.sessionId, loaded?.modes ?? forked.modes, loaded?.configOptions ?? forked.configOptions);
            this.cfg.log(`forked ACP session ${from} -> ${forked.sessionId}${params.messageId ? ` at ${params.messageId}` : ""}`);
            return { acpSessionId: forked.sessionId, method: "fork" };
          } catch (e) {
            if (!params.replay) throw e;
            this.cfg.log(`session/fork failed, replaying the transcript instead: ${String(e)}`);
          }
        }
        if (!params.replay) throw new Error("this Agent cannot fork its session");
        const created = await this.newSessionWithRetry(conn, { cwd: this.cfg.cwd, mcpServers, ...this.systemPromptMeta() });
        await this.adoptSession(conn, created.sessionId, created.modes, created.configOptions);
        const replay = this.cfg.instructionsDelivery === "first-prompt" && this.instructions() !== ""
          ? withInstructions(this.instructions(), params.replay)
          : params.replay;
        const result = await conn.agent.request("session/prompt", {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text: replay }],
        });
        this.cfg.log(`replayed transcript into ACP session ${created.sessionId} (${result.stopReason})`);
        return { acpSessionId: created.sessionId, method: "replay" };
      } finally {
        this.replaying = false;
      }
    } finally {
      this.branching = false;
      this.events.onStateChange();
    }
  }

  /**
   * Makes `acpSessionId` the Agent's session: restarts the Agent so it `session/load`s it.
   * Resolves with the session actually running (a new one if the load failed).
   */
  async switchSession(acpSessionId: string): Promise<string> {
    if (this.turnActive) throw new Error("a turn is already active");
    if (this.branching) throw new Error("another branch operation is in progress");
    if (acpSessionId === this.acpSessionId && this.ready) return acpSessionId;
    this.branching = true;
    try {
      await this.mcpApplyChain.catch(() => undefined);
      if (this.starting) await this.starting.catch(() => undefined);
      if (this.turnActive) throw new Error("a turn is already active");
      this.acpSessionId = acpSessionId;
      this.writeState({ acpSessionId, freshSessionIds: this.freshSessionIds() });
      this.kill();
      await this.ensureStarted();
      if (!this.acpSessionId) throw new Error("agent not ready");
      return this.acpSessionId;
    } finally {
      this.branching = false;
    }
  }

  private async adoptSession(
    conn: ClientConnection,
    sessionId: string,
    modes: SessionModeState | null | undefined,
    configOptions: SessionConfigOption[] | null | undefined,
  ): Promise<void> {
    this.acpSessionId = sessionId;
    this.writeState({ acpSessionId: sessionId, freshSessionIds: this.freshSessionIds() });
    this.currentModel = null;
    this.captureConfigOptions(configOptions);
    await this.ensureBypassMode(conn, sessionId, modes);
    await this.applyRequestedModel(conn, sessionId, false).catch((e: unknown) => this.cfg.log(`model switch after fork failed: ${String(e)}`));
    await this.applyRequestedOptions(conn, sessionId, undefined, false, false).catch((e: unknown) =>
      this.cfg.log(`option set after fork failed: ${String(e)}`),
    );
    this.events.onStateChange();
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

  /** `_meta` carrying the instructions for adapters that take them as a system prompt addition. */
  private systemPromptMeta(): Pick<NewSessionRequest, "_meta"> {
    if (this.cfg.instructionsDelivery !== "system-prompt" || this.instructions() === "") return {};
    return { _meta: { systemPrompt: { append: this.instructions() } } };
  }

  /** The Session's instructions followed by the Workspace briefing, trimmed; empty when there is neither. */
  private instructions(): string {
    const briefing = this.cfg.workspaceBriefing?.().trim() ?? "";
    return [this.cfg.instructions.trim(), briefing].filter((s) => s !== "").join("\n\n");
  }

  private freshSessionIds(): string[] {
    return this.readState()?.freshSessionIds ?? [];
  }

  /** Prefixes the instructions when this is the first prompt of a session created here (`first-prompt` delivery). */
  private firstPromptText(text: string): string {
    if (this.cfg.instructionsDelivery !== "first-prompt" || this.instructions() === "") return text;
    if (!this.acpSessionId || !this.freshSessionIds().includes(this.acpSessionId)) return text;
    this.cfg.log(`first prompt of ${this.acpSessionId}: instructions prepended`);
    return withInstructions(this.instructions(), text);
  }

  private markPrompted(sessionId: string): void {
    const state = this.readState();
    if (!state?.freshSessionIds?.includes(sessionId)) return;
    this.writeState({ ...state, freshSessionIds: state.freshSessionIds.filter((id) => id !== sessionId) });
  }

  private readState(): PersistedState | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.cfg.stateFile, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { acpSessionId?: unknown }).acpSessionId === "string"
      ) {
        const state = parsed as PersistedState;
        if (!Array.isArray(state.freshSessionIds)) delete state.freshSessionIds;
        if (typeof state.sessionId !== "string") delete state.sessionId;
        return state;
      }
    } catch {
      // first start
    }
    return null;
  }

  private writeState(state: PersistedState): void {
    mkdirSync(dirname(this.cfg.stateFile), { recursive: true });
    writeFileSync(this.cfg.stateFile, JSON.stringify({ ...state, sessionId: this.cfg.sessionId }), { mode: 0o600 });
  }
}
