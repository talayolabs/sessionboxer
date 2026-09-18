# Recording captions: narrated by the agent, burned into a band and written as a WebVTT track

A recording (ADR-0017, condensed per ADR-0025) shows what happened but not why: the viewer sees clicks and page changes and has to guess which step of the feature each one is. The agent does summarise the video in its reply, but afterwards and detached from the frames. The research note `docs/research/captions-in-desktop-recordings.md` established that the agent can narrate while it works, that ffmpeg (libass, fontconfig and DejaVu are in the image) can burn text into the frames, and that browsers only show subtitle tracks from a sidecar file, never from inside the .mp4.

## Decision

**Source of the text.** A new desktop MCP tool `annotate_recording({ text })` appends `{ at: <seconds since start>, text }` to the running recording's state file (the same tmpfs file that lets a recording survive MCP restarts). The agent is briefed to call it right before each step, one sentence per step; a caption lasts until the next one. Timing comes from the tool call, not from the model: the agent has no clock and cannot time a summary written afterwards. `recording_status` reports the caption count.

**Burn-in.** `stop_recording` (`captions: "both"` by default; `"burn"`, `"track"`, `"none"`) renders the captions into the video in the same ffmpeg pass that condenses it:

```
pad=iw:ih+BAND:0:0:color=0x1a1a1a,
ass=filename=<captions.ass>,
mpdecimate, showinfo,
setpts=…, tpad=…
```

- `pad` adds a band under the desktop so no pixel of the recorded screen is covered. Its height is derived from the text: three lines at 1.2× the font size plus a half-font margin above and below, rounded up to an even number for yuv420p (126 px for 1024×768, about 16 % of the display).
- The captions are an ASS script sized to the padded frame with one style: DejaVu Sans at 3.5 % of the display height (27 px), light on the band's colour with a thin dark outline, **bottom-centre aligned with the half-font margin from the frame's bottom edge**. Three lines are guaranteed to fit in the band; a fourth stacks *upwards* over the bottom of the desktop (the outline keeps it legible there) rather than being cut off below the frame, which is what a top anchor would do with the extra lines. Text is capped at 300 characters and braces/backslashes (ASS override syntax) are stripped.
- The captions are drawn **before** `mpdecimate`. They are authored in wall-clock time, like the frames they describe, so condensing carries them along without any time arithmetic: a caption change is itself a frame change, so the frame it first appears on is kept, and the frames it sits on are re-timed together with it.

**Sidecar track.** For the browser the same pass writes `<name>.vtt` next to `<name>.mp4`, with times in the *condensed* timeline. `showinfo`, placed between `mpdecimate` and `setpts`, logs the input timestamp of every kept frame; the tool parses those from ffmpeg's stderr and replays the `setpts` expression (`out[i] = out[i-1] + min(in[i] - in[i-1], hold)`) to map each caption's wall-clock time to its video time. One pass, no second decode. Cues are at least 0.5 s long so two annotations that fell inside one collapsed pause both show. The tool result lists the captions with their final times and the `track` path, so the agent's summary can quote them.

**Player.** The chat's video card fetches the sibling `.vtt` (the raw-file route now serves `text/vtt`); when it exists the `<video>` gets a `<track kind="captions">` (not `default`: the picture already carries the text) and a list of the cues is rendered under the player as clickable steps, the current one highlighted from `timeupdate`, a click seeking there and resuming playback. `.vtt` is deliberately not a media kind: mentioning it in a reply must not produce a card of its own.

On any failure of the finishing pass the recording is kept as it was, the tool result carries a `warning`, and the `.vtt` is still written from the wall-clock times (they are correct for an uncondensed video).

## Considered Options

- **Caption from the final summary** (rejected): nothing to time it against; the model does not know when each sentence happened.
- **Automatic captions from the MCP's own actions** ("click at 412,300", "type 'hello'") (deferred): free but noisy and not what a viewer wants; may come later as an off-by-default second track.
- **Overlay captions on the desktop** (rejected): covers the very UI the video is about; the band costs 16 % more pixels and nothing else.
- **A taller band with top-anchored text** (tried, 25 % of the display): wastes a strip of the video on empty space most of the time, and anything that did not fit would vanish below the frame; a bottom anchor degrades visibly instead.
- **A 64 px band** (prototype, rejected): one line only; a wrapped caption spilled into the desktop.
- **Second ffmpeg pass to find kept frames** (rejected): `showinfo` inside the single pass gives the same information for free.
- **Embed the subtitle track in the .mp4** (rejected): Chrome, Firefox and Safari ignore it; a sidecar is the only in-player option.
- **`subtitles=` filter with an .srt and `force_style`** (rejected): the .ass script expresses alignment, margins and resolution directly, without shell/filter quoting of style strings.

## Consequences

- Videos with captions are 1024×894 instead of 1024×768; the band is part of the file the user downloads, so the captions travel with it.
- The `.vtt` is a second file in `recordings/`; it is served like any Workspace file and moves with the video in Pull to folder.
- A caption changes the picture, so `mpdecimate` keeps that frame: a caption in the middle of a still stretch adds one held frame (1.5 s) to the video. Intended.
- Text is wall-clock-timed at the moment of the tool call; the corresponding screen change follows within the agent's next action, typically well under the hold. Captions therefore read as "about to do X" rather than "X happened".
- The MCP lives in the image: `npm run build:image` and Stop → Resume are needed for existing sessions.
