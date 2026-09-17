import { useEffect, useState } from "react";
import { dirOf } from "./attachment-paths";
import { Markdown } from "./Markdown";
import { Mermaid } from "./Mermaid";

type State = { state: "loading" } | { state: "ok"; text: string } | { state: "error"; message: string };

/** A Markdown or Mermaid file fetched from the Sandbox and rendered (chat cards for `.md` / `.mmd`). */
export function DocumentView({ src, path, kind }: { src: string; path: string; kind: "markdown" | "mermaid" }) {
  const [state, setState] = useState<State>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ state: "loading" });
    fetch(src)
      .then(async (res) => {
        if (!res.ok) throw new Error(`cannot load (${res.status})`);
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setState({ state: "ok", text });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ state: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (state.state === "loading") return <div className="document muted">Loading…</div>;
  if (state.state === "error") return <div className="document attachment-error">{state.message}</div>;
  return <div className="document">{kind === "mermaid" ? <Mermaid code={state.text} /> : <Markdown text={state.text} base={dirOf(path)} />}</div>;
}
