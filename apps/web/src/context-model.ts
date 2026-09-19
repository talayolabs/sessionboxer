import type { ContextBreakdown, SessionEvent, SessionUpdate, TurnUsage } from "@sessionboxer/protocol";

/** What the Agent said about one context compaction (ADR-0030). */
export interface Compaction {
  id: string;
  status: string;
  trigger: "automatic" | "manual" | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
}

/** One point of the occupancy history: the window after a model reply. */
export interface UsagePoint {
  seq: number;
  ts: string;
  used: number;
  size: number;
}

/** The context as the event stream describes it now. */
export interface ContextState {
  /** Tokens in the window after the last model reply; `null` before the first. */
  used: number | null;
  size: number | null;
  /** Cumulative Session cost as the Agent reports it (Claude does; Devin does not). */
  cost: { amount: number; currency: string } | null;
  compactions: Compaction[];
  /** Latest `/context` report, if one was taken. */
  breakdown: ContextBreakdown | null;
  breakdownTs: string | null;
  history: UsagePoint[];
  /** Turns completed (prompts answered) so far. */
  turns: number;
}

/** What one turn cost, shown on its divider. */
export interface TurnStats {
  /** From the prompt response (exact) or summed from the Provider's per-reply metadata. */
  usage: TurnUsage | null;
  /** Model replies in the turn (one `usage_update` each). */
  calls: number;
  /** Window occupancy after the turn and how it moved from before the prompt. */
  contextUsed: number | null;
  contextDelta: number | null;
  costDelta: number | null;
}

interface CompactionMeta {
  trigger?: unknown;
  preTokens?: unknown;
  postTokens?: unknown;
  durationMs?: unknown;
}

