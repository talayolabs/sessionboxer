# ADR 0072: Recordings draw their own pointer, badge and captions

## Status

Accepted

## Context

The pointer in a recording was X's own, grabbed by x11grab's `-draw_mouse 1`: a 16-pixel black arrow, easy to lose on a busy screen, and a click left no mark at all — the viewer saw the result and had to infer the button. The Sessionboxer icon appeared nowhere in a video, and the burned-in captions (ADR-0025) used DejaVu Sans, the only face in the image, which reads like a system dialog.

Everything about the pointer is known to the MCP: it moves it, it clicks. The frames can carry no pointer and get a better one afterwards.

## Decision

**The frames are grabbed without a pointer** (`-draw_mouse 0`). While a recording runs, every pointer action also *traces*: `mouseMove` reports the positions of its glide with the moment each was reached (the planned pauses scaled to the time xdotool actually took); `click`, `mouseDown` and `mouseUp` report presses — at a position, from a moment, until another (`null` while a button is held). The trace is appended to the recording's state file on the tmpfs, next to the captions, so it survives the MCP restarting and the finishing pass finds it there. Without a recording nothing is traced and nothing slows down (the `Hand` an action receives is its `Pace` plus, only while recording, the trace).

**The finishing pass draws the pointer.** `stop_recording` always re-encodes now (it did only to burn captions or condense): a white arrow with a dark outline and a soft shadow, 5.5 % of the display's height tall (42 px at 768, about twice X's), generated with ImageMagick at four times the size and scaled down; a second one at 80 % of the size for the pressed state. Both are `overlay` inputs that a `sendcmd` script moves at every traced moment — the arrow matching the button state stands at the position with its tip on the hotspot, the other is parked off-frame. A click shows the small arrow for 120 ms (four frames at 30 fps), a double-click for 60 ms twice, a drag for its whole length. Two fainter copies of the arrow (45 % and 22 % opaque) stand where the pointer was a third and two thirds of a frame earlier, interpolated between traced positions: under the arrow while it rests or moves slowly, a short motion smear when it moves fast — the trail, kept to the length of one frame so it never draws over the UI for longer than the pointer itself does. The trace is in wall-clock time and ffmpeg's first frame comes a few tenths of a second after `start_recording` returned (it opens the display and the encoder first), so the trace is shifted by the difference between the recorded time and the video's length before it is drawn — the pointer lands where the screen reacts.

**A badge at the top-right corner**: the Sessionboxer icon, 3.65 % of the display's height (28 px at 768), centred on a rounded translucent dark square, 1.3 % from the edges. The icon ships with the MCP (`packages/computer-use-mcp/assets/logo.png`, copied into the image); without the file the badge is simply not drawn.

**Captions in Inter** (`fonts-inter-variable`, family `Inter Variable`), the same band and layout as before; fontconfig falls back to DejaVu Sans where the font is missing, which is why the style names the family rather than a file.

The finishing pass is one filter graph — pointer overlays, then badge, then `pad` + `ass` for the captions, then the condensing filters (ADR-0025) — in a script file, so its length is not an argument. If it fails the recording is kept as grabbed: without a pointer, which the tool result says.

**A speed limit on recorded glides.** At 30 fps the eye reads a pointer that moves more than ~40 px between frames as appearing somewhere else, not as travelling: the eased glide of ADR-0070, capped at 700 ms, peaked at ~100 px per frame across the screen while a short hop looked fine. `RECORDED_PACE` gains `peakPxPerSecond: 1200`: a glide lasts at least 1.5 × distance / 1200 s (the ease peaks at 1.5 × the average speed), so a move across a 1024 × 768 screen takes ~1.2 s and never exceeds 40 px per frame; short moves are unchanged, and `FAST_PACE` has no limit.

Researched, done as the smear above rather than as a line: **a trail behind the pointer.** A longer trail — dots or a line through the last few hundred ms of positions, delayed copies of the trace moved by `sendcmd`, which a prototype showed feasible — draws over the application's UI along every path, the thing the recording is meant to show. The one-frame smear gives the motion continuity without leaving anything behind.

## Consequences

- Recordings show a pointer a viewer can follow, clicks are visible, every video carries the mark; captions are easier to read.
- `stop_recording` takes a re-encode for every recording (about a tenth of the video's length on one core at 1024×768, as condensing already did) — the trace is applied in the same pass.
- The pointer in the video is the MCP's account of it: a pointer moved by hand (takeover, ADR-0011) during a recording is not drawn until the agent acts again, at which point it lands at the traced position; the pointer's shape does not follow the application's (a text cursor, a hand over a link) — it is always the arrow.
- Screenshots and the live Desktop pane are unchanged: the X pointer is still the small one there. `SESSIONBOXER_MOUSE_GLIDE=0` recordings show the arrow jumping, as before.
- Image rebuild: the font and the icon are new in the image, and the MCP's `dist`.
