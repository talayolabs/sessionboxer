import type { LlmCall, LlmCallKind } from "@sessionboxer/protocol";

export const LLM_KIND_LABELS: Record<LlmCallKind, string> = {
  turn: "conversation",
  side: "side call",
  count_tokens: "token count",
  other: "other",
};

/** One node of the parsed view of a request or response body. */
export interface TreeNode {
  label: string;
  /** Short facts shown after the label (sizes, names). */
  meta?: string;
  /** Text shown when the node is opened; `children` otherwise. */
  text?: string;
  children?: TreeNode[];
  /** Opened by default. */
  open?: boolean;
}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function chars(n: number): string {
  return `${n.toLocaleString()} chars`;
}

function blockSummary(block: unknown): { label: string; meta: string; text: string } {
  if (!isObject(block)) return { label: typeof block, meta: chars(JSON.stringify(block).length), text: JSON.stringify(block, null, 2) };
  const type = str(block.type) ?? "block";
  const cache = isObject(block.cache_control) ? ` · cache ${str(block.cache_control.ttl) ?? "5m"}` : "";
  switch (type) {
    case "text": {
      const text = str(block.text) ?? "";
      return { label: "text", meta: `${chars(text.length)}${cache}`, text };
    }
    case "tool_use": {
      const input = JSON.stringify(block.input, null, 2);
      return { label: `tool_use ${str(block.name) ?? ""}`, meta: `${chars(input.length)}${cache}`, text: input };
    }
    case "tool_result": {
      const content = block.content;
      const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
      return { label: `tool_result${block.is_error === true ? " (error)" : ""}`, meta: `${chars(text.length)}${cache}`, text };
    }
    case "image":
      return { label: "image", meta: `${JSON.stringify(block).length.toLocaleString()} chars of data${cache}`, text: "(image data)" };
    case "thinking": {
      const text = str(block.thinking) ?? "";
      return { label: "thinking", meta: `${chars(text.length)}${cache}`, text };
    }
    default: {
      const text = JSON.stringify(block, null, 2);
      return { label: type, meta: `${chars(text.length)}${cache}`, text };
    }
  }
}

function contentNodes(content: unknown): TreeNode[] {
  if (typeof content === "string") return [{ label: "text", meta: chars(content.length), text: content }];
  if (!Array.isArray(content)) return [{ label: "content", text: JSON.stringify(content, null, 2) }];
  return content.map((block, i) => {
    const s = blockSummary(block);
    return { label: `${i + 1}. ${s.label}`, meta: s.meta, text: s.text };
  });
}

const SKIP_TOP_LEVEL = new Set(["system", "tools", "messages"]);