/** The `contextCompaction` extension claude-agent-acp puts on its synthetic compaction tool call. */
export function compactionMeta(update: SessionUpdate): CompactionMeta | null {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;
  const meta = update._meta?.contextCompaction;
  return meta && typeof meta === "object" ? (meta as CompactionMeta) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function applyCompactionMeta(c: Compaction, meta: CompactionMeta): void {
  if (meta.trigger === "automatic" || meta.trigger === "manual") c.trigger = meta.trigger;
  c.preTokens = num(meta.preTokens) ?? c.preTokens;
  c.postTokens = num(meta.postTokens) ?? c.postTokens;
  c.durationMs = num(meta.durationMs) ?? c.durationMs;
}

/**
 * Folds compactions out of the update stream: ACP's experimental `compaction_update`, or
 * claude-agent-acp's tool call carrying `_meta.contextCompaction` (what it sends to Clients
 * that do not advertise the compaction capability, like the Daemon).
 */
export function foldCompaction(map: Map<string, Compaction>, update: SessionUpdate): Compaction | null {
  if (update.sessionUpdate === "compaction_update") {
    let c = map.get(update.compactionId);
    if (!c) {
      c = { id: update.compactionId, status: update.status, trigger: null, preTokens: null, postTokens: null, durationMs: null };
      map.set(c.id, c);
    }
    c.status = update.status;
    const meta = update._meta?.contextCompaction;
    if (meta && typeof meta === "object") applyCompactionMeta(c, meta as CompactionMeta);
    return c;
  }
  const meta = compactionMeta(update);
  if (!meta || (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")) return null;
  let c = map.get(update.toolCallId);
  if (!c) {
    c = { id: update.toolCallId, status: update.status ?? "in_progress", trigger: null, preTokens: null, postTokens: null, durationMs: null };
    map.set(c.id, c);
  }
  if (update.status) c.status = update.status;
  applyCompactionMeta(c, meta);
  return c;
}

/**
 * Devin puts each reply's request tokens on the usage update, and then repeats the same
 * update tagged `cognition.ai/subagent_context` (the root agent seen as its own subagent).
 */
function devinRequestTokens(update: SessionUpdate & { sessionUpdate: "usage_update" }): { input: number; output: number; cachedRead: number } | null {
  if (update._meta?.["cognition.ai/subagent_context"] !== undefined) return null;
  const input = num(update._meta?.["cognition.ai/inputTokens"]);
  const output = num(update._meta?.["cognition.ai/outputTokens"]);
  if (input === null && output === null) return null;
  return { input: input ?? 0, output: output ?? 0, cachedRead: num(update._meta?.["cognition.ai/cachedReadTokens"]) ?? 0 };
}

/**
 * claude-agent-acp sends several `usage_update`s per model reply: an early one with the
 * model's nominal window (200k), rate-limit ones, and the one with the cost and the real
 * window (1M on the long-context plan). Devin repeats each update once for the subagent
 * view. Those two carry the reply itself; the others are progress or echoes.
 */
function isReplyUsage(update: SessionUpdate & { sessionUpdate: "usage_update" }): boolean {
  return update.cost != null || devinRequestTokens(update) !== null;
}

export function deriveContext(events: SessionEvent[]): ContextState {
  const compactions = new Map<string, Compaction>();
  const state: ContextState = { used: null, size: null, cost: null, compactions: [], breakdown: null, breakdownTs: null, history: [], turns: 0 };
  let sizeFromReply = false;
  const allPoints: UsagePoint[] = [];
  const replyPoints: UsagePoint[] = [];
  for (const ev of events) {
    const body = ev.body;
    if (body.type === "turn_ended") state.turns++;
    else if (body.type === "context_breakdown") {
      state.breakdown = body.breakdown;
      state.breakdownTs = ev.ts;
    } else if (body.type === "update") {
      const u = body.update;
      if (u.sessionUpdate === "usage_update") {
        const reply = isReplyUsage(u);
        state.used = u.used;
        if (reply || !sizeFromReply) state.size = u.size;
        if (reply) sizeFromReply = true;
        if (u.cost) state.cost = { amount: u.cost.amount, currency: u.cost.currency };
        const point = { seq: ev.seq, ts: ev.ts, used: u.used, size: state.size ?? u.size };
        allPoints.push(point);
        if (reply) replyPoints.push(point);
      } else foldCompaction(compactions, u);
    }
  }
  state.compactions = [...compactions.values()];
  state.history = replyPoints.length > 0 ? replyPoints : allPoints;
  return state;
}

/** Compactions that actually happened (not failed, not still running). */
export function completedCompactions(compactions: Compaction[]): number {
  return compactions.filter((c) => c.status === "completed").length;
}

/** Accumulates one turn's stats while `buildTranscript` walks its events. */
export class TurnAccumulator {
  private calls = 0;
  private replies = 0;
  private devinIn = 0;
  private devinOut = 0;
  private devinCached = 0;
  private devinSeen = false;
  private usedAtStart: number | null;
  private costAtStart: number | null;
  private used: number | null;
  private cost: number | null;

  constructor(used: number | null, cost: number | null) {
    this.usedAtStart = used;
    this.costAtStart = cost;
    this.used = used;
    this.cost = cost;
  }

  onUsage(update: SessionUpdate & { sessionUpdate: "usage_update" }): void {
    this.calls++;
    if (isReplyUsage(update)) this.replies++;
    this.used = update.used;
    if (update.cost) this.cost = update.cost.amount;
    const devin = devinRequestTokens(update);
    if (devin) {
      this.devinSeen = true;
      this.devinIn += devin.input;
      this.devinOut += devin.output;
      this.devinCached += devin.cachedRead;
    }
  }

  /** The turn is over: its stats, and the baseline the next turn starts from. */
  finish(usage: TurnUsage | undefined): { stats: TurnStats; used: number | null; cost: number | null } {
    const fallback: TurnUsage | null = this.devinSeen
      ? { totalTokens: this.devinIn + this.devinOut, inputTokens: this.devinIn, outputTokens: this.devinOut, cachedReadTokens: this.devinCached || null }
      : null;
    // Claude reports all-zero usage for turns without a model reply (`/compact`, `/context`).
    const noReply = usage !== undefined && usage.totalTokens === 0;
    const stats: TurnStats = {
      usage: (noReply ? null : usage) ?? fallback,
      calls: this.replies > 0 || noReply ? this.replies : this.calls,
      contextUsed: this.used,
      contextDelta: this.used !== null && this.usedAtStart !== null ? this.used - this.usedAtStart : null,
      costDelta: this.cost !== null && this.costAtStart !== null ? this.cost - this.costAtStart : this.cost,
    };
    return { stats, used: this.used, cost: this.cost };
  }
}

/** `30.1k`, `1M`, `936`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
}

export function formatCost(amount: number, currency = "USD"): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${amount < 0.01 && amount > 0 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

/** Fraction of the window in use, clamped to [0, 1]. */
export function fillFraction(used: number, size: number): number {
  if (size <= 0) return 0;
  return Math.min(1, Math.max(0, used / size));
}

/**
 * Gauge colour: green at empty, through yellow, red at half (and beyond — a half-full
 * window is where the Agent starts to forget; the label says "rotting").
 */
export function gaugeHue(fraction: number): number {
  return Math.round(120 * (1 - Math.min(1, fraction / 0.5)));
}

export const ROTTING_FRACTION = 0.5;
