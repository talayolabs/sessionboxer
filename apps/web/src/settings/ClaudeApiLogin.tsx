import { useEffect, useState, type ReactNode } from "react";
import type { ClaudeApiLogin } from "@sessionboxer/protocol";
import { api } from "../api";

/**
 * The login command behind the Claude API gateway's credential (ADR-0090), run on the Control
 * Plane's machine: started from here, its output followed every second while it runs (a device
 * flow prints a code and a URL, then waits for the browser), cancellable. A run already in
 * progress when the component mounts is followed too, so the Session notice and the settings
 * panel show the same run.
 */
export function useClaudeApiLogin(): { state: ClaudeApiLogin | null; error: string | null; start: () => Promise<void>; cancel: () => Promise<void> } {
  const [state, setState] = useState<ClaudeApiLogin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  useEffect(() => {
    let cancelled = false;
    void api
      .claudeApiLogin()
      .then((s) => {
        if (!cancelled && s.running) setState(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!state?.running) return;
    const timer = setTimeout(() => void api.claudeApiLogin().then(setState).catch(fail), 1000);
    return () => clearTimeout(timer);
  }, [state]);
  return {
    state,
    error,
    start: async () => {
      setError(null);
      try {
        setState(await api.claudeApiLoginStart());
      } catch (e) {
        fail(e);
      }
    },
    cancel: async () => {
      try {
        setState(await api.claudeApiLoginCancel());
      } catch (e) {
        fail(e);
      }
    },
  };
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** The output with its URLs clickable (they open in a new tab, where the browser's SSO session is). */
export function linkify(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <a key={at} href={m[0]} target="_blank" rel="noreferrer noopener">
        {m[0]}
      </a>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function ClaudeApiLoginOutput({ login }: { login: ReturnType<typeof useClaudeApiLogin> }) {
  const { state, error, cancel } = login;
  if (error) return <pre className="error">{error}</pre>;
  if (!state) return null;
  const output = state.output.trim();
  const text = output !== "" ? output : state.running ? "Running…" : state.ok ? "The login command finished." : "The login command failed without output.";
  return (
    <div className="claude-api-login-output">
      <pre className={state.ok === false ? "error" : ""}>{linkify(text)}</pre>
      {state.running && (
        <button type="button" className="link" onClick={() => void cancel()}>
          Cancel
        </button>
      )}
    </div>
  );
}
