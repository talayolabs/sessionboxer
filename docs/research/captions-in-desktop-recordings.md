# Research: captions / subtitles in desktop recordings

Question (2026-09-18): the agent's reply summarises what a recording shows; could that text be *in* the video,
as subtitles that say what is happening in each part, so a viewer (or another LLM) can follow it without the chat?

Short answer: yes, cheaply, and the timing problem introduced by condensing (ADR-0025) has a clean solution.
The pieces: (1) the agent narrates **while recording** through an `annotate_recording` tool (it cannot time a
summary written afterwards), (2) at `stop_recording` the captions are **burned into a band under the desktop**
by ffmpeg's `subtitles` filter placed *before* `mpdecimate`, so they ride along through condensing with no time
maths, and (3) the same captions are also written as a **WebVTT sidecar** (times remapped) and returned in the
tool result, so the chat's player can show a toggleable track and a clickable list of steps. Prototype below.

## 1. Where the text comes from

| Option | Verdict |
| --- | --- |
| **`annotate_recording(text)` during the recording** (chosen). Timestamp = now − `startedAt` from the recording state file (`/dev/shm/sessionboxer/recording.json`, which already survives MCP restarts; append captions to it). Each caption lasts until the next one or the end. The agent narrates as it goes: "Opening the login page", "Submitting with a wrong password: error shown". | Natural for the agent (it knows what it is about to do), no remapping issues, works with condensing. This is how Devin's own recorder works (setup / test_start / assertion annotations). |
| Captions passed to `stop_recording` with times | The agent has no clock; we would have to return `recording_at` in every desktop tool result during a recording so it can quote them. Clunky, and it invites made-up times. Keep as an optional extra (`captions: [{at, text}]`) for editing/fixing, not as the main path. |
| Auto-captions from the MCP's own actions ("click (412, 300)", "type 'admin'", "key Return") | Free, exact, but machine-like and noisy. Worth having as a **second, off-by-default track** (`auto_captions: true`) or for debugging; not a substitute for narration. |
| Post-hoc: ask the model to caption the finished video from frames | Slow, costs tokens, and the agent already knows what it did. No. |

The final chat summary then falls out of the annotations: `stop_recording` returns the caption list with final
timestamps, so the agent's reply can list "0:00 Login page · 0:04 Wrong password rejected · 0:07 Success" and
the text in the video and the text in the chat agree.

## 2. Where the text lives

**A. Burned into the frames (chosen as default).** ffmpeg's `subtitles` filter (libass; the image's ffmpeg has
`--enable-libass`, DejaVu Sans is installed) renders an .srt/.ass. Two decisions that matter:

- *Draw in a band, not over the desktop*: `pad=iw:ih+64:0:0:color=0x111111` adds a dark strip under the 1024×768
  grab and the caption is aligned bottom-centre inside it, so no UI is covered (the prototype's two-line caption
  spilled into the desktop with a 56 px band; 64 px fits two lines at 20 px, or clamp captions to one line).
- *Place it before `mpdecimate`/`setpts` in the chain.* Captions are authored in wall-clock time, and so are the
  input frames at that point; the re-timing then carries the burned frames along. No mapping needed. A caption
  change during a still stretch makes that frame differ, so it is kept and gets its own hold, which is exactly
  right (the state is shown once with the old caption, once with the new).

Pros: survives download, sharing, re-encoding; visible to any viewer or model that sees the frames. Cons: fixed
language and size, not selectable/searchable, adds 64 px to the height, the stop pass is a little slower (libass
render per frame; +0.1 s on the 24 s test).

**B. Sidecar WebVTT track** (`recordings/<name>.vtt` next to the .mp4, served by the existing `/fs/raw` route;
the chat's video card adds `<track kind=subtitles default>` when the sidecar exists). Toggleable, selectable,
accessible; and the card can render the cues as a **clickable step list** under the player (click → seek), which
is the "tell me what happens in each part" feature in its most useful form. Cons: times must be remapped through
condensing, and the text is lost when the .mp4 alone is downloaded. Browsers do **not** render mp4-embedded
`mov_text` tracks (Chrome ignores them), so in-container subtitles are not an alternative to the sidecar.

Remapping is small: run the decimate pass once as a dry run (`-vf mpdecimate,showinfo -f null -`, 0.3 s on the
test) to get the kept input timestamps `a_i`; the output times are `b_0 = 0`, `b_i = b_{i-1} + min(a_i − a_{i-1},
hold)`; a caption at wall time `t` with `a_i ≤ t < a_{i+1}` lands at `b_i + min(t − a_i, hold − 1/fps)`. Cue ends
map the same way. Alternatively derive `a_i` from the condensed file itself (`ffprobe -show_frames`) and the
original frame times from the caption pass — the dry run is simpler.

**C. mp4 chapters** (`-map_metadata` from an ffmetadata file with `[CHAPTER]` blocks): VLC/QuickTime show a chapter
menu, browsers show nothing. Free to add from the same list; low value on its own.

Recommendation: **A + B together** (`captions: "burn" | "track" | "both" | "none"`, default `"both"`), plus the
list in the tool result. Burn-in is what makes the video self-contained; the track is what makes it navigable in
the chat.

## 3. Prototype (in a Sandbox, ffmpeg 6.1.1)

Filter script used on the ADR-0025 test recording (24.5 s, three pauses), with four hand-written cues:

```
pad=iw:ih+56:0:0:color=0x111111,
subtitles=caps.srt:force_style='FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H00FFFFFF,BorderStyle=1,Outline=0,Shadow=0,Alignment=2,MarginV=14',
mpdecimate,
setpts=if(eq(N\,0)\,0\,PREV_OUTPTS+min(PTS-PREV_INPTS\,1.5/TB)),
tpad=stop_mode=clone:stop_duration=1.5
```

Result: 1024×824, 11.7 s, 56 frames (52 without captions: the four caption changes each kept one more frame),
0.56 s to encode. Frames sampled at output times 1.2 / 3.7 / 5.5 / 7.3 / 9.5 s show the caption that matches the
action on screen (typing while "Typing a greeting…", the `ls` listing under "Listing the root directory…"), i.e.
the wall-clock cues survived the re-timing untouched. Passing the filter as `-filter_script:v` avoids the quoting
mess of `force_style` inside `-vf`; the implementation would write the .srt and the script to the tmpfs.

## 4. Implementation sketch (~1 session, image rebuild)

- MCP: `annotate_recording({ text })` appends `{ at, text }` to the recording state; `stop_recording` gains
  `captions` (`both` default) and `auto_captions` (off); writes `<name>.srt` to tmpfs, pads + burns before
  decimating, writes `<name>.vtt` next to the video with remapped cues, returns `captions: [{ at, text }]`
  (final times) alongside `seconds`/`recordedSeconds`. Text sanitised for ASS/SRT (no `{}` overrides, one or two
  lines, ≤ ~120 chars; longer text wrapped by libass with `PlayResX` set to the width).
- Briefing: "narrate the recording with `annotate_recording` before each step; keep captions short; the list
  comes back from `stop_recording` for your summary".
- Web: video card looks for the `.vtt` sibling (HEAD on `/fs/raw`), adds `<track>`, and renders the cues as a
  step list with timestamps that seek the player.
- Fonts: DejaVu covers Latin/Cyrillic/Greek; CJK captions would need `fonts-noto-cjk` in the image (+~100 MB),
  decide when needed.

Not covered: speech (TTS narration would need a voice engine in the image and makes the file much larger), and
captions on recordings made before the change.
