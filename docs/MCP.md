# The built-in MCP servers: every tool of `desktop` and `sessionboxer`

Every session's agent gets two MCP servers from Sessionboxer itself, next to the ones you add in Global settings: **`desktop`**, which sees and drives the box's screen, and **`sessionboxer`**, which tells the agent which session it is and lets it act on Sessionboxer. Both are always on (Advanced… → MCP & connectors shows them as switches you cannot turn off; only the `sessionboxer` *policy* changes). This page lists each tool as the agent sees it: the exact name, every parameter with its accepted values and defaults, what comes back, and what happens on the Sessionboxer side. The sources are `packages/computer-use-mcp` and `packages/sessionboxer-mcp` in the repository; the [user guide](GUIDE.md) says how the same things look from the UI.

Conventions: parameters marked *required* have no default. Sizes are in characters. A tool that fails (a parameter out of range, a policy that forbids it, a session that does not exist) returns an MCP tool error whose text says why, so the agent can tell you rather than guess.

## Where the servers run

Both servers are stdio MCP processes inside the **Linux box** of the session (the Sandbox container). The agent's MCP configuration (`.mcp.json` for Claude Code, the equivalent for Codex, Cursor and Devin) lists them under the names `desktop` and `sessionboxer`.

| Environment | Agent, repositories, your MCP servers | `desktop` | `sessionboxer` |
| --- | --- | --- | --- |
| **Docker · Linux** | In the box (`/workspace`) | The box's own X display, 1024×768 by default (`SESSIONBOXER_DISPLAY_WIDTH` / `_HEIGHT`) | In the box; talks to the box's daemon |
| **QEMU · Windows** | In the Windows VM (`C:\workspace`), agent started over SSH | Still in the Linux box: the display shows the VM's desktop full screen over RDP, and the tools act on that picture. The agent in the VM reaches the server through a bridge command the daemon installs | Same bridge; the daemon and the Control Plane connection are on the Linux side |
| **QEMU · macOS** | In the macOS VM (`/Users/agent/workspace`), agent started over SSH | As Windows, over VNC | Same |

What this means for a Windows or macOS session: screenshots are of the remote-desktop stream, full screen at the display's size (the guest runs at 1024×768 too), typing is paced at 40 ms per key (`SESSIONBOXER_TYPE_DELAY_MS`, 12 ms on Linux) because RDP and VNC drop keys at xdotool's default pace, and a few combinations may be kept by the viewer instead of reaching the guest (Win-key shortcuts over RDP; on macOS ⌘ is `super` and most combinations pass, Spotlight is the fallback). The agent's briefing says so and tells it to open programs from the Start menu or Spotlight. Recordings are of the same display, so they work unchanged; their paths are Linux paths under `/workspace`, which the daemon mirrors into the guest's Workspace so the file shows up for the agent and in the chat.

## The `desktop` server

The desktop MCP mirrors Anthropic's computer-use tool set, implemented with xdotool and ffmpeg on the box's X display. Coordinates are integer pixels, `[x, y]`, origin at the top-left of the screen; the `screenshot` tool's description tells the agent the screen size. Every tool that moves the pointer to a target *glides* there (an eased motion of 100–300 ms, about 120 positions a second) so hover effects and drag-and-drop see a moving pointer; `SESSIONBOXER_MOUSE_GLIDE=0` in the server's environment makes it jump. While a recording runs, the pointer and the keys move at a hand's pace instead — glides of 350–700 ms, about 30 keys a second — so the video shows the pointer travel and the text arrive letter by letter rather than in blocks; without a recording the agent works at full speed. The video does not carry X's small pointer: when the recording stops, a large white arrow is drawn along the path the pointer took — smaller while a button is down, so clicks and drags show — with the Sessionboxer badge at the top-right corner (ADR-0072).

Tools that act (move, click, type, scroll…) return the text `OK`; `screenshot`, `zoom` and `wait` return a PNG image; the recording tools return JSON.

