# ADR 0070: Recordings at 30 fps, actions at a hand's pace while recording

## Status

Accepted

## Context

Recordings (ADR-0017) looked jerky: the pointer jumped to its target in a few steps and typed text landed in blocks of ten letters. Measured on the Sandbox image, the encoder was not the cause — ffmpeg kept every frame, at ~15 % of one core for 30 fps and ~30 % for 60 — the ratio between the actions and the frame rate was. A recording ran at 15 fps (one frame every 67 ms) while the MCP acted as fast as X11 takes it: `type` lands about 150 characters a second (xdotool's `--delay 12` sleeps half of it per key, so ~7 ms), a glide (since 1.4.1) lasts 100–300 ms. A 55-character sentence was five frames; a move across the screen, four.

The fast pace is right when nobody watches: the agent's turn should not wait on cosmetics. It is wrong when the point of the recording is to show a person what happened.

## Decision

**30 fps by default, 60 allowed.** `start_recording`'s `fps` defaults to 30 (1–60); the capture pipeline is unchanged (x11grab → libx264 veryfast, CRF 23).

**Two paces, picked per action by whether a recording runs.** The desktop MCP's pointer and keyboard functions take a `Pace` — the glide's shortest and longest duration, and xdotool's `--delay` between keys. `FAST_PACE` (glides 100–300 ms, `SESSIONBOXER_TYPE_DELAY_MS`, 12 by default) is used when no recording runs; `RECORDED_PACE` (glides 350–700 ms, `--delay` at least 64, so ~32 ms per key, one per frame at 30 fps) when one does. The check is the recording state file on the tmpfs, read before each action, so a recording started in one turn paces the actions of the next as well, and stopping it restores full speed at once.

**A glide keeps its time.** Positions of the eased path that round to the same pixel are merged into one longer pause instead of being dropped, so a short hop lasts its minimum instead of collapsing to a few steps; the target itself is still left to the final `mousemove --sync`.

## Consequences

- Recorded steps take longer: a sentence of 50 letters is ~1.6 s instead of ~0.4 s, a move ~0.5 s. Condensing (ADR-0025) does not touch them — every frame differs — so videos are a little longer and show what happened.
- Un-recorded turns are as fast as before; Windows and macOS keep their 40 ms `--delay` (raised to 64 while recording).
- Files are somewhat larger at 30 fps; CPU stays well under a core on a 1024×768 desktop.
- The agent's briefing needs no change: the pacing is automatic. `fps: 60` remains for animations or performance demos.
