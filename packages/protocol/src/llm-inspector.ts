// ---------------------------------------------------------------------------
// Model API calls seen by the Sandbox's loopback inspector (`Session.inspectLlm`).
// Claude Code sends every request to `ANTHROPIC_BASE_URL`; with inspection on, that is
// the Daemon, which forwards to the real upstream (the company proxy or Anthropic)
// and keeps the bodies. Headers are never recorded.
// ---------------------------------------------------------------------------

import { z } from "zod";

/** Loopback port the Daemon's inspector listens on inside the Sandbox. */
export const LLM_INSPECTOR_PORT = 7200;
/** Anthropic's API, the upstream when no `ANTHROPIC_BASE_URL` is configured anywhere. */
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * - `turn`: a conversation request (has tools): what the transcript's agent messages and tool
 *   calls come from.
 * - `side`: a `/v1/messages` request without tools: Claude's own helpers (session naming,
 *   compaction summaries, prompt suggestions), no bubble of their own.
 * - `count_tokens`: `/v1/messages/count_tokens`.
 * - `other`: anything else sent to the base URL.
 */
export const LlmCallKind = z.enum(["turn", "side", "count_tokens", "other"]);
export type LlmCallKind = z.infer<typeof LlmCallKind>;

export const LlmCallUsage = z.object({
  inputTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
export type LlmCallUsage = z.infer<typeof LlmCallUsage>;

/** Shape of a `/v1/messages` request body, counted (not copied) for the list and the labels. */
export const LlmRequestShape = z.object({
  systemBlocks: z.number().int().nonnegative(),
  systemChars: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  toolsChars: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  messagesChars: z.number().int().nonnegative(),
  maxTokens: z.number().nullable(),
  stream: z.boolean(),
  systemPromptHash: z.string().nullable().optional(),
  toolSchemaHash: z.string().nullable().optional(),
});
export type LlmRequestShape = z.infer<typeof LlmRequestShape>;

/** Summary of one call; the bodies themselves stay in the Sandbox (`DaemonLlmCallBodyResult`). */
export const LlmCall = z.object({
  /** Unique per Daemon process. */
  id: z.string(),
  /** 1-based position among the Session's recorded calls, the `n` of the `LLM #n` label; set by the Control Plane (0 from the Daemon). */
  ordinal: z.number().int().nonnegative(),
  kind: LlmCallKind,
  method: z.string(),
  /** Path and query as Claude sent them, e.g. `/v1/messages?beta=true`. */
  path: z.string(),
  model: z.string().nullable(),
  /** HTTP status from upstream; `null` when the request never got a response. */
  status: z.number().int().nullable(),
  /** Why there is no (complete) response: upstream unreachable, client went away, … */
  error: z.string().nullable(),
  startedAt: z.string(),
  /** Request start to last response byte. */
  durationMs: z.number().nullable(),
  /** Decoded body sizes; `Truncated` when the inspector's per-body cap cut the copy. */
  requestBytes: z.number().int().nonnegative(),
  requestTruncated: z.boolean(),
  responseBytes: z.number().int().nonnegative(),
  responseTruncated: z.boolean(),
  /** The response was a `text/event-stream` (passed through as it arrived). */
  streamed: z.boolean(),
  /** `message.id` from the response, when it was a Messages API reply. */
  messageId: z.string().nullable(),
  stopReason: z.string().nullable(),
  usage: LlmCallUsage.nullable(),
  shape: LlmRequestShape.nullable(),
});
export type LlmCall = z.infer<typeof LlmCall>;

/** The exact bodies of one call, decoded (content-encoding removed) and as UTF-8 text. */
export const LlmCallBody = z.object({
  call: LlmCall.nullable(),
  /** `null` when evicted (the Sandbox keeps a bounded number of bodies, on tmpfs: gone after Stop → Resume too). */
  request: z.string().nullable(),
  response: z.string().nullable(),
});
export type LlmCallBody = z.infer<typeof LlmCallBody>;
