import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { estimateNarrationSeconds, narrateVideo, narrationAvailable, narrationPrefs, resolveNarrationVoice, type NarrationOptions } from "./narration.js";
import type { Coordinate, Display, PointerTrace, TimedPoint } from "./x11.js";

const WORKSPACE = process.env.SESSIONBOXER_WORKSPACE ?? "/workspace";
const TMPFS = process.env.SESSIONBOXER_TMPFS ?? "/dev/shm/sessionboxer";
/**
 * The running recording, kept outside this process: the MCP server is restarted whenever
 * the Agent is (MCP toggles, resume), and a recording must survive that to be stoppable.
 */
const STATE_FILE = `${TMPFS}/recording.json`;
const LOG_FILE = `${TMPFS}/recording.log`;
/** One record per finished video (captions in video time), so it can be narrated after the fact. */
const FINISHED_DIR = `${TMPFS}/recordings`;
const STOP_TIMEOUT_MS = 20_000;
/** The finishing pass re-encodes only the frames that changed; even long recordings take seconds. */
const FINISH_TIMEOUT_MS = 180_000;
/** Caption font size as a fraction of the display height (27 px at 768). */
const FONT_FRACTION = 0.035;
/** Lines of caption text the band under the desktop is sized for; longer captions stack up over the desktop. */
const BAND_LINES = 3;
/** Inter's line height relative to the font size (libass uses the font's ascent + descent); DejaVu Sans, its fallback, matches. */
const LINE_HEIGHT = 1.21;
/** The caption face (fonts-inter-variable in the Sandbox image); fontconfig falls back to DejaVu Sans where it is missing. */
const CAPTION_FONT = "Inter Variable";
/** The pointer drawn into the video: an arrow this fraction of the display height tall (42 px at 768, about twice X's). */
const CURSOR_FRACTION = 0.055;
/** How much the arrow shrinks while a button is down. */
const PRESSED_SCALE = 0.8;
/** Transparent margin around the arrow, so its shadow fits; the tip (the hotspot) sits at (pad, pad). */
const CURSOR_PAD = 6;
/** The Sessionboxer mark at the video's top-right corner: its side as a fraction of the display height (28 px at 768), on a rounded dark badge. */
const LOGO_FRACTION = 0.0365;
const LOGO_FILE = fileURLToPath(new URL("../assets/logo.png", import.meta.url));
const MAX_CAPTION_CHARS = 300;
/** Shortest cue the sidecar track gets, so two annotations inside one collapsed pause both show. */
const MIN_CUE_SECONDS = 0.5;

const execFileAsync = promisify(execFile);

export interface Caption {
  /** Seconds from the start of the video. */
  at: number;
  text: string;
}

/** A pointer position: seconds since the recording started, x, y. */
type PointerMove = [number, number, number];
/** A button held: from and until (seconds since the start; `null` while still held), at x, y. */
interface PointerPress {
  from: number;
  until: number | null;
  x: number;
  y: number;
}

interface RecordingState {
  pid: number;
  path: string;
  startedAt: string;
  width: number;
  height: number;
  fps: number;
  captions: Caption[];
  /** What the pointer did, in wall-clock time; drawn into the frames when the recording stops (ADR-0072). */
  moves: PointerMove[];
  presses: PointerPress[];
}

export interface RecordingInfo {
  path: string;
  startedAt: string;
  seconds: number;
  captions: number;
}

export type Narration =
  | { added: true; language: string; voice: string; speechSeconds: number; processingSeconds: number }
  /** Settings say to ask above a cost, and this recording is above it: the agent asks, then calls `narrate_recording`. */
  | { pending: true; estimatedSeconds: number; language: string; voice: string; nextStep: string }
  | { skipped: string };

export interface NarrateResult {
  path: string;
  /** Length of the video. */
  seconds: number;
  bytes: number;
  /** Captions with their times in the video. */
  captions: Caption[];
  /** WebVTT sidecar next to the video, when a track was written. */
  track?: string;
  narration?: Narration;
  /** What did not happen as asked (finishing, narration); the video is still usable. */
  warning?: string;
}

export interface RecordingResult extends NarrateResult {
  startedAt: string;
  /** Wall-clock length of the recording. */
  recordedSeconds: number;
  condensed: boolean;
}

export type CaptionMode = "both" | "burn" | "track" | "none";

export interface StopOptions {
  /** Collapse stretches where nothing changes on screen to at most `holdSeconds` each. */
  condense: boolean;
  holdSeconds: number;
  captions: CaptionMode;
  /** Speak the captions into an audio track; `undefined` follows the Settings preference. */
  narrate: boolean | undefined;
  narration: NarrationOptions;
}

