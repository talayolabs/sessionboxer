import type {
  ContentBlock,
  SessionEvent,
  SessionStatus,
  Snapshot,
  StopReason,
  ToolCallContent,
} from "@sessionboxer/protocol";

export type TranscriptItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "agent"; key: string; text: string }
  | { kind: "thought"; key: string; text: string }
  | {
      kind: "tool";
      key: string;
      toolCallId: string;
      title: string;
      toolKind: string;
      status: string;
      content: ToolCallContent[];
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | { kind: "plan"; key: string; entries: { content: string; status: string }[] }
  | {
      kind: "turn_ended";
      key: string;
      stopReason: StopReason;
      seq: number;
      branchId: string;
      ts: string;
      /** Nothing conversational follows: the Session is waiting here for the next prompt. */
      tail: boolean;
    }
  | { kind: "error"; key: string; message: string }
  | { kind: "status"; key: string; status: SessionStatus; error?: string }
  | { kind: "snapshot"; key: string; snapshot: Snapshot }
  | { kind: "forked"; key: string; fromSessionId: string; fromTitle: string; snapshotOrdinal: number }
  | { kind: "mcp_changed"; key: string; servers: string[] }
  | { kind: "model_changed"; key: string; model: string; name: string }
  | { kind: "option_changed"; key: string; option: string; value: string; valueName: string };

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
  const pending = [...snapshots].sort((a, b) => a.eventSeq - b.eventSeq || a.ordinal - b.ordinal);
  const flushSnapshots = (uptoSeq: number) => {
    for (let next = pending[0]; next && next.eventSeq <= uptoSeq; next = pending[0]) {
      pending.shift();
      items.push({ kind: "snapshot", key: `s${next.id}`, snapshot: next });
    }
  };

  const appendText = (kind: "agent" | "thought", key: string, text: string) => {
    const last = items[items.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
    } else {
      items.push({ kind, key, text });
    }
  };

  for (const ev of events) {
    const key = String(ev.seq);
    const body = ev.body;
    switch (body.type) {
      case "user_prompt":
        markContinued(items);
        items.push({ kind: "user", key, text: body.text });
        break;
      case "turn_ended":
        items.push({ kind: "turn_ended", key, stopReason: body.stopReason, seq: ev.seq, branchId: ev.branchId, ts: ev.ts, tail: true });
        break;
      case "agent_error":
        items.push({ kind: "error", key, message: body.message });
        break;
      case "status":
        items.push(body.error ? { kind: "status", key, status: body.status, error: body.error } : { kind: "status", key, status: body.status });
        break;
      case "forked":
        items.push({
          kind: "forked",
          key,
          fromSessionId: body.fromSessionId,
          fromTitle: body.fromTitle,
          snapshotOrdinal: body.snapshotOrdinal,
        });
        break;
      case "mcp_changed":
        items.push({ kind: "mcp_changed", key, servers: body.servers });
        break;
      case "model_changed":
        items.push({ kind: "model_changed", key, model: body.model, name: body.name });
        break;
      case "option_changed":
        items.push({ kind: "option_changed", key, option: body.name, value: body.value, valueName: body.valueName });
        break;
      case "update": {
        const u = body.update;
        if (CONVERSATIONAL_UPDATES.has(u.sessionUpdate)) markContinued(items);
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            appendText("agent", key, blockText(u.content));
            break;
          case "agent_thought_chunk":
            appendText("thought", key, blockText(u.content));
            break;
          case "user_message_chunk":
            // Replayed history from session/load; live prompts arrive as user_prompt.
            {
              const last = items[items.length - 1];
              if (last && last.kind === "user" && last.key.startsWith("h")) last.text += blockText(u.content);
              else items.push({ kind: "user", key: `h${key}`, text: blockText(u.content) });
            }
            break;
          case "tool_call": {
            const item: Extract<TranscriptItem, { kind: "tool" }> = {
              kind: "tool",
              key,
              toolCallId: u.toolCallId,
              title: u.title,
              toolKind: u.kind ?? "other",
              status: u.status ?? "pending",
              content: u.content ?? [],
              rawInput: u.rawInput,
              rawOutput: u.rawOutput,
            };
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
                toolCallId: u.toolCallId,
                title: u.title ?? u.toolCallId,
                toolKind: u.kind ?? "other",
                status: u.status ?? "pending",
                content: [],
              };
              tools.set(u.toolCallId, item);
              items.push(item);
            }
            if (u.title) item.title = u.title;
            if (u.kind) item.toolKind = u.kind;
            if (u.status) item.status = u.status;
            if (u.content) item.content = u.content;
            if (u.rawInput !== undefined) item.rawInput = u.rawInput;
            if (u.rawOutput !== undefined) item.rawOutput = u.rawOutput;
            break;
          }
          case "plan":
            items.push({
              kind: "plan",
              key,
              entries: u.entries.map((e) => ({ content: e.content, status: e.status })),
            });
            break;
          default:
            // available_commands_update, current_mode_update, usage_update, ...: not rendered.
            break;
        }
      }
    }
    flushSnapshots(ev.seq);
  }
  flushSnapshots(Number.POSITIVE_INFINITY);
  return items;
}
