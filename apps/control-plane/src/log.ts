// A reader that goes away (EPIPE) must not make logging itself fail: the uncaughtException handler logs too.
process.stderr.on("error", () => undefined);

export const log = (msg: string): void => {
  process.stderr.write(`[control-plane ${new Date().toISOString()}] ${msg}\n`);
};

/**
 * Prints lines framed and unprefixed, so they survive the wall of startup logs
 * (`docker compose logs -f`, image pulls) a first-time reader is scrolling through.
 */
export const banner = (lines: readonly string[]): void => {
  const width = Math.max(...lines.map((l) => [...l].length));
  const rule = "─".repeat(width + 2);
  const body = lines.map((l) => `│ ${l}${" ".repeat(width - [...l].length)} │`).join("\n");
  process.stderr.write(`\n┌${rule}┐\n${body}\n└${rule}┘\n\n`);
};
