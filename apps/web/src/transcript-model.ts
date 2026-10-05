import {
  repoOriginLabel,
  type AgentApproval,
  type AgentPromptOrigin,
  type ContentBlock,
  type E2eRunSummary,
  type ForkConversation,
  type LlmCall,
  type McpAppCall,
  type PromptAttachment,
  type Provider,
  type SessionEvent,
  type SessionStatus,
  type Snapshot,
  type StopReason,
  type ToolCallContent,
  type ToolCallLocation,
} from "@sessionboxer/protocol";
import type { AgentActionItem } from "./AgentActions";
import { TurnAccumulator, foldCompaction, isCompactionUpdate, type Compaction, type TurnStats } from "./context-model";

export type TranscriptItem =
  | {
      kind: "user";
      key: string;
      ts: string;
      text: string;
      attachments?: PromptAttachment[];
      /** The fork's first message: the handoff the origin's Agent wrote, not the user's words. */
      handoff?: boolean;
      /** Another Session's Agent sent it (`session_message`, ADR-0062), not the user. */
      fromAgent?: AgentPromptOrigin;
    }
  /** `handoff`: written in reply to the hidden handoff request (rendered without its tags). */
  | { kind: "agent"; key: string; ts: string; text: string; llmCall?: LlmCall; handoff?: boolean }
  | { kind: "thought"; key: string; ts: string; text: string; llmCall?: LlmCall }
  | {
      kind: "tool";
      key: string;
      ts: string;
      /** The model API call this came out of (Claude with inspection on; see `labelLlmCalls`). */
      llmCall?: LlmCall;
      toolCallId: string;
      title: string;
      toolKind: string;
      status: string;
      content: ToolCallContent[];
      locations: ToolCallLocation[];
      rawInput?: unknown;
      rawOutput?: unknown;
      /** The call went to an MCP tool with a view (ADR-0079): rendered as an app card. */
      mcpApp?: McpAppCall;
    }
  | { kind: "plan"; key: string; ts: string; entries: { content: string; status: string }[] }
  | {
      kind: "turn_ended";
      key: string;
      stopReason: StopReason;
      seq: number;
      branchId: string;
      ts: string;
      /** Nothing conversational follows: the Session is waiting here for the next prompt. */
      tail: boolean;
      stats: TurnStats;
    }
  | { kind: "compaction"; key: string; compaction: Compaction; index: number }
  | { kind: "context_report"; key: string; totalTokens: number | null; maxTokens: number | null; percent: number | null }
  | { kind: "error"; key: string; ts: string; message: string }
  | { kind: "status"; key: string; ts: string; status: SessionStatus; error?: string }
  | { kind: "snapshot"; key: string; snapshot: Snapshot }
  | {
      kind: "forked";
      key: string;
      fromSessionId: string;
      fromTitle: string;
      snapshotOrdinal: number;
      conversation: ForkConversation;
      /** The origin's Agent, when this Session runs another one. */
      fromProvider?: Provider;
    }
  | { kind: "mcp_changed"; key: string; servers: string[] }
  | { kind: "utilities_changed"; key: string; utilities: string[] }
  | { kind: "model_changed"; key: string; model: string; name: string }
  | { kind: "option_changed"; key: string; option: string; value: string; valueName: string }
  | { kind: "repo_changed"; key: string; action: "added" | "removed"; name: string; origin: string }
  | { kind: "usb_changed"; key: string; action: "connected" | "disconnected"; name: string; node: string | null }
  /** The fork's Agent was staged into its Sandbox (the Snapshot's image lacked it). */
  | { kind: "payload_injected"; key: string; provider: Provider; version: string; bytes: number; from: string }
  /** The Control Plane's hidden verification prompt: a marker, not the user's words. */
  | { kind: "e2e_prompt"; key: string }
  /** The Control Plane's hidden request for a handoff (a fork is waiting for the Agent's reply). */
  | { kind: "handoff_request"; key: string }
  | { kind: "e2e_run"; key: string; run: E2eRunSummary }
  /** The Agent asked the user's permission (a card with Allow / Deny while pending); the latest state of each id. */
  | { kind: "agent_approval"; key: string; ts: string; approval: AgentApproval }
  /** Something the Agent did through the `sessionboxer` MCP (attached a PR, took a Snapshot, …). */
  | AgentActionItem;

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    case "resource_link":
      return block.uri;
    case "resource":
      return "text" in block.resource ? block.resource.text : `[resource ${block.resource.uri}]`;
  }
}

