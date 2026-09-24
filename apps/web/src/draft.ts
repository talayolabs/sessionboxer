import { useRef, useSyncExternalStore } from "react";

/**
 * The composer's draft, held outside React state so that typing re-renders only the composer:
 * the owner (the Session view) reads and writes it through this handle without re-rendering, and
 * the composer subscribes with `useDraft`.
 */
export interface Draft {
  get(): string;
  set(next: string | ((cur: string) => string)): void;
  subscribe(listener: () => void): () => void;
}

export function useDraftStore(): Draft {
  const ref = useRef<Draft | null>(null);
  if (!ref.current) {
    let text = "";
    const listeners = new Set<() => void>();
    ref.current = {
      get: () => text,
      set: (next) => {
        const value = typeof next === "function" ? next(text) : next;
        if (value === text) return;
        text = value;
        for (const l of listeners) l();
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }
  return ref.current;
}

/** The draft's current text; re-renders the caller when it changes. */
export function useDraft(draft: Draft): string {
  return useSyncExternalStore(draft.subscribe, draft.get, draft.get);
}
