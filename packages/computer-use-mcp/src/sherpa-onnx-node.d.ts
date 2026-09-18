declare module "sherpa-onnx-node" {
  interface KokoroModelConfig {
    model: string;
    voices: string;
    tokens: string;
    dataDir: string;
    lexicon?: string;
    lang?: string;
  }
  interface OfflineTtsConfig {
    model: { kokoro: KokoroModelConfig; numThreads: number; debug: number; provider?: string };
    maxNumSentences: number;
  }
  interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }
  class OfflineTts {
    constructor(config: OfflineTtsConfig);
    readonly numSpeakers: number;
    readonly sampleRate: number;
    generate(request: { text: string; sid: number; speed: number }): GeneratedAudio;
  }
  function writeWave(path: string, audio: { samples: Float32Array; sampleRate: number }): void;
  const sherpa: { OfflineTts: typeof OfflineTts; writeWave: typeof writeWave };
  export default sherpa;
}
