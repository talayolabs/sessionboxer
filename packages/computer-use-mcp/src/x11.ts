import { spawn } from "node:child_process";

export interface Display {
  name: string;
  width: number;
  height: number;
}

export function displayFromEnv(): Display {
  const name = process.env.DISPLAY ?? ":1";
  const width = Number(process.env.SESSIONBOXER_DISPLAY_WIDTH ?? 1024);
  const height = Number(process.env.SESSIONBOXER_DISPLAY_HEIGHT ?? 768);
  return { name, width, height };
}

function run(cmd: string, args: string[], display: Display, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, DISPLAY: display.name } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}: ${Buffer.concat(err).toString("utf8").trim()}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export type Coordinate = [number, number];

export function assertOnScreen(display: Display, [x, y]: Coordinate): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= display.width || y >= display.height) {
    throw new Error(`coordinate [${x}, ${y}] is outside the ${display.width}x${display.height} display`);
  }
}

export async function xdotool(display: Display, ...args: string[]): Promise<string> {
  const out = await run("xdotool", args, display);
  return out.toString("utf8");
}

/** The cursor glides to its target (`SESSIONBOXER_MOUSE_GLIDE=0` makes it jump instead). */
const GLIDE = process.env.SESSIONBOXER_MOUSE_GLIDE !== "0";
const GLIDE_STEP_MS = 8;
/**
 * Pause between typed characters, as xdotool's `--delay` (it sleeps half of it per key); a
 * desktop reached over RDP/VNC drops keys at xdotool's default pace.
 */
const TYPE_DELAY_MS = Number(process.env.SESSIONBOXER_TYPE_DELAY_MS ?? 12);

/** How fast the pointer travels and the keys fall. */
export interface Pace {
  /** Shortest (a short hop) and longest (across the screen) glide, in ms. */
  glideMs: [number, number];
  /** xdotool `--delay` between typed keys. */
  typeDelayMs: number;
}

/** When nobody watches: as fast as the applications keep up with. */
export const FAST_PACE: Pace = { glideMs: [100, 300], typeDelayMs: TYPE_DELAY_MS };
/**
 * While the desktop is recorded: a hand's pace, so a 30 fps video shows the pointer travelling
 * and the text arriving letter by letter (about one per frame) instead of in blocks.
 */
export const RECORDED_PACE: Pace = { glideMs: [350, 700], typeDelayMs: Math.max(TYPE_DELAY_MS, 64) };

function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

/** One position of a glide and the pause before the next one. */
export interface GlideStep {
  at: Coordinate;
  pauseMs: number;
}

/**
 * The intermediate positions of an eased glide from `from` to `to`, one per {@link GLIDE_STEP_MS};
 * the duration grows with the square root of the distance between the pace's bounds (a short
 * hop gets the shortest, ~900 px and more the longest). Consecutive steps that round to the same
 * pixel merge into one longer pause, so a short glide still takes its time. Empty when the two
 * are (nearly) the same point.
 */
export function glidePath(from: Coordinate, to: Coordinate, pace: Pace): GlideStep[] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 3) return [];
  const [minMs, maxMs] = pace.glideMs;
  const durationMs = Math.min(maxMs, minMs + ((maxMs - minMs) * Math.sqrt(distance)) / 30);
  const steps = Math.max(2, Math.round(durationMs / GLIDE_STEP_MS));
  const path: GlideStep[] = [];
  for (let i = 1; i < steps; i++) {
    const e = easeInOutCubic(i / steps);
    const last = path[path.length - 1];
    let p: Coordinate = [Math.round(from[0] + dx * e), Math.round(from[1] + dy * e)];
    // The target itself is left to the final `--sync` move, which would otherwise wait on a cursor already there.
    if (p[0] === to[0] && p[1] === to[1]) p = last?.at ?? from;
    if (last !== undefined && last.at[0] === p[0] && last.at[1] === p[1]) last.pauseMs += GLIDE_STEP_MS;
    else path.push({ at: p, pauseMs: GLIDE_STEP_MS });
  }
  return path;
}

/**
 * Move the cursor to `c`. With the glide on, the whole path goes to xdotool as one command chain
 * (`mousemove x y sleep 0.008 …`), so the motion is smooth and costs one process, and every
 * intermediate position is a real motion event for the application under the cursor (hover,
 * drag-over) as with a hand-moved mouse.
 */
