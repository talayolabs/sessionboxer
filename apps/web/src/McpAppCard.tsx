import { useCallback, useEffect, useRef, useState } from "react";
import {
  MCP_APPS_PROTOCOL_VERSION,
  type DaemonMcpAppsToolResultResult,
  type McpAppResourceResponse,
  type McpUiCsp,
  type Theme,
} from "@sessionboxer/protocol";
import { api } from "./api";
import type { Draft } from "./draft";
import { SANDBOX_PROXY_HTML, viewCsp } from "./mcp-app-sandbox";
import { useTheme } from "./theme";
import type { TranscriptItem } from "./transcript-model";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type Json = Record<string, unknown>;

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 900;
const DEFAULT_HEIGHT = 360;

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** The view's requested domains, each list present (the spec leaves them optional). */
function requested(csp: Partial<McpUiCsp> | undefined): McpUiCsp {
  return {
    connectDomains: csp?.connectDomains ?? [],
    resourceDomains: csp?.resourceDomains ?? [],
    frameDomains: csp?.frameDomains ?? [],
    baseUriDomains: csp?.baseUriDomains ?? [],
  };
}

const wantsDomains = (csp: McpUiCsp) => Object.values(csp).some((d) => d.length > 0);

/** Whether every domain the view asks for is in what was approved for the server. */
function covered(asked: McpUiCsp, approved: McpUiCsp | null): boolean {
  if (!approved) return !wantsDomains(asked);
  return (Object.keys(asked) as Array<keyof McpUiCsp>).every((k) => asked[k].every((d) => approved[k].includes(d)));
}

/** Our theme in the spec's `--color-*` / `--font-*` variables; the view styles itself with them. */
/** A view that speaks the MCP Apps protocol (`text/html;profile=mcp-app`), as opposed to plain HTML an MCP-UI result embeds. */
const isMcpApp = (r: { mimeType: string }) => /profile=mcp-app/i.test(r.mimeType);

function styleVariables(theme: Theme): Record<string, string> {
  const c = theme.colors;
  const root = getComputedStyle(document.documentElement);
  const sans = getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
  const mono = root.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
  // `*-background-{info,danger,…}` are pale tints the view puts `*-text-{info,…}` on (the reference
  // host uses #eff6ff/#1e3a5f for info), never the full status colour.
  const tint = (color: string) => `color-mix(in srgb, ${color} 15%, ${c.bg})`;
  return {
    "--color-background-primary": c.bg,
    "--color-background-secondary": c.panel,
    "--color-background-tertiary": c.sunken,
    "--color-background-inverse": c.text,
    "--color-background-ghost": c.hover,
    "--color-background-info": tint(c.accent),
    "--color-background-danger": tint(c.error),
    "--color-background-success": tint(c.ok),
    "--color-background-warning": tint(c.warn),
    "--color-background-disabled": c.sunken,
    "--color-text-primary": c.text,
    "--color-text-secondary": c.muted,
    "--color-text-tertiary": c.muted,
    "--color-text-inverse": c.bg,
    "--color-text-ghost": c.muted,
    "--color-text-info": c.accent,
    "--color-text-danger": c.error,
    "--color-text-success": c.ok,
    "--color-text-warning": c.warn,
    "--color-text-disabled": c.muted,
    "--color-border-primary": c.border,
    "--color-border-secondary": c.border,
    "--color-border-tertiary": c.border,
    "--color-border-inverse": c.text,
    "--color-border-ghost": c.border,
    "--color-border-info": c.accent,
    "--color-border-danger": c.error,
    "--color-border-success": c.ok,
    "--color-border-warning": c.warn,
    "--color-border-disabled": c.border,
    "--color-ring-primary": c.accent,
    "--color-ring-secondary": c.border,
    "--color-ring-inverse": c.text,
    "--color-ring-info": c.accent,
    "--color-ring-danger": c.error,
    "--color-ring-success": c.ok,
    "--color-ring-warning": c.warn,
    "--font-sans": sans,
    "--font-mono": mono,
    "--font-weight-normal": "400",
    "--font-weight-medium": "500",
    "--font-weight-semibold": "600",
    "--font-weight-bold": "700",
    "--font-text-xs-size": "11px",
    "--font-text-sm-size": "12px",
    "--font-text-md-size": "14px",
    "--font-text-lg-size": "16px",
    "--font-heading-xs-size": "14px",
    "--font-heading-sm-size": "16px",
    "--font-heading-md-size": "18px",
    "--font-heading-lg-size": "20px",
    "--font-heading-xl-size": "24px",
    "--font-heading-2xl-size": "30px",
    "--font-heading-3xl-size": "36px",
    "--border-radius-xs": "2px",
    "--border-radius-sm": "4px",
    "--border-radius-md": "6px",
    "--border-radius-lg": "10px",
    "--border-radius-xl": "16px",
    "--border-radius-full": "9999px",
    "--border-width-regular": "1px",
    "--shadow-hairline": `0 0 0 1px ${c.border}`,
  };
}

