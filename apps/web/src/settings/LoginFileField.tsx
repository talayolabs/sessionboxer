import { useRef, type ReactNode } from "react";
import { Caption } from "../ui";
import type { Setter } from "./shared";

/**
 * A Provider login pasted or imported from a file, with "Forget" for the one stored: the shape of
 * the fx (ADR-0077) and Mistral Vibe (ADR-0085) cards. `stored` is what the Control Plane holds,
 * `metadata` its one-line description (never the secret); `value`/`forget` the form's state.
 */
export function LoginFileField({
  caption,
  help,
  stored,
  metadata,
  value,
  setValue,
  forget,
  setForget,
  placeholder,
  accept,
  importLabel,
}: {
  caption: string;
  help: ReactNode;
  stored: boolean;
  metadata: string | null;
  value: string;
  setValue: Setter<string>;
  forget: boolean;
  setForget: Setter<boolean>;
  placeholder: string;
  accept: string;
  importLabel: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const set = stored && !forget;
  const importFile = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setValue(text);
      setForget(false);
    });
  };
  return (
    <>
      <label>
        <Caption help={help}>
          {caption}{" "}
          {set ? <span className="ok">(set{metadata ? `: ${metadata}` : ""})</span> : <span className="warn">(not set)</span>}
        </Caption>
        <textarea
          rows={3}
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (e.target.value.trim()) setForget(false);
          }}
          placeholder={set ? "Leave empty to keep the current login" : placeholder}
        />
      </label>
      <div className="field-hint">
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          hidden
          onChange={(e) => {
            importFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button type="button" onClick={() => fileRef.current?.click()}>
          {importLabel}
        </button>
        {stored && (
          <label className="check">
            <input
              type="checkbox"
              checked={forget}
              onChange={(e) => {
                setForget(e.target.checked);
                if (e.target.checked) setValue("");
              }}
            />{" "}
            Forget the stored login
          </label>
        )}
      </div>
    </>
  );
}
