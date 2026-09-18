# Research: streaming a single window (terminal, VS Code) instead of the whole desktop

Question (2026-09-17): could the **Terminal** pane be a VNC view of just a terminal window, in a session separate from
the Desktop, instead of today's xterm.js client talking to a PTY through the Daemon? And could the **Files/editor**
pane be a VNC view of a VS Code window running inside the box?

Short answer: yes for both, with three ways to isolate a window; but for these two particular apps the pixel route
is the wrong tool. The terminal is best left as xterm.js (a VNC terminal is strictly worse), and VS Code is best
served as a **web app from inside the box** (`openvscode-server` / `code-server`) in an iframe, which the frontend
gets for free through the same proxy that streams `/fs/raw`. Details and numbers below.

Today: one `Xvfb :1` (1024x768) + XFCE + `x11vnc` (polling) + `websockify` on :6080; the web app uses `@novnc/novnc`'s
`RFB` class directly (`apps/web/src/Desktop.tsx`), so a second RFB connection to another display is a small change.
Ubuntu 24.04 base; `tigervnc-standalone-server` 1.13 is in the Ubuntu repo (7 packages), `xpra` only as 3.1 (no
`xpra-html5`; xpra.org ships v6 + html5 in its own apt repo).

## Ways to show "only one window" over VNC

| | How | Verdict |
|---|---|---|
| **A. `x11vnc -id <windowid>`** on the existing `:1` | Polls one window of the shared display | **No.** Documented as approximate: menus, dropdowns, tooltips and dialogs (separate top-level or override-redirect windows) do not show up (x11vnc FAQ Q-27), it breaks when another window overlaps, and the window is still on the desktop the user/agent sees, so the agent could click it. `-appshare` is "very primitive" per its own docs. |
| **B. One extra X server per pane** (`Xvnc :2` running just `xterm`/`code`, no desktop) | TigerVNC's `Xvnc` is X server + VNC server in one; noVNC connects to it | **Works, and is the right VNC design.** The window is the whole screen of its own display, so nothing overlaps it and the agent (on `:1`) cannot see or touch it. `Xvnc` supports client-initiated resize (`ExtendedDesktopSize`/`SetDesktopSize`, `-AcceptSetDesktopSize` default on) and noVNC's `RFB.resizeSession = true` sends the pane size, so the "screen" follows the pane. Needs a tiny WM (or `xdotool`/`wmctrl` on `RRScreenChangeNotify`) to keep the app maximised after a resize since a bare X app does not follow the root window size. Cost per pane: one Xvnc (~30–60 MB RSS) + the app. Not hands-on tested here (Xvnc behaviour from its man page and noVNC docs). |
| **C. Xpra seamless + HTML5 client** (`xpra start :100 --start=xterm --html=on --bind-tcp=…`) | Xpra forwards top-level windows individually; its HTML5 client draws each in a canvas in the browser | **Works and is designed for exactly this** (one command → one app forwarded, windows resize with the browser, clipboard, disconnect/reconnect without losing the app). Downsides: another server + protocol next to noVNC (Ubuntu's xpra is 3.1 from 2021 without the html5 client; you would add xpra.org's repo, ~100 MB of deps), its own client lib to embed, and still pixels. Worth it only if you want to forward *arbitrary* GUI apps as detached windows later. |

Any of B/C also needs: one more `websockify` (or Xvnc's own websocket support; TigerVNC ≥1.13 has none, Xpra has
built-in), a Daemon RPC to start/stop the display per pane, and a Control Plane proxy path like the desktop one.

## Terminal: VNC window vs. xterm.js (today)

| | xterm.js + PTY (today) | Terminal window over VNC (B or C) |
|---|---|---|
| Text | Real text: crisp at any DPI, selectable, searchable, copy with the browser's own clipboard, screen-reader-able | Pixels: blurry when scaled, selection/copy only through VNC clipboard sync, no find |
| Bandwidth / CPU | Bytes of terminal output (KB/s) | Framebuffer diffs, JPEG/PNG tiles (100 KB–MB/s while scrolling); x11vnc polling costs CPU in the box permanently |
| Latency | One WebSocket hop, typing echoes immediately | Encode + decode per keystroke, visible lag on `less`/vim |
| Resize | Client tells PTY the cols×rows, apps reflow | Xvnc resizes the screen, then a WM must re-maximise the terminal, then the terminal re-derives cols×rows |
| Keyboard | Browser shortcuts handled per key by us | noVNC captures everything; Ctrl+W/Ctrl+T conflicts (same as the Desktop pane today) |
| Persistence | Daemon keeps the PTY + scrollback across reloads (done) | Same (the X app survives client disconnects) |
| Extra processes in the box | none | Xvnc + WM + terminal + websockify per pane |
| What you gain | — | Identical rendering to a "real" terminal emulator (font ligatures, sixel/kitty graphics, GUI popups from TUI apps that spawn windows) |

