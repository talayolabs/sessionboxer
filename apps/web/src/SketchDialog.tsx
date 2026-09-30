import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Modal } from "./ui";
import {
  COLOR_NAMES,
  SKETCH_COLORS,
  SOFTENS,
  WIDTHS,
  blankCanvasSize,
  drawBackground,
  drawStroke,
  imageCanvasSize,
  loadImage,
  sketchFile,
  type Point,
  type SketchColor,
  type Soften,
  type Stroke,
  type Width,
} from "./sketch";

const WIDTH_LABELS: Record<Width, string> = { thin: "Thin", med: "Medium", bold: "Bold" };
const SOFTEN_LABELS: Record<Soften, string> = { low: "Low", med: "Medium", high: "High" };

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  undo: "M6 4L2.5 7.5 6 11M2.5 7.5H10a3.5 3.5 0 0 1 0 7H8",
  redo: "M10 4l3.5 3.5L10 11M13.5 7.5H6a3.5 3.5 0 0 0 0 7h2",
  close: "M4 4l8 8M12 4l-8 8",
  send: "M14 2L2 7l5 2 2 5zM14 2L7 9",
};
const SOFTEN_LINE: Point[] = [
  [1, 13],
  [6, 3],
  [10, 13],
  [15, 3],
];

/**
 * The polyline with each corner replaced by a quadratic curve that leaves the incoming segment `t` of the
 * way before the corner and rejoins the outgoing one `t` of the way after it: 0 keeps the corners, 0.5 is
 * the quadratic B-spline through the segment midpoints.
 */
