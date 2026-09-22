# Dictation: the browser records, whisper.cpp on the host transcribes

The user wants to speak a prompt instead of typing it, offline, from the laptop and from a phone paired through a tunnel. Three ways were weighed:

- **OS dictation** (Win+H, the macOS/iOS/Android keyboard microphone) types into the composer already and runs on-device on current systems, but it is per-device setup with no button in the UI.
- **Web Speech API** (`SpeechRecognition`): Chrome sends the audio to Google (on-device only from Chrome 139 on desktop), Safari to Apple, Firefox has none — neither offline nor uniform.
- **Whisper**: in the browser (transformers.js/WebGPU, 40–150 MB per device, slow on phones) or on the host with whisper.cpp, one model for every device.

## Decision

**The browser records, the Control Plane transcribes with `whisper-cli`.** `apps/web/src/speech.ts` records with `MediaRecorder` (Opus in WebM/Ogg or AAC in MP4, whatever the browser offers), decodes the clip with Web Audio, downmixes and resamples it to 16 kHz mono 16-bit PCM WAV — what whisper.cpp reads without ffmpeg, and about a tenth of the raw 48 kHz stereo — and posts it to `POST /api/speech/transcribe` (`audio/wav`, 30 MB cap checked before and after reading the body; a recording stops itself after 10 minutes, 19 MB). The route inherits the `/api` login, so a paired phone uses the same tunnel and cookie as the rest of the UI; the clip is written to a private temporary directory (`0600`) for the one `whisper-cli` run and removed, and nothing about its content is logged.

**Tap to start, tap to stop, text appended, never sent.** The composer's 🎤 button toggles; while recording it turns red with a timer, then the line under the box shows *Preparing the clip…*, the download progress when a first use fetches `whisper-cli` or the model (the browser polls `GET /api/speech` once a second while the request is pending), *Transcribing…*, and errors for eight seconds. The transcript goes to the end of the draft (raw Markdown: `onChange` with a caret move; rich: `editor.chain().focus("end").insertContent`), after a space when needed, so what was typed or attached stays. Whether it is sent is the user's decision, as with a translation.

**Binaries and models are downloaded on first use, like `frpc`.** `whisper-cli` is looked for in `~/.sessionboxer/bin`, then on `PATH` (a user who built whisper.cpp with CUDA/Metal keeps it), else downloaded from *this* repository's Release `whisper-cpp-v<version>` (`.github/workflows/whisper-cpp.yml` builds static CPU-only binaries for linux amd64/arm64, macOS arm64/amd64 and Windows amd64 from the upstream tag; upstream publishes no Linux/macOS binaries) with the SHA-256 pinned in `speech.ts` for the current version and read from the Release's `SHA256SUMS` for another one (`SESSIONBOXER_WHISPER_CPP_VERSION`). Models come from `huggingface.co/ggerganov/whisper.cpp` with their LFS SHA-256 pinned, streamed to `ggml-<name>.bin.part` and renamed once verified. Both live under `SESSIONBOXER_HOME`, so a `docker compose` Control Plane keeps them on its data volume. `POST /api/speech/prepare` starts the downloads without a clip (Settings → Download now); `DELETE /api/speech/models/:name` removes a model other than the selected one.

**`small` by default, language `auto`, both in Settings.** Measured on an 8-thread CPU per 11–20 s clip: `tiny` 0.8 s, `base` 1.2 s, `small` 2.9 s, `medium-q5_0` 7.5 s with the language fixed, roughly double with detection; Whisper's published word error rates on Spanish/English read speech are 16/12 % (`tiny`), 10/9 % (`base`), 5.6/6.1 % (`small`), 3.6/4.4 % (`medium`). `small` is the first that gets Spanish right most of the time and still answers within a few seconds; `large-v3-turbo-q5_0` is offered for machines with a GPU build on `PATH`. `SpeechSettings` (`model`, `language` = `auto` or a 2–3 letter code) is part of `Settings`; a request may override the language (`?language=`).

**One transcription at a time**, `min(8, cores − 1)` threads: the models are memory-bound, two at once are slower than one after the other, and the boxes need cores too. `SpeechStatus.busy` shows the queue.

## Consequences

- The microphone needs a secure context: `localhost` or `https://` (any tunnel). Over plain `http://` on the LAN the button explains that and OS dictation remains.
- Decoding happens in the browser; an old browser that cannot decode what its own `MediaRecorder` produced gets an error rather than a silent upload of raw audio.
- Whisper occasionally hallucinates a phrase on silence or noise; the text is appended, not sent, so the user sees it first.
- No streaming/live transcription: a clip is transcribed when it ends. Whisper works on 30 s windows and a whole prompt is a few seconds anyway.
- Not done here: a hold-to-talk mode, push of the transcript to the Agent as it speaks, GPU builds of `whisper-cli` (the user can put one on `PATH`), speaker- or session-level vocabulary.
