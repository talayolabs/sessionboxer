# Research: spoken narration in desktop recordings

Question (2026-09-18): when a recording is finished, can we also generate **audio** that reads the captions
(ADR-0026), so the video narrates itself? Kokoro was suggested; is there something better suited?

Short answer: yes. The captions are already timed text, so a local TTS pass at `stop_recording` can voice each
one and the result is muxed as an AAC track into the same `.mp4`. Prototype below: Kokoro through
`sherpa-onnx-node` (the same runtime family we would ship in the image), narration placed at each caption's time,
steps that are shorter than their sentence get their last frame held so speech never runs into the next step.
On this VM a 4-caption, 20 s clip took 1.3 s to load the model, 1.7 s to synthesise 5.8 s of speech and 0.2 s to
encode. Recommendation: **Kokoro-82M via sherpa-onnx-node, opt-in (`narrate: true`), in the image**, with
Piper as the "small image" fallback if the 400 MB turn out to matter.

## 1. Engines

Everything below runs on CPU inside the Sandbox (no GPU, no network, no key). Numbers marked *measured* are from
this VM (4 threads); the rest come from the projects' own docs/model cards and should be re-measured before
relying on them.

| Engine | Quality | Languages | Size in image | Speed (CPU) | Licence | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **Kokoro-82M** (v1.0, via `sherpa-onnx-node` 1.13.x) | Natural, best of the small open models; 54 voices | en, es, fr, hi, it, pt-br, zh (+ja in upstream, not in the sherpa build) | ~384 MB model dir (310 MB fp32 ONNX + 26 MB voices + espeak-ng data) + ~35 MB `sherpa-onnx-node`; an int8 quantisation brings the model to ~120 MB | *measured*: 1.1–1.4 s load, ~0.3× real time (3.2 s of speech in 1.0 s), Spanish same | Apache-2.0 (model, sherpa-onnx); phonemiser is espeak-ng (GPL-3, dynamically bundled by sherpa) | **Recommended.** Only small model with good non-English voices; the Spanish sample is intelligible and pleasant. |
| **Piper** (`vits-piper-*` ONNX, same `sherpa-onnx-node` runtime) | Clearly synthetic but intelligible ("GPS voice") | 30+ languages, one model per language/voice (~60–75 MB each, `medium` quality) | 60–75 MB per language; runtime shared with Kokoro | ~0.05–0.1× real time (not measured here; documented as faster than real time on a Pi 4) | MIT (models); the new `piper1-gpl` project is GPL-3 but we would not use it — the ONNX files run in sherpa | Fallback when image size matters more than voice quality, or to add a language Kokoro lacks (de, nl, pl, ru, …). Same code path: just a different `OfflineTts` config. |
| **Kitten TTS** (nano/mini, 15–80 M params, sherpa-onnx supports it) | Good for its size, English only | en | 25–80 MB | very fast | Apache-2.0 | English-only rules it out as the default; could be the "tiny" option later. |
| **Supertonic / Pocket TTS / Kyutai TTS** | Good, newer (2025–26) | Supertonic: en, ko, es, pt, fr, de …; Pocket TTS: en/fr | 100–300 MB | fast, ONNX / PyTorch | Apache-2.0 / CC-BY | Promising but immature in sherpa-onnx or PyTorch-only; revisit in a few months. |
| **espeak-ng / festival** (apt) | Robotic | many | 10 MB | instant | GPL-3 | Only as a last-resort fallback when no model is present; quality is not something we want in a demo video. |
| **Cloud TTS** (OpenAI `gpt-4o-mini-tts`, ElevenLabs, Azure) | Best | many | 0 | network latency; needs a key and sends the captions out | paid | Could be an optional provider later (Settings → TTS provider + key, injected like the other secrets); not for the default path — the recorder must work offline and without credentials. |

Why not `kokoro-js` (ONNX Runtime in JS)? It exists (1.2.x) but its README lists English voices only, it downloads
the model from Hugging Face at first use (no good in a box without network policy), and would be a second ONNX
runtime next to whatever we pick for Piper. `sherpa-onnx-node` covers Kokoro, Piper, Kitten and Matcha with one
API and ships prebuilt binaries for linux-x64 and arm64.

Why not Python (`pip install kokoro`)? It adds a 1 GB+ torch stack to the image and a runtime we do not have
elsewhere. sherpa-onnx is a single native module loaded from the MCP's own Node process.

## 2. How the audio lines up with the video

The captions ride through condensing (ADR-0025) by being burned in *before* `mpdecimate`, and the `.vtt` gets
its times through the kept-frame map (`retiming()` in `recording.ts`). Narration needs one more thing: a step
must be **at least as long as its sentence**, and it very often is not — the agent annotates and then acts within
a second, and condensing then squeezes the wait to `hold_seconds` (1.5 s). Reading "Submitting the form with an
empty e-mail to check the validation message" takes 4 s.

