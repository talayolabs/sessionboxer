// Provider usage limits (ADR-0053): pure helpers shared by the Daemon (which reads Anthropic's
// response headers and classifies the Agent's errors), the Control Plane (which re-classifies the
// errors of its own probes) and the UI (which formats the countdown). No schemas here; those
// live in `index.ts` next to the Session.

/** One usage window a Provider meters (a rolling 5 hours, a week, a spend cap, …). */
export interface UsageWindowShape {
  /** Stable id within the Provider (`five_hour`, `seven_day`, `codex_primary`, …). */
  id: string;
  /** Short name for the bar ("Session", "This week", "Fable"). */
  label: string;
  /** Share of the window used, 0..1 (may exceed 1 when the Provider reports it so). */
  used: number;
  /** ISO time the window resets, when the Provider says. */
  resetsAt: string | null;
}

/**
 * Claude's windows and how the UI names them. `seven_day_overage_included` is the weekly
 * allowance of the Max/Team plans' included overage ("Fable" in Claude Code's own status line).
 */
export const CLAUDE_USAGE_WINDOWS: ReadonlyArray<{ header: string; id: string; label: string }> = [
  { header: "5h", id: "five_hour", label: "Session" },
  { header: "7d", id: "seven_day", label: "This week" },
  { header: "7d_oi", id: "seven_day_overage_included", label: "Fable" },
  { header: "7d_opus", id: "seven_day_opus", label: "Opus (week)" },
  { header: "7d_sonnet", id: "seven_day_sonnet", label: "Sonnet (week)" },
];

/** Windows the bars show first, in this order; others follow. */
export const USAGE_BAR_WINDOWS = ["five_hour", "seven_day", "seven_day_overage_included", "codex_primary", "codex_secondary"];

const CLAUDE_HEADER_PREFIX = "anthropic-ratelimit-unified-";

/**
 * The usage windows in an Anthropic response's `anthropic-ratelimit-unified-*` headers (lower-case
 * names). Only windows with a utilization are reported; a window without a reset keeps `null`.
 */
export function claudeUsageWindows(headers: Record<string, string | undefined>): UsageWindowShape[] {
  const out: UsageWindowShape[] = [];
  for (const w of CLAUDE_USAGE_WINDOWS) {
    const used = Number(headers[`${CLAUDE_HEADER_PREFIX}${w.header}-utilization`]);
    if (!Number.isFinite(used)) continue;
    out.push({ id: w.id, label: w.label, used: Math.max(0, used), resetsAt: epochHeader(headers[`${CLAUDE_HEADER_PREFIX}${w.header}-reset`]) });
  }
  return out;
}

/**
 * Anthropic refused the call for lack of usage credit: `anthropic-ratelimit-unified-status:
 * rejected` (or a 429 whose windows are full). Answers the reset time it advertises, if any.
 */
export function claudeRejectedReset(status: number | null, headers: Record<string, string | undefined>): { resetsAt: string | null } | null {
  const unified = headers[`${CLAUDE_HEADER_PREFIX}status`]?.toLowerCase();
  const windows = claudeUsageWindows(headers);
  const full = windows.filter((w) => w.used >= 1);
  if (unified !== "rejected" && !(status === 429 && full.length > 0)) return null;
  const direct = epochHeader(headers[`${CLAUDE_HEADER_PREFIX}reset`]);
  if (direct) return { resetsAt: direct };
  const candidates = (full.length > 0 ? full : windows).map((w) => w.resetsAt).filter((r): r is string => r !== null).sort();
  return { resetsAt: candidates[0] ?? null };
}

function epochHeader(value: string | undefined): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/** Headers the Daemon may keep from a Provider response: nothing but the usage meters. */
export function usageHeadersOnly(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!key.startsWith(CLAUDE_HEADER_PREFIX) && key !== "retry-after") continue;
    const v = Array.isArray(value) ? value[0] : value;
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Codex's `/status` answer, e.g. `**5h limit:** 80% left (resets 14:00)` and
 * `**Weekly limit:** 40% left (resets 14:00 on 26 Sep)` (codex-acp's wording; the `**` is
 * optional). Two windows at most: the first is the short one, the second the weekly one.
 */