/** Updates that say or do something, as opposed to usage/title/command bookkeeping. */
const CONVERSATIONAL_UPDATES = new Set<string>([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

/** Conversation went on after the last turn boundary, so it is no longer the waiting point. */
function markContinued(items: TranscriptItem[]): void {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) break;
    if (item.kind === "turn_ended") {
      item.tail = false;
      return;
    }
    if (item.kind === "user" || item.kind === "agent" || item.kind === "thought" || item.kind === "tool" || item.kind === "plan") return;
  }
}

/**
 * Folds the persisted event stream into renderable items (chunks merged, tool calls
 * updated in place). Snapshots are slotted in right after the event they were taken at.
 */
export function buildTranscript(events: SessionEvent[], snapshots: Snapshot[] = []): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  const compactions = new Map<string, Compaction>();
  let used: number | null = null;
  let turn = new TurnAccumulator(null, null);
  const pending = [...snapshots].sort((a, b) => a.eventSeq - b.eventSeq || a.ordinal - b.ordinal);
  const flushSnapshots = (uptoSeq: number) => {
    for (let next = pending[0]; next && next.eventSeq <= uptoSeq; next = pending[0]) {
      pending.shift();
      items.push({ kind: "snapshot", key: `s${next.id}`, snapshot: next });
    }
  };

  let handoffTurn = false;
  const appendText = (kind: "agent" | "thought", key: string, ts: string, text: string) => {
    const last = items[items.length - 1];
    if (last && last.kind === kind && !last.llmCall) {
      last.text += text;
    } else {
      items.push(kind === "agent" && handoffTurn ? { kind, key, ts, text, handoff: true } : { kind, key, ts, text });
    }
  };

  /** `mcp_app_call` events that came before their `tool_call`. */
  const appCalls = new Map<string, McpAppCall>();
  for (const ev of events) {
    const key = String(ev.seq);
    const ts = ev.ts;
    const body = ev.body;
    switch (body.type) {
      case "mcp_app_call": {
        const tool = tools.get(body.call.toolCallId);
        if (tool) tool.mcpApp = body.call;
        else appCalls.set(body.call.toolCallId, body.call);
        break;
      }
      case "user_prompt":
        markContinued(items);
        handoffTurn = body.origin === "handoff_request";
        if (body.origin === "e2e") items.push({ kind: "e2e_prompt", key });
        else if (handoffTurn) items.push({ kind: "handoff_request", key });
        else {
          items.push({
            kind: "user",
            key,
            ts,
            text: body.text,
            ...(body.attachments?.length ? { attachments: body.attachments } : {}),
            ...(body.origin === "handoff" ? { handoff: true } : {}),
            ...(typeof body.origin === "object" ? { fromAgent: body.origin } : {}),
          });
        }
        {
          // Usage that landed between turns (a compaction's refresh) is the new baseline.
          const base = turn.finish(undefined);
          turn = new TurnAccumulator(base.used, base.cost);
        }
        break;
      case "turn_ended": {
        const done = turn.finish(body.usage);
        turn = new TurnAccumulator(done.used, done.cost);
        items.push({ kind: "turn_ended", key, stopReason: body.stopReason, seq: ev.seq, branchId: ev.branchId, ts: ev.ts, tail: true, stats: done.stats });
        break;
      }
      case "context_breakdown":
        items.push({
          kind: "context_report",
          key,
          totalTokens: body.breakdown.totalTokens,
          maxTokens: body.breakdown.maxTokens,
          percent: body.breakdown.percent,
        });
        break;
      case "agent_error":
        items.push({ kind: "error", key, ts, message: body.message });
        break;
      case "status":
        items.push(body.error ? { kind: "status", key, ts, status: body.status, error: body.error } : { kind: "status", key, ts, status: body.status });
        break;
      case "forked":
        items.push({
          kind: "forked",
          key,
          fromSessionId: body.fromSessionId,
          fromTitle: body.fromTitle,
          snapshotOrdinal: body.snapshotOrdinal,
          conversation: body.conversation ?? "continue",
          ...(body.fromProvider ? { fromProvider: body.fromProvider } : {}),
        });
        break;
      case "mcp_changed":
        items.push({ kind: "mcp_changed", key, servers: body.servers });
        break;
      case "utilities_changed":
        items.push({ kind: "utilities_changed", key, utilities: body.utilities });
        break;
      case "model_changed":
        items.push({ kind: "model_changed", key, model: body.model, name: body.name });
        break;
      case "option_changed":
        items.push({ kind: "option_changed", key, option: body.name, value: body.value, valueName: body.valueName });
        break;
      case "repo_changed":
        items.push({ kind: "repo_changed", key, action: body.action, name: body.name, origin: repoOriginLabel(body.source) });
        break;
      case "usb_changed":
        items.push({ kind: "usb_changed", key, action: body.action, name: body.name, node: body.node });
        break;
      case "payload_injected":
        items.push({ kind: "payload_injected", key, provider: body.provider, version: body.version, bytes: body.bytes, from: body.from });
        break;
      case "e2e_run":
        items.push({ kind: "e2e_run", key, run: body.run });
        break;
      case "agent_action":
        items.push({ kind: "agent_action", key, ts: ev.ts, tool: body.tool, text: body.text, pane: body.pane ?? null, sessionId: body.sessionId ?? null });
        break;
      case "agent_approval": {
        // The card stays where it was asked; a later event of the same id settles it in place.
        const card = items.find((it) => it.kind === "agent_approval" && it.approval.id === body.approval.id);
        if (card && card.kind === "agent_approval") card.approval = body.approval;
        else items.push({ kind: "agent_approval", key, ts: ev.ts, approval: body.approval });
        break;
      }
      case "llm_call":
        if (body.call.kind === "turn") labelLlmCall(items, body.call);
        break;
      case "update": {
        const u = body.update;
        if (isCompactionUpdate(u)) {
          const before = compactions.size;
          const done = [...compactions.values()].filter((c) => c.status === "completed").length;
          const c = foldCompaction(compactions, u, key, used);
          if (c && compactions.size > before) items.push({ kind: "compaction", key, compaction: c, index: done });
          break;
        }
        if (CONVERSATIONAL_UPDATES.has(u.sessionUpdate)) markContinued(items);
        switch (u.sessionUpdate) {
          case "usage_update":
            used = u.used;
            turn.onUsage(u);
            break;
          case "agent_message_chunk":
            appendText("agent", key, ts, blockText(u.content));
            break;
          case "agent_thought_chunk":
            appendText("thought", key, ts, blockText(u.content));
            break;
          case "user_message_chunk":
            // Replayed history from session/load; live prompts arrive as user_prompt.
            {
              const last = items[items.length - 1];
              if (last && last.kind === "user" && last.key.startsWith("h")) last.text += blockText(u.content);
              else items.push({ kind: "user", key: `h${key}`, ts, text: blockText(u.content) });
            }
            break;
          case "tool_call": {
            const item: Extract<TranscriptItem, { kind: "tool" }> = {
              kind: "tool",
              key,
              ts,
              toolCallId: u.toolCallId,
              title: u.title,
              toolKind: u.kind ?? "other",
              status: u.status ?? "pending",
              content: u.content ?? [],
              locations: u.locations ?? [],
              rawInput: u.rawInput,
              rawOutput: u.rawOutput,
            };
            const app = appCalls.get(u.toolCallId);
            if (app) item.mcpApp = app;
            tools.set(u.toolCallId, item);
            items.push(item);
            break;
          }
          case "tool_call_update": {
            let item = tools.get(u.toolCallId);
            if (!item) {
              item = {
                kind: "tool",
                key,
                ts,
                toolCallId: u.toolCallId,
                title: u.title ?? u.toolCallId,
                toolKind: u.kind ?? "other",
                status: u.status ?? "pending",
                content: [],
                locations: [],
              };
              tools.set(u.toolCallId, item);
              items.push(item);
            }
            if (u.title) item.title = u.title;
            if (u.kind) item.toolKind = u.kind;
            if (u.status) item.status = u.status;
            if (u.content) item.content = u.content;
            if (u.locations) item.locations = u.locations;
            if (u.rawInput !== undefined) item.rawInput = u.rawInput;
            if (u.rawOutput !== undefined) item.rawOutput = u.rawOutput;
            break;
          }
          case "plan":
            items.push({
              kind: "plan",
              key,
              ts,
              entries: u.entries.map((e) => ({ content: e.content, status: e.status })),
            });
            break;
          default:
            // available_commands_update, current_mode_update, ...: not rendered.
            break;
        }
      }
    }
    flushSnapshots(ev.seq);
  }
  flushSnapshots(Number.POSITIVE_INFINITY);
  return items;
}

/**
 * A conversation call's summary arrives once its response has been read, i.e. after the
 * agent text and tool calls it streamed and before the next call's: label everything
 * conversational since the previous label (or the prompt) with it.
 */
function labelLlmCall(items: TranscriptItem[], call: LlmCall): void {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) break;
    if (item.kind === "agent" || item.kind === "thought" || item.kind === "tool") {
      if (item.llmCall) break;
      item.llmCall = call;
      continue;
    }
    if (item.kind === "user" || item.kind === "turn_ended") break;
  }
}

/** Every model API call recorded for the Session, in order. */
export function llmCallsOf(events: SessionEvent[]): LlmCall[] {
  const calls: LlmCall[] = [];
  for (const ev of events) if (ev.body.type === "llm_call") calls.push(ev.body.call);
  return calls;
}
