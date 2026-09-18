#!/usr/bin/env node
/**
 * Child process of `narrateRecording`: loads the Kokoro model (hundreds of MB that go away with
 * the process), speaks every caption, lays the clips out on the video's timeline and writes one
 * mono WAV. Input JSON on argv[2], plan JSON on stdout.
 */
import { readFileSync } from "node:fs";
import sherpa from "sherpa-onnx-node";
import { planNarration, type NarrationPlan } from "./narration-plan.js";

export interface WorkerInput {
  modelDir: string;
  /** espeak-ng language for the phonemiser; English uses the lexicon instead. */
  lang: string | null;
  lexicon: string | null;
  sid: number;
  speed: number;
  captions: { at: number; text: string }[];
  videoSeconds: number;
  tail: number;
  wavPath: string;
}

export interface WorkerOutput extends Omit<NarrationPlan, "map"> {
  speechSeconds: number;
  loadMs: number;
  synthMs: number;
}

const input = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as WorkerInput;
const d = input.modelDir;
let t = Date.now();
const tts = new sherpa.OfflineTts({
  model: {
    kokoro: {
      model: `${d}/model.onnx`,
      voices: `${d}/voices.bin`,
      tokens: `${d}/tokens.txt`,
      dataDir: `${d}/espeak-ng-data`,
      ...(input.lexicon ? { lexicon: `${d}/${input.lexicon}` } : {}),
      ...(input.lang ? { lang: input.lang } : {}),
    },
    numThreads: 4,
    debug: 0,
  },
  maxNumSentences: 1,
});
const loadMs = Date.now() - t;
t = Date.now();
const clips = input.captions.map((c) => {
  const audio = tts.generate({ text: c.text, sid: input.sid, speed: input.speed });
  if (audio.samples.length === 0) throw new Error(`nothing could be spoken for "${c.text}"`);
  return audio;
});
const synthMs = Date.now() - t;
const rate = clips[0]?.sampleRate ?? 24_000;
const plan = planNarration(
  input.captions.map((c, i) => ({ at: c.at, clipSeconds: (clips[i]?.samples.length ?? 0) / rate })),
  input.videoSeconds,
  input.tail,
);
const mix = new Float32Array(Math.ceil(plan.seconds * rate));
clips.forEach((clip, i) => {
  const offset = Math.round((plan.starts[i] ?? 0) * rate);
  for (let k = 0; k < clip.samples.length && offset + k < mix.length; k++) mix[offset + k] = clip.samples[k] ?? 0;
});
sherpa.writeWave(input.wavPath, { samples: mix, sampleRate: rate });
const out: WorkerOutput = {
  starts: plan.starts,
  shifts: plan.shifts,
  endHold: plan.endHold,
  seconds: plan.seconds,
  speechSeconds: clips.reduce((sum, c) => sum + c.samples.length / rate, 0),
  loadMs,
  synthMs,
};
process.stdout.write(JSON.stringify(out));
