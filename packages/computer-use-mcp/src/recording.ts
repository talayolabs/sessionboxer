import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Display } from "./x11.js";

const WORKSPACE = process.env.SESSIONBOXER_WORKSPACE ?? "/workspace";
/**
 * The running recording, kept outside this process: the MCP server is restarted whenever
 * the Agent is (MCP toggles, resume), and a recording must survive that to be stoppable.
 */
const STATE_FILE = `${process.env.SESSIONBOXER_TMPFS ?? "/dev/shm/sessionboxer"}/recording.json`;
const LOG_FILE = `${process.env.SESSIONBOXER_TMPFS ?? "/dev/shm/sessionboxer"}/recording.log`;
const STOP_TIMEOUT_MS = 20_000;

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

/** Asks ffmpeg to finish (SIGINT writes the trailer), waits for the file to be complete. */
export async function stopRecording(): Promise<RecordingResult> {
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
  const bytes = existsSync(s.path) ? statSync(s.path).size : 0;
  if (bytes === 0) throw new Error(`recording produced no data at ${s.path}`);
  return { path: s.path, startedAt: s.startedAt, seconds: elapsed(s.startedAt), bytes };
}
