import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CompactionDetails, CompactionDetailsRequest, CompactionMessage, Provider } from "@sessionboxer/protocol";

/**
 * What a context compaction did, read from the Provider's own records (ADR-0031). Nothing
 * here talks to the Agent: Claude Code keeps every message and each compaction in the session
 * transcript JSONL, Devin in the message tree of its `sessions.db`; both keep the summary that
 * now stands in for the conversation.
 */

/** A message is cut here; the store keeps the rest. */
const MESSAGE_CHARS_MAX = 6_000;
/** Newest messages kept when the conversation before a compaction is longer than this. */
const MESSAGES_MAX = 400;
/** A transcript beyond this is not read into memory. */
const FILE_BYTES_MAX = 256 * 1024 * 1024;

type Role = CompactionMessage["role"];

interface Recorded {
  trigger: "automatic" | "manual" | null;
  preTokens: number | null;
  postTokens: number | null;
  before: CompactionMessage[];
  summary: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function message(role: Role, text: string, kept = false): CompactionMessage {
  const t = text.trimEnd();
  return t.length > MESSAGE_CHARS_MAX ? { role, text: t.slice(0, MESSAGE_CHARS_MAX), truncated: true, kept } : { role, text: t, truncated: false, kept };
}

function trimList(list: CompactionMessage[]): { before: CompactionMessage[]; dropped: number } {
  return list.length > MESSAGES_MAX ? { before: list.slice(list.length - MESSAGES_MAX), dropped: list.length - MESSAGES_MAX } : { before: list, dropped: 0 };
}

/** Text of a content block list as Claude and Devin both use it (text / tool_use / tool_result / image…). */
function blocksText(content: unknown): { text: string; toolResult: boolean } {
  if (typeof content === "string") return { text: content, toolResult: false };
  if (!Array.isArray(content)) return { text: "", toolResult: false };
  const parts: string[] = [];
  let results = 0;
  for (const b of content) {
    if (!isRecord(b)) continue;
    switch (b.type) {
      case "text":
        parts.push(str(b.text) ?? "");
        break;
      case "thinking":
        break;
      case "tool_use":
        parts.push(`\u2192 ${str(b.name) ?? "tool"} ${JSON.stringify(b.input ?? {})}`);
        break;
      case "tool_result": {
        results++;
        const inner = blocksText(b.content).text;
        parts.push(b.is_error === true ? `\u26A0 ${inner}` : inner);
        break;
      }
      case "image":
        parts.push("[image]");
        break;
      case "document":
        parts.push("[document]");
        break;
      default:
        parts.push(`[${str(b.type) ?? "block"}]`);
    }
  }
  return { text: parts.filter((p) => p !== "").join("\n"), toolResult: results > 0 && results === content.length };
}

/** Slash commands and their local output are stored wrapped in tags; show what the user saw. */
function unwrapLocal(text: string): string {
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
    return `${cmd[1]?.trim() ?? ""}${args ? ` ${args}` : ""}`;
  }
  const out = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/.exec(text);
  return out ? (out[1] ?? "") : text;
}

// --- Claude Code -------------------------------------------------------------

interface ClaudeEntry {
  type: string;
  subtype: string | null;
  uuid: string | null;
  role: string | null;
  content: unknown;
  meta: boolean;
  sidechain: boolean;
  compactSummary: boolean;
  compact: Record<string, unknown> | null;
}

function claudeEntry(line: string): ClaudeEntry | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.type !== "string") return null;
  const msg = isRecord(v.message) ? v.message : null;
  return {
    type: v.type,
    subtype: str(v.subtype),
    uuid: str(v.uuid),
    role: msg ? str(msg.role) : null,
    content: msg ? msg.content : v.content,
    meta: v.isMeta === true,
    sidechain: v.isSidechain === true,
    compactSummary: v.isCompactSummary === true,
    compact: isRecord(v.compactMetadata) ? v.compactMetadata : null,
  };
}

function claudeMessage(e: ClaudeEntry, kept: boolean): CompactionMessage | null {
  if (e.type === "system") {
    if (e.subtype !== "local_command") return null;
    const text = str(e.content);
    return text ? message("system", unwrapLocal(text), kept) : null;
  }
  if (e.type !== "user" && e.type !== "assistant") return null;
  if (e.meta || e.sidechain) return null;
  const { text, toolResult } = blocksText(e.content);
  if (text === "") return null;
  if (e.type === "assistant") return message("assistant", text, kept);
  return message(toolResult ? "tool" : "user", unwrapLocal(text), kept);
}

/** The uuids a compaction kept verbatim after the summary. */
function preservedUuids(compact: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const pm = isRecord(compact.preservedMessages) ? compact.preservedMessages : null;
  const list = pm && Array.isArray(pm.allUuids) ? pm.allUuids : pm && Array.isArray(pm.uuids) ? pm.uuids : [];
  for (const u of list) if (typeof u === "string") out.add(u);
  return out;
}

