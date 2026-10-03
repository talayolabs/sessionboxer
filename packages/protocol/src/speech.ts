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

/**
 * `GET /api/sandbox-image`: whether the Sandbox image is on this machine. The first Session waits
 * on a multi-GB pull, so the UI shows where it stands instead of a silent "Creating…".
 */
export const SandboxImageStatus = z.object({
  image: z.string(),
  state: z.enum(["checking", "pulling", "ready", "error"]),
  /** Bytes so far and in total across the layers Docker has announced (0 until known). */
  received: z.number(),
  total: z.number(),
  error: z.string().nullable(),
});
export type SandboxImageStatus = z.infer<typeof SandboxImageStatus>;

/**
 * `GET /api/windows`: the shared Windows base disk every `qemu-windows` Session's VM starts from
 * (ADR-0057). Installed once from Microsoft's media by `POST /api/windows/install` (a long
 * unattended install); a Session cannot be created while it is `missing`.
 */
export const WindowsBaseStatus = z.object({
  state: z.enum(["missing", "installing", "ready", "error"]),
  /** The Windows edition the base was (or is being) installed with, a `WindowsSettings.version` code. */
  version: z.string().nullable(),
  /** Bytes the base disk takes on this machine (0 until installed). */
  sizeBytes: z.number(),
  /** ISO 8601, while `installing`. */
  startedAt: z.string().nullable(),
  /** The last lines the installer printed, while `installing` or after an `error`. */
  log: z.array(z.string()),
  error: z.string().nullable(),
  /** Sessions whose VM disk builds on this base; it cannot be reinstalled while there are any. */
  sessions: z.number().int().nonnegative(),
});
export type WindowsBaseStatus = z.infer<typeof WindowsBaseStatus>;

/**
 * `GET /api/macos`: the shared macOS base disk every `qemu-macos` Session's VM starts from
 * (ADR-0059). Unlike Windows, macOS has no unattended installer: `POST /api/macos/install` boots
 * Apple's Recovery in a VM (`installing`), then the user installs macOS and creates the account by
 * hand in the VM's screen (`setup`); once the guest answers on SSH the Control Plane finishes the
 * base (`finishing`) and shuts the VM down (`ready`).
 */
export const MacosBaseStatus = z.object({
  state: z.enum(["missing", "installing", "setup", "finishing", "ready", "error"]),
  /**
   * Whether the base carries the toolchain the Agent needs in the guest (Node, git, uv, the Provider
   * CLIs; ADR-0061). False for a base installed before that: "Reprovision" adds it in place.
   */
  toolchain: z.boolean(),
  /** While `installing`/`setup`/`finishing`: this run only reprovisions an existing base (no Recovery, no Setup Assistant). */
  reprovisioning: z.boolean(),
  /** The macOS release the base was (or is being) installed with, a `MacosSettings.version` code. */
  version: z.string().nullable(),
  /** Bytes the base disk takes on this machine (0 until installed). */
  sizeBytes: z.number(),
  /** ISO 8601, while `installing`, `setup` or `finishing`. */
  startedAt: z.string().nullable(),
  /** The last lines the VM container printed, while installing or after an `error`. */
  log: z.array(z.string()),
  error: z.string().nullable(),
  /** Sessions whose VM disk builds on this base; it cannot be reinstalled while there are any. */
  sessions: z.number().int().nonnegative(),
  /**
   * While `setup`: the account the user must create in the guest, so the Sandbox can log in over
   * SSH later, and where the VM's screen is (`GET /api/macos/screen`, a noVNC websocket).
   */
  setup: z
    .object({
      user: z.string(),
      password: z.string(),
      /** The steps left, as shown in Global settings. */
      steps: z.array(z.string()),
    })
    .nullable(),
});
export type MacosBaseStatus = z.infer<typeof MacosBaseStatus>;

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
