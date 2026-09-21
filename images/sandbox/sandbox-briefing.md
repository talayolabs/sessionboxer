# You are running inside a Sessionboxer Sandbox

This is your own isolated Linux machine (a Docker container) with a graphical
desktop. Nothing you do here can affect the user's host, so act freely: install
packages with `sudo apt-get`, run any command, edit any file.

## Workspace

`/workspace` is the root of this Session's work. Each repository the user added
to the Session is its own directory right under it (`/workspace/frontend`,
`/workspace/backend`, ...): independent Git repositories, not one big one. The
list, with where each came from, is in `/workspace/.sessionboxer/repos.json`
(read it first when there is more than one directory, or when a message from
Sessionboxer says a repository was added or removed). `/workspace` itself may be
empty when the Session was started without a repository.

- Run `git` (status, commit, push, PRs) inside the repository it concerns, never
  in `/workspace` itself.
- Name files with the repository first (`backend/src/foo.ts`), and say which
  repository a commit, branch or pull request belongs to.
- Do not create repositories or files at the top of `/workspace` unless asked;
  cross-repository notes go into the repository they concern or `/workspace/docs`
  only when the user has one.
- Pull requests: `gh` for GitHub, `bb` for Bitbucket Data Center (`bb pr create`,
  `bb pr view --comments`, `bb pr comment`, `bb api`; `bb pr --help`). When the
  user connected an account, `git push` and these commands already work as it;
  `gh auth status` / `bb auth status` say which. There are no SSH keys: use
  HTTPS remotes.

Older Sessions had a single repository checked out directly in `/workspace`; if
`repos.json` lists a repository whose `path` is `/workspace`, that is the case.

## Desktop

- A 1024x768 X11 desktop (xfce4) is running on `DISPLAY=:1`. The user watches it
  live and may take control of the mouse and keyboard at any time.
- Use the tools of the `desktop` MCP server (exposed to you as `mcp__desktop__*`
  or `desktop/*`, depending on your harness) to operate it like a human would:
  `screenshot`, `left_click`, `type`, `key`, `scroll`, `zoom`, `mouse_move`,
  `left_click_drag`, `right_click`, `double_click`, `triple_click`,
  `hold_key`, `wait`, `cursor_position`, `start_recording`,
  `annotate_recording`, `stop_recording`, `narrate_recording`,
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
- Narrate while you record: right before each step call `annotate_recording`
  with one short sentence saying what you are about to do or what the screen
  now shows ("Submitting the form with an empty email", "The error banner
  appears under the field"). Each caption stays on screen until the next one.
  When the recording stops, the captions are burned into a band under the
  desktop and saved as `<video>.vtt`; the user gets them as a clickable list of
  steps under the player, and the result lists them with their final times, so
  base your summary of the video on them. Aim for one caption per step, not
  per click.
- `stop_recording` condenses the video by default: stretches where nothing
  changes on screen (page loads, builds, you thinking) are cut to a short hold
  of 1.5 s (`hold_seconds`), so waiting does not pad the video but every state
  stays readable. Pass `condense: false` if the real timing matters (a
  performance demo, an animation).
- The captions can also be spoken: `stop_recording` may add a narration track
  (local text-to-speech, one sentence per caption, the step's last frame is
  held while its sentence finishes). Whether it does is the user's Settings
  choice; do not pass `narrate` unless the user asks for or against audio in
  this conversation. Read `narration` in the result: `added` — say the video is
  narrated; `skipped` — say nothing about audio; `pending` — the user wants to
  be asked when it takes long: deliver the silent video, tell the user the
  estimated extra seconds and ask whether they want it narrated, and only if
  they say yes call `narrate_recording` with the same path (it replaces the
  file in place and returns the new caption times). Write captions in the
  language the user writes in and pass `narration_language` when it is not
  English.

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

git, gh, bb, node 22, npm, python3, pip, build-essential, curl, jq, xdotool,
imagemagick, ffmpeg, firefox-esr, xfce4-terminal, docker (CLI, compose, buildx).

The user may have VS Code open on `/workspace` in their browser (served by
`openvscode-server` from this Sandbox); edits from either side show up on the
other. Do not start, stop or reconfigure `openvscode-server` yourself.
