# VS Code in the Sandbox via openvscode-server behind the Control Plane

Users want a real IDE on the Workspace next to the chat: search, Git view, extensions. Monaco in the Files pane is an editor, not an IDE, and the research in `docs/research/window-streaming-for-terminal-and-vscode.md` ruled out streaming Electron VS Code over VNC (heavy, pixel-based, keyboard shortcuts stolen by the browser). The questions were how VS Code runs, how the browser reaches it without a new port on the host, and who starts and stops it.

## Considered Options

### Which VS Code

- **`openvscode-server` inside the Sandbox image (chosen)**: Gitpod's build of VS Code's own web server, MIT, pinned in the Dockerfile (`OPENVSCODE_SERVER_VERSION`), installed under `/opt/openvscode-server`. Same workbench as VS Code for the Web, extensions from Open VSX. No extension is preinstalled: the Claude Code extension was in the first cut and dropped at the user's request, because it is a second Claude Code instance next to the chat's ACP conversation (same Workspace and login, separate history) and would confuse more than help; users install what they need from the Extensions view. Machine settings (`~/.openvscode-server/data/Machine/settings.json`) turn off telemetry, the welcome page and extension auto-updates and enable auto-save, so the agent and the user see each other's edits without pressing Ctrl+S. User data lives in the container, so installed extensions and settings survive Stop → Resume and travel with snapshots.
- `code-server` (Coder): equivalent and also MIT, but it carries its own password/auth layer and a larger patch set on top of VS Code; no benefit over the build that tracks upstream more closely.
- Electron VS Code on the Xvfb desktop, streamed over VNC: rejected in the research (600 MB image, 500–800 MB RAM, blurry, shortcuts).
- Microsoft's `code serve-web` / Remote Tunnels: the proprietary VS Code server and its license, and tunnels go through Microsoft's relay; not a local-only setup.

### How the browser reaches it

- **Loopback in the Sandbox, proxied twice (chosen)**: the server binds `127.0.0.1:7100` inside the container with `--without-connection-token`. The Daemon's existing HTTP server on port `7000` forwards everything under `/code/*` to it (plain requests and WebSocket upgrades, prefix stripped), and the Control Plane forwards `/api/sessions/:id/code/*` to the Daemon, adding `X-Forwarded-Prefix: /api/sessions/:id/code` so the workbench renders its asset URLs and WebSocket URL under that path. The browser loads `/api/sessions/:id/code/` in an iframe: same origin as the UI, so no CORS, no third-party-cookie issues, and clipboard/keyboard work as in any tab. Sandboxes still publish no host ports (ADR-0005); the Control Plane on `127.0.0.1:4000` remains the only door, exactly like noVNC, terminals and raw files. A connection token would only be visible to the same local user who already reaches the Daemon port, so it adds nothing here; if the Control Plane ever gets remote access with authentication, the token stays unnecessary because the proxy is the boundary.
- A third published container port for VS Code: rejected, it would be the first host port and bypass the Control Plane's session checks.
- Serving it under a separate hostname or port on the host: cross-origin iframe, cookies and clipboard restrictions, and another thing to configure.

### Who starts it

- **The Daemon, on demand (chosen)**: `_sessionboxer/code/start|status|stop` RPCs, a `CodeServer` supervisor that spawns the server, polls `/version` until it answers (90 s budget), keeps the last stderr lines for the error message, and stops it with SIGTERM → SIGKILL when asked or when the Daemon shuts down; a start after a stop waits for the old process to exit so the port is free. The Code pane starts it the first time it is opened and reuses a running one afterwards; the server is not started for Sessions whose pane is never opened (idle cost is zero), and it stops with the box. A Restart button stops and starts it for when the workbench is wedged.
- Starting it in the entrypoint for every Sandbox: 150–300 MB RAM per box whether used or not.
- Starting it from the Control Plane over `docker exec`: no health, no status, and it would not know when the Daemon restarts.

## Consequences

- Image: `openvscode-server` (~77 MB tarball, ~250 MB unpacked); `images/sandbox/openvscode-machine-settings.json`; briefing tells the agent the user may have VS Code open on `/workspace` and not to touch the server. Rebuild required.
- Protocol: `CODE_PATH`, `CodeServerStatus`, `DAEMON_METHODS.codeStart|codeStatus|codeStop`.
- Daemon: `code-server.ts`; the WebSocket server switched to `noServer` so the HTTP `upgrade` event can route `/code/*` to VS Code and everything else to JSON-RPC; the raw-file route is untouched.
- Control Plane: `code-proxy.ts` (`codePrefix`, `forwardedHeaders`, `codeTarget`, `proxyCodeRequest`, `bridgeCodeSocket`); `POST|GET|DELETE /api/sessions/:id/code-server` and `ALL /api/sessions/:id/code/*` (HTTP and WebSocket). The upstream is always the Session's Daemon address, never a client-supplied URL.
- Web: `Code.tsx` (`CodePane`), **Code** in the pane switcher between Files and Terminal, `api.codeStart|codeStatus|codeStop`, `codeUrl()`.
- Not done: forwarding ports the user opens in VS Code's Ports view to the host browser (the workbench will show them as `127.0.0.1:<port>` inside the box), pre-warming the server on Session start, an option to pick the default folder.