Rule chosen (prototyped): the narration for step *i* starts when caption *i* appears; if `speech_i + 0.4 s tail`
is longer than the step's on-screen time, the **last frame of the step is held** by the difference and everything
after shifts. So the action is shown while it is being described, the result state stays up until the sentence
ends, and the next caption/sentence starts on the next frame. Steps that are already long enough are untouched.
Holding the *first* frame instead (explain, then do) was rejected: it freezes the "before" state and makes the
video feel stalled.

Pipeline change in `finish()` (one encode, as today):

```
1. dry run    ffmpeg -i raw.mp4 -vf "<pad,ass>,mpdecimate,showinfo" -f null -   → kept frame times (decode only, ~fast)
2. plan       condensed time of every kept frame (existing setpts rule), caption i's first kept frame c_i,
              TTS each caption → clip_i (24 kHz mono Float32), need_i = len(clip_i) + tail,
              extra_i = max(0, need_i − (c_{i+1} − c_i)), starts_i = c_i + Σ_{j<i} extra_j
3. audio      one WAV of final length with clip_i written at starts_i (pure JS, no ffmpeg)
4. encode     same filter chain as today, with the setpts rule extended so the frame that opens step i+1 gets
              its gap raised to at least the remaining speech of step i; tpad so the last step can finish;
              -i narration.wav -map 0:v -map 1:a -c:a aac -b:a 64k -ac 1
5. vtt/result the retiming map now includes the narration holds; .vtt and the caption list use it
```

The dry run replaces "read `showinfo` from the encode pass" (what the code does now) — without narration we
can keep the single pass, so the dry run only costs when `narrate: true`. Spoken sentences longer than a step
are therefore the *only* thing that lengthens the video; a fully narrated 20 s demo grew 0.85 s in the prototype.
Without condensing (`condense: false`) the same rule applies to wall-clock gaps.

Prototype (`/home/ubuntu/tts-proto/narrate.cjs` on the dev VM, run on an already condensed recording):
`video 20.47 s → 21.32 s (+0.85 s of holds)`; ffmpeg `silencedetect` shows speech starting at 0.0, 2.44, 10.64,
15.32 s while the captions change at 0.0, 2.38, 10.58, 15.25 s — i.e. within one frame.

## 3. Text → speech details

- **Language / voice.** Kokoro voices are per language (`af_heart` en-US, `bf_emma` en-GB, `ef_dora` es, `ff_siwis` fr,
  `if_sara` it, `pf_dora` pt-br, `hf_alpha` hi, `zf_xiaobei` zh). Plan: `start_recording(narration_language?: string,
  narration_voice?: string)` with a per-language default voice table; the agent picks the language of its captions
  (the briefing tells it to caption in the user's language). One `OfflineTts` instance per language used
  (English uses the lexicon, others the `lang` field), loaded lazily in a **child process** so the ~500 MB of RAM
  is released after `stop_recording`.
- **Normalisation.** Captions are sentences already; before TTS: strip Markdown/backticks, expand `path/to/file.tsx`
  → "path to file dot t s x" is *not* worth it — read them as-is (Kokoro spells unknown tokens), cap a caption's
  speech at ~15 s (`speed` up to 1.2 for very long ones), and skip captions that reduce to nothing.
- **Speed.** `speed: 1.05–1.1` reads slightly faster than default and keeps holds short; make it a tool
  parameter with that default.
- **Format.** 24 kHz mono AAC at 64 kb/s (≈8 KB/s); the chat's `<video>` plays it with the existing controls.
  The `.vtt` and burned captions are unchanged, so a viewer can mute and still follow.
- **Failure.** Any TTS or mux error → keep the silent video, `narrated: false` + `warning`, like the condensing
  fallback today.

## 4. Cost

- Image: +~420 MB (fp32 Kokoro + runtime) or +~230 MB with the int8 model — worth measuring the int8 voice
  quality first; the current image is 4.5 GB. Model files are downloaded at image build from the sherpa-onnx
  GitHub release (pinned URL + sha256).
- Finalisation time: ~0.3× the speech length plus 1.3 s model load; a 3-minute demo with 30 captions of 4 s of
  speech each ≈ 40 s of CPU on this VM (Piper would be ~5–8 s). Acceptable for an opt-in; the agent's briefing
  should say so.
- RAM: ~500 MB while synthesising (child process, freed afterwards). Box memory limits apply.

## 5. Recommendation and effort

Build it as an opt-in on the existing tools: `start_recording(narrate?: boolean, narration_language?, narration_voice?)`
(so the agent decides up-front and the briefing can suggest it for demos), Kokoro through `sherpa-onnx-node`
in the image, pipeline as in §2, Piper reachable through the same config later for languages Kokoro lacks or a
"small" image variant. Web: nothing required (the `<video>` already has controls); a small speaker icon on the
video card marking "narrated" is nice to have. Effort: ~1 session + image rebuild. Decisions:

1. fp32 (best quality, +420 MB) vs int8 Kokoro (+230 MB, quality to be checked) — or make the model an
   image build arg.
2. Default off (agent must ask for it) vs default on when captions exist — off, until we have listened to a
   few real runs.
3. Whether to expose a global default voice/language in Settings (later; the tool parameters are enough to start).
