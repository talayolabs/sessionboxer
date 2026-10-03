import { useMemo, useState, type Dispatch, type SetStateAction } from "react";

/** A `useState` setter handed to a section component by `SettingsView`, which keeps the hooks. */
export type Setter<T> = Dispatch<SetStateAction<T>>;

/** `setX` for every key `x` of the section's values. */
export type SectionSetters<T> = { [K in keyof T & string as `set${Capitalize<K>}`]: Setter<T[K]> };

export type SectionState<T> = {
  /** The current field values; spread into the section component. */
  values: T;
  /** One setter per field, stable like `useState` setters; spread into the section component. */
  set: SectionSetters<T>;
  /** Whether any field differs from the value it was initialised with. */
  dirty: boolean;
};

/**
 * The form fields of one settings section as a single state object, initialised once from the stored settings
 * like the `useState` per field it replaces: setters accept a value or an updater and skip the re-render when
 * the field does not change.
 */
export function useSectionState<T extends Record<string, unknown>>(initial: T): SectionState<T> {
  const [initialValues] = useState(initial);
  const [values, setValues] = useState(initialValues);
  const set = useMemo(() => {
    const setters: Record<string, Setter<unknown>> = {};
    for (const key of Object.keys(initialValues)) {
      setters[`set${key.charAt(0).toUpperCase()}${key.slice(1)}`] = (update) =>
        setValues((prev) => {
          const next = typeof update === "function" ? (update as (current: unknown) => unknown)(prev[key]) : update;
          return Object.is(next, prev[key]) ? prev : { ...prev, [key]: next };
        });
    }
    return setters as SectionSetters<T>;
  }, [initialValues]);
  const dirty = Object.keys(initialValues).some((key) => !Object.is(values[key], initialValues[key]));
  return { values, set, dirty };
}

/** Origins (`https://host`) from a list typed one per line or separated by spaces/commas; anything that is not a URL is dropped. */
export function parseOriginList(text: string): string[] {
  const origins: string[] = [];
  for (const part of text.split(/[\s,]+/)) {
    const v = part.trim();
    if (!v) continue;
    try {
      const origin = new URL(v.includes("://") ? v : `https://${v}`).origin;
      if (origin !== "null" && !origins.includes(origin)) origins.push(origin);
    } catch {
      // not a URL
    }
  }
  return origins;
}
