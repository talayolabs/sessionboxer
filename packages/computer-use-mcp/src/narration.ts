import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Caption } from "./recording.js";
import type { WorkerInput, WorkerOutput } from "./narration-worker.js";

const TMPFS = process.env.SESSIONBOXER_TMPFS ?? "/dev/shm/sessionboxer";
/** Kokoro model directory as unpacked from sherpa-onnx's `kokoro-multi-lang-v1_0` release (see the Dockerfile). */
const MODEL_DIR = process.env.SESSIONBOXER_TTS_MODEL ?? "/opt/sessionboxer/tts/kokoro";
/** Written by the Sandbox Daemon from `Settings` (`recording/prefs`); absent in a Sandbox that predates it. */
const PREFS_FILE = `${TMPFS}/recording-prefs.json`;
/** Speeds measured on the last run, so the estimate reflects this machine rather than the developer's. */
const CALIBRATION_FILE = `${TMPFS}/narration-calibration.json`;
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "narration-worker.js");
const WORKER_TIMEOUT_MS = 600_000;
const ENCODE_TIMEOUT_MS = 180_000;
/** Silence after a sentence before the next step may begin. */
const TAIL_SECONDS = 0.4;
/** Characters of caption text Kokoro speaks per second at speed 1 (measured: 17 in English and Spanish). */
const CHARS_PER_SECOND = 17;

const execFileAsync = promisify(execFile);

export type NarrationMode = "ask" | "always" | "never";

export interface NarrationPrefs {
  mode: NarrationMode;
  /** With `mode: "ask"`, narration is added without asking when the estimate is at most this. */
  askAboveSeconds: number;
}

export const DEFAULT_NARRATION_PREFS: NarrationPrefs = { mode: "ask", askAboveSeconds: 5 };

export interface NarrationOptions {
  /** One of `NARRATION_LANGUAGES`; the voice's language when a voice is given. */
  language: string | undefined;
  /** A Kokoro voice name (`af_heart`, `ef_dora`, ...); the language's default when omitted. */
  voice: string | undefined;
  speed: number;
}

export interface Narrated {
  seconds: number;
  /** Time in the silent video → time in the narrated one. */
  map: (t: number) => number;
  speechSeconds: number;
  processingSeconds: number;
  language: string;
  voice: string;
}

interface Calibration {
  loadSeconds: number;
  /** Seconds of synthesis per second of speech. */
  rtf: number;
  /** Seconds of encoding per second of video. */
  encodeRate: number;
}

const DEFAULT_CALIBRATION: Calibration = { loadSeconds: 1.5, rtf: 0.35, encodeRate: 0.03 };

interface Language {
  /** espeak-ng language for the phonemiser; English goes through the lexicon instead. */
  lang: string | null;
  lexicon: string | null;
  voice: string;
  /** First letter of the voice names that speak it. */
  prefix: string;
}

const LANGUAGES: Record<string, Language> = {
  en: { lang: null, lexicon: "lexicon-us-en.txt", voice: "af_heart", prefix: "a" },
  "en-gb": { lang: null, lexicon: "lexicon-gb-en.txt", voice: "bf_emma", prefix: "b" },
  es: { lang: "es", lexicon: null, voice: "ef_dora", prefix: "e" },
  fr: { lang: "fr", lexicon: null, voice: "ff_siwis", prefix: "f" },
  hi: { lang: "hi", lexicon: null, voice: "hf_alpha", prefix: "h" },
  it: { lang: "it", lexicon: null, voice: "if_sara", prefix: "i" },
  pt: { lang: "pt-br", lexicon: null, voice: "pf_dora", prefix: "p" },
};
export const NARRATION_LANGUAGES = Object.keys(LANGUAGES);

/** Speaker ids of `kokoro-multi-lang-v1_0` (`id2speaker` in the model's metadata). */
const VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  "ef_dora", "em_alex", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola",
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa",
  "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang", "em_santa",
];
export const NARRATION_VOICES = VOICES.filter((v) => Object.values(LANGUAGES).some((l) => v.startsWith(l.prefix)));

export function narrationAvailable(): boolean {
  return ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"].every((f) => existsSync(join(MODEL_DIR, f)));
}

export function narrationPrefs(): NarrationPrefs {
  try {
    const raw = JSON.parse(readFileSync(PREFS_FILE, "utf8")) as Partial<NarrationPrefs>;
    return {
      mode: raw.mode === "always" || raw.mode === "never" || raw.mode === "ask" ? raw.mode : DEFAULT_NARRATION_PREFS.mode,
      askAboveSeconds: typeof raw.askAboveSeconds === "number" && raw.askAboveSeconds >= 0 ? raw.askAboveSeconds : DEFAULT_NARRATION_PREFS.askAboveSeconds,
    };
  } catch {
    return DEFAULT_NARRATION_PREFS;
  }
}

function calibration(): Calibration {
  try {
    const raw = JSON.parse(readFileSync(CALIBRATION_FILE, "utf8")) as Partial<Calibration>;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
    return { loadSeconds: num(raw.loadSeconds, DEFAULT_CALIBRATION.loadSeconds), rtf: num(raw.rtf, DEFAULT_CALIBRATION.rtf), encodeRate: num(raw.encodeRate, DEFAULT_CALIBRATION.encodeRate) };
  } catch {
    return DEFAULT_CALIBRATION;
  }
}

