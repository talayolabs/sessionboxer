export const log = (msg: string): void => {
  process.stderr.write(`[control-plane ${new Date().toISOString()}] ${msg}\n`);
};
