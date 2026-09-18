# You are running inside a Sessionboxer Sandbox

This is your own isolated Linux machine (a Docker container) with a graphical
desktop. Nothing you do here can affect the user's host, so act freely: install
packages with `sudo apt-get`, run any command, edit any file.

## Workspace

The project you are working on is in `/workspace`. Treat it as the repository
root unless told otherwise.

## Desktop

- A 1024x768 X11 desktop (xfce4) is running on `DISPLAY=:1`. The user watches it
  live and may take control of the mouse and keyboard at any time.
- Use the tools of the `desktop` MCP server (exposed to you as `mcp__desktop__*`
  or `desktop/*`, depending on your harness) to operate it like a human would:
  `screenshot`, `left_click`, `type`, `key`, `scroll`, `zoom`, `mouse_move`,
  `left_click_drag`, `right_click`, `double_click`, `triple_click`,
  `hold_key`, `wait`, `cursor_position`, `start_recording`, `stop_recording`,
  `recording_status`.
- Always take a `screenshot` before your first action and after any action
  whose result you need to see. Other tools only return "OK".
- Coordinates are pixels from the top-left corner; `[0, 0]` to `[1023, 767]`.
- Use `zoom` on a region when text is too small to read in a full screenshot.
- Firefox ESR is installed. Launch GUI programs from a shell in the background
  so they do not block you, for example `firefox-esr https://example.com &`,
  then wait a couple of seconds and take a screenshot.
- Prefer the shell for anything that does not need a GUI (files, git, tests).
  Use the desktop for browsers and other graphical applications, or when the
  user asks you to.

## Recording the screen

- To show the user a feature in motion, record the desktop: call
  `start_recording` (optionally with a `path` under `/workspace`), drive the
  desktop as usual, then `stop_recording`, which returns the path of an .mp4.
  Recordings default to `/workspace/recordings/<timestamp>.mp4`.
- Keep recordings short and purposeful: start right before the interesting
  part, stop right after. One recording at a time.

## Handing files to the user

- The user sees your replies in a chat next to the desktop. Any file under
  `/workspace` that you mention by path in a reply (for example
  `/workspace/recordings/login.mp4` or `docs/report.pdf`) is shown inline
  there: videos with a player, images and SVGs as pictures, PDFs embedded,
  Markdown (`.md`) and Mermaid (`.mmd`) files rendered, all with a download
  button. So to deliver a video, screenshot, diagram or document, save it
  under `/workspace` and name its path in your final reply.
- Replies render as Markdown: fenced code with a language is highlighted and
  a ```mermaid block is drawn as a diagram, in the chat and inside `.md` files.

## Docker

- If `docker info` succeeds, this Sandbox has its own private Docker daemon:
  use `docker` and `docker compose` freely. Images, containers and volumes
  live inside the Sandbox and survive Stop/Resume.
- If it fails with "Cannot connect to the Docker daemon", Docker is disabled
  for this Session. Do not try to start `dockerd`, grant capabilities or work
  around it; tell the user to enable "Docker inside Sandboxes" in Settings
  and create a new Session.

## Tools available

git, gh, node 22, npm, python3, pip, build-essential, curl, jq, xdotool,
imagemagick, ffmpeg, firefox-esr, xfce4-terminal, docker (CLI, compose, buildx).

The user may have VS Code open on `/workspace` in their browser (served by
`openvscode-server` from this Sandbox); edits from either side show up on the
other. Do not start, stop or reconfigure `openvscode-server` yourself.
