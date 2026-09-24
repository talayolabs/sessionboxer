import { useSyncExternalStore } from "react";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const two = (n: number) => String(n).padStart(2, "0");

/** The instant as an RFC 5322 date in the browser's time zone: `Tue, 22 Sep 2026 10:47:12 +0200`. */
export function formatRfc5322(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const zone = `${sign}${two(Math.floor(Math.abs(offset) / 60))}${two(Math.abs(offset) % 60)}`;
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${zone}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * The instant as people say it: `just now`, `12 min ago`, `3 h ago`, then `today 14:32`,
 * `yesterday 14:32`, `Mon 14:32` within the week, `12 Sep 14:32` within the year, `12 Sep 2025`.
 */
export function formatRelative(iso: string, now: number): string {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return iso;
  const ago = now - t;
  if (ago < 45_000) return "just now";
  if (ago < HOUR) return `${Math.round(ago / MINUTE)} min ago`;
  const ref = new Date(now);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (ago < 6 * HOUR && sameDay(d, ref)) return `${Math.floor(ago / HOUR)} h ago`;
  if (sameDay(d, ref)) return `today ${hm}`;
  if (sameDay(d, new Date(now - DAY))) return `yesterday ${hm}`;
  if (ago < 6 * DAY) return `${DAYS[d.getDay()]} ${hm}`;
  if (d.getFullYear() === ref.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// One ticker for every relative time on the page: it advances every half minute, and only
// the components showing a time re-render.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current time, refreshed every half minute (enough for `formatRelative`). */
export function useClock(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}
