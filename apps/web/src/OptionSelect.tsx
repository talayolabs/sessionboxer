import type { AgentOption, OptionValues } from "@sessionboxer/protocol";
import { Select, type SelectOption } from "./ui";

/** The RadioGroup value standing for "the Agent's default" (`null` to callers). */
const DEFAULT_VALUE = "";

/**
 * One dropdown per non-model config option the Provider's Agent advertised over ACP
 * (Claude: Effort, Fast mode; Devin: none today). Labels are the Agent's, the value sent is
 * the exact ACP one. A value the option no longer lists is kept selectable so it is never
 * silently dropped.
 */
export function OptionSelects({
  options,
  values,
  onChange,
  disabled = false,
  allowDefault = false,
  compact = false,
  pending = false,
}: {
  options: AgentOption[];
  values: OptionValues;
  onChange: (id: string, value: string | null) => void;
  disabled?: boolean;
  /** Offer an "Agent default" entry (New Session, where nothing has been picked yet). */
  allowDefault?: boolean;
  /** Toolbar styling for the composer instead of form fields. */
  compact?: boolean;
  /** Changes wait for the current turn to end. */
  pending?: boolean;
}) {
  return (
    <>
      {options.map((opt) => {
        const value = values[opt.id] ?? null;
        const known = value === null || opt.choices.some((c) => c.value === value);
        const current = opt.choices.find((c) => c.value === value);
        const label = current ? `${opt.name}: ${current.name}` : value ? `${opt.name} "${value}" (not in the current list)` : opt.name;
        const title = pending ? `${label} (change applies after this turn)` : (opt.description ? `${label} \u2014 ${opt.description}` : label);
        const choices: SelectOption<string>[] = [];
        if (allowDefault || value === null) choices.push({ value: DEFAULT_VALUE, label: "Agent default", textValue: "Agent default" });
        if (!known && value !== null) choices.push({ value, label: value, hint: "not in the current list" });
        for (const c of opt.choices) choices.push({ value: c.value, label: c.name, hint: c.description ?? undefined, textValue: c.name });
        const select = (
          <Select<string>
            value={value ?? DEFAULT_VALUE}
            onChange={(v) => onChange(opt.id, v === DEFAULT_VALUE ? null : v)}
            options={choices}
            disabled={disabled}
            aria-label={opt.name}
            className={compact ? "compact" : "field"}
            title={compact ? title : undefined}
          >
            {compact && (
              <span className={`select-label${value === null ? " muted" : ""}`}>
                {current ? `${opt.name}: ${current.name}` : value === null ? opt.name : value}
              </span>
            )}
          </Select>
        );
        return compact ? (
          <span key={opt.id} className="model-select">
            {select}
          </span>
        ) : (
          <label key={opt.id} className="model-select" title={title}>
            {opt.name}
            {select}
          </label>
        );
      })}
      {pending && options.length > 0 && <span className="warn-sign">pending</span>}
    </>
  );
}
