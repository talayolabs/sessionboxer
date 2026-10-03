import type { PromptResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentOption, ModelOption, OptionChoice, TurnUsage } from "@sessionboxer/protocol";

/**
 * The prompt response's `usage` as the event carries it, dropping ACP's `_meta`. Agents leave out
 * what they do not know (fx sends only the counts it has, under `cacheReadTokens`/`cacheWriteTokens`/
 * `reasoningTokens`, and no total), so missing counts read as 0 and the total is summed when absent.
 */
export function turnUsage(usage: PromptResponse["usage"]): TurnUsage | undefined {
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
  const cachedWriteTokens = count("cachedWriteTokens", "cacheWriteTokens");
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