| Tool | Does |
| --- | --- |
| [`screenshot`](#screenshot) | Picture of the whole screen |
| [`zoom`](#zoom) | Picture of a region, scaled up |
| [`cursor_position`](#cursor_position) | Where the pointer is |
| [`mouse_move`](#mouse_move) | Move the pointer |
| [`left_click`](#left_click-right_click-middle_click-double_click-triple_click), `right_click`, `middle_click`, `double_click`, `triple_click` | Click |
| [`left_click_drag`](#left_click_drag) | Drag from one point to another |
| [`left_mouse_down`](#left_mouse_down-left_mouse_up), `left_mouse_up` | Press and release separately |
| [`type`](#type) | Type text |
| [`key`](#key) | Press keys and combinations |
| [`hold_key`](#hold_key) | Hold a key for a while |
| [`scroll`](#scroll) | Wheel scrolling |
| [`wait`](#wait) | Pause, then a screenshot |
| [`start_recording`](#start_recording) | Begin an .mp4 recording of the screen |
| [`annotate_recording`](#annotate_recording) | Caption the running recording |
| [`stop_recording`](#stop_recording) | Finish the video: condense, captions, narration |
| [`narrate_recording`](#narrate_recording) | Add spoken narration to a finished video |
| [`recording_status`](#recording_status) | Is a recording running |

### Seeing the screen

#### `screenshot`

Take a screenshot of the whole desktop. The agent is told to call it before acting and after any action whose result it needs to see, since the other tools only answer `OK`.

No parameters. Returns a PNG of the full screen.

#### `zoom`

Capture a rectangular region and scale it up to the full screen size, to read small text or inspect a detail. Coordinates the agent sees in the zoomed image are not screen coordinates; it maps them back through the region.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `region` | `[x0, y0, x1, y1]`, integers, *required* | Top-left and bottom-right corners, in screen coordinates |

Returns a PNG.

#### `cursor_position`

No parameters. Returns `{ "x": …, "y": … }`, the pointer's current position.

### Mouse

#### `mouse_move`

Move the pointer to a coordinate without clicking.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `coordinate` | `[x, y]`, integers, *required* | Where to go |

#### `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`

Click the left, right or middle button; double-click; triple-click (selects a line or paragraph in most programs). All five take the same parameter.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `coordinate` | `[x, y]`, integers, optional | Where to click; omitted = click where the pointer already is |

#### `left_click_drag`

Press the left button at `start_coordinate`, move to `coordinate`, release. The move between the two is a glide, so drop targets that watch the pointer travel see it.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `start_coordinate` | `[x, y]`, integers, *required* | Where the button goes down |
| `coordinate` | `[x, y]`, integers, *required* | Where it is released |

#### `left_mouse_down`, `left_mouse_up`

Press and hold the left button, and release it, as two calls, for drags that need something in between (a `mouse_move` through several points, a `key` while dragging). Both take the optional `coordinate` of the click tools: the pointer moves there first.

### Keyboard

#### `type`

Type a string at the current focus, as a keyboard would. For shortcuts and special keys the agent uses `key`.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `text` | string, at least 1 character, *required* | What to type |

Typed in chunks of 50 characters with a pause between keys (12 ms on a Linux desktop, 40 ms on a Windows or macOS one; about 32 ms while a recording runs, one key per frame at 30 fps).

#### `key`

Press a key or a combination, named the way xdotool names them: `Return`, `Escape`, `Tab`, `BackSpace`, `Delete`, `Home`, `End`, `Page_Down`, `Up`, `F5`, `ctrl+s`, `alt+Tab`, `super`, `ctrl+shift+t`. Several presses in a row are separated by spaces (`"ctrl+a Delete"`).

| Parameter | Type | Meaning |
| --- | --- | --- |
| `text` | string, at least 1 character, *required* | The key or combination(s) |

#### `hold_key`

Hold a key or combination down for a number of seconds, then release it (for a program that reacts to a long press, or to keep a modifier down during another action).

| Parameter | Type | Meaning |
| --- | --- | --- |
| `text` | string, *required* | The key or combination, xdotool names |
| `duration` | number > 0, at most 30, *required* | Seconds to hold |

### Scrolling and waiting

#### `scroll`

Scroll the mouse wheel at a coordinate.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `coordinate` | `[x, y]`, integers, optional | Where to scroll; omitted = where the pointer is |
| `scroll_direction` | `up` · `down` · `left` · `right`, *required* | Which way |
| `scroll_amount` | integer 1–50, default 3 | Wheel clicks |

#### `wait`

Wait for a page to load or an animation to finish, then take a screenshot.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `duration` | number > 0, at most 60, default 2 | Seconds to wait |

Returns a PNG of the screen after the wait.

### Recording

A recording is ffmpeg grabbing the display into an H.264 `.mp4` (yuv420p, faststart, so browsers play it). It runs detached from the MCP process and its state lives in a file on the box's tmpfs, so **one recording runs at a time** per session and a `stop_recording` from a later turn still finds it. The lifecycle the agent follows: `start_recording` → (`annotate_recording`, then the step, repeated) → `stop_recording` → mention the returned path in the reply, and the chat shows a player with the captions as clickable steps. Auto QA runs use the same tools and hand the path to `e2e_finish`.

#### `start_recording`

Start recording the desktop until `stop_recording`. Fails when a recording is already running.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `path` | string, optional | Output file, **under `/workspace`** and **ending in `.mp4`**; default `recordings/<timestamp>.mp4` (relative paths resolve against `/workspace`). Anything else is refused |
| `fps` | integer 1–60, default 30 | Frames per second; 30 shows the pointer travel and typing smoothly (~15 % of one core at 1024×768), 60 for animations |

Returns `{ path, startedAt, seconds: 0, captions: 0 }`.

#### `annotate_recording`

Add a caption to the running recording at this moment: one short sentence saying what the agent is about to do or what the screen now shows ("Submitting the form with an empty email"). Each caption stays on screen until the next one. The agent calls it right before each step.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `text` | string, 1–300 characters, *required* | The caption |

Returns the caption with its time from the start of the recording (`{ at, text, path }`). Fails when nothing is recording.

#### `stop_recording`

Stop the recording and finish the video. In order: the pointer (the large arrow, small while a button is down) and the Sessionboxer badge are drawn into the frames; the captions are burned into a band added **under** the desktop (nothing on screen is covered; the band fits about three lines and grows upwards for a longer caption); static stretches are condensed; the `.vtt` is written with the re-timed captions; narration is added when it applies. The tool result reports the recorded and the final length.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `condense` | boolean, default `true` | Cut every stretch where nothing changes on screen (a page loading, a build, the agent thinking) down to a hold of `hold_seconds`, so waiting does not pad the video while each state stays on screen long enough to read. Motion plays at real speed. `false` keeps the real timing, for animations or performance demos |
| `hold_seconds` | number 0.5–10, default 1.5 | How long a static stretch stays after condensing |
| `captions` | `both` · `burn` · `track` · `none`, default `both` | Burn the captions into the frames, write them as a WebVTT file next to the video (`demo.vtt` beside `demo.mp4`, which the chat's player offers as a subtitle track), both, or drop them |
| `narrate` | boolean, optional | Force narration on or off for this video (because you just asked for it, say); omitted = follow **Global settings → MCP & connectors → desktop → Narrate recordings** |
| `narration_language` | `en` · `en-gb` · `es` · `fr` · `hi` · `it` · `pt`, optional (default `en`) | The language the captions are written in; picks the default voice for it unless `narration_voice` is given |
| `narration_voice` | a Kokoro voice name, optional | The first letter is the language (`a` en-US, `b` en-GB, `e` es, `f` fr, `h` hi, `i` it, `p` pt-BR), the second `f`/`m`. Accepted: `af_alloy` `af_aoede` `af_bella` `af_heart` `af_jessica` `af_kore` `af_nicole` `af_nova` `af_river` `af_sarah` `af_sky` `am_adam` `am_echo` `am_eric` `am_fenrir` `am_liam` `am_michael` `am_onyx` `am_puck` `am_santa` `bf_alice` `bf_emma` `bf_isabella` `bf_lily` `bm_daniel` `bm_fable` `bm_george` `bm_lewis` `ef_dora` `em_alex` `em_santa` `ff_siwis` `hf_alpha` `hf_beta` `hm_omega` `hm_psi` `if_sara` `im_nicola` `pf_dora` `pm_alex` `pm_santa`. Defaults per language: `af_heart`, `bf_emma`, `ef_dora`, `ff_siwis`, `hf_alpha`, `if_sara`, `pf_dora` |
| `narration_speed` | number 0.7–1.5, default 1 | Speaking rate |

Returns JSON:

```
{
  path, startedAt,
  recordedSeconds,      // wall-clock length of the recording
  seconds,              // length of the finished video
  condensed,            // whether static stretches were cut
  bytes,
  captions: [{ at, text }],   // with their times in the finished video
  track,                // the .vtt path, when one was written
  narration,            // see below; absent when there were no captions
  warning               // what did not happen as asked; the video is still usable
}
```

`narration` is one of:

- `{ added: true, language, voice, speechSeconds, processingSeconds }`: the captions were spoken (Kokoro, a text-to-speech model inside the box; nothing leaves the machine) and muxed in as an audio track. A step shorter than its sentence holds its last frame until the sentence ends, so the video may grow a little; `captions` and the `.vtt` carry the new times.
- `{ pending: true, estimatedSeconds, language, voice, nextStep }`: the setting is *Ask when it takes longer than N seconds* (the default, N = 5) and this video is above it. The silent video is delivered and the agent is told to ask you first, then call `narrate_recording` if you want it.
- `{ skipped: "…" }`: the setting is *Never*, `narrate: false` was passed, or the TTS model is not in the image.

Fails when nothing is recording.

#### `narrate_recording`

Add spoken narration to a finished recording: after a `pending` answer and your yes, or when you ask for narration later. Rewrites the `.mp4` in place with the audio track (extending short steps as above) and returns the same shape as `stop_recording` minus the recording-time fields, with the re-timed captions and `.vtt`.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `path` | string, *required* | The recording's path, as `stop_recording` returned it |
| `narration_language`, `narration_voice`, `narration_speed` | as in `stop_recording` | |

#### `recording_status`

No parameters. Returns `{ path, startedAt, seconds, captions }` for the running recording, or `{ "recording": false }`.

## The `sessionboxer` server

### How a call travels, and what the agent knows without asking

The box has no route to Sessionboxer's API and no token. The `sessionboxer` MCP posts each call to the box's own daemon (`POST http://127.0.0.1:7000/sessionboxer`; the Auto QA tools use `/e2e`), the daemon forwards it over the WebSocket the Control Plane already holds to the box, and the Control Plane, which knows from that socket which session is talking, applies the session's policy, performs the action and answers. A box can only ever speak for its own session; the agent cannot claim to be another one. When the box's daemon is unreachable the tool error says so.

Before any tool call the agent already knows where it is: its briefing opens with the session's name and environment, and `.sessionboxer/session.json` in the Workspace (`/workspace`, `C:\workspace` or `/Users/agent/workspace`) holds the id, title, URL, provider, model, environment, guest OS, creation time, what it was forked from, which session's agent created it, the conversation branch, the snapshot count, the Sessionboxer version and the policy in force, kept current by the box.

Results are JSON text. Every action that changes something (a PR attached, a snapshot, a rename, a queued prompt, a verification run, a notification, a pane opened, a session created, forked, messaged or stopped, a schedule) is also written into the transcript as a small **marker at the point where it happened** ("attached PR #12 (owner/repo)", "took Snapshot 3", "sent a message to Backend tests"), so the chat says what the agent did.

### Policy, approval and limits

Two settings decide what the agent may do: the default in **Global settings → MCP & connectors → sessionboxer** and the session's own value in **Advanced… / Session settings → MCP & connectors**. A change applies to the running agent at its next turn.

| Policy | The agent gets |
| --- | --- |
| **Off** | No `sessionboxer` server at all (the briefing and `session.json` remain). Every call errors with "the sessionboxer tools are off for this Session" |
| **This Session only** | The self-knowledge tools, the tools on its own session (PRs, snapshot, queue, title, verify, notify, terminals, `ui_open`), `session_fork` of itself, `approval_wait`, automations that prompt itself (or attach / notify), and the Auto QA tools. A cross-session tool errors with the reason and where you can allow it |
| **All Sessions** (the default for new installs) | Everything, including `sessions_list`, `session_get`, `session_create`, `session_message`, `session_wait`, `session_stop` and automations that prompt other sessions or start Sessions |

**When the Agent creates a Session** (same place): *Ask me* (default) or *Do not ask*. With *Ask me*, `session_create` returns `{ pending: true, id, summary, expiresAt, hint }` and a card appears in your chat ("Claude Code wants to create a Session 'Backend tests'") with **Allow** and **Deny**; the agent waits with `approval_wait`. A card nobody answers in **10 minutes** expires and counts as denied. Settled cards stay in the transcript with a link to the session they created.

Limits that hold whatever the policy: at most **3 alive sessions created by one agent** at a time (stopped ones do not count; `session_stop` frees a place) and a global cap on agent-created sessions (**Global settings → MCP & connectors → sessionboxer**, 10 by default); a chain of agents prompting agents stops after **4 hops**; **one message in flight** per sender and target (wait for the reply first); a session cannot message itself; `session_stop` only stops sessions the calling agent created. Sessions an agent created show *child of …* under their name in the sidebar and in `sessions_list`.

The wait tools (`session_wait`, `approval_wait`) block for at most **20 s** per call (default 15) because the bridge itself times out at 20 s; the agent calls them again while the answer is still pending.

| Tool | Does | Policy |
| --- | --- | --- |
| [`whoami`](#whoami) | Everything about this session | session |
| [`docs`](#docs) | Look a topic up in the user guide | session |
| [`settings_get`](#settings_get) | The settings in force, secrets removed | session |
| [`pr_attach`](#pr_attach) | Attach a pull request to the session | session |
| [`pr_list`](#pr_list) | The attached PRs | session |
| [`pr_follow`](#pr_follow) | Follow a repository's, your own or requested PRs | all |
| [`pr_followed_list`](#pr_followed_list) | The follows and followed PRs | all |
| [`pr_items`](#pr_items) | A PR's review comments and checks | session |
| [`pr_mark_addressed`](#pr_mark_addressed) | Mark items as dealt with | session |
| [`pr_review_submit`](#pr_review_submit) | Hand a finished review to the Control Plane, which posts it (Auto review runs only) | session |
| [`snapshot`](#snapshot) | Snapshot the box now | session |
| [`queue_add`](#queue_add) | Queue a prompt for itself | session |
| [`queue_list`](#queue_list) | The queue | session |
| [`title_set`](#title_set) | Rename the session | session |
| [`verify`](#verify) | Open an Auto QA run with a brief | session |
| [`notify`](#notify) | Push a notification to you | session |
| [`terminal_list`](#terminal_list) | Your Terminals | session |
| [`terminal_read`](#terminal_read) | What a Terminal printed | session |
| [`ui_open`](#ui_open) | Open a pane in your browser | session |
| [`sessions_list`](#sessions_list) | Every session | all |
| [`session_get`](#session_get) | One session and its last reply | all |
| [`session_create`](#session_create) | Start a new session | all |
| [`session_fork`](#session_fork) | Fork this session, optionally with a handoff | session |
| [`session_message`](#session_message) | Prompt another session's agent | all |
| [`session_wait`](#session_wait) | Wait for another session's turn | all |
| [`session_stop`](#session_stop) | Stop a session it created | all |
| [`approval_wait`](#approval_wait) | Wait for your Allow / Deny | session |
| [`schedule_create`](#schedule_create) | Create a scheduled task | session (own), all (others) |
| [`schedule_list`](#schedule_list) | The scheduled tasks | session |
| [`automation_create`](#automation_create) | Create an automation | session (own prompt, attach, notify), all (others) |
| [`automation_list`](#automation_list) | Every automation | session |
| [`automation_runs`](#automation_runs) | An automation's last runs | session |
| [`e2e_plan`](#e2e_plan) | Register the cases of the Auto QA run | session |
| [`e2e_case_start`](#e2e_case_start) | Start a case | session |
| [`e2e_case_end`](#e2e_case_end) | Record a case's result | session |
| [`e2e_finish`](#e2e_finish) | Close the run with the video | session |

### Self-knowledge

#### `whoami`

No parameters. Returns the session as the Control Plane sees it, live:

```
{
  id, title, url, provider, model, environment,   // "docker-linux" | "qemu-windows" | "qemu-macos"
  guest,                // { os: "windows" | "macos", workspace } or null
  createdAt,
  forkedFrom,           // { sessionId, title, snapshotId } or null
  createdBy,            // { sessionId, title } or null: the agent that created this session
  branch, snapshotCount, sessionboxerVersion,
  agentTools,           // "off" | "session" | "all"
  status,               // running, idle, stopped…
  usage,                // the provider's usage windows, when it reports them
  context,              // context window use of the current conversation
  queueLength,
  panes,                // which panes you have open right now
  terminals: [{ id, createdAt, exitCode }],
  prs: [ summaries of the attached pull requests ],
  verification,         // { id, status, brief } of the current Auto QA run, or null
  repos: [{ name, path }]   // /workspace/<name> as the agent sees it
}
```

#### `docs`

Look a topic up in the Sessionboxer user guide, which ships in the box (`/opt/sessionboxer/docs/GUIDE.md`). The agent's briefing tells it to answer questions about Sessionboxer from this rather than from memory.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `query` | string, 1–200 characters, *required* | A heading, a feature name or a few keywords |

Returns `{ query, sections: [{ heading, path, text }] }`, the three best-matching sections by word overlap with the heading and text, each cut at 6,000 characters, `path` being the chain of headings ("Using it › MCP servers"). With no match, `sections` is empty and `headings` lists every heading of the guide so the agent can retry with one.

#### `settings_get`

No parameters. Returns the public settings that apply to this session (the same object the UI reads: environments available, defaults, git identity, the MCP registry without its secrets, the sessionboxer policy…), with any secret-shaped value removed before it leaves the Control Plane.

### This session

#### `pr_attach`

Attach a pull request to the session: you see it in the PRs pane with its checks and review comments from then on, and the session gets notified when reviewers comment or a check fails. The agent is told to call it right after creating a PR.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `ref` | string, 1–500 characters, *required* | The PR's URL, or `owner/repo#number` (GitHub, or a Bitbucket Data Center URL) |

Returns the attached PR's summary. Marker in the transcript: "attached PR #n (owner/repo)".

#### `pr_list`

No parameters. Returns the pull requests attached to the session with their state, check counts and unseen review items.

#### `pr_items`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `pr` | string, *required* | The PR's id from `pr_list`, or its URL / `owner/repo#number` |

Returns the review comments, check results and other items of the PR, each with its id and whether it was marked addressed.

#### `pr_follow`

Follow pull requests without attaching them to a session: they appear on the user's **Pull requests** page and their events (opened, new commits, comment, review, failing check…) can trigger automations. The Control Plane polls them with the connected login's token; the agent never sees the token. The follow is enabled at once; following an already followed scope returns the existing follow.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `kind` | `repo` (default), `mine` or `requested` | Every open PR of one repository; the PRs the login opened; the PRs the login is asked to review |
| `repo` | string, ≤500 characters | For `repo`: `owner/repo`, a `PROJECT/slug` on Bitbucket Data Center, or a repository / PR URL |
| `account` | string, optional | A connected login; omitted takes the first connected account of the provider |
| `provider` | `github` or `bitbucket`, optional | Guessed from `repo` when omitted (GitHub unless the reference looks like a Bitbucket one) |
| `host` | string, optional | The Bitbucket Data Center host when there are several |

Returns the follow (`id`, `provider`, `host`, `account`, `kind`, `owner`, `repo`, `enabled`, `prCount`, `polledAt`, sync error). Marker: "followed owner/repo" / "followed PRs opened by @login".

#### `pr_followed_list`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `repo` | string, optional | `owner/repo` to narrow down to |
| `state` | `open` (default) or `all` | `all` includes merged and closed PRs of the last week |

Returns `{ follows, prs }`: the follows as `pr_follow` returns them, and each followed PR with `id`, `repo`, `number`, `url`, `title`, `state`, `author`, `headRef`, `headSha`, `baseRef`, `isFork`, `reviewDecision`, `checks { failed, pending, passed }`, `updatedAt`, `attachedTo` (session ids) and `lastRuns` (the newest run per automation). Use `pr_attach` with the PR's URL to work on one in this session.

#### `pr_mark_addressed`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `pr` | string, *required* | As above |
| `items` | array of 1–200 item ids from `pr_items`, *required* | What was dealt with |

The items show as addressed in the PRs pane.

#### `snapshot`

No parameters. Takes a Snapshot of the Sandbox now (its disk, the Workspace and the conversation), the same as the **Snapshot** button; you can fork from it or revert to it. Returns `{ id, ordinal, sizeBytes, createdAt }`. Marker: "took Snapshot n". Not available in Windows and macOS sessions (their VM disk is outside the Sandbox image).

#### `queue_add`

Queue a prompt for the agent itself: it is sent as the next user turn once the current one ends, after anything you already queued. Meant for a follow-up the agent wants a fresh turn for; you see it in the queue and can edit or drop it before it goes.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `text` | string, 1–20,000 characters, *required* | The prompt |

Returns `{ id, position }`. Marker: "queued a message (…)".

#### `queue_list`

No parameters. Returns the prompts queued for the session, in order, with their ids.

#### `title_set`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `title` | string, 1–200 characters, *required* | The new name (sidebar and browser tab) |

Marker: "renamed the Session to …".

#### `pr_review_submit`

Only in a Session an **Auto review** automation started for a pull request: the review the Agent wrote, posted by the Control Plane under the connected login (a GitHub review pinned to the head commit, or Bitbucket comments plus the participant status). The box never holds the token. Any other Session gets an error and nothing is posted; a run posts once.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `verdict` | `comment`, `approve` or `request_changes` | Capped by the automation's *Strongest verdict*: a verdict above the cap is posted as a comment and the body says which one the Agent wanted |
| `summary` | string, ≤4,000 characters | The review in Markdown |
| `findings` | array, ≤50, optional | `{ path, line, side?, severity?, body }`: repository-relative path, line in the head (`RIGHT`, default) or base (`LEFT`) version, `high` / `medium` (default) / `low`, the finding in Markdown (≤2,000 characters). A path outside the PR's diff, or a position the platform refuses, goes into the review body instead |

Returns `{ url, verdict, findings, inline, note }`: the review's URL, the verdict as posted, how many findings, how many of them inline, and a note ("posted", "verdict capped to comment", what was folded). Marker: "review posted: 3 findings, comment → link".

#### `verify`

Open an Auto QA (verification) run for the work of this turn, with a brief of what it checks that the Auto QA pane shows above the cases; then the agent follows the `e2e-verification` skill (`e2e_plan` unless the cases were given here, `e2e_case_start` / `e2e_case_end`, `e2e_finish`). The agent is told not to call it when Sessionboxer already asked it to verify the turn (the Auto QA setting does that after every user turn).

| Parameter | Type | Meaning |
| --- | --- | --- |
| `brief` | string, 1–2,000 characters, *required* | What the run verifies and how, in two or three sentences |
| `cases` | array of at most 10 `{ title (1–200), steps (≤4,000), expected (≤2,000) }`, optional | The cases, when already known; otherwise `e2e_plan` comes next |

Returns `{ id, status, cases: [{ index, title, status }] }`. Marker: "opened verification run …".

#### `notify`

Send you a short notification about the session: a browser push (when the device is enrolled under Devices) and the bell in Sessionboxer. For something that cannot wait for the reply, not for progress.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `text` | string, 1–500 characters, *required* | The notification |

Returns `{ ok: true }`. Marker: "notified you: …".

#### `terminal_list`

No parameters. Returns the Terminals of the session, yours and the ones `ui_open` opened for the agent, with `id`, `createdAt` and `exitCode` (null while the shell still runs).

#### `terminal_read`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `id` | string, *required* | A Terminal id from `terminal_list` |
| `lines` | integer 1–2,000, default 100 | How many of the last lines |

Returns `{ id, text, exitCode }`: the last lines of the Terminal's retained output (what you would see scrolling up in the pane) and the shell's exit code, null while it runs.

#### `ui_open`

Ask your browser to show a pane of this session. Honoured only when you are looking at **this** session and not typing; otherwise it is ignored, so an agent cannot pull you away from another session or interrupt a message. With `pane: "terminal"` and a `terminal.command`, a new Terminal opens and runs the command where you can watch it (a dev server, a test run).

| Parameter | Type | Meaning |
| --- | --- | --- |
| `pane` | `chat` · `desktop` · `code` · `terminal` · `context` · `prs` · `e2e` · `schedules`, *required* | Which pane (`e2e` is Auto QA) |
| `terminal` | `{ command: string (1–4,000) }`, optional | With `terminal`: the command the new Terminal runs |

Returns `{ pane, terminalId, shown }`, `shown` being whether a browser of yours had the session open to receive it; `terminalId` can be read back with `terminal_read`. Marker: "opened the … pane" / "opened a Terminal running …".

### Other sessions (policy *All Sessions*)

Session ids in these tools are the ids `sessions_list` returns; a prefix of 6 or more characters is enough when it is unambiguous.

#### `sessions_list`

No parameters. Returns every session on this Control Plane: `id`, `title`, `url`, `status`, `provider`, `environment`, `repos` (names), `createdAt`, `createdBy`, `forkedFrom`, `queueLength`, with the calling session marked `self: true` and the ones its agent created `mine: true`.

#### `session_get`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `id` | string, 1–100 characters, *required* | The session |

Returns that session's summary plus the last thing its agent said (capped in length). Never another session's whole conversation.

#### `session_create`

Start a new session whose first prompt is `first_prompt`; it is marked as created by this session (*child of …*). The new agent shares nothing with the caller but that text, so the prompt has to be the whole task, self-contained.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `title` | string, 1–200 characters, optional | Defaults to the start of `first_prompt` |
| `provider` | `claude-code` · `devin` · `codex` · `cursor`, optional | Defaults to the caller's provider; the provider has to be connected |
| `repos` | array of at most 20 repositories, default `[]` | Each `{ name?, source }` with `source` either `{ type: "git", url, ref? }` or `{ type: "copy", path }` (a directory on the host, copied in). `name` is the directory under `/workspace`, derived from the source when omitted |
| `first_prompt` | string, 1–20,000 characters, *required* | What the new agent is asked first |

Returns `{ pending: false, sessionId, title, url }`, or with approval on `{ pending: true, id, summary, expiresAt, hint }` where `id` is the approval to pass to `approval_wait`. The new session takes the Global defaults (environment Docker · Linux, model, instructions, policy). Errors: 3 alive children already, the global cap reached, provider not connected. Marker: "created Session …", linking to it.

#### `session_fork`

Fork this session from a Snapshot taken now: the fork has the same files, repositories and tools. Works under the *This Session only* policy too, since it acts on the caller's own session.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `conversation` | `continue` · `new` · `handoff`, default `continue` | `continue` keeps the conversation (same provider only); `new` starts an empty one; `handoff` starts from `document` |
| `provider` | `claude-code` · `devin` · `codex` · `cursor`, optional | Another agent for the fork; then `conversation` must be `new` or `handoff` |
| `title` | string, 1–200 characters, optional | |
| `document` | string, 1–200,000 characters, optional | With `handoff`: the handoff document, written by the agent in Markdown (goal, state of the work, decisions, open items, files, how to run it). Because the agent writes it itself, the fork starts at once, without the hidden handoff turn the UI's **Hand off** performs |
| `first_prompt` | string, 1–20,000 characters, optional | A prompt queued for the fork's agent after it starts |

Returns `{ pending: false, sessionId, title, url, snapshotOrdinal }`. Counts as a child for the 3-alive limit. Not available in Windows and macOS sessions (no snapshots there).

#### `session_message`

Send a prompt to another session's agent. Its transcript shows the prompt as *from Session X (its Agent)*, never as your words, and the sender's shows *sent a message to Y*.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `id` | string, 1–100 characters, *required* | The target session |
| `text` | string, 1–20,000 characters, *required* | The prompt |
| `when` | `now` · `queue`, default `now` | `now` prompts at once when the target is idle and queues it when it is busy; `queue` always queues it behind whatever is already there |

Refused when: the target is the caller itself (`queue_add` is for that), a message from this sender to that target is still in flight (`session_wait` for the reply first), the chain of agents prompting agents would go past hop 4, the target is in error, or the target is stopped and `when` is `now` (`queue` leaves it for when you resume it). Returns `{ sessionId, title, delivery }` with `delivery` `prompted` or `queued`.

#### `session_wait`

Wait until another session's agent finishes its turn and its queue is empty, or the timeout passes.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `id` | string, 1–100 characters, *required* | The session |
| `timeout_s` | integer 1–20, default 15 | Seconds to wait at most; the call returns earlier when the session settles |

Returns `{ sessionId, title, still_running, status, lastReply }`; the agent calls again while `still_running` is true. Waiting for itself is refused.

#### `session_stop`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `id` | string, 1–100 characters, *required* | A session this agent created (`session_create` or `session_fork`) |

Stops its Sandbox (you can resume it) and frees one of the 3 child places; returns `{ sessionId, title, status }`. Any other session is yours to stop, and the tool refuses it; so is stopping itself (the agent ends its turn instead).

#### `approval_wait`

Wait for your answer to a pending approval.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `id` | string, 1–100 characters, *required* | The approval id `session_create` returned |
| `timeout_s` | integer 1–20, default 15 | Seconds to wait at most |

Returns the approval: `{ id, kind, summary, status, expiresAt, result?, error? }` with `status` one of `pending`, `allowed`, `denied`, `expired`; with `allowed`, `result` is what the approved action returned (the created session). The agent is told to call again while `pending` and to tell you what it is waiting for; its turn may also end, in which case the card in the chat still creates the session when you allow it.

### Automations

An automation (Automations page; ADR-0063) is a trigger — a cron schedule, an event on a followed pull request, or manual — an action, and limits. Scheduled tasks are automations with a schedule trigger; the `schedule_*` tools below are the older, narrower way to make one.

#### `automation_create`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `name` | string, 1–200 characters, *required* | |
| `enabled` | boolean, default `true` | |
| `trigger` | one of the objects below, *required* | |
| `action` | one of the objects below, *required* | |
| `limits` | `{ maxConcurrent?, maxRunsPerDay?, maxRunsPerPrPerDay?, debounceSeconds?, timeoutMinutes? }`, optional | Defaults 2 · 20 · 4 · 120 s · 360 min |

`trigger`:

- `{ type: "schedule", cron, timezone, missedRun? }`: a 5-field cron expression and an IANA time zone; `missedRun` is `skip` (default) or `catch_up`.
- `{ type: "pr_event", follows?, events, filters? }`: `follows` are `pr_follows` ids (empty = every follow the user has; the user follows repositories on the Pull requests page or with `pr_follow`); `events` among `opened`, `synchronize`, `ready_for_review`, `converted_to_draft`, `review_requested`, `review_submitted`, `comment`, `check_failed`, `merged`, `closed`, `reopened`; `filters` `{ drafts: skip|include, forks: skip|review_only|allow, authors: any|not_self|self_only, includeOwn, baseRef?, titleMatch?, labels? }`.
- `{ type: "manual" }`: only Run now.

`action`:

- `{ type: "prompt", sessionId?, text }`: `sessionId` defaults to the caller; `"attached"` means the Session the PR is attached to (PR triggers). `text` (1–20,000) may use `{pr.url}`, `{pr.number}`, `{pr.title}`, `{pr.repo}`, `{pr.headSha}`, `{event}`.
- `{ type: "new_session", title?, provider?, repos, prompt, stopAfter, checkoutPrHead }`: as in `schedule_create`; `checkoutPrHead` (default `true`) clones the PR's repository at the PR head first on a PR trigger.
- `{ type: "auto_review", provider?, instructions?, maxVerdict, deltaOnly, notifyOn, stopAfter }`: a Session on the PR head reviews it; the Control Plane posts the review (`maxVerdict` `comment` by default, `request_changes`, `approve`).
- `{ type: "auto_qa", provider?, instructions?, publish, commentOnSkip, maxMinutes, stopAfter }`: a Session on the PR head runs the Auto QA flow and posts the video (`publish` `github_attachment` or `link_only`).
- `{ type: "attach" }`: attach the PR to the Session that pushed its branch.
- `{ type: "notify", text? }`: a push notification.

Prompting the caller's own session, `attach` and `notify` work under *This Session only*; anything that prompts another session or starts one needs *All Sessions*. Returns `{ id, name, enabled, trigger, action, nextRunAt }`. Marker: "created the automation …".

#### `automation_list`

No parameters. Returns every automation with `id`, `name`, `enabled`, `trigger`, `action`, `limits`, `nextRunAt`, `lastRunAt`, `lastStatus`, `runsToday`.

#### `automation_runs`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `id` | string, *required* | The automation |

Returns its last 50 runs: `id`, `trigger`, `status` (`queued`, `running`, `succeeded`, `failed`, `skipped`), `event`, `prUrl`, `sessionId`, `queuedAt`, `finishedAt`, `detail`, `error`, `result`.

#### `schedule_create`

Create a scheduled task — an automation with a schedule trigger — the same as one made on the Automations page: on a cron schedule, prompt a session or start a new one each time. Prompting the caller's own session works under *This Session only*; another session's needs *All Sessions*.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `name` | string, 1–200 characters, *required* | |
| `cron` | string, 1–200 characters, *required* | A 5-field cron expression, e.g. `0 9 * * 1-5` |
| `timezone` | string, 1–100 characters, optional | An IANA time zone (`Europe/Madrid`); the Control Plane's when omitted |
| `action` | one of the two objects below, *required* | |

`action`:

- `{ type: "prompt", sessionId?, text }`: send `text` (1–20,000 characters) to a session at each run; `sessionId` defaults to the caller.
- `{ type: "new_session", title?, provider?, repos, prompt, stopAfter }`: start a session at each run with `prompt` (1–20,000) as its first prompt; `repos` as in `session_create` (default `[]`); `stopAfter` (default `true`) stops the session once its first turn ends.

Returns `{ id, name, cron, timezone, nextRunAt }`. The schedule is enabled at once and skips runs missed while Sessionboxer was down (the *skip* policy; you can change it on the Automations page). Marker: "scheduled …"; the agent is told to say what it scheduled in its reply.

#### `schedule_list`

No parameters. Returns the automations with a schedule trigger with `id`, `name`, `cron`, `timezone`, `enabled`, `action`, `nextRunAt` and `lastRunAt`.

### Utilities

Utilities (Settings → Utilities; ADR-0073) are the observability systems and applications the user lets agents investigate with, each in a target Environment (`prod`, `staging`, `qa`…) with credentials and facets (web UI, HTTP API, SSH host, CLI, MCP server). Which are on for a session is in `.sessionboxer/utilities.json` in the box; the credentials never travel through these tools — the agent uses them by name (`${util:<name>.password}` in the desktop `type` tool, `sb-util` in a shell). The four that change something return a pending approval the user answers in the chat (`approval_wait(id)` waits); the card shows every field, secrets masked. All of them work under *This Session only*.

#### `utilities_list`

No parameters. Returns `environments` (`name`, `production`), `groups`, `utilities` — for each `name`, `label`, `group`, `environment`, `production`, `readOnly`, `enabled` (on for this session), `preset`, `facets` (`mcp`, `web`, `http`, `ssh`, `cli`), `credentials` (names), `mcp` (the MCP server's name while on), a `notes` excerpt — and `presets` (`newrelic`, `grafana`, `graylog`, `argocd`, `rabbitmq`, `mongodb`, `webapp`, `ssh`, with the credential names each takes).

#### `utilities_get`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `name` | string, *required* | A Utility's name, or `name@environment` |
| `environment` | string, optional | When the name exists in several Environments |

Returns the Utility in full: `notes`, `credentials` (name, whether set), `otp` (a `totp` credential is stored), `web` (`url`, `login`), `http` (`baseUrl`, header names), `ssh` (`host`, `port`, `user`, `jump`), `cli` (`install`, variable names), `mcp` (transport, command/URL, variable names, `server` name while on) and `usage` lines (`sb-util` commands and placeholders for it).

#### `utilities_open`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `name` | string, *required* | A Utility with a web facet, on for this session |
| `environment` | string, optional | |
| `path` | string, optional | A path or URL under the web UI |

Opens the web UI in the box's browser (a Terminal runs `sb-util open`), shows the user the Desktop and returns `url`, `login` and the placeholders to sign in with. Marker: "opened … in the browser".

#### `utilities_add`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `name` | string, `[a-z0-9][a-z0-9_-]{0,63}`, *required* | The placeholder and `sb-util` name |
| `label` | string, optional | |
| `group` | `observability` \| `applications`, optional | The preset's, else `observability` |
| `environment` | string, optional | The first non-production Environment when omitted |
| `preset` | string, optional | Fills the facets from the URL given in `web.url` or `http.baseUrl` |
| `credentials` | `[{ name, value }]`, default `[]` | `user`, `password`, `token`, `totp`, `ssh_key`, `uri`, … |
| `readOnly` | boolean, default `true` | |
| `notes` | string, optional | |
| `web` | `{ url?, login? }`, optional | `login` among `form`, `basic`, `sso`, `none` |
| `http` | `{ baseUrl, headers? }`, optional | Header values may use `${cred:<name>}` |
| `ssh` | `{ host?, port?, user?, jump? }`, optional | |
| `cli` | `{ install?, env? }`, optional | |
| `mcp` | `{ transport?, command?, args?, env?, url?, headers? }`, optional | |
| `enable` | boolean, default `true` | Switch it on for this session once stored |

Returns a pending approval; allowed, the Utility is stored in Settings → Utilities (and switched on). The call's input is stored in the transcript with the credential values masked. Marker: "registered the Utility …".

#### `utilities_update`

The same fields as `utilities_add` (without `enable`), `name`/`environment` naming the Utility: fields given replace the stored ones; credentials given replace the stored ones of the same name. Returns a pending approval. Marker: "changed the Utility …".

#### `utilities_enable`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `names` | string[], 1–100, *required* | Utility names (`name`, `name@environment`), Environment names (all of it) or groups |
| `enabled` | boolean, default `true` | |

Switching off is immediate and returns `{ changed, enabled }`; switching on returns a pending approval (the card lists the Utilities, production ones flagged). Their MCP facets join or leave the agent's MCP servers when applied (idle: at once; busy: at the end of the turn); the manifest and `sb-util` follow at once. Marker: "switched on/off …".

#### `procedure_save`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `name` | string, `[a-z0-9][a-z0-9-]{0,63}`, *required* | The skill directory |
| `description` | string, 1–1024, *required* | When to use it (frontmatter) |
| `body` | string, 1–200,000, *required* | Markdown steps |
| `utilities` | string[], default `[]` | Utility names it needs; empty = any |
| `environments` | string[], default `[]` | Environments it applies to; empty = all |

Proposes a procedure (a skill) for the user to keep; the card shows name, description and body. Allowed, it is stored in Settings → Utilities → Procedures (source *agent*) and materialised as `~/.claude/skills/<name>/SKILL.md` in every session it applies to. A name that exists is updated. Marker: "saved/updated the procedure …".

### Auto QA (end-to-end verification) runs

When **Auto QA** is on, Sessionboxer opens a verification run after each of your turns and asks the agent to follow the `e2e-verification` skill; `verify` opens one on the agent's own initiative. These four tools fill the run in so the Auto QA pane follows along as it happens: the cases appear when planned, each turns *running*, *passed*, *failed* or *skipped* with its note and screenshot, and the video is attached at the end. They go through the daemon's `/e2e` endpoint rather than the general bridge and need an open run; without one they error.

#### `e2e_plan`

Register the test cases of the current run, or skip the run when the turn changed nothing testable (an answer-only turn, research). Called once, before `start_recording`. Cases are numbered from 1 in the order given.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `cases` | array of at most 10 `{ title (1–200), steps (≤4,000, one per line), expected (≤2,000) }`, default `[]` | 2 to 5 normally; up to 10 only for a very large change. Empty when skipping |
| `skip_reason` | string, ≤1,000 characters, optional | Why nothing is verified; no cases then |

#### `e2e_case_start`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `index` | integer ≥ 1, *required* | The case number from `e2e_plan` |

Marks the case *running*. A failed case is started again after the fix; the run keeps every attempt.

#### `e2e_case_end`

| Parameter | Type | Meaning |
| --- | --- | --- |
| `index` | integer ≥ 1, *required* | The case |
| `status` | `passed` · `failed` · `skipped`, *required* | `failed` means: fix the code, then `e2e_case_start` it again; `skipped` when it could not be exercised |
| `note` | string, ≤2,000 characters, optional | One line: what was seen, and for a failure what went wrong |
| `screenshot_path` | string, ≤1,000 characters, optional | A `/workspace` path of a screenshot of the final state; shown in the pane |

#### `e2e_finish`

Close the run after `stop_recording`. Cases never started are marked skipped; the run's verdict is *passed* when no case's last attempt failed.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `video_path` | string, ≤1,000 characters, optional | The recording's path as `stop_recording` returned it |
| `summary` | string, ≤4,000 characters, optional | Two or three sentences: what was verified, what failed, what was fixed |

Returns the closed run. The agent then ends its reply with a short summary that mentions the video's path, so the chat shows the player.
