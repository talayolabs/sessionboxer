import { getStroke } from "perfect-freehand";

// The drawing behind the pencil button: strokes over a blank sheet or an attached image, rendered to a PNG.

export const SKETCH_COLORS = ["#111111", "#ffffff", "#e5484d", "#30a46c"] as const;
export type SketchColor = (typeof SKETCH_COLORS)[number];
export const COLOR_NAMES: Record<SketchColor, string> = { "#111111": "Black", "#ffffff": "White", "#e5484d": "Red", "#30a46c": "Green" };

export const WIDTHS = ["thin", "med", "bold"] as const;
export type Width = (typeof WIDTHS)[number];
export const SOFTENS = ["low", "med", "high"] as const;
export type Soften = (typeof SOFTENS)[number];

export type Point = [number, number];
export type Stroke = { points: Point[]; color: SketchColor; width: Width; soften: Soften };

/** Blank sheet: the stage's size in device pixels, within these bounds. */
export const BLANK_MIN = 640;
export const BLANK_MAX = 2048;
/** An attached image larger than this on a side is drawn on scaled down (its PNG would be huge anyway). */
export const IMAGE_MAX = 4096;

/** Stroke diameter in canvas pixels: thin is 2 px on a small sheet, the others grow with the sheet. */
export function strokeSize(width: Width, w: number, h: number): number {
  const k = Math.max(1, Math.max(w, h) / 1024);
  switch (width) {
    case "thin":
      return 2 * k;
    case "med":
      return 6 * k;
    case "bold":
      return 16 * k;
  }
}

const SOFTEN_OPTIONS: Record<Soften, { smoothing: number; streamline: number }> = {
  low: { smoothing: 0.15, streamline: 0.1 },
  med: { smoothing: 0.5, streamline: 0.4 },
  high: { smoothing: 0.85, streamline: 0.7 },
};

export function strokeOutline(stroke: Stroke, w: number, h: number, last: boolean): Point[] {
  return getStroke(stroke.points, {
    size: strokeSize(stroke.width, w, h),
    thinning: 0,
    simulatePressure: false,
    ...SOFTEN_OPTIONS[stroke.soften],
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
    last,
  }) as Point[];
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, last = true): void {
  if (stroke.points.length === 0) return;
  const [first, ...rest] = strokeOutline(stroke, ctx.canvas.width, ctx.canvas.height, last);
  if (!first) return;
  ctx.fillStyle = stroke.color;
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (const p of rest) ctx.lineTo(p[0], p[1]);
  ctx.closePath();
  ctx.fill();
}

/** The sheet: white, or the image scaled to the canvas. */
export function drawBackground(ctx: CanvasRenderingContext2D, image: CanvasImageSource | null): void {
  const { width, height } = ctx.canvas;
  if (image) ctx.drawImage(image, 0, 0, width, height);
  else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("This image cannot be opened for drawing."));
    img.src = url;
  });
}

/** Canvas size for an image: its own pixels, scaled down to fit `IMAGE_MAX`. */
export function imageCanvasSize(w: number, h: number): { w: number; h: number } {
  const s = Math.min(1, IMAGE_MAX / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Canvas size for a blank sheet filling a stage of `w`×`h` CSS pixels. */
export function blankCanvasSize(w: number, h: number, dpr: number): { w: number; h: number } {
  const scale = Math.min(BLANK_MAX / Math.max(1, w * dpr, h * dpr), 1) * dpr;
  return { w: Math.max(BLANK_MIN, Math.round(w * scale)), h: Math.max(Math.round(BLANK_MIN * 0.6), Math.round(h * scale)) };
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** The PNG of the canvas as a File: `sketch-<date>.png`, or the edited image's name with a `.png` ending. */
export async function sketchFile(canvas: HTMLCanvasElement, editedName: string | null): Promise<File> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The drawing could not be saved as an image.");
  const name = editedName ? editedName.replace(/\.[a-z0-9]+$/i, "") + ".png" : `sketch-${stamp()}.png`;
  return new File([blob], name, { type: "image/png", lastModified: Date.now() });
}
