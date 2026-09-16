import type { AgentOption, OptionValues } from "@sessionboxer/protocol";

/**
 * One `<select>` per non-model config option the Provider's Agent advertised over ACP
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
  /** Footer styling for the composer instead of form fields. */
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
        const select = (
          <select
            value={value ?? ""}
            disabled={disabled}
            onChange={(e) => onChange(opt.id, e.target.value === "" ? null : e.target.value)}
            aria-label={opt.name}
          >
            {(allowDefault || value === null) && <option value="">{compact ? opt.name : "Agent default"}</option>}
            {!known && value !== null && <option value={value}>{value}</option>}
            {opt.choices.map((c) => (
              <option key={c.value} value={c.value} title={c.description ?? undefined}>
                {compact ? `${opt.name}: ${c.name}` : c.name}
              </option>
            ))}
          </select>
        );
        return compact ? (
          <span key={opt.id} className="model-select" title={title}>
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
