import type { Dispatch, SetStateAction } from "react";

/** A `useState` setter handed to a section component by `SettingsView`, which keeps the hooks. */
export type Setter<T> = Dispatch<SetStateAction<T>>;

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
