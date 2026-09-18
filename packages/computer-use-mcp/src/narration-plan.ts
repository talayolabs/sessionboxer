/** A caption's start in the finished video, and how long its spoken sentence lasts. */
export interface Spoken {
  at: number;
  clipSeconds: number;
}

/** Frames at or after `from` (video time) move later by `extra` seconds: the frame before is held. */
export interface Shift {
  from: number;
  extra: number;
}

export interface NarrationPlan {
  /** Where each clip starts in the narrated video. */
  starts: number[];
  shifts: Shift[];
  /** Hold on the last frame, so the final sentence finishes before the video ends. */
  endHold: number;
  /** Length of the narrated video. */
  seconds: number;
  /** Time in the silent video → time in the narrated video. */
  map: (t: number) => number;
}

/**
 * The sentence of a step starts when its caption appears. A step shorter than its sentence
 * (plus `tail` of silence) keeps its last frame on screen for the difference, so the next step
 * never starts while the previous one is still being read; steps long enough are left alone.
 */
export function planNarration(spoken: Spoken[], videoSeconds: number, tail: number): NarrationPlan {
  const starts: number[] = [];
  const shifts: Shift[] = [];
  let endHold = 0;
  let shift = 0;
  spoken.forEach((s, i) => {
    const next = spoken[i + 1]?.at ?? videoSeconds;
    starts.push(s.at + shift);
    const extra = s.clipSeconds + tail - (next - s.at);
    if (extra <= 0) return;
    if (i + 1 < spoken.length) shifts.push({ from: next, extra });
    else endHold = extra;
    shift += extra;
  });
  const map = (t: number): number => {
    let out = t;
    for (const s of shifts) if (t >= s.from) out += s.extra;
    return out;
  };
  return { starts, shifts, endHold, seconds: videoSeconds + shift, map };
}