export function codexStatusWindows(text: string, now: Date = new Date()): UsageWindowShape[] {
  const out: UsageWindowShape[] = [];
  const re = /\*{0,2}([^*\n:]{1,40}?(?:limit|window))\*{0,2}:\*{0,2}\s*(\d{1,3})%\s*left(?:\s*\(resets\s+([^)]+)\))?/gi;
  for (const m of text.matchAll(re)) {
    const label = (m[1] ?? "").trim();
    const left = Number(m[2]);
    if (label === "" || !Number.isFinite(left)) continue;
    const kind = /week/i.test(label) ? "secondary" : "primary";
    if (out.some((w) => w.id === `codex_${kind}`)) continue;
    const span = label.replace(/\s*limit$/i, "").trim();
    out.push({
      id: `codex_${kind}`,
      label: kind === "secondary" ? "This week" : /^\d+[mhd]$/i.test(span) ? `Session (${span})` : span || "Session",
      used: Math.min(1, Math.max(0, (100 - left) / 100)),
      resetsAt: m[3] ? parseClockReset(m[3], now) : null,
    });
  }
  return out;
}

/** What a Provider's error says about its usage limit: nothing (not a limit) or the reset, if it gives one. */
export interface UsageLimitHit {
  resetsAt: string | null;
}

const CLAUDE_LIMIT = [
  /hit your (?:session|weekly|monthly|fast[- ]mode|opus|sonnet)?\s*(?:usage |spend )?limit/i,
  /reached your (?:weekly |monthly )?(?:usage |spend )?limit/i,
  /usage (?:credit )?limit (?:has been )?reached/i,
  /out of (?:usage )?credits/i,
  /extra usage limit/i,
];
const CODEX_LIMIT = [
  /hit your usage limit/i,
  /usage[_ ]limit[_ ]reached/i,
  /usage[_ ]limited/i,
  /quota[_ ]exceeded/i,
  /budget[_ ]limited/i,
  /out of credits/i,
  /insufficient[_ ]quota/i,
];
const DEVIN_LIMIT = [/quota exhausted/i, /usage[_ ]limit[_ ]reached/i, /resource[_ ]exhausted/i, /acu limit/i, /out of acus/i, /no acus? (?:left|remaining)/i];

/**
 * Whether an Agent error is the Provider refusing to work for lack of usage credit (the prompt
 * can be sent again once the window resets), as opposed to any other failure. Wrapped messages
 * ("… — Claude Code failed: You've hit your session limit · resets 2pm (UTC).") count too.
 */
export function classifyUsageLimit(provider: "claude-code" | "devin" | "codex", message: string, now: Date = new Date()): UsageLimitHit | null {
  const patterns = provider === "claude-code" ? CLAUDE_LIMIT : provider === "codex" ? CODEX_LIMIT : DEVIN_LIMIT;
  if (!patterns.some((p) => p.test(message))) return null;
  return { resetsAt: parseResetMention(message, now) };
}

/**
 * The reset time a limit message mentions: Claude's `resets 2pm (UTC)`, `resets 11:30am (UTC)`,
 * `resets Sep 25, 2pm (UTC)`; Codex's `resets 14:00 on 26 Sep`; `try again in 2h 15m` /
 * `in 45 minutes` / `retry after 3600 seconds`. `null` when none is found.
 */
