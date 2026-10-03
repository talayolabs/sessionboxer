import { HttpError } from "./http-error.js";

/**
 * API keys as `NAME=value` lines, the way pi (ADR-0075) and Qwen Code (ADR-0083) take them:
 * `export NAME=value` is accepted too, blank and `#` lines are skipped, quotes around a value are
 * dropped. `invalid` words the 400 for a line that is not one. `""` means none.
 */
export function normalizeEnvLines(text: string, invalid: (line: string) => string): string {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    const value = m?.[2]?.trim().replace(/^(["'])(.*)\1$/, "$2") ?? "";
    if (!m || value === "") throw new HttpError(400, invalid(raw.trim()));
    lines.push(`${m[1]}=${value}`);
  }
  return lines.join("\n");
}

/** The normalized lines as the environment the Agent process gets. */
export function envOfLines(lines: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of lines.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}
