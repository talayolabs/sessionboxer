import { useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  USAGE_AUTO_CONTINUE_INTERVAL_MS,
  USAGE_BAR_WINDOWS,
  formatCountdown,
  type Provider,
  type SessionUsage,
  type UsageWindow,
} from "@sessionboxer/protocol";
import { formatRfc5322, useClock } from "./time";

/** How many bars the row holds, whatever the Provider reports (ADR-0053). */
export const USAGE_BAR_COUNT = 3;

/** What a Provider that reports no windows would say in the bars' tooltip. */
const NO_WINDOWS: Record<Provider, string> = {
  "claude-code": "Claude has not reported its usage yet: it comes with the first call of a turn (Inspect LLM must be on).",
  codex: "Codex has not reported its usage yet: it comes after the first turn.",
  devin: "Devin does not report its usage windows (ACUs) to Sessionboxer.",
};

/** The current time, ticking every second while `live`. */
function useSeconds(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

/** A no-entry sign (drawn, so it looks the same whatever fonts the machine has). */
export function NoEntrySign({ size = 14 }: { size?: number }) {
  return (
    <svg className="no-entry" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="7.5" fill="#d1242f" />
      <rect x="3.5" y="6.75" width="9" height="2.5" rx="0.75" fill="#fff" />
    </svg>
  );
}

/** Bar colour: green when the window is empty, red when it is used up. */
function usageHue(used: number): number {
  return Math.round(120 * (1 - Math.min(1, Math.max(0, used))));
}

/** Time left as people say it ("2 d 3 h", "45 min", "under a minute"), for the bars' tooltip. */
export function formatLeft(resetsAt: string, now: number): string {
  const min = Math.max(0, Math.round((new Date(resetsAt).getTime() - now) / 60_000));
  if (min < 1) return "under a minute";
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

function windowTitle(w: UsageWindow, now: number): string {
  const pct = `${Math.round(w.used * 100)}%`;
  if (w.resetsAt === null) return `${w.label} usage: ${pct} used \u00b7 reset time not reported`;
  const when = new Date(w.resetsAt).getTime() <= now ? "reset due" : `resets in ${formatLeft(w.resetsAt, now)}`;
  return `${w.label} usage: ${pct} used \u00b7 ${when} (${formatRfc5322(w.resetsAt)})`;
}

/** The three bars the Provider's windows fill, in `USAGE_BAR_WINDOWS` order; empty slots say so on hover. */
export function usageBarSlots(windows: UsageWindow[]): (UsageWindow | null)[] {
  const ranked = [...windows].sort((a, b) => rank(a.id) - rank(b.id)).slice(0, USAGE_BAR_COUNT);
  return [...ranked, ...Array<null>(Math.max(0, USAGE_BAR_COUNT - ranked.length)).fill(null)];
}

function rank(id: string): number {
  const i = USAGE_BAR_WINDOWS.indexOf(id);
  return i === -1 ? USAGE_BAR_WINDOWS.length : i;
}

/**
 * Three usage bars side by side above the context gauge: the Provider's metered windows
 * (Claude: session / this week / Fable; Codex: its two limits), no figures on the bars, the
 * percentage and reset on hover.
 */
export function UsageBars({ usage, provider }: { usage: SessionUsage; provider: Provider }) {
  const now = useClock();
  const slots = usageBarSlots(usage.windows);
  const empty = usage.windows.length === 0;
  return (
    <div className="usage-bars" role="group" aria-label="Provider usage" title={empty ? NO_WINDOWS[provider] : undefined}>
      {slots.map((w, i) =>
        w ? (
          <span
            key={w.id}
            className={`ctx-bar usage-bar${w.used >= 1 ? " full" : ""}`}
            title={windowTitle(w, now)}
            style={{ ["--ctx-hue" as string]: String(usageHue(w.used)) }}
          >
            <span className="ctx-fill" style={{ width: `${Math.max(w.used > 0 ? 2 : 0, Math.min(100, w.used * 100))}%` }} />
          </span>
        ) : (
          <span key={`blank-${i}`} className="ctx-bar usage-bar blank" title={empty ? NO_WINDOWS[provider] : "Not reported by the Provider"} />
        ),
      )}
    </div>
  );
}

/**
 * The Provider refused the last turn for lack of usage credit: a ⛔ with the time left to the
 * reset, Continue (sends the interrupted prompt again) and Auto-continue (polls every 10 s and
 * continues by itself once the Provider answers again).
 */
export function UsageLimitBar({
  usage,
  provider,
  canContinue,
  busy,
  onContinue,
  onAutoContinue,
}: {
  usage: SessionUsage;
  provider: Provider;
  canContinue: boolean;
  busy: boolean;
  onContinue: () => void;
  onAutoContinue: (enabled: boolean) => void;
}) {
  const limit = usage.limit;
  const now = useSeconds(limit !== null && limit.resetsAt !== null);
  if (!limit) return null;
  const left = limit.resetsAt !== null ? formatCountdown(limit.resetsAt, new Date(now)) : null;
  const due = limit.resetsAt !== null && new Date(limit.resetsAt).getTime() <= now;
  const name = PROVIDER_LABELS[provider];
  const signTitle =
    (left !== null
      ? due
        ? `The usage limit should have reset (${formatRfc5322(limit.resetsAt!)}).`
        : `${left} left to reset usage (${formatRfc5322(limit.resetsAt!)}).`
      : `${name} did not say when its usage resets.`) + `\n\n${name} said: ${limit.message}`;
  return (
    <div className="usage-limit" role="status">
      <span className="usage-sign" title={signTitle}>
        <NoEntrySign size={16} />
        <span className="usage-limit-text">{name} usage limit reached</span>
        {left !== null && <span className={`usage-countdown${due ? " due" : ""}`}>{due ? "reset due" : left}</span>}
      </span>
      <span className="usage-limit-actions">
        <button
          type="button"
          className="small primary"
          disabled={!canContinue || busy}
          title={limit.retry ? `Send the interrupted prompt again now: \u201c${limit.retry.text.slice(0, 120)}\u201d` : "Clear the limit; the interrupted turn had nothing to send again"}
          onClick={onContinue}
        >
          Continue
        </button>
        <label
          className="usage-auto"
          title={`Polls ${name} every ${USAGE_AUTO_CONTINUE_INTERVAL_MS / 1000} s${limit.resetsAt !== null ? " once the reset is due" : ""} and continues by itself when usage is available again.`}
        >
          <input type="checkbox" checked={usage.autoContinue} disabled={busy} onChange={(e) => onAutoContinue(e.target.checked)} />
          Auto-continue
          {usage.autoContinue && <span className="usage-polling">{due || limit.resetsAt === null ? "\u00b7 polling\u2026" : "\u00b7 waits for the reset"}</span>}
        </label>
      </span>
    </div>
  );
}
