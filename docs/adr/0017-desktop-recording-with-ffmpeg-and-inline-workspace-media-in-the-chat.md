# Desktop recording with ffmpeg, and Workspace media files shown inline in the chat

Users want to ask the agent for a video of a feature ("record the login flow") and watch it in the Session UI with one click, and more generally to receive files the agent produces (videos first; PDFs, images, SVG, later maybe Mermaid) embedded rather than as paths to copy out of the box. Two problems: how the agent records the Sandbox desktop, and how bytes that live inside the container reach the browser as something playable.

## Considered Options

### Recording

- **`ffmpeg` with `x11grab` on the Sandbox's Xvfb display (chosen)**, driven by `start_recording` / `stop_recording` / `recording_status` tools on the built-in desktop MCP. H.264 (`libx264`, `yuv420p`, `veryfast`, CRF 23, `+faststart`) so every browser plays it and can seek immediately; 15 fps default (1–30). Output under `/workspace` only (`recordings/<timestamp>.mp4` by default; anything else is refused), one recording at a time. ffmpeg is spawned detached with its PID, path and start time in `/dev/shm/sessionboxer/recording.json`, because the MCP process is restarted whenever the agent restarts (MCP toggles, model allowlist changes) and the recording must survive that and still be stoppable; `stop_recording` sends SIGINT so ffmpeg writes the moov atom, waits up to 20 s, SIGKILLs as a last resort, and returns path, duration and size. A recording that dies within the first 700 ms (bad display, unwritable path) is reported as a start error with ffmpeg's stderr.
- A separate recording MCP or a Daemon RPC (rejected): the desktop MCP already knows the display and is the tool the agent uses to drive what it records; one tool list to learn.
- Recording from the Control Plane over VNC (rejected): lossy, host CPU, and the agent could not start/stop it by itself.
- GIF or WebM/VP9 (rejected): GIF is huge and has no seeking; VP9 encodes far slower in software than x264 for a live screen grab.

### Getting the file to the browser

- **A raw-file HTTP endpoint on the Daemon, proxied by the Control Plane (chosen)**: `GET|HEAD /fs/raw?path=<workspace-relative>[&download=1]` on the Daemon's existing port `7000` (the WebSocket JSON-RPC server now hangs off a plain `http.Server`), reached from the browser as `GET /api/sessions/:id/fs/raw?path=…`. The Daemon resolves the path through the same containment check as the Files pane (lexical + realpath, so symlinks pointing out of `/workspace` are 403), sets the content type from the extension, honours `Range` (206 / 416, needed for `<video>` seeking and for Chrome's metadata probe) and `Content-Disposition: inline|attachment`. The Control Plane forwards the request with its `Range` and passes through the content headers; it refuses when the Sandbox is not running (409), which the UI turns into "Resume the Session to view it". Sandboxes still publish no host ports (ADR-0005).
- Base64 through the existing `fs/read` JSON-RPC (rejected): the 2 MB editor cap, no streaming, no seeking, and a 50 MB video would be held three times in memory.
- Copying files out to the host for a static server (rejected): copies, staleness, and a second place to clean up.

### How the chat knows what to embed

- **Scan the agent's reply for Workspace paths with a media extension (chosen)**: `/workspace/recordings/demo.mp4`, `./out/report.pdf`, `docs/chart.svg`, in prose, backticks or Markdown links; URLs, absolute paths outside `/workspace` and anything with `..` are ignored. Each distinct path becomes a card under the message: name, size (from a `HEAD`), **Open** and **Download**, and the media itself (`<video controls>`, `<audio>`, `<img>`, `<iframe>` for PDF). Markdown links and images that point at Workspace files are rewritten to the raw endpoint too. The Sandbox briefing tells the agent that naming a file under `/workspace` in its reply is how to hand it to the user, so no special syntax or tool call is needed and it works for Claude and Devin alike.
- A dedicated "deliver file" MCP tool or ACP resource links (rejected for now): more protocol, and agents already write paths in prose; can be added on top if false positives become a problem (a mentioned file that does not exist shows as "not found" and nothing else).
- The supported set is a table in the protocol package (`mediaKind` / `contentTypeFor`): video (mp4, m4v, webm, mov), audio (mp3, wav, ogg, m4a), image (png, jpg, jpeg, gif, webp, svg), pdf. Mermaid is not a file the browser renders natively and is left for later (it would be a `.mmd` → client-side render).

## Consequences

- Image: `ffmpeg` added (apt); briefing gains "Recording the screen" and "Handing files to the user". Rebuild required.
- `computer-use-mcp`: `recording.ts` + three tools; state and log on tmpfs so Snapshots never contain them.
- Protocol: `FS_RAW_PATH`, `MediaKind`, `MEDIA_EXTENSIONS`, `mediaKind()`, `contentTypeFor()`.
- Daemon: `raw-files.ts` (`serveRawFile`, range parsing), `WorkspaceFs.raw()`, HTTP server shared with the WebSocket server. Sessions on an older Daemon get 404 from the raw route until Stop → Resume (the Control Plane copies the current Daemon into the box on every start).
- Control Plane: `SessionManager.daemonHttpUrl()`, `GET|HEAD /api/sessions/:id/fs/raw` streaming proxy.
- Web: `attachment-paths.ts` (`findAttachments`, `workspacePath`, `rawFileUrl`), `Attachments.tsx` (`AttachmentCard`, `AttachmentList`, `AttachmentSession` context), `Markdown` embeds for agent messages only (user prompts and thoughts are rendered without cards), Files pane shows the same card for media files instead of "Binary file".
- Not done: thumbnails/posters generated in the box, Mermaid rendering, transcoding of formats browsers cannot play (a `.mov` with ProRes will show a broken player; ffmpeg is there for the agent to convert), a size cap on embeds (a 2 GB video is streamed on demand, so it is only a bandwidth concern).
