import { useEffect, useId, useState } from "react";

type Renderer = { render(id: string, code: string): Promise<{ svg: string }> };

let renderer: Promise<Renderer> | null = null;

/** Mermaid is ~2 MB, so it is fetched the first time a diagram shows up. */
function loadMermaid(): Promise<Renderer> {
  renderer ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      suppressErrorRendering: true,
      fontFamily: "inherit",
    });
    return mermaid;
  });
  return renderer;
}

type State = { state: "loading" } | { state: "ok"; svg: string } | { state: "error"; message: string };

/** A Mermaid diagram (from a ```mermaid block or a .mmd file) drawn as SVG; syntax errors show the message and the source. */
export function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [state, setState] = useState<State>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ state: "loading" });
    loadMermaid()
      .then((m) => m.render(`mermaid-${id}`, code.trim()))
      .then(({ svg }) => {
        if (!cancelled) setState({ state: "ok", svg });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ state: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  if (state.state === "error") {
    return (
      <div className="mermaid mermaid-error">
        <div className="mermaid-error-message">Mermaid: {state.message}</div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  if (state.state === "loading") return <div className="mermaid muted">Drawing diagram…</div>;
  // Mermaid sanitises the SVG itself (securityLevel strict: no scripts, no click handlers).
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: state.svg }} />;
}