/** A finished video whose captions are known in its own timeline. */
interface Finished {
  path: string;
  seconds: number;
  fps: number;
  captions: Caption[];
  track: boolean;
  narrated: boolean;
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

function sinceStart(startedAt: string, whenMs: number): number {
  return Math.round(whenMs - Date.parse(startedAt)) / 1000;
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
 * The frames carry no pointer: the finishing pass draws one from the trace, starting at `pointer`.
 */
export async function startRecording(display: Display, requested: string | undefined, fps: number, pointer: Coordinate): Promise<RecordingInfo> {
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
    "0",
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
  const state: RecordingState = {
    pid: child.pid ?? -1,
    path,
    startedAt,
    width: display.width,
    height: display.height,
    fps,
    captions: [],
    moves: [[0, pointer[0], pointer[1]]],
    presses: [],
  };
  writeFileSync(STATE_FILE, JSON.stringify(state));
  return { path, startedAt, seconds: 0, captions: 0 };
}

/** The running recording's view of the pointer; each action appends to the state file once. */
export const recordingTrace: PointerTrace = {
  moved(points: TimedPoint[]): void {
    const s = readState();
    if (!s) return;
    for (const p of points) s.moves.push([sinceStart(s.startedAt, p.when), p.at[0], p.at[1]]);
    writeFileSync(STATE_FILE, JSON.stringify(s));
  },
  pressed(at: Coordinate, when: number, until: number | null): void {
    const s = readState();
    if (!s) return;
    s.presses.push({ from: sinceStart(s.startedAt, when), until: until === null ? null : sinceStart(s.startedAt, until), x: at[0], y: at[1] });
    writeFileSync(STATE_FILE, JSON.stringify(s));
  },
  released(when: number): void {
    const s = readState();
    if (!s) return;
    const held = s.presses.filter((p) => p.until === null);
    if (held.length === 0) return;
    for (const p of held) p.until = sinceStart(s.startedAt, when);
    writeFileSync(STATE_FILE, JSON.stringify(s));
  },
};

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
  const stoppedAt = Date.now();
  const recordedSeconds = elapsed(s.startedAt);
  const captions = opts.captions === "none" ? [] : s.captions;
  const burn = captions.length > 0 && (opts.captions === "both" || opts.captions === "burn");
  const track = captions.length > 0 && (opts.captions === "both" || opts.captions === "track");
  let finished: Finished = { path: s.path, seconds: recordedSeconds, fps: s.fps, captions, track, narrated: false };
  let condensed = false;
  let warning: string | undefined;
  try {
    const out = await finish(s, captions, burn, opts.condense ? opts.holdSeconds : null, sinceStart(s.startedAt, stoppedAt));
    finished = { ...finished, seconds: out.seconds, captions: captions.map((c) => ({ at: Math.min(out.map(c.at), out.seconds), text: c.text })) };
    condensed = opts.condense;
  } catch (e) {
    warning = `left as recorded, without the pointer: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (track) writeTrack(finished);
  saveFinished(finished);
  const result: RecordingResult = { ...present(finished), startedAt: s.startedAt, recordedSeconds, condensed };
  if (warning !== undefined) result.warning = warning;
  await addNarration(finished, result, opts.narrate, opts.narration);
  return result;
}

/**
 * Narrates a finished video after the fact, typically once the user agreed to the cost
 * `stop_recording` reported. Captions come from the record `stop_recording` left, or from the
 * video's own `.vtt` when that record is gone (a Sandbox restart clears the tmpfs).
 */
export async function narrateRecording(requested: string, opts: NarrationOptions): Promise<NarrateResult> {
  const path = recordingPath(requested);
  if (!existsSync(path)) throw new Error(`no video at ${path}`);
  if (currentRecording()?.path === path) throw new Error("that recording is still running; stop it first");
  const finished = readFinished(path) ?? (await finishedFromTrack(path));
  if (finished.narrated) throw new Error(`${path} is already narrated`);
  const result = present(finished);
  await addNarration(finished, result, true, opts);
  if (result.warning !== undefined) throw new Error(result.warning);
  return result;
}

function present(f: Finished): NarrateResult {
  const result: NarrateResult = {
    path: f.path,
    seconds: round1(f.seconds),
    bytes: statSync(f.path).size,
    captions: f.captions.map((c) => ({ at: round1(c.at), text: c.text })),
  };
  if (f.track) result.track = trackPath(f.path);
  return result;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Decides from the tool's argument and the Settings preference whether to narrate, and does it.
 * `ask` narrates by itself when the estimated cost is under the configured threshold, otherwise
 * it reports the estimate and leaves the call to the agent, who asks the user first.
 */
async function addNarration(finished: Finished, result: NarrateResult, narrate: boolean | undefined, opts: NarrationOptions): Promise<void> {
  if (finished.captions.length === 0) {
    if (narrate === true) result.narration = { skipped: "the recording has no captions to speak" };
    return;
  }
  if (narrate === false) {
    result.narration = { skipped: "narrate: false" };
    return;
  }
  if (!narrationAvailable()) {
    result.narration = { skipped: "no narration model in this Sandbox image (rebuild it with npm run build:image)" };
    return;
  }
  try {
    const { language, voice } = resolveNarrationVoice(opts);
    if (narrate === undefined) {
      const prefs = narrationPrefs();
      if (prefs.mode === "never") {
        result.narration = { skipped: "Settings: narrate recordings = never" };
        return;
      }
      const estimatedSeconds = estimateNarrationSeconds(finished.captions, finished.seconds, opts.speed);
      if (prefs.mode === "ask" && estimatedSeconds > prefs.askAboveSeconds) {
        result.narration = {
          pending: true,
          estimatedSeconds,
          language,
          voice,
          nextStep: `Narrating would take about ${estimatedSeconds} s more. Ask the user whether they want the video narrated; if yes, call narrate_recording with this path.`,
        };
        return;
      }
    }
    const n = await narrateVideo(finished.path, finished.captions, finished.seconds, finished.fps, opts);
    finished.seconds = n.seconds;
    finished.captions = finished.captions.map((c) => ({ at: Math.min(n.map(c.at), n.seconds), text: c.text }));
    finished.narrated = true;
    if (finished.track) writeTrack(finished);
    saveFinished(finished);
    Object.assign(result, present(finished));
    result.narration = { added: true, language: n.language, voice: n.voice, speechSeconds: round1(n.speechSeconds), processingSeconds: round1(n.processingSeconds) };
  } catch (e) {
    const why = `narration failed, video left silent: ${e instanceof Error ? e.message : String(e)}`;
    result.warning = result.warning === undefined ? why : `${result.warning}; ${why}`;
  }
}

function finishedFile(path: string): string {
  return `${FINISHED_DIR}/${createHash("sha1").update(path).digest("hex")}.json`;
}

function saveFinished(f: Finished): void {
  mkdirSync(FINISHED_DIR, { recursive: true });
  writeFileSync(finishedFile(f.path), JSON.stringify(f));
}

function readFinished(path: string): Finished | null {
  const file = finishedFile(path);
  if (!existsSync(file)) return null;
  const f = JSON.parse(readFileSync(file, "utf8")) as Finished;
  return statSync(path).mtimeMs <= statSync(file).mtimeMs + 1000 ? f : null;
}

async function finishedFromTrack(path: string): Promise<Finished> {
  const track = trackPath(path);
  if (!existsSync(track)) throw new Error(`no captions known for ${path}: it was not finished by stop_recording in this Sandbox and has no .vtt next to it`);
  const captions: Caption[] = [];
  for (const m of readFileSync(track, "utf8").matchAll(/^(\d+):(\d\d):(\d\d)\.(\d\d\d) --> [^\n]*\n([^\n]+)/gm)) {
    captions.push({ at: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000, text: m[5] ?? "" });
  }
  if (captions.length === 0) throw new Error(`${track} has no cues`);
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "csv=p=0", path], { timeout: 30_000 });
  const seconds = Number.parseFloat(stdout.split("\n").find((l) => /^[0-9.]+$/.test(l.trim())) ?? "");
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`could not read the length of ${path}`);
  return { path, seconds, fps: 30, captions, track: true, narrated: stdout.includes("audio") };
}

/**
 * Rewrites the video in place. The pointer goes on first: `overlay`s of an arrow (and a smaller
 * one while a button is down, parked off-frame otherwise) that `sendcmd` moves along the traced
 * positions, and the Sessionboxer badge at the top-right corner. Then the captions (`pad` adds a
 * band under the desktop, `ass` renders them into it anchored at the frame's bottom, so a caption
 * taller than the band grows up into view instead of being cut off); they are authored in
 * wall-clock time like the frames at that point, so condensing carries them along. Condensing:
 * `mpdecimate` drops frames that match the last kept one, `setpts` re-times the survivors so each
 * gap is at most the hold (instead of removing it, which would make states flash by), `tpad`
 * holds the final frame so the end stays readable too. `showinfo` between the two reports which
 * input times survived, which gives the caption track the same re-timing.
 *
 * ffmpeg's first frame comes some tenths of a second after `startedAt` (it opens the display and
 * the encoder first): the trace is shifted by the time the recording lasted beyond the video's
 * length, so the pointer lands where the screen reacts.
 */
async function finish(s: RecordingState, captions: Caption[], burn: boolean, holdSeconds: number | null, recordedSeconds: number): Promise<{ seconds: number; map: (t: number) => number }> {
  const stem = s.path.slice(0, -4);
  const tmp = `${stem}.finishing.mp4`;
  const work = `${TMPFS}/recording-${process.pid}`;
  const assFile = `${work}.ass`;
  const scriptFile = `${work}.filter`;
  const cmdFile = `${work}.cmd`;
  const cursorFile = `${work}-cursor.png`;
  const pressedFile = `${work}-pressed.png`;
  const badgeFile = `${work}-badge.png`;
  const inputs = ["-i", s.path];
  const graph: string[] = [];
  let last = "0:v";
  const step = (filters: string, out: string, extraIn = ""): void => {
    graph.push(`[${last}]${extraIn}${filters}[${out}]`);
    last = out;
  };
  const cleanup = [scriptFile, cmdFile, cursorFile, pressedFile, badgeFile, assFile];
  try {
    const lead = Math.max(0, recordedSeconds - (await videoSeconds(s.path)));
    const arrow = Math.round(s.height * CURSOR_FRACTION);
    await Promise.all([drawArrow(arrow, cursorFile), drawArrow(Math.round(arrow * PRESSED_SCALE), pressedFile), drawBadge(Math.round(s.height * LOGO_FRACTION), badgeFile)]);
    writeFileSync(cmdFile, pointerCommands(s, lead));
    inputs.push("-i", cursorFile, "-i", pressedFile);
    graph.push("[1:v]format=rgba[cursor]", "[2:v]format=rgba[pressed]");
    step(`sendcmd=f=${cmdFile},format=rgba`, "v1");
    step(`overlay@cur=x=${OFF}:y=${OFF}`, "v2", "[cursor]");
    step(`overlay@pressed=x=${OFF}:y=${OFF}`, "v3", "[pressed]");
    if (existsSync(badgeFile)) {
      inputs.push("-i", badgeFile);
      graph.push("[3:v]format=rgba[badge]");
      step(`overlay=x=W-w-${Math.round(s.height * 0.013)}:y=${Math.round(s.height * 0.013)}`, "v4", "[badge]");
    }
    if (burn) {
      const { band } = captionGeometry(s.height);
      writeFileSync(assFile, assDocument(s.width, s.height, captions, elapsed(s.startedAt)));
      step(`pad=iw:ih+${band}:0:0:color=0x1a1a1a,ass=filename=${assFile}`, "v5");
    }
    if (holdSeconds !== null) {
      const hold = holdSeconds.toFixed(3);
      step(`mpdecimate,showinfo,setpts=if(eq(N\\,0)\\,0\\,PREV_OUTPTS+min(PTS-PREV_INPTS\\,${hold}/TB)),tpad=stop_mode=clone:stop_duration=${hold}`, "v6");
    }
    step("format=yuv420p", "out");
    writeFileSync(scriptFile, graph.join(";\n"));
    rmSync(tmp, { force: true });
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        holdSeconds !== null ? "info" : "error",
        "-nostats",
        ...inputs,
        "-filter_complex_script",
        scriptFile,
        "-map",
        "[out]",
        "-fps_mode",
        holdSeconds !== null ? "vfr" : "passthrough",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-movflags",
        "+faststart",
        "-y",
        tmp,
      ],
      { timeout: FINISH_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 },
    );
    const seconds = await videoSeconds(tmp);
    if (seconds <= 0 || statSync(tmp).size === 0) throw new Error("finished video is empty");
    renameSync(tmp, s.path);
    const map = holdSeconds !== null ? retiming(keptTimes(stderr), holdSeconds, 1 / s.fps) : (t: number) => t;
    return { seconds, map };
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
    for (const f of cleanup) rmSync(f, { force: true });
  }
}

async function videoSeconds(path: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { timeout: 30_000 });
  const seconds = Number.parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

/** Where an overlay is parked when it is not to be seen. */
const OFF = -4096;

/**
 * The `sendcmd` script that moves the two arrows: at every traced moment, the one matching the
 * button state stands at the position (tip on the hotspot), the other is parked. Times are
 * shifted by `lead` (see {@link finish}) and clamped to the first frame.
 */
function pointerCommands(s: RecordingState, lead: number): string {
  const presses = s.presses.map((p) => ({ ...p, until: p.until ?? Number.POSITIVE_INFINITY }));
  // A press is also a position: the pointer may have been moved by hand since the last traced move.
  const moves = [...s.moves, ...presses.map((p): PointerMove => [p.from, p.x, p.y])].sort((a, b) => a[0] - b[0]);
  const moments = new Set<number>();
  for (const [t] of moves) moments.add(t);
  for (const p of presses) if (Number.isFinite(p.until)) moments.add(p.until);
  const times = [...moments].sort((a, b) => a - b);
  const lines: string[] = [];
  let move = 0;
  let at: [number, number] = [moves[0]?.[1] ?? 0, moves[0]?.[2] ?? 0];
  for (const t of times) {
    while (move < moves.length && (moves[move]?.[0] ?? Infinity) <= t) {
      const m = moves[move++];
      if (m) at = [m[1], m[2]];
    }
    const held = presses.some((p) => p.from <= t && t < p.until);
    const shown = held ? "pressed" : "cur";
    const hidden = held ? "cur" : "pressed";
    const x = at[0] - CURSOR_PAD;
    const y = at[1] - CURSOR_PAD;
    lines.push(`${Math.max(0, t - lead).toFixed(3)} overlay@${shown} x ${x}, overlay@${shown} y ${y}, overlay@${hidden} x ${OFF}, overlay@${hidden} y ${OFF};`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A white arrow with a dark outline and a soft shadow, `height` px tall, tip at (CURSOR_PAD,
 * CURSOR_PAD), drawn 4x and scaled down for smooth edges. ImageMagick, like `screenshot` uses.
 */
async function drawArrow(height: number, out: string): Promise<void> {
  const S = 4;
  const h = height * S;
  const pad = CURSOR_PAD * S;
  const shape: [number, number][] = [[0, 0], [0, 27], [6.4, 20.8], [11.6, 31.2], [15.6, 29.5], [10.4, 19.4], [19, 19.4]];
  const points = shape.map(([x, y]) => `${(pad + (x * h) / 32).toFixed(1)},${(pad + (y * h) / 32).toFixed(1)}`).join(" ");
  const size = `${Math.ceil((19 * h) / 32 + 2 * pad)}x${h + 2 * pad}`;
  await execFileAsync("convert", [
    "-size", size, "xc:none",
    "(", "-size", size, "xc:none", "-fill", "white", "-stroke", "#1c1c1c", "-strokewidth", String(2 * S), "-draw", `polygon ${points}`, ")",
    "(", "+clone", "-background", "black", "-shadow", `55x${3 * S}+${2 * S}+${3 * S}`, ")",
    "-swap", "1,2", "-background", "none", "-layers", "flatten",
    "-resize", `${100 / S}%`,
    out,
  ], { timeout: 30_000 });
}

/** The Sessionboxer mark, `side` px, centred on a rounded translucent dark badge; nothing when the image is not shipped. */
async function drawBadge(side: number, out: string): Promise<void> {
  if (!existsSync(LOGO_FILE)) return;
  const badge = Math.round(side * 1.45);
  const radius = Math.round(badge * 0.28);
  await execFileAsync("convert", [
    "-size", `${badge}x${badge}`, "xc:none", "-fill", "#11111199", "-draw", `roundrectangle 0,0 ${badge - 1},${badge - 1} ${radius},${radius}`,
    "(", LOGO_FILE, "-resize", `${side}x${side}`, ")",
    "-gravity", "center", "-composite",
    out,
  ], { timeout: 30_000 });
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
    `Style: Caption,${CAPTION_FONT},${fontSize},&H00F4F4F5,&H00F4F4F5,&H001A1A1A,&H001A1A1A,0,0,0,0,100,100,0,0,1,1,0,2,${fontSize},${fontSize},${margin},1`,
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

function trackPath(videoPath: string): string {
  return `${videoPath.slice(0, -4)}.vtt`;
}

/** Writes `<name>.vtt` next to the video (times in video time). */
function writeTrack(f: Finished): void {
  const cues: string[] = [];
  let cursor = 0;
  f.captions.forEach((c, i) => {
    const start = Math.max(c.at, cursor);
    const end = Math.max(f.captions[i + 1]?.at ?? f.seconds, start + MIN_CUE_SECONDS);
    cursor = end;
    cues.push(`${vttTime(start)} --> ${vttTime(end)}\n${c.text.replace(/-->/g, "→").replace(/</g, "‹")}`);
  });
  writeFileSync(trackPath(f.path), `WEBVTT\n\n${cues.join("\n\n")}\n`);
}

function vttTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
