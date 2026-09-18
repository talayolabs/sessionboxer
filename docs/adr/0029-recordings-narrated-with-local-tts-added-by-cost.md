# Recording narration: captions spoken by a local TTS model, added automatically when cheap and asked about otherwise

Captions (ADR-0026) let a viewer read what each step of a recording is; a spoken track lets them *watch* the desktop while being told, and makes the video usable as a demo without reading. The research note `docs/research/narration-in-desktop-recordings.md` compared engines and prototyped the timing. The user's requirement is that narration should not get in the way: added silently when it costs a few seconds of processing, asked about when it costs more.

## Decision

**Engine.** Kokoro-82M through `sherpa-onnx-node`, loaded from the computer-use MCP's own Node runtime; no Python, no network, no account. The model (`kokoro-multi-lang-v1_0` from sherpa-onnx's releases, pinned by URL and SHA-256 in the Dockerfile) is unpacked into `/opt/sessionboxer/tts/kokoro`; the Chinese-only files (`dict/`, `lexicon-zh.txt`, `*-zh.fst`) are dropped, leaving about 360 MB in the image. Seven caption languages are offered (`en`, `en-gb`, `es`, `fr`, `hi`, `it`, `pt`), each with a default voice, and any of the model's voices for those languages can be named (`narration_voice`; the first letter encodes the language). Measured in a Sandbox: model load 1.3 s, synthesis 0.24 s per second of speech, re-encode 0.05 s per second of video.

**Process.** Synthesis runs in a child process (`narration-worker.js`) so the ~400 MB model leaves memory when done and a native crash cannot take the MCP with it. The worker speaks each caption into one clip, plans the timeline and writes a single WAV; the parent then runs one ffmpeg pass that re-times the video and muxes the WAV as mono AAC 64 kb/s into a temporary file, which replaces the original only after `ffprobe` confirms it has a duration. On any failure the silent video stays as it was and the tool result carries a `warning`.

**Timing.** Each sentence starts when its caption appears. When a sentence (plus a 0.4 s tail) outlasts the time its step is on screen, the step's last frame is held by the difference: `setpts` shifts everything from the next caption on by the accumulated extra and `tpad` clones the last frame for a sentence that runs past the end (`planNarration`). Only that lengthens the video; steps whose sentences fit are untouched. The same shift map re-times the captions, so the `.vtt` is rewritten and the tool result reports the new times. Narration is applied after condensing (ADR-0025): the visual holds are computed against the condensed timeline, which is the one the viewer sees.

**Policy.** `Settings.recordingNarration = { mode: ask | always | never, askAboveSeconds: 5 }`, default `ask`. The Control Plane hands it to every Sandbox's Daemon on connect and on change (`recording-prefs/set`); the Daemon writes it to `/dev/shm/sessionboxer/recording-prefs.json`, tmpfs, so Snapshots carry no preferences and the MCP reads the current value at `stop_recording`. With `ask`, the MCP estimates the processing time from the caption text (17 characters per second of speech, the calibration measured on the last run of this Sandbox — model load, real-time factor, encode rate — stored on tmpfs too) and narrates by itself when the estimate is at most `askAboveSeconds`; above it the result is `narration: { pending: true, estimatedSeconds, nextStep }` and the silent video is delivered. The agent is briefed to tell the user the estimate and ask; on a yes it calls the new `narrate_recording(path)` tool, which loads the captions back from the `.vtt`, narrates and replaces the file in place. `always` and `never` do what they say; an explicit `narrate: true|false` from the agent (only when the user asked in the conversation) overrides the policy, and a Sandbox without the model or the preference file behaves like `ask` with the default threshold.

## Considered Options

- **Piper** (rejected as default, see the research note): five times faster and 60 MB per language, but a robotic voice; may return as a fallback for languages Kokoro lacks.
- **`kokoro-js`** (rejected): English only, and a pure-JS runtime slower than sherpa-onnx.
- **Hosted TTS (OpenAI, ElevenLabs, Google)** (deferred): better voices, but a key, a network round trip and the captions leaving the machine; would be an opt-in provider.
- **Always ask** (rejected by the user): the question is noise when narration costs less than the answer takes.
- **Cut speech to fit the step instead of holding the frame** (rejected): speeding up or truncating sentences defeats the purpose; a held frame is what a human presenter does anyway.
- **Narrate before condensing** (rejected): the holds would be computed against wall-clock gaps that condensing then removes, so speech would overrun the condensed steps.
- **Load the model inside the MCP process** (rejected): keeps 400 MB resident for the Session's lifetime and ties the MCP's fate to a native library.
- **Padding the caption text into the audio timeline with silence in ffmpeg (`adelay` per clip)** (rejected): one WAV assembled by the worker is one input and no filter-graph quoting.

## Consequences

- The Sandbox image grows by about 360 MB (model) plus the `sherpa-onnx-node` native package; `npm run build:image` downloads the model archive once and verifies its checksum.
- A narrated video is longer than the silent one when sentences outrun their steps; the agent is told to keep captions to one sentence.
- Narration quality is Kokoro's: good in English, Spanish, French, Italian and Portuguese; Hindi acceptable; other languages fall back to English pronunciation of the text.
- The estimate is calibrated per Sandbox after the first narration; the first estimate uses conservative defaults (1.5 s load, 0.35 RTF), so the first long recording may be asked about when it would have fit.
- Older Sandboxes (image before this ADR) report `narration: { skipped: "no narration model…" }`; Stop → Resume after the image rebuild picks the new MCP up.
