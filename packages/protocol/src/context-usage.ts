// ---------------------------------------------------------------------------
// Context usage (ADR-0030). Occupancy and per-turn spend come from the ACP
// `usage_update` notifications and the prompt response's `usage`, both kept in the
// event stream; the category breakdown is the Agent's own `/context` report, parsed.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { Provider } from "./common.js";

/** What one turn spent, as the Agent reports it on the prompt response (ACP `usage`). */
export const TurnUsage = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  thoughtTokens: z.number().nullable().optional(),
  cachedReadTokens: z.number().nullable().optional(),
  cachedWriteTokens: z.number().nullable().optional(),
});
export type TurnUsage = z.infer<typeof TurnUsage>;

export const CONTEXT_CATEGORY_KINDS = ["used", "free", "buffer", "deferred"] as const;
export const ContextCategoryKind = z.enum(CONTEXT_CATEGORY_KINDS);
export type ContextCategoryKind = z.infer<typeof ContextCategoryKind>;

/** One row of the Agent's `/context` table (system prompt, tools, messages, free space, …). */
export const ContextCategory = z.object({
  name: z.string(),
  tokens: z.number(),
  /** Of the context window, as the Agent printed it. */
  percent: z.number().nullable(),
  kind: ContextCategoryKind,
});
export type ContextCategory = z.infer<typeof ContextCategory>;

/** One named contributor to a category: an MCP tool (source = server), a memory file (source = type), a skill (source = plugin). */
export const ContextContributor = z.object({
  name: z.string(),
  source: z.string(),
  tokens: z.number(),
});
export type ContextContributor = z.infer<typeof ContextContributor>;

/**
 * The Agent's own account of what fills its context window right now, parsed from its
 * `/context` report. Categories are the Provider's (Claude Code and Devin name them
 * differently); `text` is the report as printed, kept for what the parser does not know.
 */
export const ContextBreakdown = z.object({
  provider: Provider,
  model: z.string().nullable(),
  totalTokens: z.number().nullable(),
  maxTokens: z.number().nullable(),
  percent: z.number().nullable(),
  categories: z.array(ContextCategory),
  mcpTools: z.array(ContextContributor),
  memoryFiles: z.array(ContextContributor),
  skills: z.array(ContextContributor),
  /** A caveat the Agent printed ("Token counts are estimates…"). */
  note: z.string().nullable(),
  text: z.string(),
});
export type ContextBreakdown = z.infer<typeof ContextBreakdown>;

/** One message of the conversation as the Provider's own store keeps it (plain text rendering). */
export const CompactionMessage = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  text: z.string(),
  /** Cut at the Daemon's per-message limit; the store has the rest. */
  truncated: z.boolean(),
  /** Still in the window verbatim after the compaction (Claude keeps the last exchanges). */
  kept: z.boolean(),
});
export type CompactionMessage = z.infer<typeof CompactionMessage>;

/**
 * What one context compaction did, read from the Provider's own records in the Sandbox
 * (Claude Code: the session transcript JSONL; Devin: sessions.db and the history file it
 * writes): the messages it worked on and the summary that replaced them.
 */
export const CompactionDetails = z.object({
  provider: Provider,
  /** Position among the Provider's recorded compactions of this Agent session (0-based). */
  index: z.number(),
  /** How many the Provider has recorded, so the UI can tell a stale match. */
  total: z.number(),
  trigger: z.enum(["automatic", "manual"]).nullable(),
  preTokens: z.number().nullable(),
  postTokens: z.number().nullable(),
  /** The conversation the compaction started from, oldest first. */
  before: z.array(CompactionMessage),
  /** The text now standing in for it, as the model sees it; null when the store has none. */
  summary: z.string().nullable(),
  /** Where it was read from, for the curious. */
  source: z.string(),
  note: z.string().nullable(),
});
export type CompactionDetails = z.infer<typeof CompactionDetails>;

/** Which compaction the caller means: its position among the Session's completed ones, plus what the marker knows, for a safer match. */
export const CompactionDetailsRequest = z.object({
  index: z.number().int().min(0),
  preTokens: z.number().nullable().optional(),
  postTokens: z.number().nullable().optional(),
  trigger: z.enum(["automatic", "manual"]).nullable().optional(),
});
export type CompactionDetailsRequest = z.infer<typeof CompactionDetailsRequest>;
