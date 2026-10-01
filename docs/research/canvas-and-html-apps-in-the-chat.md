# Research: canvas/HTML applications inside Sessionboxer

Question (2026-10-01): can Sessionboxer show **interactive HTML/canvas applications** — the way Claude.ai shows
Artifacts, ChatGPT shows Apps, and the MCP Apps extension defines tool UIs — rather than only the text, images,
video, PDF, Markdown and Mermaid the chat renders today (ADR-0017)?

Short answer: **yes, and it is three different features** that share one rendering primitive (a sandboxed iframe on a
non-Sessionboxer origin) but differ in where the HTML comes from, how much it is trusted, and what it needs to talk to:

| | A. Workspace HTML files ("Artifacts") | B. Live servers in the Sandbox ("Preview") | C. MCP Apps (`io.modelcontextprotocol/ui`) |
|---|---|---|---|
| Source of the HTML | A file the Agent wrote under `/workspace` (canvas game, D3/three.js/Chart.js page, a report) | A process the Agent started (`vite`, `next dev`, Streamlit, Flask on :3000) | A `ui://` HTML resource the **MCP server** ships; renders a tool's result (Plotable does this) |
| Trust | Agent-written code: untrusted | Agent-written or third-party code: untrusted | Server-authored, reviewable before the first call; declares its own CSP needs |
| Transport that exists | `/api/sessions/:id/fs/raw` streams any Workspace file | `/api/sessions/:id/code/*` proxies HTTP+WS to one port (ADR-0019); ADR-0005 left "a per-port proxy" for later | Nothing: the **Agent** owns the MCP connection, Sessionboxer only sees ACP `tool_call` / `tool_call_update` |
| Size of the step | **Small** (one Session): new `html` media kind, CSP `sandbox` header, inline card | **Medium**: generalise the Code proxy per port, a second origin for the app, port discovery | **Large**: Sessionboxer becomes an MCP Apps *host* (sandbox proxy, JSON-RPC over `postMessage`, `tools/call` relay) and needs its own view of the MCP traffic |
| What the user gets | "Look at the chart / play the game" inline, no server to start | Any web app the Agent is building, rendered by the real browser, with HMR | Rich widgets from third-party MCP servers (plots, forms, maps) that call back into the server |