/** The text of the content blocks a view sends with `ui/message` / `ui/update-model-context`. */
function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => (isObject(b) && b.type === "text" && typeof b.text === "string" ? b.text : isObject(b) ? `[${String(b.type)}]` : ""))
    .filter((t) => t !== "")
    .join("\n");
}

interface Staged {
  id: number;
  text: string;
}

/**
 * An MCP App inline in the transcript (ADR-0079): the view of the tool the Agent called, hosted the
 * way the spec's sandbox proxy does it — an opaque-origin `srcdoc` iframe that puts the view in an
 * inner `srcdoc` iframe behind the CSP built from the resource's `_meta.ui.csp`. The HTML never
 * enters this document; it goes to the proxy with a message. The card speaks the host side of the
 * MCP Apps protocol over `postMessage`, validated by `event.source`; the view's own `tools/call`
 * and `resources/read` go to its server through the Daemon's tee.
 */
export function McpAppCard({ sessionId, item, draft }: { sessionId: string; item: ToolItem; draft?: Draft }) {
  const app = item.mcpApp;
  const theme = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [resource, setResource] = useState<McpAppResourceResponse | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [result, setResult] = useState<DaemonMcpAppsToolResultResult | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [fullscreen, setFullscreen] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [modelContext, setModelContext] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [approvedNow, setApprovedNow] = useState<McpUiCsp | null>(null);
  const [showContext, setShowContext] = useState(false);
  const nextId = useRef(1);
  const proxyReady = useRef(false);
  const mounted = useRef(false);

  const post = useCallback((msg: Json) => {
    frame.current?.contentWindow?.postMessage({ jsonrpc: "2.0", ...msg }, "*");
  }, []);
  const notify = useCallback((method: string, params: Json) => post({ method, params }), [post]);
  const respond = useCallback((id: unknown, result: Json) => post({ id, result }), [post]);
  const fail = useCallback((id: unknown, message: string, code = -32603) => post({ id, error: { code, message } }), [post]);

  const asked = requested(resource?.meta.csp);
  const approved = approvedNow ?? resource?.approvedDomains ?? null;
  const allowed = resource !== null && covered(asked, approved);
  const needsApproval = resource !== null && wantsDomains(asked) && !allowed;
  const running = item.status !== "completed" && item.status !== "failed";

  // The view's HTML and `_meta.ui`, from the Daemon's mirror (read through the tee when not cached).
  useEffect(() => {
    if (!app) return;
    let cancelled = false;
    let attempt = 0;
    const load = () => {
      api
        .mcpAppResource(sessionId, app.server, app.resourceUri)
        .then((r) => {
          if (!cancelled) setResource(r);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          if (attempt++ < 5) setTimeout(load, 1500);
          else setResourceError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, app?.server, app?.resourceUri]);

  // The exact result; the Daemon waits for it a little, and we come back once the ACP call settles.
  useEffect(() => {
    if (!app || (result && result.result)) return;
    let cancelled = false;
    api
      .mcpAppToolResult(sessionId, app.toolCallId)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setResultError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, app?.toolCallId, item.status]);

  // Mount the view in the proxy once both the proxy is ready and the HTML (with its CSP decision) is here.
  const mountView = useCallback(() => {
    if (!proxyReady.current || !resource || mounted.current) return;
    mounted.current = true;
    const csp = allowed ? asked : null;
    notify("ui/notifications/sandbox-resource-ready", {
      html: resource.html,
      csp: csp ?? {},
      cspPolicy: viewCsp(csp),
      sandbox: "allow-scripts allow-forms",
    });
  }, [resource, allowed, asked, notify]);
  useEffect(() => mountView(), [mountView]);

  const hostContext = useCallback(
    (mode: "inline" | "fullscreen"): Json => ({
      theme: theme.kind,
      styles: { variables: styleVariables(theme) },
      displayMode: mode,
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { maxHeight: mode === "fullscreen" ? window.innerHeight - 56 : MAX_HEIGHT, maxWidth: wrapper.current?.clientWidth ?? 900 },
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: "Sessionboxer",
      platform: "web",
      ...(result?.tool ? { toolInfo: { id: item.toolCallId, tool: result.tool } } : {}),
    }),
    [theme, result?.tool, item.toolCallId],
  );

  // Messages from the proxy (its own ready signal) and, relayed, from the view.
  useEffect(() => {
    if (!app) return;
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const msg: unknown = event.data;
      if (!isObject(msg) || msg.jsonrpc !== "2.0") return;
      const method = typeof msg.method === "string" ? msg.method : null;
      const params = isObject(msg.params) ? msg.params : {};
      const id = "id" in msg ? msg.id : undefined;
      if (method === null) return; // a response to something we asked (teardown): nothing to do
      switch (method) {
        case "ui/notifications/sandbox-proxy-ready":
          proxyReady.current = true;
          mountView();
          return;
        case "ui/initialize":
          respond(id, {
            protocolVersion: MCP_APPS_PROTOCOL_VERSION,
            hostInfo: { name: "Sessionboxer", version: "1" },
            hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {}, logging: {}, message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} } },
            hostContext: hostContext(fullscreen ? "fullscreen" : "inline"),
          });
          return;
        case "ui/notifications/initialized":
          setInitialized(true);
          return;
        case "ui/notifications/size-changed": {
          const h = typeof params.height === "number" ? params.height : null;
          if (h !== null) setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(h) + 2)));
          return;
        }
        case "ui/request-display-mode": {
          const mode = params.mode === "fullscreen" ? "fullscreen" : "inline";
          setFullscreen(mode === "fullscreen");
          respond(id, { mode });
          return;
        }
        case "ui/message":
          setStaged((s) => [...s, { id: nextId.current++, text: blocksText(params.content) }]);
          respond(id, {});
          return;
        case "ui/open-link":
          if (typeof params.url === "string") setLink(params.url);
          respond(id, {});
          return;
        case "ui/update-model-context":
          setModelContext(blocksText(params.content) || (params.structuredContent !== undefined ? JSON.stringify(params.structuredContent, null, 2) : null));
          respond(id, {});
          return;
        case "notifications/message":
          console.debug(`[mcp-app ${app.server}]`, params.level, params.data);
          return;
        case "ping":
          respond(id, {});
          return;
        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          const args = isObject(params.arguments) ? params.arguments : {};
          api
            .mcpAppCallTool(sessionId, { toolCallId: app.toolCallId, server: app.server, name, arguments: args })
            .then((r) => respond(id, r))
            .catch((e: unknown) => fail(id, e instanceof Error ? e.message : String(e)));
          return;
        }
        case "resources/read": {
          const uri = typeof params.uri === "string" ? params.uri : "";
          api
            .mcpAppReadResource(sessionId, { toolCallId: app.toolCallId, server: app.server, uri })
            .then((r) => respond(id, r))
            .catch((e: unknown) => fail(id, e instanceof Error ? e.message : String(e)));
          return;
        }
        default:
          if (id !== undefined) fail(id, `Sessionboxer does not support ${method}`, -32601);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [app, sessionId, fullscreen, hostContext, mountView, respond, fail]);

  // Once the view is initialized: its arguments, then the exact result as soon as it is known.
  useEffect(() => {
    if (!initialized || !app) return;
    notify("ui/notifications/tool-input", { arguments: app.arguments ?? {} });
  }, [initialized, app, notify]);
  useEffect(() => {
    if (!initialized) return;
    if (result?.result) notify("ui/notifications/tool-result", result.result);
    else if (item.status === "failed" && result && !result.result) notify("ui/notifications/tool-cancelled", { reason: "the tool call failed" });
  }, [initialized, result, item.status, notify]);

  // Theme or display mode changes reach the view.
  useEffect(() => {
    if (!initialized) return;
    notify("ui/notifications/host-context-changed", hostContext(fullscreen ? "fullscreen" : "inline"));
  }, [initialized, fullscreen, hostContext, notify]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Graceful shutdown of the view when the card leaves.
  useEffect(
    () => () => {
      post({ id: `host-teardown`, method: "ui/resource-teardown", params: {} });
    },
    [post],
  );

  const approve = async () => {
    if (!app) return;
    setApproving(true);
    try {
      await api.mcpAppApprove({ server: app.server, csp: asked });
      setApprovedNow(asked);
      mounted.current = false; // remount the view with the approved CSP
      setInitialized(false);
    } finally {
      setApproving(false);
    }
  };

  if (!app) return null;
  const domains = (Object.keys(asked) as Array<keyof McpUiCsp>).flatMap((k) => asked[k].map((d) => `${d} (${k.replace("Domains", "")})`));
  const title = `${app.server} / ${app.tool}`;

  return (
    <div className={`mcp-app${fullscreen ? " mcp-app-fullscreen" : ""}${resource?.meta.prefersBorder === false ? " mcp-app-borderless" : ""}`} data-tool-call-id={item.toolCallId}>
      <div className="mcp-app-bar">
        <span className="mcp-app-name" title={app.resourceUri}>
          {title}
        </span>
        <span className="mcp-app-status">
          {resourceError
            ? `view unavailable: ${resourceError}`
            : !resource
              ? "loading the view…"
              : running
                ? "running…"
                : resultError
                  ? `result unavailable: ${resultError}`
                  : !result?.result
                    ? "waiting for the result…"
                    : result.result.isError
                      ? "error result"
                      : needsApproval
                        ? "restricted"
                        : initialized || !isMcpApp(resource)
                          ? ""
                          : "starting…"}
        </span>
        {modelContext !== null && (
          <button type="button" className="small" onClick={() => setShowContext(!showContext)} title="What the view asked to tell the model with the next message">
            model context
          </button>
        )}
        <button type="button" className="small" onClick={() => setFullscreen(!fullscreen)}>
          {fullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>
      {needsApproval && (
        <div className="mcp-app-approval">
          <strong>{app.server}'s view wants to reach</strong> {domains.join(", ")}.
          <span className="muted"> It runs with the restrictive policy (no network, no frames) until you allow this for the server.</span>
          {resource?.approvable ? (
            <div className="approval-actions">
              <button type="button" className="small" disabled={approving} onClick={() => void approve()}>
                Allow for {app.server}
              </button>
            </div>
          ) : (
            <span className="muted"> Only registry MCP servers can be approved; this one comes from a Utility.</span>
          )}
        </div>
      )}
      {resourceError === null && (
        <div ref={wrapper} className="mcp-app-frame" style={fullscreen ? undefined : { height }}>
          {resource && <iframe ref={frame} title={`${title} view`} sandbox="allow-scripts" srcDoc={SANDBOX_PROXY_HTML} referrerPolicy="no-referrer" />}
        </div>
      )}
      {showContext && modelContext !== null && (
        <details className="mcp-app-context" open>
          <summary>model context from the view</summary>
          <pre>{modelContext}</pre>
        </details>
      )}
      {staged.map((s) => (
        <div key={s.id} className="mcp-app-staged">
          <span>The view wants to say:</span>
          <pre>{s.text}</pre>
          <div className="approval-actions">
            {draft && (
              <button
                type="button"
                className="small"
                onClick={() => {
                  draft.set((cur) => (cur.trim() === "" ? s.text : `${cur}\n${s.text}`));
                  setStaged((list) => list.filter((x) => x.id !== s.id));
                }}
              >
                Put it in the composer
              </button>
            )}
            <button type="button" className="small" onClick={() => setStaged((list) => list.filter((x) => x.id !== s.id))}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
      {link !== null && (
        <div className="mcp-app-staged">
          <span>The view wants to open</span>
          <code>{link}</code>
          <div className="approval-actions">
            <button
              type="button"
              className="small"
              onClick={() => {
                window.open(link, "_blank", "noopener,noreferrer");
                setLink(null);
              }}
            >
              Open in a new tab
            </button>
            <button type="button" className="small" onClick={() => setLink(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
