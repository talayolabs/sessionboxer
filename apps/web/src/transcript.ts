import type {
  ContentBlock,
  SessionEvent,
  SessionStatus,
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
  | { kind: "turn_ended"; key: string; stopReason: StopReason }
  | { kind: "error"; key: string; message: string }
  | { kind: "status"; key: string; status: SessionStatus; error?: string };

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

/** Folds the persisted event stream into renderable items (chunks merged, tool calls updated in place). */
export function buildTranscript(events: SessionEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();

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
        items.push({ kind: "user", key, text: body.text });
        break;
      case "turn_ended":
        items.push({ kind: "turn_ended", key, stopReason: body.stopReason });
        break;
      case "agent_error":
        items.push({ kind: "error", key, message: body.message });
        break;
      case "status":
        items.push(body.error ? { kind: "status", key, status: body.status, error: body.error } : { kind: "status", key, status: body.status });
        break;
      case "update": {
        const u = body.update;
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
  }
  return items;
}