/** The Messages API request as a tree: settings, system blocks, tools, messages. */
export function requestTree(body: unknown): TreeNode[] {
  if (!isObject(body)) return [{ label: "body", text: typeof body === "string" ? body : JSON.stringify(body, null, 2) }];
  const nodes: TreeNode[] = [];
  const settings = Object.entries(body).filter(([k]) => !SKIP_TOP_LEVEL.has(k));
  if (settings.length > 0) {
    nodes.push({
      label: "settings",
      meta: settings.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" "),
      children: settings.map(([k, v]) => ({ label: k, text: JSON.stringify(v, null, 2) })),
    });
  }
  if (body.system !== undefined) {
    const blocks = contentNodes(body.system);
    const total = typeof body.system === "string" ? body.system.length : JSON.stringify(body.system).length;
    nodes.push({ label: "system", meta: `${blocks.length} block${blocks.length === 1 ? "" : "s"} · ${chars(total)}`, children: blocks, open: true });
  }
  if (Array.isArray(body.tools)) {
    const tools = body.tools;
    nodes.push({
      label: "tools",
      meta: `${tools.length} · ${chars(JSON.stringify(tools).length)}`,
      children: tools.map((t, i) => {
        const name = isObject(t) ? (str(t.name) ?? `#${i + 1}`) : `#${i + 1}`;
        const text = JSON.stringify(t, null, 2);
        return { label: name, meta: chars(JSON.stringify(t).length), text };
      }),
    });
  }
  if (Array.isArray(body.messages)) {
    const messages = body.messages;
    nodes.push({
      label: "messages",
      meta: `${messages.length} · ${chars(JSON.stringify(messages).length)}`,
      open: true,
      children: messages.map((m, i) => {
        const role = isObject(m) ? (str(m.role) ?? "?") : "?";
        const content = isObject(m) ? m.content : m;
        const blocks = contentNodes(content);
        return {
          label: `${i + 1}. ${role}`,
          meta: `${blocks.length} block${blocks.length === 1 ? "" : "s"} · ${chars(JSON.stringify(content).length)}`,
          children: blocks,
        };
      }),
    });
  }
  return nodes;
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** The `event:`/`data:` records of a server-sent-events body. */
export function parseSse(text: string): SseEvent[] | null {
  if (!/^(event|data):/m.test(text)) return null;
  const events: SseEvent[] = [];
  for (const record of text.split(/\r?\n\r?\n/)) {
    let event = "message";
    const data: string[] = [];
    for (const line of record.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    const joined = data.join("\n");
    let parsed: unknown = joined;
    try {
      parsed = JSON.parse(joined);
    } catch {
      // keep the text
    }
    events.push({ event, data: parsed });
  }
  return events;
}

/** The streamed response put back together: the message the Agent saw, plus the event count. */
export function responseTree(text: string | null): TreeNode[] {
  if (text === null) return [];
  const sse = parseSse(text);
  if (!sse) {
    const body = parseJson(text);
    if (!isObject(body)) return [{ label: "body", text }];
    const nodes: TreeNode[] = [];
    const rest = Object.entries(body).filter(([k]) => k !== "content");
    if (rest.length > 0) nodes.push({ label: "message", meta: rest.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" "), children: rest.map(([k, v]) => ({ label: k, text: JSON.stringify(v, null, 2) })) });
    if (body.content !== undefined) nodes.push({ label: "content", children: contentNodes(body.content), open: true });
    return nodes;
  }
  const blocks: JsonObject[] = [];
  const partialJson: string[] = [];
  let message: JsonObject = {};
  const counts = new Map<string, number>();
  for (const { event, data } of sse) {
    counts.set(event, (counts.get(event) ?? 0) + 1);
    if (!isObject(data)) continue;
    switch (event) {
      case "message_start":
        if (isObject(data.message)) message = { ...data.message };
        break;
      case "content_block_start":
        if (isObject(data.content_block)) {
          blocks.push({ ...data.content_block });
          partialJson.push("");
        }
        break;
      case "content_block_delta": {
        const index = typeof data.index === "number" ? data.index : blocks.length - 1;
        const block = blocks[index];
        const delta = data.delta;
        if (!block || !isObject(delta)) break;
        if (str(delta.type) === "text_delta") block.text = (str(block.text) ?? "") + (str(delta.text) ?? "");
        else if (str(delta.type) === "thinking_delta") block.thinking = (str(block.thinking) ?? "") + (str(delta.thinking) ?? "");
        else if (str(delta.type) === "input_json_delta") partialJson[index] = (partialJson[index] ?? "") + (str(delta.partial_json) ?? "");
        else if (str(delta.type) === "signature_delta") block.signature = str(delta.signature);
        break;
      }
      case "message_delta":
        if (isObject(data.delta)) message = { ...message, ...data.delta };
        if (isObject(data.usage)) message.usage = { ...(isObject(message.usage) ? message.usage : {}), ...data.usage };
        break;
      default:
        break;
    }
  }
  blocks.forEach((block, i) => {
    const json = partialJson[i];
    if (json) {
      try {
        block.input = JSON.parse(json);
      } catch {
        block.input = json;
      }
    }
  });
  const nodes: TreeNode[] = [];
  const rest = Object.entries(message).filter(([k]) => k !== "content");
  if (rest.length > 0) {
    nodes.push({
      label: "message",
      meta: rest
        .filter(([k]) => k !== "usage")
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" "),
      children: rest.map(([k, v]) => ({ label: k, text: JSON.stringify(v, null, 2) })),
    });
  }
  nodes.push({ label: "content", meta: `${blocks.length} block${blocks.length === 1 ? "" : "s"}`, children: contentNodes(blocks), open: true });
  nodes.push({
    label: "stream events",
    meta: `${sse.length}`,
    children: [...counts.entries()].map(([event, n]) => ({ label: event, meta: String(n) })),
  });
  return nodes;
}

export type DiffLine = { kind: "same" | "added" | "removed" | "changed"; text: string; detail?: string };

export interface DiffSection {
  title: string;
  lines: DiffLine[];
}

function summarizeMessage(m: unknown): string {
  if (!isObject(m)) return JSON.stringify(m).slice(0, 80);
  const role = str(m.role) ?? "?";
  const content = m.content;
  if (typeof content === "string") return `${role}: ${content.slice(0, 80).replace(/\s+/g, " ")}${content.length > 80 ? "\u2026" : ""}`;
  if (!Array.isArray(content)) return role;
  const parts = content.map((b) => {
    const s = blockSummary(b);
    return s.label;
  });
  return `${role}: ${parts.join(", ")} (${chars(JSON.stringify(content).length)})`;
}

/**
 * What changed between two Messages API requests, section by section: the settings, each
 * system block, the tool set and the message list (a growing prefix in a conversation; a shorter
 * one after a compaction).
 */