function softenedPath(pts: Point[], t: number): string {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return "";
  const n = (v: number) => String(Math.round(v * 100) / 100);
  let d = `M${n(first[0])} ${n(first[1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const c = pts[i];
    const next = pts[i + 1];
    if (!prev || !c || !next) continue;
    d += `L${n(c[0] + (prev[0] - c[0]) * t)} ${n(c[1] + (prev[1] - c[1]) * t)}`;
    d += `Q${n(c[0])} ${n(c[1])} ${n(c[0] + (next[0] - c[0]) * t)} ${n(c[1] + (next[1] - c[1]) * t)}`;
  }
  return `${d}L${n(last[0])} ${n(last[1])}`;
}

/** The same A-B-C-D line at each soften level: as drawn, lightly smoothed, fully smoothed. */
const SOFTEN_ICONS: Record<Soften, string> = {
  low: softenedPath(SOFTEN_LINE, 0),
  med: softenedPath(SOFTEN_LINE, 0.25),
  high: softenedPath(SOFTEN_LINE, 0.5),
};

/**
 * Full-screen sheet to draw on — blank, or over an attached image — with four colours, three widths
 * (relative to the sheet), a soften level that rounds the strokes, undo/redo, and **Send**, which
 * hands the PNG to the composer's attachment list (replacing the image when editing one).
 */
export function SketchDialog({ image, onDone, onClose }: { image: { url: string; name: string } | null; onDone: (file: File) => void; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Background plus the committed strokes; the visible canvas is this plus the stroke in progress. */
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const backgroundRef = useRef<HTMLImageElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [color, setColor] = useState<SketchColor>(SKETCH_COLORS[0]);
  const [width, setWidth] = useState<Width>("med");
  const [soften, setSoften] = useState<Soften>("med");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redo, setRedo] = useState<Stroke[]>([]);
  const [saving, setSaving] = useState(false);
  const liveRef = useRef<Stroke | null>(null);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const redoRef = useRef(redo);
  redoRef.current = redo;

  // The sheet's size: the image's pixels, or the stage in device pixels, decided once.
  useLayoutEffect(() => {
    let cancelled = false;
    if (image) {
      loadImage(image.url)
        .then((img) => {
          if (cancelled) return;
          backgroundRef.current = img;
          setSize(imageCanvasSize(img.naturalWidth, img.naturalHeight));
        })
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    } else {
      const rect = stageRef.current?.getBoundingClientRect();
      setSize(blankCanvasSize(rect?.width ?? 1280, rect?.height ?? 800, window.devicePixelRatio || 1));
    }
    return () => {
      cancelled = true;
    };
  }, [image]);

  const paintBase = useCallback((list: Stroke[]) => {
    const base = baseRef.current;
    if (!base) return;
    const ctx = base.getContext("2d");
    if (!ctx) return;
    drawBackground(ctx, backgroundRef.current);
    for (const s of list) drawStroke(ctx, s);
  }, []);

  const present = useCallback((live: Stroke | null) => {
    const canvas = canvasRef.current;
    const base = baseRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !base || !ctx) return;
    ctx.drawImage(base, 0, 0);
    if (live) drawStroke(ctx, live, false);
  }, []);

  // Repaint everything when the sheet appears or the stroke list changes (undo, redo, commit).
  useEffect(() => {
    if (!size) return;
    if (!baseRef.current) {
      baseRef.current = document.createElement("canvas");
      baseRef.current.width = size.w;
      baseRef.current.height = size.h;
    }
    paintBase(strokes);
    present(liveRef.current);
  }, [size, strokes, paintBase, present]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) undo();
      else if ((k === "z" && e.shiftKey) || k === "y") redoOne();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const canvasPoint = (e: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height];
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || saving) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    liveRef.current = { points: [canvasPoint(e)], color, width, soften };
    present(liveRef.current);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current;
    if (!live) return;
    live.points.push(canvasPoint(e));
    present(live);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const live = liveRef.current;
    if (!live) return;
    liveRef.current = null;
    if (e.type !== "pointercancel") live.points.push(canvasPoint(e));
    setStrokes((cur) => [...cur, live]);
    setRedo([]);
  };

  const undo = () => {
    const cur = strokesRef.current;
    const last = cur[cur.length - 1];
    if (!last) return;
    setStrokes(cur.slice(0, -1));
    setRedo((r) => [...r, last]);
  };
  const redoOne = () => {
    const r = redoRef.current;
    const last = r[r.length - 1];
    if (!last) return;
    setRedo(r.slice(0, -1));
    setStrokes((cur) => [...cur, last]);
  };

  const send = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    try {
      onDone(await sketchFile(canvas, image?.name ?? null));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Modal className="sketch-dialog" title={image ? `Draw on ${image.name}` : "Draw"} dismissible={strokes.length === 0 && !saving} onClose={onClose}>
      <div ref={stageRef} className={`sketch-stage${image ? " image" : ""}`}>
        {size && !error && (
          <canvas
            ref={canvasRef}
            width={size.w}
            height={size.h}
            aria-label="Drawing sheet"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        )}
        {!size && !error && <div className="muted">{image ? "Opening the image\u2026" : ""}</div>}
        {error && <div className="error">{error}</div>}
      </div>
      <div className="actions sketch-actions">
        <div className="sketch-colors" role="radiogroup" aria-label="Colour">
          {SKETCH_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              className={`sketch-color${color === c ? " active" : ""}`}
              style={{ background: c }}
              title={COLOR_NAMES[c]}
              aria-label={COLOR_NAMES[c]}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <div className="segmented small" role="radiogroup" aria-label="Width">
          {WIDTHS.map((w) => (
            <button key={w} type="button" role="radio" aria-checked={width === w} aria-selected={width === w} title={`${WIDTH_LABELS[w]} pencil`} aria-label={`${WIDTH_LABELS[w]} pencil`} onClick={() => setWidth(w)}>
              <span className={`sketch-width ${w}`} aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="segmented small" role="radiogroup" aria-label="Soften">
          {SOFTENS.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={soften === s} aria-selected={soften === s} title={`Soften: ${SOFTEN_LABELS[s].toLowerCase()} — how much each line is rounded`} aria-label={`Soften ${SOFTEN_LABELS[s].toLowerCase()}`} onClick={() => setSoften(s)}>
              <Icon d={SOFTEN_ICONS[s]} />
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" onClick={undo} disabled={strokes.length === 0 || saving} title="Undo (Ctrl+Z)" aria-label="Undo">
          <Icon d={ICONS.undo} />
        </button>
        <button type="button" className="icon-btn" onClick={redoOne} disabled={redo.length === 0 || saving} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <Icon d={ICONS.redo} />
        </button>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={onClose} disabled={saving} title="Cancel" aria-label="Cancel">
          <Icon d={ICONS.close} />
        </button>
        <button
          type="button"
          className={`primary icon-btn${saving ? " busy" : ""}`}
          onClick={() => void send()}
          disabled={!size || saving || (image === null && strokes.length === 0)}
          title={image ? "Send: replace the attachment with this drawing" : "Send: attach the drawing to the prompt"}
          aria-label={saving ? "Saving" : "Send"}
        >
          <Icon d={ICONS.send} />
        </button>
      </div>
    </Modal>
  );
}
