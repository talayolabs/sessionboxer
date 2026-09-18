import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { Display } from "./x11.js";

const WORKSPACE = process.env.SESSIONBOXER_WORKSPACE ?? "/workspace";
const TMPFS = process.env.SESSIONBOXER_TMPFS ?? "/dev/shm/sessionboxer";
/**
 * The running recording, kept outside this process: the MCP server is restarted whenever
 * the Agent is (MCP toggles, resume), and a recording must survive that to be stoppable.
 */
const STATE_FILE = `${TMPFS}/recording.json`;
const LOG_FILE = `${TMPFS}/recording.log`;
const STOP_TIMEOUT_MS = 20_000;
/** The finishing pass re-encodes only the frames that changed; even long recordings take seconds. */
const FINISH_TIMEOUT_MS = 180_000;
/** Caption font size as a fraction of the display height (27 px at 768). */
const FONT_FRACTION = 0.035;
/** Lines of caption text the band under the desktop is sized for; longer captions stack up over the desktop. */
const BAND_LINES = 3;
/** DejaVu Sans line height relative to the font size (libass uses the font's ascent + descent). */
const LINE_HEIGHT = 1.2;
const MAX_CAPTION_CHARS = 300;
/** Shortest cue the sidecar track gets, so two annotations inside one collapsed pause both show. */
const MIN_CUE_SECONDS = 0.5;

const execFileAsync = promisify(execFile);

export interface Caption {
  /** Seconds from the start of the video. */
  at: number;
  text: string;
}

interface RecordingState {
  pid: number;
  path: string;
  startedAt: string;
  width: number;
  height: number;
  fps: number;
  captions: Caption[];
}

export interface RecordingInfo {
  path: string;
  startedAt: string;
  seconds: number;
  captions: number;
}

export interface RecordingResult {
  path: string;
  startedAt: string;
  /** Length of the finished video. */
  seconds: number;
  /** Wall-clock length of the recording. */
  recordedSeconds: number;
  bytes: number;
  condensed: boolean;
  /** Captions with their times in the finished video. */
  captions: Caption[];
  /** WebVTT sidecar next to the video, when a track was written. */
  track?: string;
  /** Why the video was left as recorded, when finishing was asked for but did not happen. */
  warning?: string;
}

export type CaptionMode = "both" | "burn" | "track" | "none";

export interface StopOptions {
  /** Collapse stretches where nothing changes on screen to at most `holdSeconds` each. */
  condense: boolean;
  holdSeconds: number;
  captions: CaptionMode;
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
  return s ? { path: s.path, startedAt: s.startedAt, seconds: elapsed(s.startedAt), captions: s.captions.length } : null;
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
  const state: RecordingState = { pid: child.pid ?? -1, path, startedAt, width: display.width, height: display.height, fps, captions: [] };
  writeFileSync(STATE_FILE, JSON.stringify(state));
  return { path, startedAt, seconds: 0, captions: 0 };
}

/** Adds a caption at the current moment of the running recording; it shows until the next one. */
export function annotateRecording(text: string): Caption & { path: string } {
  const s = readState();
  if (!s) throw new Error("no recording is running; call start_recording first");
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_CAPTION_CHARS);
  if (clean === "") throw new Error("the caption is empty");
  const caption: Caption = { at: elapsed(s.startedAt), text: clean };
  s.captions.push(caption);
  writeFileSync(STATE_FILE, JSON.stringify(s));
  return { ...caption, path: s.path };
}

