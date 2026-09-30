/**
 * The audio of a video or audio file as the 16 kHz mono 16-bit WAV Whisper wants, made with the
 * Sandbox's ffmpeg under `.sessionboxer/tmp/` in the Workspace — where the Control Plane reads it
 * back through the Daemon's `/fs/raw` — and removed once the transcription is in.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const WORKSPACE = process.env.SESSIONBOXER_WORKSPACE ?? "/workspace";
const TMP_DIR = ".sessionboxer/tmp";
/** What the Control Plane accepts (`SPEECH_CLIP_MAX_BYTES`): 32 kB per second, so about 15 minutes. */
const MAX_WAV_BYTES = 30 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 5 * 60_000;

export interface ExtractedWav {
  /** Workspace-relative, forward slashes: the `path` the Control Plane reads. */
  workspacePath: string;
  remove: () => void;
}

function locate(path: string): string {
  const candidates = isAbsolute(path) ? [path] : [resolve(WORKSPACE, path), resolve(process.cwd(), path)];
  const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  if (!hit) throw new Error(`No file at ${path}${isAbsolute(path) ? "" : ` (looked under ${WORKSPACE} and ${process.cwd()})`}.`);
  return hit;
}

export async function extractWav(path: string): Promise<ExtractedWav> {
  const source = locate(path);
  const root = resolve(WORKSPACE);
  const dir = join(root, TMP_DIR);
  mkdirSync(dir, { recursive: true });
  const wav = join(dir, `transcribe-${randomBytes(6).toString("hex")}.wav`);
  const remove = () => rmSync(wav, { force: true });
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", wav];
  return new Promise<ExtractedWav>((done, fail) => {
    execFile("ffmpeg", args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        remove();
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return fail(new Error("ffmpeg is not installed on this machine, so the audio cannot be extracted."));
        const tail = String(stderr ?? "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
        return fail(new Error(`ffmpeg could not read ${path}${tail ? `: ${tail}` : ""} (does the file have an audio track?).`));
      }
      const size = existsSync(wav) ? statSync(wav).size : 0;
      if (size <= 44) {
        remove();
        return fail(new Error(`${path} has no audio to transcribe.`));
      }
      if (size > MAX_WAV_BYTES) {
        remove();
        return fail(new Error(`${path} has more than about 15 minutes of audio; cut it into parts with ffmpeg (-ss/-t) and transcribe each.`));
      }
      done({ workspacePath: relative(root, wav).split(sep).join("/"), remove });
    });
  });
}