export function parseResetMention(message: string, now: Date = new Date()): string | null {
  const resets = /resets?(?:\s+(?:at|on))?\s+([^.\n]*?)(?=[.\n]|$)/i.exec(message);
  if (resets?.[1]) {
    const parsed = parseClockReset(resets[1].trim(), now);
    if (parsed) return parsed;
  }
  const relative =
    /\b(?:in|after)\s+(?=\d)(?:(\d+)\s*(?:d|days?)\b)?\s*(?:(\d+)\s*(?:h|hours?|hrs?)\b)?\s*(?:(\d+)\s*(?:m|min|minutes?)\b)?\s*(?:(\d+)\s*(?:s|sec|seconds?)\b)?/i.exec(message);
  if (relative && (relative[1] || relative[2] || relative[3] || relative[4])) {
    const ms =
      (Number(relative[1] ?? 0) * 86_400 + Number(relative[2] ?? 0) * 3_600 + Number(relative[3] ?? 0) * 60 + Number(relative[4] ?? 0)) * 1000;
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A clock time with optional date and zone, as the Providers print it: `2pm (UTC)`,
 * `11:30am (UTC)`, `14:00`, `14:00 on 26 Sep`, `Sep 25, 2pm (UTC)`, `Sep 25 at 2pm (UTC)`. The
 * next such moment after `now` (today, or tomorrow when the time has passed today); an unknown
 * zone is taken as the local one (the Sandbox's clock, which is what the Agent printed in).
 */
export function parseClockReset(text: string, now: Date = new Date()): string | null {
  // `14:00`, `11:30am`, or `2pm`; a bare number is a day of the month, not a time.
  const time = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i.exec(text) ?? /\b(\d{1,2})()\s*(am|pm)\b/i.exec(text);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = time[2] ? Number(time[2]) : 0;
  const ampm = time[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const utc = /\b(utc|gmt|z)\b/i.test(text);
  const dateMatch =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/i.exec(text) ??
    /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?/i.exec(text);
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  if (dateMatch) {
    const [, first = "", second = ""] = dateMatch;
    const monthFirst = /^[a-z]/i.test(first);
    month = MONTHS.indexOf((monthFirst ? first : second).slice(0, 3).toLowerCase());
    day = Number(monthFirst ? second : first);
    year = dateMatch[3] ? Number(dateMatch[3]) : null;
  }
  const build = (y: number, mo: number, d: number): Date =>
    utc ? new Date(Date.UTC(y, mo, d, hour, minute, 0, 0)) : new Date(y, mo, d, hour, minute, 0, 0);
  const nowY = utc ? now.getUTCFullYear() : now.getFullYear();
  const nowM = utc ? now.getUTCMonth() : now.getMonth();
  const nowD = utc ? now.getUTCDate() : now.getDate();
  if (month !== null && day !== null) {
    let at = build(year ?? nowY, month, day);
    if (year === null && at.getTime() < now.getTime() - 86_400_000) at = build(nowY + 1, month, day);
    return at.toISOString();
  }
  let at = build(nowY, nowM, nowD);
  if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + 86_400_000);
  return at.toISOString();
}

/** `1 day 03:14:07` / `03:14:07` left until `resetsAt`; `00:00:00` once passed. */
export function formatCountdown(resetsAt: string | Date, now: Date = new Date()): string {
  const target = typeof resetsAt === "string" ? new Date(resetsAt) : resetsAt;
  let s = Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000));
  const days = Math.floor(s / 86_400);
  s -= days * 86_400;
  const h = Math.floor(s / 3_600);
  s -= h * 3_600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return days > 0 ? `${days} day${days === 1 ? "" : "s"} ${clock}` : clock;
}

/** Windows in bar order, dropping duplicates by id (the last report of a window wins). */
export function mergeUsageWindows<T extends UsageWindowShape>(previous: T[], reported: T[]): T[] {
  const byId = new Map<string, T>();
  for (const w of previous) byId.set(w.id, w);
  for (const w of reported) byId.set(w.id, w);
  return [...byId.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

function rank(id: string): number {
  const i = USAGE_BAR_WINDOWS.indexOf(id);
  return i === -1 ? USAGE_BAR_WINDOWS.length : i;
}