export function diffRequests(prev: unknown, cur: unknown): DiffSection[] {
  if (!isObject(prev) || !isObject(cur)) return [{ title: "bodies", lines: [{ kind: "changed", text: "One of the two bodies is not a JSON object; compare them in the Request tab." }] }];
  const sections: DiffSection[] = [];

  const settings: DiffLine[] = [];
  for (const key of new Set([...Object.keys(prev), ...Object.keys(cur)].filter((k) => !SKIP_TOP_LEVEL.has(k)))) {
    const a = JSON.stringify(prev[key]);
    const b = JSON.stringify(cur[key]);
    if (a === b) settings.push({ kind: "same", text: `${key} = ${b}` });
    else if (a === undefined) settings.push({ kind: "added", text: `${key} = ${b}` });
    else if (b === undefined) settings.push({ kind: "removed", text: `${key} = ${a}` });
    else settings.push({ kind: "changed", text: `${key}: ${a} \u2192 ${b}` });
  }
  sections.push({ title: "settings", lines: settings });

  const sys = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.map((b) => (isObject(b) ? (str(b.text) ?? JSON.stringify(b)) : JSON.stringify(b))) : []);
  const prevSys = sys(prev.system);
  const curSys = sys(cur.system);
  const system: DiffLine[] = [];
  for (let i = 0; i < Math.max(prevSys.length, curSys.length); i++) {
    const a = prevSys[i];
    const b = curSys[i];
    if (a === undefined && b !== undefined) system.push({ kind: "added", text: `block ${i + 1}: ${chars(b.length)}`, detail: b });
    else if (b === undefined && a !== undefined) system.push({ kind: "removed", text: `block ${i + 1}: ${chars(a.length)}`, detail: a });
    else if (a !== undefined && b !== undefined && a === b) system.push({ kind: "same", text: `block ${i + 1}: ${chars(b.length)}` });
    else if (a !== undefined && b !== undefined) system.push({ kind: "changed", text: `block ${i + 1}: ${chars(a.length)} \u2192 ${chars(b.length)}`, detail: changedText(a, b) });
  }
  sections.push({ title: "system", lines: system });

  const toolMap = (v: unknown): Map<string, string> => {
    const m = new Map<string, string>();
    if (Array.isArray(v)) v.forEach((t, i) => m.set(isObject(t) ? (str(t.name) ?? `#${i + 1}`) : `#${i + 1}`, JSON.stringify(t)));
    return m;
  };
  const prevTools = toolMap(prev.tools);
  const curTools = toolMap(cur.tools);
  const tools: DiffLine[] = [];
  let sameTools = 0;
  for (const [name, a] of prevTools) {
    const b = curTools.get(name);
    if (b === undefined) tools.push({ kind: "removed", text: name });
    else if (a !== b) tools.push({ kind: "changed", text: `${name}: ${chars(a.length)} \u2192 ${chars(b.length)}` });
    else sameTools++;
  }
  for (const [name] of curTools) if (!prevTools.has(name)) tools.push({ kind: "added", text: name });
  if (sameTools > 0) tools.unshift({ kind: "same", text: `${sameTools} tool${sameTools === 1 ? "" : "s"} unchanged` });
  sections.push({ title: "tools", lines: tools });

  const prevMsgs = Array.isArray(prev.messages) ? prev.messages : [];
  const curMsgs = Array.isArray(cur.messages) ? cur.messages : [];
  const messages: DiffLine[] = [];
  let same = 0;
  const shared = Math.min(prevMsgs.length, curMsgs.length);
  for (let i = 0; i < shared; i++) {
    const a = JSON.stringify(prevMsgs[i]);
    const b = JSON.stringify(curMsgs[i]);
    if (a === b) {
      same++;
      continue;
    }
    if (same > 0) {
      messages.push({ kind: "same", text: `${same} message${same === 1 ? "" : "s"} unchanged` });
      same = 0;
    }
    messages.push({ kind: "changed", text: `${i + 1}. ${summarizeMessage(curMsgs[i])}`, detail: changedText(JSON.stringify(prevMsgs[i], null, 2), JSON.stringify(curMsgs[i], null, 2)) });
  }
  if (same > 0) messages.push({ kind: "same", text: `${same} message${same === 1 ? "" : "s"} unchanged` });
  for (let i = shared; i < prevMsgs.length; i++) messages.push({ kind: "removed", text: `${i + 1}. ${summarizeMessage(prevMsgs[i])}`, detail: JSON.stringify(prevMsgs[i], null, 2) });
  for (let i = shared; i < curMsgs.length; i++) messages.push({ kind: "added", text: `${i + 1}. ${summarizeMessage(curMsgs[i])}`, detail: JSON.stringify(curMsgs[i], null, 2) });
  sections.push({ title: "messages", lines: messages });
  return sections;
}

/** The two texts side by side around their first difference, for a changed block. */
function changedText(a: string, b: string): string {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ctx = 80;
  const from = Math.max(0, start - ctx);
  const cut = (s: string, end: number) => `${from > 0 ? "\u2026" : ""}${s.slice(from, Math.min(s.length, end + ctx))}${end + ctx < s.length ? "\u2026" : ""}`;
  return `--- before\n${cut(a, endA)}\n+++ after\n${cut(b, endB)}`;
}

/** The call to diff against: the previous one of the same kind that has a recorded body. */
export function previousCall(calls: LlmCall[], call: LlmCall, withBodies: Set<string>): LlmCall | null {
  let best: LlmCall | null = null;
  for (const c of calls) {
    if (c.ordinal >= call.ordinal || c.kind !== call.kind || !withBodies.has(c.id)) continue;
    if (!best || c.ordinal > best.ordinal) best = c;
  }
  return best;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