Recommendation: **do A first** (it is what most "canvas app" requests mean and is the smallest), **then C** through a
transparent MCP tee in the Sandbox (which also makes MCP tool telemetry exact for all seven Providers), and treat **B**
as an add-on whose cheap version (open the dev server in the Desktop pane's browser) already works today. Details,
security boundaries and a plan follow.

## 1. Where we start

| Need | Have | Where |
|---|---|---|
| Serve a Workspace file to the browser | `GET|HEAD /fs/raw?path=…` through the Daemon, lexical + realpath containment, Range support; `.html` is not in `MEDIA_TYPES`, so it is served as `application/octet-stream` (never executed by accident) | `packages/sandbox-daemon/src/raw-files.ts`, `packages/protocol/src/index.ts` (`MEDIA_TYPES`, `contentTypeFor`), ADR-0017 |
| Show a file inline when the Agent mentions its path | `attachment-paths.ts` scans text for Workspace paths with a media extension and renders a card; `AttachmentPreview` previews `.html`/`.htm` **as text** | `apps/web/src/attachment-paths.ts`, `AttachmentPreview.tsx` |
| HTML in Markdown | `rehype-raw` + `rehype-sanitize` (default schema): no `script`/`style`/`iframe`/`form`, no `on*`. Display-only by design; **must not be loosened** for apps | `apps/web/src/Markdown.tsx` |
| Embed a web app from the Sandbox in a pane | Code pane: `openvscode-server` on `127.0.0.1:7100`, Daemon routes `/code`, Control Plane proxies HTTP+WebSocket under `/api/sessions/:id/code/*` (hop-by-hop headers stripped, `X-Forwarded-Prefix`), **same origin as the UI** so clipboard and keyboard just work | `apps/control-plane/src/code-proxy.ts`, `packages/sandbox-daemon/src/code-server.ts`, ADR-0019 |
| Start/stop a server in the Sandbox on demand | `CodeServer` supervisor: first open starts it, lives until the Sandbox stops | `code-server.ts` |
| Auth model the iframe must respect | Bearer token or device cookie (`HttpOnly; SameSite=Lax`); `rejectCrossOrigin` compares `Origin` to the host — and **returns early on `Origin: null`**, which is exactly what a sandboxed iframe sends | `apps/control-plane/src/auth.ts` |
| What an MCP tool call looks like to us | `ToolTelemetry` keeps `rawInput`, `rawOutput`, `content`, `_meta` of ACP updates; `Transcript.tsx` prints `rawOutput` as `<pre>` JSON when no renderer applies | `packages/sandbox-daemon/src/tool-telemetry.ts`, `apps/web/src/Transcript.tsx` |
| Panes | `Pane = "chat" \| "desktop" \| "code" \| "terminal" \| "context" \| "prs" \| …`; a new `app` pane is a one-line type change plus a view | `apps/web/src/App.tsx` |
| MCP client code in the repo | `@modelcontextprotocol/sdk` is a dependency of the two servers we ship (`sessionboxer-mcp`, `computer-use-mcp`); no client anywhere yet | `packages/*/package.json` |

## 2. The one primitive: an untrusted document on another origin

Every option renders HTML we did not write. The rules, shared with Claude Artifacts and the MCP Apps spec:

1. **Never into the React DOM.** `Markdown.tsx` sanitises for a reason; apps go in an `<iframe>`.
2. **Never on the Sessionboxer origin.** The Code pane is same-origin because `openvscode-server` is trusted software;
   an Agent-written page on the same origin could `fetch('/api/sessions/…')` with the user's cookie and do anything the
   UI can. Three ways to get a different origin, usable together:
   - **Opaque origin**: `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), or the response header
     `Content-Security-Policy: sandbox allow-scripts` which forces it even when the URL is opened in a top-level tab.
     Needs no DNS or extra port; works through the remote-access tunnel. Costs: `localStorage`/`indexedDB` throw, the
     document's `'self'` matches nothing, every request it makes is cross-site (so the `SameSite=Lax` cookie is not
     sent — good — but subresources that need auth get 401, see §3).
   - **Second loopback port** on the Control Plane (`127.0.0.1:4001`): a real origin with HTTP CSP headers; this is what
     the `ext-apps` reference host does. Does not exist behind a one-hostname tunnel.
   - **Subdomain**: `<port>-<session>.localhost:4000` resolves to loopback in Chrome/Firefox with no hosts-file; remotely
     it needs wildcard DNS on `SESSIONBOXER_PUBLIC_URL`. Host-only cookies are not sent to subdomains, so the frame needs
     its own short-lived credential (§4).
3. **CSP from the HTTP response, not from the page.** Default for Agent-written content, following Artifacts:
   `default-src 'none'; script-src 'unsafe-inline' <cdn allowlist>; style-src 'unsafe-inline' <cdn>; img-src data: blob:
   <cdn>; font-src <cdn>; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'`. The CDN allowlist
   (cdnjs, jsdelivr, unpkg, esm.sh, Google Fonts) is what makes "a three.js demo" possible without bundling; `connect-src`
   stays closed unless the app (C) declares domains.
4. **`postMessage` is the only channel**, and the parent checks `event.source` (opaque origins have no checkable
   `origin`) and the message shape before acting.
5. **Tighten `rejectCrossOrigin`**: once sandboxed frames exist on purpose, treat `Origin: null` as cross-origin for
   `/api/*` except the routes that intentionally serve app content. Today the cookie is withheld anyway for cross-site
   requests (I believe Chrome treats sandboxed-opaque initiators as cross-site; verify in the POC), so this is
   defence in depth, not a current hole.
6. **Caps**: Artifacts caps a rendered page at ~16 MiB; `/fs/raw` has no size cap today (ADR-0017 lists that as a
   limitation). Apps should get one (8–16 MiB), and a "Run" click for files above a smaller threshold.

## 3. A. Workspace HTML files as Artifacts

What the Agent does today when asked for "a canvas game" is write `game.html` and say the path; the chat shows a text
preview. The change:

- `MEDIA_TYPES` gains `html`/`htm` → `["html", "text/html; charset=utf-8"]`; `attachment-paths.ts` recognises them;
  the card renders an `<iframe sandbox="allow-scripts allow-pointer-lock" src="/api/sessions/:id/fs/raw?path=game.html">`
  (the attribute is a second fence; the header below is the real one), with a toolbar: Run/Stop, reload, open in the
  `app` Pane, fullscreen, open the source in Code.
- The Control Plane's `/fs/raw` route (or a sibling `/fs/app`) sets `Content-Security-Policy: sandbox allow-scripts …;
  default-src 'none'; …` and `X-Frame-Options`-free headers on `text/html` responses only. Serving it from a dedicated
  route avoids ever changing how other files are served.
- Opaque origin means the page's `<img src="shot.png">` or `<script src="app.js">` are cross-site requests without the
  cookie → 401. v1 therefore supports **single-file apps** (inline CSS/JS + allowlisted CDNs), exactly like Artifacts, and
  the Agent should be told so (one line in the system prompt / `sessionboxer` MCP knowledge). v2 adds **directory apps**:
  `GET /api/sessions/:id/app/<token>/<path>` where `<token>` is a short-lived (minutes), read-only capability minted by
  the UI for one directory; relative URLs then resolve naturally because the route is path-shaped, not `?path=`.
- Where it shows: inline in the transcript like media (collapsed to a fixed height, resizable), and the `app` Pane for
  "keep it open while we iterate" — reload-on-save for the pane is one `fs` watch event away since the Daemon already
  streams file changes for the Files view.
- Multi-page / fetch-heavy apps are B, not A; the card can say "this page talks to `localhost:3000`, start a Preview".

Nothing about Providers or ACP is involved: this works identically for all seven Agents and for Windows/macOS guests
(the Daemon reads the file through the guest transport as it does for images today).

## 4. B. Live servers in the Sandbox as a Preview

`ADR-0005` ("Dev servers the Agent starts inside a Sandbox are reachable from the Desktop's browser, but not from the
host, unless a per-port proxy is added later") and `ADR-0019` ("arbitrary port forwarding: not yet") both named this.
The pieces:

- **Daemon**: generalise `codeServer.handleHttp`'s `/code` → `127.0.0.1:7100` into `/ports/<n>/*` → `127.0.0.1:<n>`
  for HTTP and WebSocket (HMR). Windows/macOS guests go through the same transport the Code proxy already uses to reach
  the guest. Plus `ports/list` (parse `/proc/net/tcp` or `ss -ltn`) so the UI can show "listening: 3000, 5173" chips
  the way VS Code's Ports view does, and the `sessionboxer` MCP can offer `preview_open(port)`.
- **Control Plane**: `/api/sessions/:id/ports/:n/*` modelled on `code-proxy.ts`, **but on a different origin** (§2):
  `<n>-<sessionId>.localhost:<cpPort>` locally, `<n>-<sessionId>.<publicHost>` when wildcard DNS exists, otherwise fall
  back to the path prefix with the frame forced opaque by a CSP `sandbox` header (which breaks apps that use
  `localStorage`; acceptable as a fallback, not as the default). The subdomain frame gets a one-time redirect that
  exchanges a short-lived token for a subdomain-scoped cookie so the proxy stays authenticated.
- **Path-prefix pain**: apps emit absolute URLs (`/assets/x.js`, `/_next/…`). Host-based routing avoids it entirely;
  the prefix fallback needs the Agent to set the dev server's base (`vite --base /api/sessions/x/ports/5173/`), which is
  what code-server documents for its own `/proxy/<port>/` — workable but a footgun.
- **Zero-cost version that exists now**: the Desktop pane's Chromium can open `http://localhost:3000`; the Agent can be
  told to do that (and record it, ADR-0017) when a Preview is asked for. Pixels instead of DOM, but no new surface.

B is independent of A and C; it mostly matters for "I'm building a web app, show me", not for "draw me a chart".

## 5. C. MCP Apps: tool results rendered by the server's own UI

### 5.1 What the extension is (spec 2026-01-26, stable)

- A tool declares `_meta.ui.resourceUri = "ui://server/view.html"`; the resource's MIME type is
  `text/html;profile=mcp-app`; the host fetches it with `resources/read` (cacheable, reviewable before any call).
- The resource's `_meta.ui.csp` declares `connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`;
  `permissions` asks for camera/microphone/geolocation/clipboard-write. Host **must** build CSP from this and must not
  loosen; with no declaration the default is `default-src 'none'; script-src/style-src 'self' 'unsafe-inline';
  img-src/media-src 'self' data:; connect-src 'none'`.
- The view speaks JSON-RPC over `postMessage` as if it were an MCP client: `ui/initialize` → host returns capabilities,
  theme, container size; `ui/notifications/tool-input` and `ui/notifications/tool-result` deliver the call's arguments
  and result (`content`, **`structuredContent`**, `_meta`); the view may send `tools/call` and `resources/read` (relayed to
  the server, with `visibility: ["app"]` tools callable only from the app), `ui/message` (post into the chat),
  `ui/update-model-context`, `ui/open-link`, `ui/notifications/size-changed`; `ui/resource-teardown` on close.
- **Web hosts must wrap the view in a sandbox proxy iframe on a different origin** (`allow-scripts allow-same-origin`),
  which receives the raw HTML (`sandbox-resource-ready`), applies the CSP, creates the inner iframe and relays all
  non-`ui/notifications/sandbox-*` messages. `@modelcontextprotocol/ext-apps` ships the host SDK (`AppBridge`), the view
  SDK (`App`, React hooks) and a reference `basic-host`; `@mcp-ui/client`'s `AppRenderer` is the other host implementation.
- Clients advertise support in `initialize` under `capabilities.extensions["io.modelcontextprotocol/ui"]`; servers that
  see no such capability may answer text-only (Plotable's tools also return a text `content` fallback).

Plotable (`talayolabs/plotable`) is a ready fixture: `registerAppResource` + `registerAppTool` from `ext-apps`,
`ui://plotable/view.html`, and its viewer renders **`result.structuredContent`** in `app.ontoolresult`.

### 5.2 The real obstacle: Sessionboxer is not the MCP client

The Agent (Claude Code, Codex, Cursor, pi, OpenCode, fx) connects to the MCP servers; we hand it the list over ACP
(`acpMcpServers` in `packages/sandbox-daemon/src/mcp-config.ts`) and observe `tool_call`/`tool_call_update`. What
survives that leg:

- `claude-agent-acp`: `rawInput` = the tool's arguments, `rawOutput: chunk.content` = the SDK's `tool_result` **content
  blocks only** — `structuredContent` and `_meta` of the MCP result are not there. The server identity is in
  `_meta.claudeCode.mcpServer.name` (SDK ≥0.3.274) and `toolName` is `mcp__<server>__<tool>`.
- The other five adapters each do their own mapping; none is known to forward `structuredContent`, and we never see
  `tools/list` (`_meta.ui.resourceUri`) or `resources/read` at all.

So with ACP alone we can know *that* `plotable.render` ran and with which arguments, but not fetch its view nor feed it
the structured result it renders. Two ways out:

| | 1. Second connection from the Daemon | 2. Transparent MCP tee in the Sandbox (recommended) |
|---|---|---|
| How | Daemon runs an MCP client to each activated server (HTTP/SSE: same URL; stdio: a second process), does `tools/list`, `resources/read`, relays app `tools/call` | A small stdio/HTTP shim (`sb-mcp-tee <server>`) that the Agent is pointed at instead of the real server; it forwards everything unchanged and copies `tools/list` results, `tools/call` results (full: `content`, `structuredContent`, `_meta`) and `resources/read` to the Daemon over a local socket; app-initiated `tools/call` goes through the same connection |
| Gets `structuredContent` of the Agent's call | **No** (the result went to the Agent); the view would have to re-call the tool with the same arguments — wrong for non-idempotent tools, double cost | **Yes**, exact |
| Stateful stdio servers (a server that remembers a login or a document between calls) | Two processes, two states: breaks | One process, one state |
| Provider-agnostic | Yes | Yes, and it also fixes MCP tool telemetry (`ToolTelemetry` currently reconstructs from ACP; exact inputs/outputs for all seven Providers, Windows/macOS included via the existing MCP bridge) |
| Cost | MCP client in the Daemon; stdio servers started twice | The shim (~200 lines on `@modelcontextprotocol/sdk` transports), one more hop per call, the Agent's config points at the shim; servers' env/headers stay in the shim's process, not the Agent's |
| Relation to earlier decisions | — | `runtime-debugging-utilities.md` rejected a *gateway* that merges tools under new names; the tee is per-server and changes no tool name or schema, so that decision stands |

With the tee, the Daemon has the whole MCP conversation and can: cache `ui://` resources per server at activation
(reviewable, hash-logged as the spec suggests), emit `mcp_execution` events with exact results, and act as the host's
server-side half (relay `tools/call`/`resources/read` from the view, enforce `visibility`).

### 5.3 The host in the browser

- `apps/web`: an `McpAppCard` in the transcript for `tool_call` items whose (server, tool) has a `resourceUri`; it
  mounts the sandbox proxy iframe, drives `ui/initialize` / `tool-input` / `tool-result` through `AppBridge` (or a
  hand-rolled 150-line version — the protocol is small), applies our theme variables, honours `size-changed` up to a
  cap, and routes `ui/message` into the composer as a user message and `ui/open-link` to a new tab (with a confirm).
- Sandbox proxy origin: the spec wants `allow-same-origin` on a *different* origin. Locally the second-port or
  `apps.localhost` route gives that; behind the tunnel we fall back to an opaque-origin `srcdoc` proxy that injects the
  CSP as a `<meta http-equiv>` ahead of the view (stricter than the spec, not weaker; `frame-ancestors`/`sandbox`
  directives are not needed there). Verify in the POC that a leading `<head><meta …></head>` before the view's own
  `<!DOCTYPE html>` is honoured by the parser as intended.
- `connectDomains` requests should surface as a one-time per-server approval ("Plotable's view wants to reach
  `https://cdn.jsdelivr.net`"), stored with the MCP registry entry.
- Windows/macOS guests: the Agent's MCP traffic already crosses the guest bridge; the tee sits on the Linux side of it,
  so C needs nothing guest-specific.

## 6. Plan

1. **A, v1 (one Session)**: `html` media kind; `/fs/raw` HTML responses with CSP `sandbox` + Artifacts-style CSP and a
   size cap; inline card with Run/reload/fullscreen; `app` Pane; one sentence of Agent guidance ("single-file HTML with
   inline JS/CSS and CDN imports renders inline"). Tighten `rejectCrossOrigin` for `Origin: null`. ADR.
2. **A, v2**: directory apps via a tokenised path-shaped route; reload-on-save in the pane.
3. **C (two Sessions)**: `sb-mcp-tee` + Daemon-side MCP mirror (also lands exact MCP telemetry); `McpAppCard` with the
   sandbox proxy; Plotable as the test server; per-server `connectDomains` approval. ADR, and the MCP guide page.
4. **B (one Session, optional)**: `/ports/:n` in the Daemon and Control Plane, `*.localhost`/wildcard-DNS host routing
   with the token→cookie handshake, port chips, `preview_open` in the `sessionboxer` MCP; path-prefix fallback documented
   with the base-path caveat.

## 7. Open questions for the owner (with the recommended default)

1. Auto-run Agent-written HTML, or click-to-run? **Default: auto-run inline up to 2 MiB, click above; always auto in the
   `app` Pane.** It is sandboxed with `connect-src 'none'`; the risk is CPU, not data.
2. CDN allowlist for A: **cdnjs, jsdelivr, unpkg, esm.sh, fonts.googleapis/gstatic**, editable in Settings → Agent.
3. Second origin: **opaque-origin by default** (works everywhere, including remote access), with the subdomain mode
   switched on automatically when `SESSIONBOXER_PUBLIC_URL` has wildcard DNS or is `localhost`.
4. Build C on `@modelcontextprotocol/ext-apps` (`AppBridge`, maintained with the spec, React 19 peer) or hand-roll the
   small protocol? **Default: `ext-apps` for the host SDK types and the sandbox proxy, own card component.**
5. Does the tee replace the Agent's direct connections for *all* activated servers, or only those whose `tools/list`
   carries `_meta.ui`? **Default: all** — the telemetry win applies everywhere and the hop is local.

## References

- MCP Apps specification 2026-01-26 — https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- `@modelcontextprotocol/ext-apps` (host/view SDKs, `basic-host` reference) — https://github.com/modelcontextprotocol/ext-apps
- MCP-UI `AppRenderer` — https://mcpui.dev
- Plotable (MCP Apps server with `structuredContent`-driven view) — https://github.com/talayolabs/plotable
- `claude-agent-acp` tool result mapping (`rawOutput: chunk.content`, `_meta.claudeCode.mcpServer`) — https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts
- Claude Artifacts security model (separate origin, strict CSP, no network, ~16 MiB) — https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them
- CSP `sandbox` directive — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/sandbox
- ADR-0005 (no host ports), ADR-0017 (raw files and inline media), ADR-0019 (VS Code behind the Control Plane),
  `docs/research/runtime-debugging-utilities.md` §3 (gateway decision)
