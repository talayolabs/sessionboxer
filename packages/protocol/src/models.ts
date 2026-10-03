// ---------------------------------------------------------------------------
// Models: each Provider's ACP adapter advertises the models it can run as the
// `model` session config option (ACP `configOptions`), and switches with
// `session/set_config_option`. The Control Plane remembers the last list seen
// per Provider so New Session can offer it before a Sandbox exists.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { Provider } from "./common.js";

export const ModelOption = z.object({
  /** Value understood by the Agent (`sonnet`, `opus[1m]`, `claude-sonnet-5-low`, …). */
  value: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  /** Group label when the Agent organises its list (ACP select groups). */
  group: z.string().nullable().default(null),
});
export type ModelOption = z.infer<typeof ModelOption>;

/** Last model list seen from each Provider's Agent; empty until a Session of that Provider has started. */
export type ProviderModels = Record<Provider, ModelOption[]>;

// ---------------------------------------------------------------------------
// Agent options: the other `select` config options an Agent advertises besides
// the model and the permission mode (claude-agent-acp: `effort`, `fast`). They
// are set the same way (`session/set_config_option`) and the set on offer can
// change with the model, so a Session carries both the values it asked for and
// what its Agent currently advertises.
// ---------------------------------------------------------------------------

export const OptionChoice = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
});
export type OptionChoice = z.infer<typeof OptionChoice>;

export const AgentOption = z.object({
  /** ACP config option id (`effort`, `fast`, …). */
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  category: z.string().nullable().default(null),
  choices: z.array(OptionChoice),
});
export type AgentOption = z.infer<typeof AgentOption>;

/** Option values by option id. */
export const OptionValues = z.record(z.string().min(1), z.string().min(1));
export type OptionValues = z.infer<typeof OptionValues>;

/** Every option each Provider's Agent has ever advertised (merged by id), so New Session can offer them. */
export type ProviderOptions = Record<Provider, AgentOption[]>;

/** Claude aliases Sessionboxer allows by default (Claude's own list plus Fable, which the SDK hides otherwise). */
export const DEFAULT_CLAUDE_MODELS = ["opus", "sonnet", "haiku", "fable"];

/** Origins an HTML Artifact may load scripts, styles, images and fonts from (shipped default of `Settings.htmlAppCdns`). */
export const DEFAULT_HTML_APP_CDNS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://esm.sh",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

/** Shipped default for `Settings.instructions`. Testing the change is not asked for here: `e2eVerify`, when on, runs a verification turn after each turn. */
export const DEFAULT_INSTRUCTIONS =
  "- Never author git commits as an agent: commits carry the user's git identity only, with no `Co-Authored-By` trailer, no \"generated with\" line and no mention of Claude, Devin or any other agent in commit messages or PR text.";

/** Earlier shipped defaults; a config.json still holding one of them verbatim is moved to the current text. */
export const PAST_DEFAULT_INSTRUCTIONS = [
  [
    DEFAULT_INSTRUCTIONS,
    "- After changing code, when the change can be exercised, run the application and use the desktop (mouse, keyboard, screenshots) to test it end to end, watching the change work. Record a video of the core part of the change with the desktop's start_recording/stop_recording tools and hand the user the file path so it plays in the chat.",
  ].join("\n"),
];

export const INSTRUCTIONS_MAX_CHARS = 20_000;

/**
 * How a Session's `instructions` reach the Agent. `system-prompt`: appended to the Agent's system
 * prompt (claude-agent-acp accepts `_meta.systemPrompt.append` on session/new and session/load;
 * fx `_meta.fx.systemPrompt`, Grok Build `_meta.rules`).
 * `first-prompt`: the Agent has no such hook (Devin CLI), so they are prepended to the first prompt
 * of every fresh ACP session the Daemon creates.
 */
export const InstructionsDelivery = z.enum(["system-prompt", "first-prompt"]);
export type InstructionsDelivery = z.infer<typeof InstructionsDelivery>;

export function instructionsDelivery(provider: Provider): InstructionsDelivery {
  return provider === "claude-code" || provider === "fx" || provider === "grok" ? "system-prompt" : "first-prompt";
}