The one thing a pixel terminal gives (bitmap-exact rendering, image protocols) is not something Sessionboxer needs;
xterm.js already runs TUIs (vim, htop, lazygit, Claude Code's own TUI) correctly. **Recommendation: keep xterm.js.**
If the motivation was the Terminal pane sharing the box's *Desktop* session, note it does not: it is a PTY on the
Daemon, separate from `:1`, so it is already independent of the desktop.

## VS Code inside the box

Three ways to show VS Code from the box, all possible:

1. **VS Code desktop (Electron) on its own `Xvnc :2`, streamed as pixels** (option B above). Works, but: ~600 MB
   image growth + 500–800 MB RAM per session while open, GPU-less Electron rendering is slow under VNC (large
   dirty regions on every scroll), text is blurry when the pane is scaled, and the browser eats Ctrl+W/Ctrl+N/
   Ctrl+T/Ctrl+Shift+P style shortcuts before noVNC sees them, which is exactly what an editor lives on. Clipboard
   is VNC-mediated. Not recommended.

2. **VS Code as a web app served from the box: `openvscode-server` (Gitpod, MIT) or `code-server` (Coder, MIT)**.
   Same VS Code UI, but rendered natively by the user's browser: crisp text, native clipboard and keyboard handling,
   all VS Code features (integrated terminal, git view, extensions from Open VSX, diff viewer, search). The
   Control Plane already proxies HTTP+WebSocket to the Daemon port (`/api/sessions/:id/…`), so the pane is an
   `<iframe src="/api/sessions/:id/code/…">` and the Daemon starts `openvscode-server --host 127.0.0.1 --port
   3100 --server-base-path /api/sessions/<id>/code/ --connection-token <random> --default-folder /workspace` on
   demand. Facts checked:
   - `openvscode-server` supports a URL path prefix since v1.97 (`--server-base-path`, issue #603), so it can
     live under our per-session path without a subdomain; `code-server` has done relative paths for years.
   - Access: `--connection-token` (query/cookie) or `--without-connection-token` behind our localhost-only proxy.
   - Iframes: same-origin here (our own origin proxies it), so the clipboard restrictions people hit are the
     cross-origin case; add `allow="clipboard-read; clipboard-write"` anyway. Some browser shortcuts (Ctrl+W,
     Ctrl+T) are still taken by the browser, as in vscode.dev.
   - **Anthropic's Claude Code extension is published on Open VSX**, so it installs into openvscode-server/code-
     server; it runs its own `claude` CLI, so with `CLAUDE_CODE_OAUTH_TOKEN` in the box you would get the Claude
     Code panel inside the IDE too (a second, independent agent instance in the same box, not our ACP one).
   - Cost: ~150 MB download (tarball, Node included), ~150–300 MB RAM while the pane is open; start ~1–2 s;
     idle when nobody has the pane open (Daemon can stop it after N minutes).
   - Your Monaco editor + file tree pane would be superseded by this; the "follow the agent's edits live" behaviour
     comes for free (VS Code watches the filesystem) and Save is VS Code's.
   - Version drift: both track upstream VS Code within days; extension host is the same as desktop, but the
     Microsoft Marketplace is not usable (Open VSX only, licence terms), so extensions missing from Open VSX need a
     `.vsix`.

3. **VS Code Remote Tunnels** (`code tunnel` in the box, open in the user's own VS Code / vscode.dev): needs a
   GitHub/Microsoft login and routes through Microsoft's relay, so it breaks the local-only promise. Skip.

**Recommendation: option 2.** It is the standard way every cloud IDE (Gitpod, Codespaces, Coder, Devin's IDE)
ships VS Code in a browser, and it fits the existing proxy without any VNC work.

## If you still want per-window VNC panes (for other GUI apps)

The pattern to build is B: a Daemon RPC `_sessionboxer/window/open { command, cols?, rows? }` that starts
`Xvnc :N -geometry WxH -SecurityTypes None -localhost -rfbport 59NN` + a one-window WM (`matchbox-window-manager`
or a 20-line `xdotool` resize loop) + the command, and a websockify on a port the Control Plane proxies like the
desktop; the web pane is `Desktop.tsx` with `resizeSession = true`. Each pane is its own display, so the agent's
screenshots and clicks on `:1` never touch it. That is a generic "run any GUI app in a tab the agent can't see"
feature (e.g. a private browser for you to log in to sites, gitk, a database GUI); half a session plus an image
rebuild. Alternatively Xpra if you want many detached windows per display.

## Sources

- x11vnc FAQ Q-26/Q-27 (single-window `-id`/`-sid`, missing transient windows, `-appshare`):
  https://github.com/LibVNC/x11vnc/blob/master/doc/FAQ.md
- TigerVNC `Xvnc` man page (`-AcceptSetDesktopSize`, default on): https://tigervnc.org/doc/Xvnc.html
- noVNC client-initiated resize via ExtendedDesktopSize/SetDesktopSize (`RFB.resizeSession`):
  https://github.com/kanaka/noVNC/pull/271, https://github.com/novnc/noVNC/blob/master/docs/API.md
- Xpra seamless mode and HTML5 client: https://github.com/Xpra-org/xpra/blob/master/docs/Usage/Seamless.md,
  https://github.com/Xpra-org/xpra-html5
- openvscode-server: README (`--connection-token`, `--host`, extensions from Open VSX),
  `--server-base-path` since v1.97 (https://github.com/gitpod-io/openvscode-server/issues/603)
- code-server iframe/clipboard history: https://github.com/coder/code-server/issues/1509 (Chrome ≥85 needs
  `clipboard-read`/`clipboard-write` in `allow` for cross-origin frames)
- Claude Code extension available on Open VSX and in VS Code forks: https://code.claude.com/docs/en/vs-code