/**
 * Asks ffmpeg to finish (SIGINT writes the trailer), waits for the file to be complete, then
 * runs the finishing pass: captions burned into a band under the desktop and/or written as a
 * WebVTT sidecar, and static stretches condensed.
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
  const captions = opts.captions === "none" ? [] : s.captions;
  const burn = captions.length > 0 && (opts.captions === "both" || opts.captions === "burn");
  const track = captions.length > 0 && (opts.captions === "both" || opts.captions === "track");
  const asIs = (extra: Partial<RecordingResult>): RecordingResult => ({
    path: s.path,
    startedAt: s.startedAt,
    seconds: recordedSeconds,
    recordedSeconds,
    bytes: statSync(s.path).size,
    condensed: false,
    captions,
    ...extra,
  });
  if (!opts.condense && !burn) {
    return track ? asIs({ track: writeTrack(s.path, captions, recordedSeconds) }) : asIs({});
  }
  try {
    const out = await finish(s, captions, burn, opts.condense ? opts.holdSeconds : null);
    const result: RecordingResult = {
      path: s.path,
      startedAt: s.startedAt,
      seconds: out.seconds,
      recordedSeconds,
      bytes: statSync(s.path).size,
      condensed: opts.condense,
      captions: captions.map((c) => ({ at: out.map(c.at), text: c.text })),
    };
    if (track) result.track = writeTrack(s.path, result.captions, out.seconds);
    return result;
  } catch (e) {
    const warning = `left as recorded: ${e instanceof Error ? e.message : String(e)}`;
    return asIs(track ? { warning, track: writeTrack(s.path, captions, recordedSeconds) } : { warning });
  }
}

/**
 * Rewrites the video in place. Captions are drawn first (`pad` adds a band under the desktop,
 * `ass` renders them into it anchored at the frame's bottom, so a caption taller than the band
 * grows up into view instead of being cut off);
 * they are authored in wall-clock time like the frames at that point, so condensing carries them
 * along. Condensing: `mpdecimate` drops frames that match the last kept one, `setpts` re-times
 * the survivors so each gap is at most the hold (instead of removing it, which would make states
 * flash by), `tpad` holds the final frame so the end stays readable too. `showinfo` between the
 * two reports which input times survived, which gives the caption track the same re-timing.
 */
async function finish(s: RecordingState, captions: Caption[], burn: boolean, holdSeconds: number | null): Promise<{ seconds: number; map: (t: number) => number }> {
  const stem = s.path.slice(0, -4);
  const tmp = `${stem}.finishing.mp4`;
  const assFile = `${TMPFS}/recording-${process.pid}.ass`;
  const scriptFile = `${TMPFS}/recording-${process.pid}.filter`;
  const chain: string[] = [];
  if (burn) {
    const { band } = captionGeometry(s.height);
    writeFileSync(assFile, assDocument(s.width, s.height, captions, elapsed(s.startedAt)));
    chain.push(`pad=iw:ih+${band}:0:0:color=0x1a1a1a`, `ass=filename=${assFile}`);
  }
  if (holdSeconds !== null) {
    const hold = holdSeconds.toFixed(3);
    chain.push("mpdecimate", "showinfo", `setpts=if(eq(N\\,0)\\,0\\,PREV_OUTPTS+min(PTS-PREV_INPTS\\,${hold}/TB))`, `tpad=stop_mode=clone:stop_duration=${hold}`);
  }
  writeFileSync(scriptFile, chain.join(",\n"));
  rmSync(tmp, { force: true });
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        holdSeconds !== null ? "info" : "error",
        "-nostats",
        "-i",
        s.path,
        "-filter_script:v",
        scriptFile,
        "-fps_mode",
        holdSeconds !== null ? "vfr" : "passthrough",
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
        tmp,
      ],
      { timeout: FINISH_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 },
    );
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp], { timeout: 30_000 });
    const seconds = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0 || statSync(tmp).size === 0) throw new Error("finished video is empty");
    renameSync(tmp, s.path);
    const map = holdSeconds !== null ? retiming(keptTimes(stderr), holdSeconds, 1 / s.fps) : (t: number) => t;
    return { seconds: Math.round(seconds * 10) / 10, map: (t) => Math.min(Math.round(map(t) * 10) / 10, seconds) };
  } catch (e) {
    rmSync(tmp, { force: true });
    const stderr = typeof e === "object" && e !== null && "stderr" in e && typeof e.stderr === "string" ? e.stderr : "";
    const errors = stderr
      .split("\n")
      .filter((l) => !l.includes("Parsed_showinfo") && l.trim() !== "")
      .slice(-5)
      .join("\n");
    throw new Error(errors || (e instanceof Error ? e.message : String(e)));
  } finally {
    rmSync(assFile, { force: true });
    rmSync(scriptFile, { force: true });
  }
}

