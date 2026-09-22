/**
 * Speech to text on the host with whisper.cpp: the browser records a clip and posts it as a
 * 16 kHz mono WAV; `whisper-cli` (downloaded from this repository's `whisper-cpp-v*` Release for
 * the platform, like frpc) transcribes it with a ggml model fetched from Hugging Face on first
 * use. Both live under `~/.sessionboxer` (`bin/whisper-cli`, `models/whisper/ggml-<name>.bin`),
 * so a `docker compose` Control Plane keeps them on its data volume. Clips are written to a
 * private temporary directory for the duration of one run and removed; nothing about their
 * content is logged. Transcriptions run one at a time: the models are memory-bound and two at
 * once would only be slower.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { SPEECH_MODEL_INFO, SPEECH_MODELS, type SpeechModel, type SpeechSettings, type SpeechStatus, type Transcription } from "@sessionboxer/protocol";
import { DATA_DIR } from "./config.js";
import { HttpError } from "./http-error.js";
import { BIN_DIR, download, fetchOrExplain, findBinary, probeVersion, untarFile, type Binary } from "./tunnel-base.js";

/** whisper.cpp version whose `whisper-cli` is downloaded (built by .github/workflows/whisper-cpp.yml). */
export const WHISPER_CPP_VERSION = process.env.SESSIONBOXER_WHISPER_CPP_VERSION ?? "1.9.4";
const RELEASES = "https://github.com/talayolabs/sessionboxer/releases/download";
/** SHA-256 of the archives of `whisper-cpp-v1.9.4` (its `SHA256SUMS`); other versions fetch that file. */
const PINNED_SHA256: Record<string, string> = {
  "whisper-cli-1.9.4-darwin-amd64.tar.gz": "8bbff39709e2fe403e124fb908c922b6a438fcf158e623ee415cb71b1079c1af",
  "whisper-cli-1.9.4-darwin-arm64.tar.gz": "5983ab64ff525dfe4ce4a27addc892344cf2a501ed1ae46569456a559e78bfa1",
  "whisper-cli-1.9.4-linux-amd64.tar.gz": "0e23b728f712246697667f9dec9134318754a586d6a8adc4378b34477e584199",
  "whisper-cli-1.9.4-linux-arm64.tar.gz": "df672d512b85720ffb9906942fca6dc74e2bcab489f54e154d22925c51fddc2f",
  "whisper-cli-1.9.4-windows-amd64.tar.gz": "5748086d8e0f0b84b144cd54c05fd3e6fe05b1d0998b8696fb27e0713cd73862",
};
/** Model files of https://huggingface.co/ggerganov/whisper.cpp (their Git LFS SHA-256). */
const MODELS_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const MODEL_SHA256 = {
  tiny: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
  base: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  small: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  "medium-q5_0": "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
  "large-v3-turbo-q5_0": "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
} satisfies Record<SpeechModel, string>;
export const MODELS_DIR = join(DATA_DIR, "models", "whisper");
/** A clip longer than this is refused by the browser; the run itself is capped generously below. */
const RUN_TIMEOUT_MS = 10 * 60_000;
/** Whisper is memory-bound past a handful of threads; leave cores for the boxes. */
const THREADS = Math.max(1, Math.min(8, availableParallelism() - 1));

const cliVersion = (path: string) => probeVersion(path, ["--version"], (out) => /whisper\.cpp version:\s*(\S+)/.exec(out)?.[1] ?? null);

function releaseAsset(): string {
  const os = platform();
  const cpu = arch();
  const archName = cpu === "x64" ? "amd64" : cpu === "arm64" ? "arm64" : null;
  const osName = os === "linux" || os === "darwin" ? os : os === "win32" ? "windows" : null;
  if (archName === null || osName === null || (osName === "windows" && archName !== "amd64")) {
    throw new Error(`whisper-cli is not downloaded automatically for ${os}/${cpu}; build whisper.cpp yourself and put whisper-cli on the PATH or in ${BIN_DIR}.`);
  }
  return `whisper-cli-${WHISPER_CPP_VERSION}-${osName}-${archName}.tar.gz`;
}

