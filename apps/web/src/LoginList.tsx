import { useId, useState } from "react";

/**
 * A list of logins (or `org/team` names) as pills with one input to add more: Enter, comma or
 * leaving the field adds what was typed (the `@` is dropped), Backspace on an empty field removes
 * the last pill, and `suggestions` come up as a native datalist while typing.
 */
export function LoginList({
  value,
  onChange,
  suggestions,
  placeholder,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const listId = useId();
  const add = (raw: string): void => {
    const items = raw
      .split(/[,\s]+/)
      .map((x) => x.trim().replace(/^@/, ""))
      .filter((x) => x !== "");
    setText("");
    if (items.length === 0) return;
    const next = [...value];
    for (const it of items) if (!next.some((v) => v.toLowerCase() === it.toLowerCase())) next.push(it);
    if (next.length !== value.length) onChange(next);
  };
  return (
    <div className={`login-list${disabled ? " disabled" : ""}`}>
      {value.map((v) => (
        <span key={v} className="pill">
          @{v}
          <button type="button" className="login-list-x" aria-label={`Remove @${v}`} disabled={disabled} onClick={() => onChange(value.filter((x) => x !== v))}>
            ×
          </button>
        </span>
      ))}
      <input
        list={listId}
        value={text}
        placeholder={value.length === 0 ? placeholder : undefined}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          const ev = e.nativeEvent;
          if (ev instanceof InputEvent && ev.inputType === "insertReplacementText") add(e.target.value);
          else setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && text === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => add(text)}
      />
      <datalist id={listId}>
        {suggestions
          .filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  );
}
