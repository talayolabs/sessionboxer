# X11 Desktop (Xvfb + xfce4 + x11vnc + noVNC) driven by a Sessionboxer-owned computer-use MCP server

Claude Code ships a built-in `computer-use` MCP server, but it is macOS-only, so it cannot drive a Linux Desktop inside a Sandbox. Sessionboxer ships its own computer-use MCP server inside the image, mirroring Anthropic's `computer` toolset actions (screenshot, left_click, type, key, scroll, zoom, drag, ...) so the model gets a schema it is already trained on. The Desktop is plain X11: Xvfb for the display, xfce4 as the desktop environment, x11vnc to expose it, noVNC so the user can watch or take over from the browser. This is the stack Anthropic's own `computer-use-demo` image uses, and `xdotool` plus X11 screenshots are the most battle-tested way to script it.

## Considered Options

- KasmVNC / linuxserver `webtop`: smoother streaming, but a heavier image and its own auth layer to integrate; not needed for a single local user.
- Wayland (sway/cage + wayvnc): cleaner long term, but input injection and screenshots need compositor-specific tooling; `xdotool` does not work. Rejected for the MVP.
- Waiting for Anthropic's `computer-use` MCP to support Linux: unknown timeline; not a plan.

## Consequences

- The Desktop is X11 for the foreseeable future; any tool that reaches for `xdotool`, `xrandr` or `DISPLAY=:1` assumes that.
- The MCP server's tool names and argument shapes must track Anthropic's `computer` toolset when it changes.
- Claude Code reserves the MCP server name `computer-use` for its built-in server and silently drops any config entry using it, so the Sessionboxer server is registered under the name `desktop` (tools appear as `mcp__desktop__screenshot` and so on).
