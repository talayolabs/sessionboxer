import type { SpeechStatus, Transcription } from "@sessionboxer/protocol";
import { api } from "./api";

/**
 * Dictation into the composer: record with `MediaRecorder`, re-encode the clip as 16 kHz mono
 * PCM WAV (what whisper.cpp reads without ffmpeg; also ~10× smaller than what a phone would
 * upload as raw 48 kHz), post it to the Control Plane. Needs a secure context for the microphone
 * (localhost or the https tunnel), like the desktop's clipboard.
 */

export const WHISPER_RATE = 16_000;
/** Whisper works on 30 s windows; long dictations are fine, but the button stops itself here. */
export const MAX_RECORDING_S = 10 * 60;

export type MicSupport = { ok: true } | { ok: false; reason: string };

export function micSupport(): MicSupport {
  if (typeof window === "undefined") return { ok: false, reason: "no window" };
  if (!window.isSecureContext) return { ok: false, reason: "The microphone needs https or localhost; open Sessionboxer through its tunnel or on this machine." };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: "This browser has no microphone access (getUserMedia)." };
  if (typeof MediaRecorder === "undefined") return { ok: false, reason: "This browser cannot record audio (MediaRecorder)." };
  if (typeof AudioContext === "undefined") return { ok: false, reason: "This browser cannot decode audio (Web Audio)." };
  return { ok: true };
}

export interface Recording {
  /** Stops the microphone and resolves with the clip as a WAV Blob. */
  stop: () => Promise<Blob>;
  /** Stops the microphone and drops the clip. */
  cancel: () => void;
}

function pickMimeType(): string | undefined {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  recorder.start(1000);
  return {
    stop: async () => {
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      release();
      const raw = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
      if (raw.size === 0) throw new Error("Nothing was recorded.");
      return toWav(raw);
    },
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}

/** Decodes any clip the browser can play and re-encodes it as 16 kHz mono 16-bit PCM WAV. */
export async function toWav(clip: Blob): Promise<Blob> {
  const bytes = await clip.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes);
  } finally {
    void ctx.close();
  }
  const mono = downmix(decoded);
  const samples = decoded.sampleRate === WHISPER_RATE ? mono : resample(mono, decoded.sampleRate, WHISPER_RATE);
  return new Blob([encodeWav(samples, WHISPER_RATE)], { type: "audio/wav" });
}

function downmix(buffer: AudioBuffer): Float32Array {
  const n = buffer.numberOfChannels;
  if (n === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < n; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) + (data[i] ?? 0) / n;
  }
  return out;
}

/** Linear interpolation is plenty for speech going down to 16 kHz. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/** One line for the composer while a transcription waits on downloads or the queue. */
export function describeSpeechStatus(s: SpeechStatus): string {
  if (s.engine.state === "downloading") return "Downloading whisper.cpp…";
  if (s.engine.state === "error") return `whisper.cpp: ${s.engine.error ?? "unavailable"}`;
  if (s.model.state === "downloading") {
    const pct = s.model.total > 0 ? Math.floor((100 * s.model.received) / s.model.total) : 0;
    return `Downloading the ${s.model.name} model… ${pct}% of ${Math.round(s.model.total / 1e6)} MB`;
  }
  if (s.model.state === "error") return `Model download: ${s.model.error ?? "failed"}`;
  return s.busy > 1 ? "Transcribing (another clip is ahead)…" : "Transcribing…";
}

/** Posts the clip and reports the Control Plane's status about once a second until it answers. */
export async function transcribe(wav: Blob, onStatus: (line: string) => void, signal?: AbortSignal): Promise<Transcription> {
  const request = api.transcribe(wav, signal);
  let done = false;
  void request.finally(() => (done = true));
  const poll = async () => {
    await new Promise((r) => setTimeout(r, 700));
    while (!done) {
      try {
        const status = await api.speechStatus();
        if (!done) onStatus(describeSpeechStatus(status));
      } catch {
        // the transcription request reports the real failure
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  void poll();
  return request;
}
