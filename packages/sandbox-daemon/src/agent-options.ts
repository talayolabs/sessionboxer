import type { PromptResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentOption, ModelOption, OptionChoice, TurnUsage } from "@sessionboxer/protocol";

/**
 * The prompt response's `usage` as the event carries it, dropping ACP's `_meta`. Agents leave out
 * what they do not know (fx sends only the counts it has, under `cacheReadTokens`/`cacheWriteTokens`/
 * `reasoningTokens`, and no total; Grok Build puts its counts under the response's `_meta.usage`, with the
 * cache write as `cacheCreationTokens`), so missing counts read as 0 and the total is summed when absent.
 */
export function turnUsage(response: Pick<PromptResponse, "usage" | "_meta">): TurnUsage | undefined {
  const meta = response._meta?.usage;
  const usage = response.usage ?? (typeof meta === "object" && meta !== null ? meta : undefined);
  if (!usage) return undefined;
  const raw = usage as Record<string, unknown>;
  const count = (...keys: string[]): number | null => {
    for (const key of keys) {
      const v = raw[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return null;
  };
  const inputTokens = count("inputTokens");
  const outputTokens = count("outputTokens");
  const thoughtTokens = count("thoughtTokens", "reasoningTokens");
  const cachedReadTokens = count("cachedReadTokens", "cacheReadTokens");
  const cachedWriteTokens = count("cachedWriteTokens", "cacheWriteTokens", "cacheCreationTokens");
  const totalTokens = count("totalTokens");
  if (inputTokens === null && outputTokens === null && totalTokens === null) return undefined;
  return {
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0) + (thoughtTokens ?? 0),
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    thoughtTokens,
    cachedReadTokens,
    cachedWriteTokens,
  };
}

/**
 * Each model's context window from `session/new` / `session/load`'s `models`, when the Agent lists
 * it there (Grok Build: `availableModels[]._meta.totalContextTokens`; the SDK does not type the field).
 */
export function modelWindows(response: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const models = (response as { models?: { availableModels?: unknown } } | null)?.models?.availableModels;
  if (!Array.isArray(models)) return out;
  for (const m of models as { modelId?: unknown; _meta?: { totalContextTokens?: unknown } }[]) {
    const size = m._meta?.totalContextTokens;
    if (typeof m.modelId === "string" && typeof size === "number" && size > 0) out[m.modelId] = size;
  }
  return out;
}

/**
 * The window's occupancy after a turn as its own tokens tell it: the input (cache reads included)
 * plus the output; exact when the turn made one model call, an over-estimate when it made several.
 * For Agents that report the turn's tokens but send no `usage_update` (Grok Build).
 */
export function contextOccupancy(usage: TurnUsage): number {
  return usage.inputTokens + (usage.cachedReadTokens ?? 0) + usage.outputTokens;
}

/** The ACP config option that selects the model (claude-agent-acp and devin acp both use id `model`, category `model`). */
export function modelOption(options: SessionConfigOption[] | null | undefined): (SessionConfigOption & { type: "select" }) | null {
  if (!options) return null;
  // fx lists both `provider` and `model` under the `model` category; the one named `model` is the picker.
  const found =
    options.find((o) => o.type === "select" && o.id === "model") ?? options.find((o) => o.type === "select" && o.category === "model");
  return found?.type === "select" ? found : null;
}

export function toModelOptions(option: SessionConfigOption & { type: "select" }): ModelOption[] {
  return option.options.flatMap((entry): ModelOption[] =>
    "group" in entry
      ? entry.options.map((v) => ({ value: v.value, name: v.name, description: v.description ?? null, group: entry.name }))
      : [{ value: entry.value, name: entry.name, description: entry.description ?? null, group: null }],
  );
}

/** The other `select` options: everything but the model and the permission mode (which the Daemon owns). */
export function otherOptions(options: SessionConfigOption[]): AgentOption[] {
  return options.flatMap((o): AgentOption[] =>
    o.type !== "select" || o.category === "model" || o.id === "model" || o.category === "mode" || o.id === "mode"
      ? []
      : [
          {
            id: o.id,
            name: o.name,
            description: o.description ?? null,
            category: o.category ?? null,
            choices: o.options.flatMap((entry): OptionChoice[] =>
              "group" in entry
                ? entry.options.map((v) => ({ value: v.value, name: v.name, description: v.description ?? null }))
                : [{ value: entry.value, name: entry.name, description: entry.description ?? null }],
            ),
          },
        ],
  );
}


/** Kimi 1.52 returns the older ACP models field instead of configOptions. */
export function sessionOptions(result: { configOptions?: SessionConfigOption[] | null; models?: { currentModelId: string; availableModels: { modelId: string; name: string; description?: string | null }[] } | null } | null | undefined): SessionConfigOption[] | null | undefined {
  if (result?.configOptions?.length || !result?.models) return result?.configOptions;
  return [{ id: "model", name: "Model", category: "model", type: "select", currentValue: result.models.currentModelId,
    options: result.models.availableModels.map((m) => ({ value: m.modelId, name: m.name, description: m.description })) }];
}