async function expectedSha256(asset: string): Promise<string> {
  const pinned = PINNED_SHA256[asset];
  if (pinned) return pinned;
  const text = (await download(`${RELEASES}/whisper-cpp-v${WHISPER_CPP_VERSION}/SHA256SUMS`)).toString("utf8");
  const m = new RegExp(`^([0-9a-f]{64})\\s+\\*?${asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").exec(text);
  if (!m) throw new Error(`no checksum listed for ${asset} in whisper-cpp-v${WHISPER_CPP_VERSION}`);
  return m[1]!;
}

export const modelFile = (model: SpeechModel): string => join(MODELS_DIR, `ggml-${model}.bin`);

/** Streams `url` into `target` (via `.part`), verifying its SHA-256; `onProgress` gets bytes so far and the total (0 when unknown). */
async function downloadTo(url: string, target: string, expected: string, onProgress: (received: number, total: number) => void): Promise<void> {
  const res = await fetchOrExplain(url, { redirect: "follow", headers: { "user-agent": "sessionboxer" } });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0) || 0;
  const hash = createHash("sha256");
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      hash.update(chunk);
      onProgress(received, total);
      cb(null, chunk);
    },
  });
  const part = `${target}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as NodeReadableStream), counter, createWriteStream(part, { mode: 0o644 }));
    const actual = hash.digest("hex");
    if (actual !== expected) throw new Error(`checksum mismatch for ${url}`);
    renameSync(part, target);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}

interface Job {
  promise: Promise<void>;
  received: number;
  total: number;
}

/** PCM WAV header check; returns the clip length in seconds. */
function wavSeconds(wav: Buffer): number {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new HttpError(400, "The clip is not a WAV file.");
  let offset = 12;
  let rate = 0;
  let bytesPerSecond = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      if (wav.readUInt16LE(offset + 8) !== 1) throw new HttpError(400, "The clip must be uncompressed PCM WAV.");
      rate = wav.readUInt32LE(offset + 12);
      bytesPerSecond = wav.readUInt32LE(offset + 16);
    } else if (id === "data") {
      if (bytesPerSecond === 0 || rate === 0) throw new HttpError(400, "The clip's WAV header is incomplete.");
      return Math.min(size, wav.length - offset - 8) / bytesPerSecond;
    }
    offset += 8 + size + (size % 2);
  }
  throw new HttpError(400, "The clip's WAV header is incomplete.");
}

export class Speech {
  private engine: Binary | null = null;
  private engineJob: Promise<Binary> | null = null;
  private engineError: string | null = null;
  private readonly modelJobs = new Map<SpeechModel, Job>();
  private readonly modelErrors = new Map<SpeechModel, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;

  constructor(private readonly log: (msg: string) => void) {}

  async status(settings: SpeechSettings): Promise<SpeechStatus> {
    const engine = this.engine ?? (this.engineJob ? null : await this.findEngine());
    const job = this.modelJobs.get(settings.model);
    const modelError = this.modelErrors.get(settings.model) ?? null;
    const modelReady = existsSync(modelFile(settings.model));
    const total = job?.total ?? SPEECH_MODEL_INFO[settings.model].bytes;
    return {
      engine: {
        state: engine ? "ready" : this.engineJob ? "downloading" : this.engineError ? "error" : "missing",
        version: engine?.version ?? null,
        path: engine?.path ?? null,
        error: engine || this.engineJob ? null : this.engineError,
      },
      model: {
        name: settings.model,
        state: modelReady ? "ready" : job ? "downloading" : modelError ? "error" : "missing",
        received: modelReady ? total : (job?.received ?? 0),
        total,
        error: job ? null : modelError,
      },
      downloaded: this.downloaded(),
      busy: this.busy,
    };
  }

  /** Starts fetching what `settings` needs and returns at once; `status()` follows the progress. */
  async prepare(settings: SpeechSettings): Promise<SpeechStatus> {
    void this.ensureEngine().catch(() => undefined);
    void this.ensureModel(settings.model).catch(() => undefined);
    return this.status(settings);
  }

  /** Transcribes a 16 kHz mono PCM WAV clip, downloading engine and model first when missing. */
  async transcribe(wav: Buffer, settings: SpeechSettings, languageOverride: string | null): Promise<Transcription> {
    const seconds = wavSeconds(wav);
    if (seconds < 0.3) throw new HttpError(400, "The clip is too short.");
    this.busy += 1;
    try {
      const [engine] = await Promise.all([this.ensureEngine(), this.ensureModel(settings.model)]);
      const run = this.queue.then(() => this.run(engine, wav, settings.model, languageOverride ?? settings.language));
      this.queue = run.catch(() => undefined);
      const result = await run;
      return { ...result, seconds };
    } finally {
      this.busy -= 1;
    }
  }

  private downloaded(): SpeechModel[] {
    if (!existsSync(MODELS_DIR)) return [];
    const files = new Set(readdirSync(MODELS_DIR));
    return SPEECH_MODELS.filter((m) => files.has(`ggml-${m}.bin`));
  }

  private async findEngine(): Promise<Binary | null> {
    const found = await findBinary("whisper-cli", cliVersion);
    if (found) this.engine = found;
    return found;
  }

