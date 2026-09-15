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
- Use the `computer-use` MCP tools to operate it like a human would:
  `screenshot`, `left_click`, `type`, `key`, `scroll`, `zoom`, `mouse_move`,
  `left_click_drag`, `right_click`, `double_click`, `triple_click`,
  `hold_key`, `wait`, `cursor_position`.
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

## Tools available

git, gh, node 22, npm, python3, pip, build-essential, curl, jq, xdotool,
imagemagick, firefox-esr, xfce4-terminal.
