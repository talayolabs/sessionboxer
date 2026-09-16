import type { ModelOption } from "@sessionboxer/protocol";

/** Above this many entries a flat list gets grouped by model family (first token of the value). */
const GROUP_FLAT_ABOVE = 24;

function familyOf(value: string): string {
  const head = value.split(/[-_:/[ ]/, 1)[0] ?? value;
  return head.length > 0 ? head.charAt(0).toUpperCase() + head.slice(1) : "Other";
}

/** `name — description`, without repeating the name when the description starts with it. */
function describe(m: ModelOption): string {
  if (!m.description) return m.name;
  const rest = m.description.startsWith(m.name) ? m.description.slice(m.name.length).replace(/^\s*[\u00b7\u2014\-:,]\s*/, "") : m.description;
  return rest.length > 0 ? `${m.name} \u2014 ${rest}` : m.name;
}

/** Ordered `[group label, models]` pairs; a `null` label means ungrouped (rendered flat, first). */
function groupModels(models: ModelOption[]): [string | null, ModelOption[]][] {
  const explicit = models.some((m) => m.group !== null);
  const derive = !explicit && models.length > GROUP_FLAT_ABOVE;
  const out = new Map<string | null, ModelOption[]>();
  for (const m of models) {
    const key = m.group ?? (derive ? familyOf(m.value) : null);
    const list = out.get(key);
    if (list) list.push(m);
    else out.set(key, [m]);
  }
  return [...out.entries()].sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0));
}

/**
 * Model picker fed by what the Provider's Agent advertised over ACP (`GET /api/models`).
 * `value` is `null` for "the Provider's default". A value the list does not know (older
 * catalog, another account) is kept selectable so the UI never silently drops it.
 */
export function ModelSelect({
  models,
  value,
  onChange,
  disabled = false,
  allowDefault = false,
  compact = false,
  pending = false,
}: {
  models: ModelOption[];
  value: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
  /** Offer a "Provider default" entry (New Session, where no model has been picked yet). */
  allowDefault?: boolean;
  /** Footer styling for the composer instead of a form field. */
  compact?: boolean;
  /** The change waits for the current turn to end. */
  pending?: boolean;
}) {
  const known = value === null || models.some((m) => m.value === value);
  const current = models.find((m) => m.value === value);
  const label = current
    ? describe(current)
    : value
      ? `Model "${value}" (not in the current list)`
      : "Model";
  const title = pending ? `${label} (change applies after this turn)` : label;
  const select = (
    <>
      <select value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} aria-label="Model">
        {(allowDefault || value === null) && <option value="">Provider default</option>}
        {!known && value !== null && <option value={value}>{value}</option>}
        {groupModels(models).map(([group, list]) => {
          const options = list.map((m) => (
            <option key={m.value} value={m.value} title={m.description ?? undefined}>
              {compact ? m.name : describe(m)}
            </option>
          ));
          return group === null ? (
            options
          ) : (
            <optgroup key={group} label={group}>
              {options}
            </optgroup>
          );
        })}
      </select>
      {pending && <span className="warn-sign">pending</span>}
    </>
  );
  return compact ? (
    <span className="model-select" title={title}>
      {select}
    </span>
  ) : (
    <label className="model-select" title={title}>
      Model
      {select}
    </label>
  );
}
