import type { PublicMcpKeyValue } from "@sessionboxer/protocol";

/** Name/value rows with a per-row "secret" switch; a stored secret shows as empty and is kept when left empty. */
export function KeyValueList({
  label,
  items,
  namePlaceholder,
  onChange,
  valuePlaceholder = "value",
  secretTitle = "Secret: stored in config.json, never shown again here, kept out of snapshots",
  addLabel = `Add ${label.toLowerCase().replace(/s$/, "")}`,
}: {
  label: string;
  items: PublicMcpKeyValue[];
  namePlaceholder: string;
  onChange: (items: PublicMcpKeyValue[]) => void;
  valuePlaceholder?: string;
  secretTitle?: string;
  addLabel?: string;
}) {
  const set = (i: number, patch: Partial<PublicMcpKeyValue>) => onChange(items.map((kv, j) => (j === i ? { ...kv, ...patch } : kv)));
  return (
    <div className="kv">
      <span className="muted">{label}</span>
      {items.map((kv, i) => {
        const stored = kv.secret && kv.value === null;
        return (
          <div key={i} className="kv-row">
            <input value={kv.name} placeholder={namePlaceholder} onChange={(e) => set(i, { name: e.target.value })} />
            <input
              type={kv.secret ? "password" : "text"}
              autoComplete="off"
              value={kv.value ?? ""}
              placeholder={stored ? "(set; leave empty to keep)" : valuePlaceholder}
              onChange={(e) => set(i, { value: e.target.value === "" && kv.secret && stored ? null : e.target.value })}
            />
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
      <div>
        <button type="button" className="small" onClick={() => onChange([...items, { name: "", value: "", secret: false }])}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}