/** Every compaction recorded in a Claude Code transcript, in order. Exported for tests. */
export function claudeCompactions(jsonl: string): Recorded[] {
  const entries: ClaudeEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    const e = claudeEntry(line);
    if (e) entries.push(e);
  }

  const out: Recorded[] = [];
  /** The window as the model saw it since the previous boundary: its summary, what it kept, then everything new. */
  let window: ClaudeEntry[] = [];
  let carried: CompactionMessage[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.type === "system" && e.subtype === "compact_boundary") {
      const compact = e.compact ?? {};
      const kept = preservedUuids(compact);
      const before = [...carried, ...window.map((w) => claudeMessage(w, kept.has(w.uuid ?? ""))).filter((m): m is CompactionMessage => m !== null)];
      let summary: string | null = null;
      for (let j = i + 1; j < entries.length; j++) {
        const n = entries[j];
        if (!n || (n.type === "system" && n.subtype === "compact_boundary")) break;
        if (n.compactSummary) {
          summary = blocksText(n.content).text;
          break;
        }
      }
      const trigger = compact.trigger === "auto" || compact.trigger === "automatic" ? "automatic" : compact.trigger === "manual" ? "manual" : null;
      out.push({ trigger, preTokens: num(compact.preTokens), postTokens: num(compact.postTokens), before, summary });
      carried = [];
      if (summary !== null) carried.push(message("system", summary));
      for (const w of window) {
        if (kept.has(w.uuid ?? "")) {
          const m = claudeMessage(w, false);
          if (m) carried.push(m);
        }
      }
      window = [];
      continue;
    }
    if (e.compactSummary) continue;
    window.push(e);
  }
  return out;
}

