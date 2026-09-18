# Recordings are condensed: static stretches capped to a short hold

Screen recordings made with the desktop MCP (ADR-0017) spend most of their length on nothing: the agent waiting for a page to load, a build to finish, or deciding on its next click, and the model itself pausing between tool calls. A two-minute recording of a ten-second feature is tedious to watch and hard to scrub. Removing the still parts entirely is wrong too: the state the video pauses on (the form after submit, the test output) is exactly what the viewer needs time to read.

## Decision

`stop_recording` post-processes the finished .mp4 in place with one ffmpeg pass (`condense: true` by default, `hold_seconds` 1.5, 0.5–10):

```
mpdecimate,
setpts=if(eq(N,0),0,PREV_OUTPTS+min(PTS-PREV_INPTS,HOLD/TB)),
tpad=stop_mode=clone:stop_duration=HOLD
```

- `mpdecimate` (default thresholds) drops every frame that does not differ from the last kept one. Typing, cursor movement, scrolling and page paints all clear the threshold; an unchanged desktop does not.
- `setpts` re-times the survivors so the gap before each kept frame is the real gap capped at `HOLD`: a 40 s wait becomes a 1.5 s hold of the state that was on screen, while 60 ms between two typed characters stays 60 ms. This is the difference from the usual `mpdecimate,setpts=N/FRAME_RATE/TB` recipe, which removes pauses altogether and makes each state flash by in one frame.
- `tpad` clones the last frame for `HOLD`, so the final state (the one the recording ends on) is readable too.

The output is variable frame rate (`-fps_mode vfr`) H.264 with the same encoder settings as the recording, so browsers play and seek it as before (checked in Chrome through the Control Plane's raw-file route). The pass writes `<name>.condensing.mp4` next to the recording and renames it over the original only when ffprobe confirms a non-empty result; on any failure or timeout (3 min) the original is kept and the tool result carries `condensed: false` with a `warning`, never a failed tool call after a successful recording. The result reports `recordedSeconds` (wall clock) and `seconds` (video length) so the agent can tell the user "45 s of work, 12 s video".

Measured on a 1024×768 desktop at 15 fps: 24.5 s with three 5–7 s pauses → 10.4 s, 29 of 367 frames kept, the pass took 0.5 s (only kept frames are encoded). The agent's briefing tells it about the default and when to turn it off (`condense: false` for animations or performance demos).

## Considered Options

- **Always cut pauses entirely** (`setpts=N/FRAME_RATE/TB`, rejected): states become single frames; unreadable.
- **Speed up pauses** (e.g. 8× during still parts, rejected): with `mpdecimate` there is nothing to speed up (the frames are identical); a cap gives a fixed, predictable hold regardless of how long the wait was.
- **Condense at start_recording time / in the grabbing ffmpeg** (rejected): `mpdecimate` needs the following frame to decide, and a live x11grab with VFR output complicates stopping; a post pass on a finished file is simpler and can fall back to the original.
- **Do it in the Control Plane when serving the video** (rejected): the file the agent hands over should be the final artefact (it may be committed, uploaded elsewhere); the box has ffmpeg already.

## Consequences

- Image rebuild (the MCP lives in the image). Existing videos are untouched.
- Blinking carets or clocks in the recorded area keep frames alive at their blink rate and defeat condensing for that stretch; mpdecimate's thresholds are left at default because raising them far enough to ignore a caret also drops single typed characters (measured: `hi=16384` kept 1 frame of a typing session). xfce4-terminal's caret did not trip the default threshold in the test.
- The tool call takes a little longer at stop (sub-second for short recordings, seconds for long ones).
