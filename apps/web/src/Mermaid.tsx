import { useEffect, useId, useState } from "react";
import type { Theme } from "@sessionboxer/protocol";
import { mermaidThemeVariables, useTheme } from "./theme";

type Renderer = { initialize(config: Record<string, unknown>): void; render(id: string, code: string): Promise<{ svg: string }> };

let renderer: Promise<Renderer> | null = null;
let configuredFor: Theme | null = null;

/** Mermaid is ~2 MB, so it is fetched the first time a diagram shows up; it is (re)configured for the theme in effect. */
function loadMermaid(theme: Theme): Promise<Renderer> {
  renderer ??= import("mermaid").then(({ default: mermaid }) => mermaid);
  return renderer.then((mermaid) => {
    if (configuredFor !== theme) {
      configuredFor = theme;
      mermaid.initialize({
        startOnLoad: false,
        theme: "base",
        themeVariables: mermaidThemeVariables(theme),
        securityLevel: "strict",
        suppressErrorRendering: true,
        fontFamily: "inherit",
      });
    }
    return mermaid;
  });
}

type State = { state: "loading" } | { state: "ok"; svg: string } | { state: "error"; message: string };

/** A Mermaid diagram (from a ```mermaid block or a .mmd file) drawn as SVG; syntax errors show the message and the source. */
export function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [state, setState] = useState<State>({ state: "loading" });
  const theme = useTheme();

  useEffect(() => {
    let cancelled = false;
    setState({ state: "loading" });
    loadMermaid(theme)
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
  }, [code, id, theme]);

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