/** `~/.claude/projects/<cwd with / as ->/<session>.jsonl`. */
function claudeTranscriptPath(home: string, cwd: string, sessionId: string): string | null {
  const dir = `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) return null;
  const direct = `${dir}/${sessionId}.jsonl`;
  if (existsSync(direct)) return direct;
  if (!existsSync(dir)) return null;
  // A forked or resumed session can live under another file name; the entries carry the id.
  const needle = `"sessionId":"${sessionId}"`;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = `${dir}/${name}`;
    try {
      if (statSync(path).size > FILE_BYTES_MAX) continue;
      if (readFileSync(path, "utf8").includes(needle)) return path;
    } catch {
      // unreadable: not ours
    }
  }
  return null;
}

// --- Devin ---------------------------------------------------------------------

interface DevinNode {
  nodeId: number;
  parentNodeId: number | null;
  message: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
}

interface DevinRow {
  node_id: number;
  parent_node_id: number | null;
  chat_message: string;
  metadata: string | null;
}

function devinNodes(dbPath: string, sessionId: string): DevinNode[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT node_id, parent_node_id, chat_message, metadata FROM message_nodes WHERE session_id = ? ORDER BY node_id")
      .all(sessionId) as unknown as DevinRow[];
    const out: DevinNode[] = [];
    for (const r of rows) {
      let message: unknown;
      let metadata: unknown = null;
      try {
        message = JSON.parse(r.chat_message);
        if (r.metadata) metadata = JSON.parse(r.metadata);
      } catch {
        continue;
      }
      if (!isRecord(message)) continue;
      out.push({ nodeId: r.node_id, parentNodeId: r.parent_node_id, message, metadata: isRecord(metadata) ? metadata : null });
    }
    return out;
  } finally {
    db.close();
  }
}

function devinMessage(n: DevinNode): CompactionMessage | null {
  const role = str(n.message.role);
  const { text, toolResult } = blocksText(n.message.content);
  const calls = Array.isArray(n.message.tool_calls) ? n.message.tool_calls : [];
  const callLines = calls
    .map((c) => {
      if (!isRecord(c)) return null;
      const fn = isRecord(c.function) ? c.function : c;
      const name = str(fn.name) ?? "tool";
      const args = fn.arguments ?? fn.input ?? fn.args;
      return `\u2192 ${name} ${typeof args === "string" ? args : JSON.stringify(args ?? {})}`;
    })
    .filter((l): l is string => l !== null);
  const full = [text, ...callLines].filter((p) => p !== "").join("\n");
  if (full === "") return null;
  if (role === "assistant") return message("assistant", full);
  if (role === "user") return message(toolResult ? "tool" : "user", full);
  if (role === "tool") return message("tool", full);
  if (role === "system") return message("system", full);
  return null;
}

/** Window size after a Devin reply, from the metrics it stored with it. */
function devinContextAfter(n: DevinNode): number | null {
  const meta = isRecord(n.message.metadata) ? n.message.metadata : null;
  const metrics = meta && isRecord(meta.metrics) ? meta.metrics : null;
  if (metrics) {
    const input = num(metrics.input_tokens) ?? 0;
    const cached = num(metrics.cache_read_tokens) ?? 0;
    const written = num(metrics.cache_creation_tokens) ?? 0;
    const output = num(metrics.output_tokens) ?? 0;
    if (input + cached + written + output > 0) return input + cached + written + output;
  }
  return n.metadata ? num(n.metadata.num_tokens_preceding) : null;
}

/** Every compaction recorded in Devin's message tree for one session, in order. Exported for tests. */
export function devinCompactions(nodes: DevinNode[]): Recorded[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const out: Recorded[] = [];
  for (const n of nodes) {
    const ext = n.message.metadata && isRecord(n.message.metadata) && isRecord(n.message.metadata.extensions) ? n.message.metadata.extensions : null;
    const isSummary = str(n.message.role) === "system" && ext !== null && "devin-rs/summary" in ext;
    if (!isSummary) continue;
    const from = n.metadata ? num(n.metadata.summarized_from) : null;
    const fromNode = from !== null ? byId.get(from) : undefined;

    // The conversation is the chain of parents from the node the summary stands in for.
    const chain: DevinNode[] = [];
    const seen = new Set<number>();
    for (let cur = fromNode; cur && !seen.has(cur.nodeId); cur = cur.parentNodeId === null ? undefined : byId.get(cur.parentNodeId)) {
      seen.add(cur.nodeId);
      if (cur.metadata?.is_system_prefix === true) continue;
      chain.push(cur);
    }
    chain.reverse();
    let before = chain.map(devinMessage).filter((m): m is CompactionMessage => m !== null);
    if (before.length === 0 && ext) {
      // No tree behind it (older CLI): fall back to the history it embeds with the summary.
      const hist = isRecord(ext["chisel/conversation_history"]) ? ext["chisel/conversation_history"] : null;
      const msgs = hist && Array.isArray(hist.messages) ? hist.messages : [];
      before = msgs
        .map((m) => (isRecord(m) && (m.role === "user" || m.role === "assistant") && typeof m.message === "string" ? message(m.role, m.message) : null))
        .filter((m): m is CompactionMessage => m !== null);
    }
    out.push({
      trigger: null,
      preTokens: fromNode ? devinContextAfter(fromNode) : null,
      postTokens: null,
      before,
      summary: blocksText(n.message.content).text || null,
    });
  }
  return out;
}

// --- Matching ----------------------------------------------------------------

/** The recorded compaction the caller means: same position, unless another one matches the marker's numbers better. */
function pick(list: Recorded[], req: CompactionDetailsRequest): number {
  if (list.length === 0) return -1;
  const fits = (r: Recorded): boolean =>
    (req.preTokens === undefined || req.preTokens === null || r.preTokens === null || r.preTokens === req.preTokens) &&
    (req.postTokens === undefined || req.postTokens === null || r.postTokens === null || r.postTokens === req.postTokens) &&
    (req.trigger === undefined || req.trigger === null || r.trigger === null || r.trigger === req.trigger);
  const at = list[req.index];
  if (at && fits(at)) return req.index;
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r && fits(r) && (best === -1 || Math.abs(i - req.index) < Math.abs(best - req.index))) best = i;
  }
  return best !== -1 ? best : Math.min(req.index, list.length - 1);
}

export interface CompactionStore {
  provider: Provider;
  home: string;
  cwd: string;
}

/** Reads the Provider's record of the compaction `req` points at for the Agent session `acpSessionId`. */
export function readCompactionDetails(store: CompactionStore, acpSessionId: string, req: CompactionDetailsRequest): CompactionDetails {
  let list: Recorded[];
  let source: string;
  const notes: string[] = [];
  if (store.provider === "claude-code") {
    const path = claudeTranscriptPath(store.home, store.cwd, acpSessionId);
    if (!path) throw new Error(`Claude Code has no transcript for session ${acpSessionId} under ~/.claude/projects`);
    if (statSync(path).size > FILE_BYTES_MAX) throw new Error(`the transcript ${path} is too large to read (${Math.round(statSync(path).size / 1024 / 1024)} MB)`);
    list = claudeCompactions(readFileSync(path, "utf8"));
    source = path.replace(store.home, "~");
  } else {
    const path = `${store.home}/.local/share/devin/cli/sessions.db`;
    if (!existsSync(path)) throw new Error("Devin has no sessions.db under ~/.local/share/devin/cli");
    list = devinCompactions(devinNodes(path, acpSessionId));
    source = `~/.local/share/devin/cli/sessions.db (session ${acpSessionId})`;
    notes.push("Devin records the size of the window before a compaction but not after it; the trigger is not recorded either.");
  }
  const index = pick(list, req);
  if (index === -1) throw new Error(`${store.provider === "devin" ? "Devin" : "Claude Code"} has recorded no compaction for session ${acpSessionId} yet`);
  const rec = list[index];
  if (!rec) throw new Error("no such compaction");
  if (index !== req.index) notes.push(`The Provider's record #${index + 1} matched this marker best (asked for #${req.index + 1} of ${list.length}).`);
  const { before, dropped } = trimList(rec.before);
  if (dropped > 0) notes.push(`Showing the last ${before.length} of ${rec.before.length} messages.`);
  if (before.some((m) => m.truncated)) notes.push(`Messages longer than ${MESSAGE_CHARS_MAX.toLocaleString()} characters are cut.`);
  return {
    provider: store.provider,
    index,
    total: list.length,
    trigger: rec.trigger,
    preTokens: rec.preTokens,
    postTokens: rec.postTokens,
    before,
    summary: rec.summary,
    source,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}
