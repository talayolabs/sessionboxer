import cronstrue from "cronstrue";
import type { ReviewVerdict } from "@sessionboxer/protocol";

export const VERDICT_LABELS: Record<ReviewVerdict, string> = { comment: "Comment only", request_changes: "May request changes", approve: "May approve" };

export function formatAt(iso: string, timeZone?: string): string {
  try {
    return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** Plain words for a cron expression, or `null` when cronstrue cannot read it (the Control Plane's preview is the authority). */
export function describeCron(cron: string): string | null {
  try {
    return cronstrue.toString(cron.trim(), { use24HourTimeFormat: true, verbose: false });
  } catch {
    return null;
  }
}