export async function mouseMove(display: Display, pace: Pace, c: Coordinate): Promise<void> {
  assertOnScreen(display, c);
  const from = await cursorPosition(display);
  // `--sync` waits for the cursor to move; when it already stands on the target it waits for nothing (15 s).
  if (from[0] === c[0] && from[1] === c[1]) return;
  const path = GLIDE ? glidePath(from, c, pace) : [];
  const args: string[] = [];
  for (const { at: [x, y], pauseMs } of path) args.push("mousemove", String(x), String(y), "sleep", (pauseMs / 1000).toFixed(3));
  args.push("mousemove", "--sync", String(c[0]), String(c[1]));
  await xdotool(display, ...args);
}

export type MouseButton = 1 | 2 | 3;

export async function click(display: Display, pace: Pace, button: MouseButton, repeat = 1, c?: Coordinate): Promise<void> {
  if (c) await mouseMove(display, pace, c);
  const args = ["click"];
  if (repeat > 1) args.push("--repeat", String(repeat), "--delay", "80");
  args.push(String(button));
  await xdotool(display, ...args);
}

export async function mouseDown(display: Display, pace: Pace, button: MouseButton, c?: Coordinate): Promise<void> {
  if (c) await mouseMove(display, pace, c);
  await xdotool(display, "mousedown", String(button));
}

export async function mouseUp(display: Display, pace: Pace, button: MouseButton, c?: Coordinate): Promise<void> {
  if (c) await mouseMove(display, pace, c);
  await xdotool(display, "mouseup", String(button));
}

export async function drag(display: Display, pace: Pace, from: Coordinate, to: Coordinate): Promise<void> {
  await mouseMove(display, pace, from);
  await xdotool(display, "mousedown", "1");
  await sleep(100);
  await mouseMove(display, pace, to);
  await sleep(100);
  await xdotool(display, "mouseup", "1");
}

export async function typeText(display: Display, pace: Pace, text: string): Promise<void> {
  const chunk = 50;
  for (let i = 0; i < text.length; i += chunk) {
    await xdotool(display, "type", "--delay", String(pace.typeDelayMs), "--", text.slice(i, i + chunk));
  }
}

export async function key(display: Display, combo: string): Promise<void> {
  await xdotool(display, "key", "--", ...combo.trim().split(/\s+/));
}

export async function holdKey(display: Display, combo: string, durationSeconds: number): Promise<void> {
  const keys = combo.trim().split(/\s+/);
  await xdotool(display, "keydown", "--", ...keys);
  try {
    await sleep(durationSeconds * 1000);
  } finally {
    await xdotool(display, "keyup", "--", ...keys);
  }
}

export type ScrollDirection = "up" | "down" | "left" | "right";

export async function scroll(display: Display, pace: Pace, direction: ScrollDirection, amount: number, c?: Coordinate): Promise<void> {
  if (c) await mouseMove(display, pace, c);
  const button: Record<ScrollDirection, string> = { up: "4", down: "5", left: "6", right: "7" };
  await xdotool(display, "click", "--repeat", String(amount), "--delay", "40", button[direction]);
}

export async function cursorPosition(display: Display): Promise<Coordinate> {
  const out = await xdotool(display, "getmouselocation", "--shell");
  const x = Number(/X=(\d+)/.exec(out)?.[1]);
  const y = Number(/Y=(\d+)/.exec(out)?.[1]);
  return [x, y];
}

export async function screenshotPng(display: Display): Promise<Buffer> {
  return run("import", ["-window", "root", "-silent", "png:-"], display);
}

export type Region = [number, number, number, number];

export async function zoomPng(display: Display, [x0, y0, x1, y1]: Region): Promise<Buffer> {
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) throw new Error("zoom region must have positive width and height");
  assertOnScreen(display, [x0, y0]);
  assertOnScreen(display, [Math.min(x1, display.width - 1), Math.min(y1, display.height - 1)]);
  const full = await screenshotPng(display);
  return run(
    "convert",
    ["png:-", "-crop", `${w}x${h}+${x0}+${y0}`, "+repage", "-resize", `${display.width}x${display.height}`, "png:-"],
    display,
    full,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
