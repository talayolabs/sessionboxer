import { PROVIDER_LABELS, type Provider, type ToolCallContent } from "@sessionboxer/protocol";
import type { TranscriptItem } from "./transcript-model";

/**
 * "Copy session" (the header's "…" menu): the transcript as Markdown, JSON or JSONL, with the parts
 * the user picked. Pure, so `scripts/session-export.test.mjs` runs it under Node.
 */
export type ExportFormat = "markdown" | "json" | "jsonl";

export type ExportOptions = {
  user: boolean;
  assistant: boolean;
  /** `last`: only the Agent's final message of each turn, the one that sums it up. */
  assistantScope: "all" | "last";
  thinking: boolean;
  toolCalls: boolean;
  /** What each tool returned (needs `toolCalls`); the bulk of a long transcript. */
  toolOutput: boolean;
  timestamps: boolean;
  format: ExportFormat;
};

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  user: true,
  assistant: true,
  assistantScope: "last",
  thinking: false,
  toolCalls: false,
  toolOutput: false,
  timestamps: false,
  format: "markdown",
};

export type ExportedTool = { title: string; kind: string; status: string; input?: unknown; output?: string };

export type ExportedMessage = {
  role: "user" | "assistant" | "thinking" | "tool";
  ts?: string;
  text?: string;
  /** A user message another Session's Agent sent, or the handoff a fork started with. */
  from?: string;
  attachments?: string[];
  tool?: ExportedTool;
};

export type ExportedSession = { id: string; title: string; provider: Provider };

type Picked = Extract<TranscriptItem, { kind: "user" | "agent" | "thought" | "tool" }>;

/** Everything up to the next prompt or turn end is one turn; its last Agent message is the summary. */
function isTurnBoundary(item: TranscriptItem): boolean {
  return item.kind === "user" || item.kind === "turn_ended" || item.kind === "e2e_prompt" || item.kind === "handoff_request";
}

function lastAgentMessages(items: TranscriptItem[]): Set<TranscriptItem> {
  const last = new Set<TranscriptItem>();
  let candidate: TranscriptItem | null = null;
  for (const item of items) {
    if (isTurnBoundary(item)) {
      if (candidate) last.add(candidate);
      candidate = null;
    } else if (item.kind === "agent" && item.text.trim()) {
      candidate = item;
    }
  }
  if (candidate) last.add(candidate);
  return last;
}

function diffText(path: string, oldText: string | null | undefined, newText: string): string {
  const lines = (text: string, sign: string) => (text ? text.split("\n").map((l) => sign + l) : []);
  return [`--- ${path}`, `+++ ${path}`, ...lines(oldText ?? "", "-"), ...lines(newText, "+")].join("\n");
}

function contentText(c: ToolCallContent): string {
  switch (c.type) {
    case "content":
      return c.content.type === "text" ? c.content.text : `[${c.content.type}]`;
    case "diff":
      return diffText(c.path, c.oldText, c.newText);
    case "terminal":
      return `[terminal ${c.terminalId}]`;
    default:
      return "";
  }
}

function toolOutput(item: Extract<TranscriptItem, { kind: "tool" }>): string | undefined {
  const text = item.content.map(contentText).filter(Boolean).join("\n\n");
  if (text) return text;
  if (item.rawOutput === undefined || item.rawOutput === null) return undefined;
  return typeof item.rawOutput === "string" ? item.rawOutput : JSON.stringify(item.rawOutput, null, 2);
}

function toMessage(item: Picked, opts: ExportOptions): ExportedMessage {
  const ts = opts.timestamps ? { ts: item.ts } : {};
  switch (item.kind) {
    case "user":
      return {
        role: "user",
        ...ts,
        text: item.text,
        ...(item.fromAgent ? { from: `Agent of "${item.fromAgent.fromTitle}" (${item.fromAgent.fromSessionId})` } : item.handoff ? { from: "handoff" } : {}),
        ...(item.attachments?.length ? { attachments: item.attachments.map((a) => a.path) } : {}),
      };
    case "agent":
      return { role: "assistant", ...ts, text: item.text };
    case "thought":
      return { role: "thinking", ...ts, text: item.text };
    case "tool": {
      const output = opts.toolOutput ? toolOutput(item) : undefined;
      return {
        role: "tool",
        ...ts,
        tool: {
          title: item.title,
          kind: item.toolKind,
          status: item.status,
          ...(item.rawInput !== undefined ? { input: item.rawInput } : {}),
          ...(output !== undefined ? { output } : {}),
        },
      };
    }
  }
}

/** The transcript entries the options keep, in order. */
export function exportMessages(items: TranscriptItem[], opts: ExportOptions): ExportedMessage[] {
  const summaries = opts.assistant && opts.assistantScope === "last" ? lastAgentMessages(items) : null;
  const keep = (item: TranscriptItem): item is Picked => {
    switch (item.kind) {
      case "user":
        return opts.user;
      case "agent":
        return opts.assistant && (summaries === null || summaries.has(item)) && item.text.trim() !== "";
      case "thought":
        return opts.thinking && item.text.trim() !== "";
      case "tool":
        return opts.toolCalls;
      default:
        return false;
    }
  };
  return items.filter(keep).map((item) => toMessage(item, opts));
}

/** A code fence longer than any backtick run inside `text`. */
function fenced(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

const HEADINGS: Record<ExportedMessage["role"], string> = { user: "User", assistant: "Assistant", thinking: "Thinking", tool: "Tool" };

function markdownMessage(m: ExportedMessage): string {
  const when = m.ts ? ` · ${m.ts}` : "";
  if (m.tool) {
    const t = m.tool;
    const parts = [`### Tool: ${t.title} (${t.kind}, ${t.status})${when}`];
    if (t.input !== undefined) parts.push(fenced(typeof t.input === "string" ? t.input : JSON.stringify(t.input, null, 2), "json"));
    if (t.output !== undefined) parts.push("Output:", fenced(t.output));
    return parts.join("\n\n");
  }
  const from = m.from ? ` (from ${m.from})` : "";
  const text = m.role === "thinking" ? (m.text ?? "").split("\n").map((l) => `> ${l}`).join("\n") : (m.text ?? "");
  const attached = m.attachments?.length ? `\n\nAttachments: ${m.attachments.map((a) => `\`${a}\``).join(", ")}` : "";
  return `## ${HEADINGS[m.role]}${from}${when}\n\n${text}${attached}`;
}

export function formatExport(session: ExportedSession, messages: ExportedMessage[], format: ExportFormat): string {
  switch (format) {
    case "jsonl":
      return messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length ? "\n" : "");
    case "json":
      return JSON.stringify({ session: { id: session.id, title: session.title, provider: session.provider }, messages }, null, 2) + "\n";
    case "markdown":
      return [`# ${session.title}`, `${PROVIDER_LABELS[session.provider]} Session \`${session.id}\``, ...messages.map(markdownMessage)].join("\n\n") + "\n";
  }
}

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = { markdown: "md", json: "json", jsonl: "jsonl" };
