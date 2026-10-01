import { posix } from "node:path";
import type { ExecutionEvidence } from "@sessionboxer/protocol";
import { fingerprint } from "@sessionboxer/protocol/node-telemetry";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const exitCode = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const commandTools = new Set(["bash", "exec", "get_output", "taskoutput", "terminal_read", "mcp__sessionboxer__terminal_read"]);

export function mergeExecutionMeta(previous: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...previous, ...patch };
  for (const key of ["terminal_exit", "claudeCode", "sessionboxer/execution", "sessionboxer/diagnostic"]) {
    if (key in previous || key in patch) merged[key] = { ...record(previous[key]), ...record(patch[key]) };
  }
  const oldResponse = record(record(previous.claudeCode).toolResponse);
  const newResponse = record(record(patch.claudeCode).toolResponse);
  if (Object.keys(oldResponse).length || Object.keys(newResponse).length) {
    const response = { ...oldResponse, ...newResponse };
    if ("task" in oldResponse || "task" in newResponse) response.task = { ...record(oldResponse.task), ...record(newResponse.task) };
    merged.claudeCode = { ...record(merged.claudeCode), toolResponse: response };
  }
  return merged;
}

export function executionEvidence(name: string | null, input: unknown, meta: Record<string, unknown>, output: unknown, locations: Array<{ path: string }> = []): ExecutionEvidence {
  const args = record(input);
  const raw = record(output);
  const response = record(record(meta.claudeCode).toolResponse);
  const task = record(response.task);
  const declared = record(meta["sessionboxer/execution"]);
  const terminal = record(meta.terminal_exit);
  const sources: Record<string, string> = {};
  const candidates: Array<[string, Record<string, unknown>]> = [["sessionboxer_execution", declared], ["terminal_exit", terminal]];
  if (commandTools.has(name?.toLowerCase() ?? "")) candidates.push(["structured_output", record(raw.structuredContent)], ["raw_output", raw], ["claude_task", task], ["claude_response", response]);
  const pick = <T>(field: string, aliases: string[], valid: (value: unknown) => value is T): T | null => {
    for (const [source, value] of candidates) {
      for (const key of aliases) {
        if (valid(value[key])) {
          sources[field] = source;
          return value[key] as T;
        }
      }
    }
    return null;
  };
  const code = pick("exitCode", ["exitCode", "exit_code"], exitCode);
  const signal = pick("terminationSignal", ["terminationSignal", "signal"], (v): v is string | number => (typeof v === "string" && /^SIG[A-Z0-9]+$/.test(v)) || (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 128));
  const bool = (v: unknown): v is boolean => typeof v === "boolean";
  const timedOut = pick("timedOut", ["timedOut", "timed_out"], bool);
  const interrupted = pick("interrupted", ["interrupted"], bool);
  const transportOutcome = pick("transportOutcome", ["transportOutcome"], (v): v is "succeeded" | "failed" => v === "succeeded" || v === "failed") ?? "unknown";
  const waitTimedOut = typeof response.timedOutAfterMs === "number" && response.timedOutAfterMs > 0 ? true : null;
  if (waitTimedOut) sources.waitTimedOut = "claude_response";
  const expected = record(meta["sessionboxer/diagnostic"]).expectedExitCodes;
  const expectedExitCodes = Array.isArray(expected) && expected.length > 0 && expected.length <= 32 && expected.every(exitCode) ? [...new Set(expected)] : null;
  const cwd = args.workdir ?? args.cwd ?? meta["cognition.ai/cwd"];
  const normalized = (path: string, relative = true): string => {
    const value = path.replace(/\\/g, "/");
    const full = value.startsWith("/") || /^[a-z]:\//i.test(value) || !relative || !text(cwd) ? value : `${cwd}/${value}`;
    const normalized = posix.normalize(full);
    return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const processRefs: string[] = [];
  const addProcess = (kind: string, id: unknown): void => {
    if ((text(id) && id.length <= 2048) || (typeof id === "number" && Number.isSafeInteger(id) && id >= 0)) processRefs.push(`${kind}:${fingerprint(String(id))}`);
  };
  addProcess("terminal", terminal.terminal_id);
  addProcess("shell", args.shell_id);
  addProcess("shell", meta["cognition.ai/backgroundShellId"]);
  addProcess("task", args.task_id);
  addProcess("task", response.backgroundTaskId);
  addProcess("task", task.task_id);
  if (commandTools.has(name?.toLowerCase() ?? "")) {
    for (const [, value] of candidates) {
      addProcess("pid", value.pid ?? value.processId);
      addProcess("shell", value.shell_id);
      addProcess("terminal", value.terminalId);
    }
  }
  if (name?.toLowerCase().endsWith("terminal_read")) addProcess("terminal", args.id);
  const targets = [args.file_path, args.path, ...locations.map((location) => location.path)].filter(text).map((path) => fingerprint(normalized(path)));
  if (text(args.url)) targets.push(fingerprint(args.url));
  const running = text(response.backgroundTaskId) || meta["cognition.ai/background"] === true || task.status === "running";
  const processOutcome = timedOut === true ? "timed_out" : signal !== null ? "signalled" : interrupted === true ? "interrupted" : code !== null ? code === 0 ? "succeeded" : "failed" : running ? "running" : "unknown";
  return {
    exitCode: code, terminationSignal: signal, timedOut, interrupted, waitTimedOut, processOutcome, transportOutcome,
    expectedExitCodes, diagnosticSource: expectedExitCodes ? "declared" : null, sources,
    context: {
      commandHash: text(args.command) ? fingerprint(args.command.trim()) : null,
      cwdHash: text(cwd) ? fingerprint(normalized(cwd, false)) : null,
      taskHash: text(declared.taskId) ? fingerprint(declared.taskId) : null,
      processRefs: [...new Set(processRefs)].sort(), targetHashes: [...new Set(targets)].sort(),
    },
  };
}