  private ensureEngine(): Promise<Binary> {
    if (this.engine) return Promise.resolve(this.engine);
    if (this.engineJob) return this.engineJob;
    this.engineJob = (async () => {
      const found = await this.findEngine();
      if (found) return found;
      const asset = releaseAsset();
      this.log(`whisper-cli not found; downloading whisper.cpp ${WHISPER_CPP_VERSION} (${asset})`);
      mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
      const [data, expected] = await Promise.all([download(`${RELEASES}/whisper-cpp-v${WHISPER_CPP_VERSION}/${asset}`), expectedSha256(asset)]);
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== expected) throw new Error(`checksum mismatch for ${asset}`);
      const name = platform() === "win32" ? "whisper-cli.exe" : "whisper-cli";
      const target = join(BIN_DIR, name);
      writeFileSync(`${target}.part`, await untarFile(data, name));
      renameSync(`${target}.part`, target);
      chmodSync(target, 0o755);
      const version = await cliVersion(target);
      if (version === null) throw new Error("the downloaded whisper-cli does not run on this machine");
      this.log(`whisper-cli ${version} installed at ${target}`);
      this.engine = { path: target, version };
      return this.engine;
    })();
    this.engineJob
      .then(() => (this.engineError = null))
      .catch((e: unknown) => {
        this.engineError = e instanceof Error ? e.message : String(e);
        this.log(`speech: ${this.engineError}`);
      })
      .finally(() => (this.engineJob = null));
    return this.engineJob;
  }

  private ensureModel(model: SpeechModel): Promise<void> {
    const target = modelFile(model);
    if (existsSync(target)) return Promise.resolve();
    const running = this.modelJobs.get(model);
    if (running) return running.promise;
    const job: Job = { promise: Promise.resolve(), received: 0, total: SPEECH_MODEL_INFO[model].bytes };
    job.promise = (async () => {
      this.log(`downloading Whisper model ${model} (${Math.round(job.total / 1e6)} MB) into ${MODELS_DIR}`);
      mkdirSync(MODELS_DIR, { recursive: true });
      await downloadTo(`${MODELS_URL}/ggml-${model}.bin`, target, MODEL_SHA256[model], (received, total) => {
        job.received = received;
        if (total > 0) job.total = total;
      });
      this.log(`Whisper model ${model} ready`);
    })();
    this.modelJobs.set(model, job);
    job.promise
      .then(() => this.modelErrors.delete(model))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        this.modelErrors.set(model, message);
        this.log(`speech: ${message}`);
      })
      .finally(() => this.modelJobs.delete(model));
    return job.promise;
  }

  private run(engine: Binary, wav: Buffer, model: SpeechModel, language: string): Promise<Omit<Transcription, "seconds">> {
    const dir = mkdtempSync(join(tmpdir(), "sessionboxer-speech-"));
    const clip = join(dir, "clip.wav");
    const out = join(dir, "out");
    writeFileSync(clip, wav, { mode: 0o600 });
    const started = Date.now();
    const args = ["-m", modelFile(model), "-f", clip, "-l", language, "-t", String(THREADS), "--no-timestamps", "--no-prints", "--output-json", "--output-file", out];
    return new Promise<Omit<Transcription, "seconds">>((resolve, reject) => {
      let stderr = "";
      const child = spawn(engine.path, args, { stdio: ["ignore", "ignore", "pipe"] });
      const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
      child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new HttpError(500, `whisper-cli failed to start: ${e.message}`));
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0) {
          const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
          reject(new HttpError(500, `whisper-cli ${signal ? `killed (${signal})` : `exited with ${code}`}${tail ? `: ${tail}` : ""}`));
          return;
        }
        try {
          const parsed = JSON.parse(readFileSync(`${out}.json`, "utf8")) as { result?: { language?: string }; transcription?: { text?: string }[] };
          const text = (parsed.transcription ?? [])
            .map((s) => s.text ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          resolve({ text, language: parsed.result?.language ?? language, tookMs: Date.now() - started, model });
        } catch (e) {
          reject(new HttpError(500, `whisper-cli produced no transcript: ${e instanceof Error ? e.message : String(e)}`));
        }
      });
    }).finally(() => rmSync(dir, { recursive: true, force: true }));
  }
}

/** Removes a downloaded model that is not the configured one. */
export function deleteModel(model: SpeechModel, settings: SpeechSettings): void {
  if (model === settings.model) throw new HttpError(409, "That model is the one selected in Settings; pick another first.");
  const file = modelFile(model);
  if (!existsSync(file)) throw new HttpError(404, "That model is not downloaded.");
  rmSync(file, { force: true });
}
