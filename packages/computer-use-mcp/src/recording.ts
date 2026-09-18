import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { Display } from "./x11.js";

const WORKSPACE = process.env.SESSIONBOXER_WORKSPACE ?? "/workspace";
/**
 * The running recording, kept outside this process: the MCP server is restarted whenever
 * the Agent is (MCP toggles, resume), and a recording must survive that to be stoppable.
 */
const STATE_FILE = `${process.env.SESSIONBOXER_TMPFS ?? "/dev/shm/sessionboxer"}/recording.json`;
const LOG_FILE = `${process.env.SESSIONBOXER_TMPFS ?? "/dev/shm/sessionboxer"}/recording.log`;
const STOP_TIMEOUT_MS = 20_000;
/** The condensing pass re-encodes only the frames that changed; even long recordings take seconds. */
const CONDENSE_TIMEOUT_MS = 180_000;

const execFileAsync = promisify(execFile);

interface RecordingState {
  pid: number;
  path: string;
  startedAt: string;
}

export interface RecordingInfo {
  path: string;
  startedAt: string;
  seconds: number;
}

export interface RecordingResult extends RecordingInfo {
  bytes: number;
  /** Wall-clock length of the recording; `seconds` is the video's length after condensing. */
  recordedSeconds: number;
  condensed: boolean;
  /** Why the video was left as recorded, when condensing was asked for but did not happen. */
  warning?: string;
}

export interface StopOptions {
  /** Collapse stretches where nothing changes on screen to at most `holdSeconds` each. */
  condense: boolean;
  holdSeconds: number;
}

function readState(): RecordingState | null {
  if (!existsSync(STATE_FILE)) return null;
  const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as RecordingState;
  if (!alive(s.pid)) {
    rmSync(STATE_FILE, { force: true });
    return null;
  }
  return s;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function elapsed(startedAt: string): number {
  return Math.round((Date.now() - Date.parse(startedAt)) / 100) / 10;
}

export function currentRecording(): RecordingInfo | null {
  const s = readState();
  return s ? { path: s.path, startedAt: s.startedAt, seconds: elapsed(s.startedAt) } : null;
}

/** Resolves the requested output path (default `recordings/<timestamp>.mp4`) inside the Workspace. */
export function recordingPath(requested: string | undefined): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const raw = requested && requested !== "" ? requested : `recordings/${stamp}.mp4`;
  const abs = resolve(WORKSPACE, raw);
  if (abs !== WORKSPACE && !abs.startsWith(`${WORKSPACE}/`)) {
    throw new Error(`recordings must be saved under ${WORKSPACE}, got ${requested}`);
  }
  if (!abs.endsWith(".mp4")) throw new Error("recordings are .mp4 files; use a path ending in .mp4");
  return abs;
}

/**
 * Starts ffmpeg grabbing the X display into an H.264 .mp4 (yuv420p + faststart, so browsers
 * play it). Detached, so it outlives this MCP server; `stopRecording` finds it through the state file.
 */
export async function startRecording(display: Display, requested: string | undefined, fps: number): Promise<RecordingInfo> {
  const running = readState();
  if (running) throw new Error(`a recording is already running since ${running.startedAt} (${running.path}); stop it first`);
  const path = recordingPath(requested);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  rmSync(path, { force: true });
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-framerate",
    String(fps),
    "-video_size",
    `${display.width}x${display.height}`,
    "-draw_mouse",
    "1",
    "-i",
    `${display.name}.0+0,0`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    path,
  ];
  // stderr goes to a file, not a pipe: a pipe would break (SIGPIPE) once this server restarts.
  const logFd = openSync(LOG_FILE, "w");
  const child = spawn("ffmpeg", args, { detached: true, stdio: ["ignore", "ignore", logFd], env: { ...process.env, DISPLAY: display.name } });
  closeSync(logFd);
  const startedAt = new Date().toISOString();
  const early = await new Promise<string | null>((done) => {
    child.on("error", (e) => done(e.message));
    child.on("exit", (code) => done(`ffmpeg exited with ${code}: ${readFileSync(LOG_FILE, "utf8").trim()}`));
    // ffmpeg fails within a moment if the display or encoder is unusable; otherwise it is recording.
    setTimeout(() => done(null), 700);
  });
  if (early !== null) throw new Error(`could not start recording: ${early}`);
  child.unref();
  const state: RecordingState = { pid: child.pid ?? -1, path, startedAt };
  writeFileSync(STATE_FILE, JSON.stringify(state));
  return { path, startedAt, seconds: 0 };
}

/**
 * Asks ffmpeg to finish (SIGINT writes the trailer), waits for the file to be complete, then
 * condenses it unless told otherwise.
 */
export async function stopRecording(opts: StopOptions): Promise<RecordingResult> {
  const s = readState();
  if (!s) throw new Error("no recording is running");
  process.kill(s.pid, "SIGINT");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (alive(s.pid)) {
    if (Date.now() > deadline) {
      process.kill(s.pid, "SIGKILL");
      rmSync(STATE_FILE, { force: true });
      throw new Error("ffmpeg did not finish in time; the recording may be unplayable");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  rmSync(STATE_FILE, { force: true });
  if (!existsSync(s.path) || statSync(s.path).size === 0) throw new Error(`recording produced no data at ${s.path}`);
  const recordedSeconds = elapsed(s.startedAt);
  const base = { path: s.path, startedAt: s.startedAt, recordedSeconds };
  if (!opts.condense) return { ...base, seconds: recordedSeconds, bytes: statSync(s.path).size, condensed: false };
  try {
    const seconds = await condense(s.path, opts.holdSeconds);
    return { ...base, seconds, bytes: statSync(s.path).size, condensed: true };
  } catch (e) {
    const warning = `left uncondensed: ${e instanceof Error ? e.message : String(e)}`;
    return { ...base, seconds: recordedSeconds, bytes: statSync(s.path).size, condensed: false, warning };
  }
}

/**
 * Rewrites the video in place with every stretch of identical frames cut down to `holdSeconds`:
 * `mpdecimate` drops frames that match the last kept one, `setpts` then re-times the survivors so
 * each gap is at most the hold (instead of removing it, which would make states flash by), and
 * `tpad` holds the final frame so the end result stays readable too. Returns the new duration.
 */
async function condense(path: string, holdSeconds: number): Promise<number> {
  const hold = holdSeconds.toFixed(3);
  const filter = [
    "mpdecimate",
    `setpts=if(eq(N\\,0)\\,0\\,PREV_OUTPTS+min(PTS-PREV_INPTS\\,${hold}/TB))`,
    `tpad=stop_mode=clone:stop_duration=${hold}`,
  ].join(",");
  const tmp = `${path.slice(0, -4)}.condensing.mp4`;
  rmSync(tmp, { force: true });
  try {
    await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", path, "-vf", filter, "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", tmp],
      { timeout: CONDENSE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp], { timeout: 30_000 });
    const seconds = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0 || statSync(tmp).size === 0) throw new Error("condensed video is empty");
    renameSync(tmp, path);
    return Math.round(seconds * 10) / 10;
  } catch (e) {
    rmSync(tmp, { force: true });
    const stderr = typeof e === "object" && e !== null && "stderr" in e && typeof e.stderr === "string" ? e.stderr.trim() : "";
    throw new Error(stderr || (e instanceof Error ? e.message : String(e)));
  }
}