/** Expected processing time (model load, synthesis, re-encode) for narrating these captions, in seconds. */
export function estimateNarrationSeconds(captions: Caption[], videoSeconds: number, speed: number): number {
  const c = calibration();
  const chars = captions.reduce((n, cap) => n + cap.text.length, 0);
  const speech = chars / CHARS_PER_SECOND / speed;
  return Math.round((c.loadSeconds + c.rtf * speech + c.encodeRate * (videoSeconds + speech)) * 10) / 10;
}

export function resolveNarrationVoice(opts: NarrationOptions): { language: string; voice: string } {
  const { language, voice } = resolveVoice(opts);
  return { language, voice };
}

function resolveVoice(opts: NarrationOptions): { language: string; voice: string; sid: number; def: Language } {
  if (opts.voice !== undefined) {
    const sid = VOICES.indexOf(opts.voice);
    const entry = Object.entries(LANGUAGES).find(([, l]) => opts.voice?.startsWith(l.prefix));
    if (sid < 0 || !entry) throw new Error(`unknown narration voice "${opts.voice}"; one of ${NARRATION_VOICES.join(", ")}`);
    if (opts.language !== undefined && opts.language !== entry[0]) throw new Error(`voice ${opts.voice} speaks ${entry[0]}, not ${opts.language}`);
    return { language: entry[0], voice: opts.voice, sid, def: entry[1] };
  }
  const language = opts.language ?? "en";
  const def = LANGUAGES[language];
  if (!def) throw new Error(`unsupported narration language "${language}"; one of ${NARRATION_LANGUAGES.join(", ")}`);
  return { language, voice: def.voice, sid: VOICES.indexOf(def.voice), def };
}

/**
 * Speaks the captions (times in the video's own timeline) and rewrites the video in place with
 * the narration as an AAC track. Steps shorter than their sentence hold their last frame (see
 * `planNarration`), so the video may get longer; the returned `map` re-times anything that
 * referred to the silent video.
 */
export async function narrateVideo(path: string, captions: Caption[], videoSeconds: number, fps: number, opts: NarrationOptions): Promise<Narrated> {
  if (!narrationAvailable()) throw new Error(`no narration model at ${MODEL_DIR}; the Sandbox image predates narration`);
  if (captions.length === 0) throw new Error("nothing to narrate: the recording has no captions");
  const { language, voice, sid, def } = resolveVoice(opts);
  const stem = path.slice(0, -4);
  const tmp = `${stem}.narrating.mp4`;
  const wav = `${TMPFS}/narration-${process.pid}.wav`;
  const inputFile = `${TMPFS}/narration-${process.pid}.json`;
  const scriptFile = `${TMPFS}/narration-${process.pid}.filter`;
  const started = Date.now();
  const input: WorkerInput = { modelDir: MODEL_DIR, lang: def.lang, lexicon: def.lexicon, sid, speed: opts.speed, captions, videoSeconds, tail: TAIL_SECONDS, wavPath: wav };
  writeFileSync(inputFile, JSON.stringify(input));
  try {
    const { stdout } = await execFileAsync(process.execPath, [WORKER, inputFile], { timeout: WORKER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }).catch((e: unknown) => {
      const stderr = typeof e === "object" && e !== null && "stderr" in e && typeof e.stderr === "string" ? e.stderr.trim().split("\n").slice(-3).join("\n") : "";
      throw new Error(`speech synthesis failed: ${stderr || (e instanceof Error ? e.message : String(e))}`);
    });
    const plan = JSON.parse(stdout) as WorkerOutput;
    const half = 1 / (2 * fps);
    let expr = "PTS";
    for (const s of plan.shifts) expr += `+gte(T\\,${(s.from - half).toFixed(4)})*${s.extra.toFixed(4)}/TB`;
    writeFileSync(scriptFile, `setpts=${expr},\ntpad=stop_mode=clone:stop_duration=${plan.endHold.toFixed(3)}`);
    const encodeStarted = Date.now();
    rmSync(tmp, { force: true });
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-nostats",
        "-i", path, "-i", wav,
        "-filter_script:v", scriptFile, "-fps_mode", "vfr",
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k", "-ac", "1",
        "-movflags", "+faststart", "-y", tmp,
      ],
      { timeout: ENCODE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    ).catch((e: unknown) => {
      const stderr = typeof e === "object" && e !== null && "stderr" in e && typeof e.stderr === "string" ? e.stderr.trim().split("\n").slice(-3).join("\n") : "";
      throw new Error(`muxing the narration failed: ${stderr || (e instanceof Error ? e.message : String(e))}`);
    });
    const { stdout: probe } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp], { timeout: 30_000 });
    const seconds = Number.parseFloat(probe.trim());
    if (!Number.isFinite(seconds) || seconds <= 0 || statSync(tmp).size === 0) throw new Error("narrated video is empty");
    renameSync(tmp, path);
    const encodeSeconds = (Date.now() - encodeStarted) / 1000;
    writeFileSync(
      CALIBRATION_FILE,
      JSON.stringify({
        loadSeconds: plan.loadMs / 1000,
        rtf: plan.speechSeconds > 0 ? plan.synthMs / 1000 / plan.speechSeconds : DEFAULT_CALIBRATION.rtf,
        encodeRate: encodeSeconds / Math.max(1, seconds),
      } satisfies Calibration),
    );
    const map = (t: number): number => {
      let out = t;
      for (const s of plan.shifts) if (t >= s.from - half) out += s.extra;
      return out;
    };
    return { seconds, map, speechSeconds: plan.speechSeconds, processingSeconds: (Date.now() - started) / 1000, language, voice };
  } finally {
    rmSync(tmp, { force: true });
    rmSync(wav, { force: true });
    rmSync(inputFile, { force: true });
    rmSync(scriptFile, { force: true });
  }
}
