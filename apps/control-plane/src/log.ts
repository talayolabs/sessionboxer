// A reader that goes away (EPIPE) must not make logging itself fail: the uncaughtException handler logs too.
process.stderr.on("error", () => undefined);

export const log = (msg: string): void => {
  process.stderr.write(`[control-plane ${new Date().toISOString()}] ${msg}\n`);
};
