import type { ModelOption } from "@sessionboxer/protocol";
import { Select, type SelectOption } from "./ui";

/** Above this many entries a flat list gets grouped by model family (first token of the value). */
const GROUP_FLAT_ABOVE = 24;

/** The RadioGroup value standing for "the Provider's default" (`null` to callers). */
const DEFAULT_VALUE = "";

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

/** The description alone, without the name it may start with; `undefined` when there is none. */
function detail(m: ModelOption): string | undefined {
  const full = describe(m);
  return full === m.name ? undefined : full.slice(m.name.length).replace(/^\s*\u2014\s*/, "");
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
  emptyHint,
}: {
  models: ModelOption[];
  value: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
  /** Offer a "Provider default" entry (New Session, where no model has been picked yet). */
  allowDefault?: boolean;
  /** Toolbar styling (composer footer, New session) instead of a form field: the model's short name only. */
  compact?: boolean;
  /** The change waits for the current turn to end. */
  pending?: boolean;
  /** Shown as a disabled entry when the list is empty (New session, before the Provider's models are known). */
  emptyHint?: string;
}) {
  const known = value === null || models.some((m) => m.value === value);
  const current = models.find((m) => m.value === value);
  const label = current
    ? describe(current)
    : value
      ? `Model "${value}" (not in the current list)`
      : "Model";
  const title = pending ? `${label} (change applies after this turn)` : label;
  const options: SelectOption<string>[] = [];
  if (allowDefault || value === null) options.push({ value: DEFAULT_VALUE, label: "Provider default", textValue: "Provider default" });
  if (!known && value !== null) options.push({ value, label: value, hint: "not in the current list" });
  for (const [group, list] of groupModels(models)) {
    for (const m of list) {
      options.push({ value: m.value, label: m.name, hint: detail(m), textValue: m.name, ...(group === null ? {} : { group }) });
    }
  }
  if (models.length === 0 && emptyHint) options.push({ value: "\u0000empty", label: "No model list yet", hint: emptyHint, disabled: true });
  const select = (
    <>
      <Select<string>
        value={value ?? DEFAULT_VALUE}
        onChange={(v) => onChange(v === DEFAULT_VALUE ? null : v)}
        options={options}
        disabled={disabled}
        aria-label="Model"
        className={compact ? "compact" : "field"}
        title={compact ? title : undefined}
        menuClassName="model-menu"
      >
        {compact && (
          <span className={`select-label${value === null ? " muted" : ""}`}>{current ? current.name : value === null ? "Default model" : value}</span>
        )}
      </Select>
      {pending && <span className="warn-sign">pending</span>}
    </>
  );
  return compact ? (
    <span className="model-select">{select}</span>
  ) : (
    <label className="model-select" title={title}>
      Model
      {select}
    </label>
  );
}