/** Input timestamps of the frames `mpdecimate` let through, from `showinfo`'s log lines. */
function keptTimes(log: string): number[] {
  const times: number[] = [];
  for (const m of log.matchAll(/Parsed_showinfo\S* @ \S+\] n:\s*\d+ .*?pts_time:([0-9.]+)/g)) times.push(Number.parseFloat(m[1] ?? "0"));
  return times;
}

/** Wall-clock time → time in the condensed video, mirroring the `setpts` expression. */
function retiming(kept: number[], hold: number, frame: number): (t: number) => number {
  const out: number[] = [];
  let prevIn = 0;
  let prevOut = 0;
  kept.forEach((at, i) => {
    const o = i === 0 ? 0 : prevOut + Math.min(at - prevIn, hold);
    out.push(o);
    prevIn = at;
    prevOut = o;
  });
  return (t) => {
    let i = 0;
    while (i + 1 < kept.length && (kept[i + 1] ?? Infinity) <= t) i++;
    const at = kept[i];
    const o = out[i];
    if (at === undefined || o === undefined) return t;
    return o + Math.max(0, Math.min(t - at, hold - frame));
  };
}

/** Font size, its margin, and a band tall enough for BAND_LINES lines plus a margin above and below (even, for yuv420p). */
function captionGeometry(displayHeight: number): { fontSize: number; margin: number; band: number } {
  const fontSize = Math.max(16, Math.round(displayHeight * FONT_FRACTION));
  const margin = Math.round(fontSize * 0.5);
  const band = Math.ceil((BAND_LINES * LINE_HEIGHT * fontSize + 2 * margin) / 2) * 2;
  return { fontSize, margin, band };
}

/**
 * An ASS script sized to the padded frame: one style, bottom-centre aligned with a small margin
 * from the frame's bottom edge, so the text sits in the band and extra lines stack upwards (over
 * the desktop's bottom if a caption is taller than the band, rather than off-screen). Braces and
 * backslashes are dropped from the text because they are ASS override syntax.
 */
function assDocument(width: number, height: number, captions: Caption[], endSeconds: number): string {
  const { fontSize, margin, band } = captionGeometry(height);
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height + band}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,DejaVu Sans,${fontSize},&H00F2F2F2,&H00F2F2F2,&H001A1A1A,&H001A1A1A,0,0,0,0,100,100,0,0,1,1,0,2,${fontSize},${fontSize},${margin},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines = captions.map((c, i) => {
    const end = captions[i + 1]?.at ?? Math.max(endSeconds, c.at + 1);
    const text = c.text.replace(/[{}\\]/g, "");
    return `Dialogue: 0,${assTime(c.at)},${assTime(end)},Caption,,0,0,0,,${text}`;
  });
  return `${[...head, ...lines].join("\n")}\n`;
}

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Writes `<name>.vtt` next to the video (times already in video time) and returns its path. */
function writeTrack(videoPath: string, captions: Caption[], endSeconds: number): string {
  const path = `${videoPath.slice(0, -4)}.vtt`;
  const cues: string[] = [];
  let cursor = 0;
  captions.forEach((c, i) => {
    const start = Math.max(c.at, cursor);
    const end = Math.max(captions[i + 1]?.at ?? endSeconds, start + MIN_CUE_SECONDS);
    cursor = end;
    cues.push(`${vttTime(start)} --> ${vttTime(end)}\n${c.text.replace(/-->/g, "→").replace(/</g, "‹")}`);
  });
  writeFileSync(path, `WEBVTT\n\n${cues.join("\n\n")}\n`);
  return path;
}

function vttTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
