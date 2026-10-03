import { useId, type ReactNode } from "react";
import type { PublicMcpKeyValue } from "@sessionboxer/protocol";

/** Name/value rows with a per-row "secret" switch; a stored secret shows as empty and is kept when left empty. */
export function KeyValueList({
  label,
  labelTitle,
  items,
  namePlaceholder,
  nameOptions,
  onChange,
  valuePlaceholder = "value",
  multiline,
  secretTitle = "Secret: stored in config.json, never shown again here, kept out of snapshots",
  addLabel = typeof label === "string" ? `Add ${label.toLowerCase().replace(/s$/, "")}` : "Add",
  newItemSecret = false,
}: {
  label: ReactNode;
  labelTitle?: string;
  items: PublicMcpKeyValue[];
  namePlaceholder: string;
  /** Known names, offered in the name's datalist with their hint (also the name's tooltip). */
  nameOptions?: Record<string, string>;
  onChange: (items: PublicMcpKeyValue[]) => void;
  /** Placeholder of an unset value; a function when it depends on the name. */
  valuePlaceholder?: string | ((kv: PublicMcpKeyValue) => string);
  /** Rows whose value is edited in a textarea (a private key). */
  multiline?: (kv: PublicMcpKeyValue) => boolean;
  secretTitle?: string;
  addLabel?: string;
  /** Whether a row added with the button starts as a secret. */
  newItemSecret?: boolean;
}) {
  const listId = useId();
  const set = (i: number, patch: Partial<PublicMcpKeyValue>) => onChange(items.map((kv, j) => (j === i ? { ...kv, ...patch } : kv)));
  const placeholder = (kv: PublicMcpKeyValue) => (typeof valuePlaceholder === "function" ? valuePlaceholder(kv) : valuePlaceholder);
  return (
    <div className="kv">
      <span className="muted" title={labelTitle}>
        {label}
      </span>
      {items.map((kv, i) => {
        const stored = kv.secret && kv.value === null;
        const setValue = (value: string) => set(i, { value: value === "" && kv.secret && stored ? null : value });
        return (
          <div key={i} className="kv-row">
            <input
              list={nameOptions ? listId : undefined}
              value={kv.name}
              placeholder={namePlaceholder}
              title={nameOptions?.[kv.name]}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            {multiline?.(kv) && !stored ? (
              <textarea rows={3} value={kv.value ?? ""} placeholder={placeholder(kv)} spellCheck={false} onChange={(e) => setValue(e.target.value)} />
            ) : (
              <input
                type={kv.secret ? "password" : "text"}
                autoComplete="off"
                value={kv.value ?? ""}
                placeholder={stored ? "(set; leave empty to keep)" : placeholder(kv)}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            <label className="check" title={secretTitle}>
              <input
                type="checkbox"
                checked={kv.secret}
                onChange={(e) => set(i, { secret: e.target.checked, ...(e.target.checked ? {} : { value: kv.value ?? "" }) })}
              />
              secret
            </label>
            <button type="button" className="small danger" onClick={() => onChange(items.filter((_, j) => j !== i))} title="Remove">
              ×
            </button>
          </div>
        );
      })}
      {nameOptions && (
        <datalist id={listId}>
          {Object.entries(nameOptions).map(([n, hint]) => (
            <option key={n} value={n}>
              {hint}
            </option>
          ))}
        </datalist>
      )}
      <div>
        <button type="button" className="small" onClick={() => onChange([...items, { name: "", value: "", secret: newItemSecret }])}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}
