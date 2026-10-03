// ---------------------------------------------------------------------------
// Provider usage limits (ADR-0053). The Daemon meters what the Provider tells it (Anthropic's
// `anthropic-ratelimit-unified-*` response headers through the LLM inspector, Codex's `/status`)
// and marks an Agent error that is the Provider refusing to work for lack of credit; the
// Control Plane keeps both on the Session, re-sends the refused prompt on Continue, and polls
// for the reset when Auto-continue is on. Devin reports no meters; only its refusals are marked.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { PromptAttachment, MAX_PROMPT_ATTACHMENTS } from "./session-settings.js";

/** One usage window a Provider meters (a rolling 5 hours, a week, a spend cap, …). */
export const UsageWindow = z.object({
  /** Stable id within the Provider (`five_hour`, `seven_day`, `seven_day_overage_included`, `codex_primary`, …). */
  id: z.string(),
  /** Short name for the bar ("Session", "This week", "Fable"). */
  label: z.string(),
  /** Share of the window used, 0..1 (a Provider may report past 1). */
  used: z.number().min(0),
  resetsAt: z.string().nullable().default(null),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/** The Provider refused the last prompt for lack of usage credit. */
export const UsageLimit = z.object({
  /** The Provider's own words. */
  message: z.string(),
  /** When the credit is back, as far as the Provider said (headers or the message); `null` when it did not. */
  resetsAt: z.string().nullable().default(null),
  hitAt: z.string(),
  /**
   * What Continue sends again: the refused prompt itself, or a nudge to carry on when the Agent had
   * already started on it. `null` when nothing is to be re-sent (a hidden verification or handoff
   * request, which fail on their own).
   */
  retry: z
    .object({ text: z.string(), attachments: z.array(PromptAttachment).max(MAX_PROMPT_ATTACHMENTS).optional() })
    .nullable()
    .default(null),
});
export type UsageLimit = z.infer<typeof UsageLimit>;

export const SessionUsage = z.object({
  /** The Provider's meters, last reported values (in bar order). */
  windows: z.array(UsageWindow).default([]),
  updatedAt: z.string().nullable().default(null),
  limit: UsageLimit.nullable().default(null),
  /** While a limit stands, the Control Plane probes the Provider every `USAGE_AUTO_CONTINUE_INTERVAL_MS` once the reset is due and continues by itself. */
  autoContinue: z.boolean().default(false),
});
export type SessionUsage = z.infer<typeof SessionUsage>;

export const USAGE_AUTO_CONTINUE_INTERVAL_MS = 10_000;

/** `PUT /api/sessions/:id/usage/auto-continue`. */
export const AutoContinueRequest = z.object({ enabled: z.boolean() });
export type AutoContinueRequest = z.infer<typeof AutoContinueRequest>;

/** What Continue sends when the Agent had already produced something before the refusal. */
export const USAGE_CONTINUE_TEXT = "Continue where you left off.";
