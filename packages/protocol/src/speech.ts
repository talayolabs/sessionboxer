// ---------------------------------------------------------------------------
// Speech to text (`/api/speech/...`): the browser records a clip, the Control Plane transcribes
// it on the host with whisper.cpp (`whisper-cli` + a ggml model, both downloaded on first use).
// ---------------------------------------------------------------------------

import { z } from "zod";

/** ggml Whisper models offered in Settings (files of ggerganov/whisper.cpp on Hugging Face). */
export const SPEECH_MODELS = ["tiny", "base", "small", "medium-q5_0", "large-v3-turbo-q5_0"] as const;
export const SpeechModel = z.enum(SPEECH_MODELS);
export type SpeechModel = z.infer<typeof SpeechModel>;
export const DEFAULT_SPEECH_MODEL: SpeechModel = "small";

/** Download size and a one-line placement of each model (word error rates from the Whisper paper, read speech). */
export const SPEECH_MODEL_INFO: Record<SpeechModel, { label: string; bytes: number; note: string }> = {
  tiny: { label: "tiny", bytes: 77_691_713, note: "fastest, rough (Spanish ~16% of words wrong)" },
  base: { label: "base", bytes: 147_951_465, note: "quick, usable for short English prompts" },
  small: { label: "small", bytes: 487_601_967, note: "default: good English and Spanish, ~3 s per prompt on a laptop CPU" },
  "medium-q5_0": { label: "medium (q5_0)", bytes: 539_212_467, note: "more accurate, 2–3× slower than small" },
  "large-v3-turbo-q5_0": { label: "large-v3-turbo (q5_0)", bytes: 574_041_195, note: "most accurate; slower than medium on a CPU, fast with a GPU (Apple Silicon)" },
};

/** `auto` lets Whisper detect the language per clip (slower); an ISO 639-1 code fixes it. */
export const SPEECH_LANGUAGE_PATTERN = /^(auto|[a-z]{2,3})$/;

/** `Settings.speech`. */
export const SpeechSettings = z.object({
  model: SpeechModel.default(DEFAULT_SPEECH_MODEL),
  language: z.string().regex(SPEECH_LANGUAGE_PATTERN, "a two-letter language code or auto").default("auto"),
});
export type SpeechSettings = z.infer<typeof SpeechSettings>;

/** Where a downloadable piece stands; `downloading` carries the byte count so the UI can show a percentage. */
export const SpeechAssetState = z.enum(["ready", "missing", "downloading", "error"]);
export type SpeechAssetState = z.infer<typeof SpeechAssetState>;

/** `GET /api/speech`: whether transcription can run right now and what it is waiting for. */
export const SpeechStatus = z.object({
  engine: z.object({
    state: SpeechAssetState,
    /** whisper.cpp version of the `whisper-cli` in use, when found. */
    version: z.string().nullable(),
    path: z.string().nullable(),
    error: z.string().nullable(),
  }),
  model: z.object({
    name: SpeechModel,
    state: SpeechAssetState,
    received: z.number(),
    total: z.number(),
    error: z.string().nullable(),
  }),
  /** Models present on disk. */
  downloaded: z.array(SpeechModel),
  /** Transcriptions running or waiting (they run one at a time). */
  busy: z.number().int().nonnegative(),
});
export type SpeechStatus = z.infer<typeof SpeechStatus>;

/** `POST /api/speech/transcribe` (body: the clip as 16 kHz mono PCM WAV; `?language=` overrides Settings). */
export const Transcription = z.object({
  text: z.string(),
  /** Language Whisper used or detected. */
  language: z.string(),
  /** Clip length in seconds. */
  seconds: z.number(),
  /** Wall time of the transcription in milliseconds (downloads excluded). */
  tookMs: z.number(),
  model: SpeechModel,
});
export type Transcription = z.infer<typeof Transcription>;

/** One stretch of speech with its place in the clip, in seconds. */
export const TranscriptionSegment = z.object({ start: z.number(), end: z.number(), text: z.string() });
export type TranscriptionSegment = z.infer<typeof TranscriptionSegment>;
/** A `Transcription` with its segments: what the Agent's `transcribe_media` returns. */
export const TimedTranscription = Transcription.extend({ segments: z.array(TranscriptionSegment) });
export type TimedTranscription = z.infer<typeof TimedTranscription>;

/** Largest clip accepted (16 kHz mono 16-bit is 32 kB/s, so about 15 minutes). */
export const SPEECH_CLIP_MAX_BYTES = 30 * 1024 * 1024;
