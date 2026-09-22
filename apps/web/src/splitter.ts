import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Pointer-capture drag for a splitter element: `onMove` gets the pointer position while dragging.
 * Shared by the composer height, the sidebar width and the pane width splitters.
 */
export function startSplitterDrag(e: ReactPointerEvent<HTMLElement>, onMove: (clientX: number, clientY: number) => void): void {
  e.preventDefault();
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => onMove(ev.clientX, ev.clientY);
  const up = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** A remembered size (px or fraction) in localStorage, or `null` for the default. */
export function loadSize(key: string, min: number, max: number): number | null {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v >= min && v <= max ? v : null;
}

export function saveSize(key: string, value: number | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, String(value));
}

export const SIDEBAR_MIN_PX = 200;
export const SIDEBAR_MAX_PX = 640;
export const PANE_MIN_FRAC = 0.2;
export const PANE_MAX_FRAC = 0.8;

export const clampSidebar = (px: number) => clamp(Math.round(px), SIDEBAR_MIN_PX, SIDEBAR_MAX_PX);
export const clampPane = (frac: number) => clamp(frac, PANE_MIN_FRAC, PANE_MAX_FRAC);
