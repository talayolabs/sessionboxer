import { createHash, randomUUID } from "node:crypto";
import type { McpExecutionTelemetry } from "./index.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
}

export function requestFingerprints(request: { system?: unknown; tools?: unknown }): { systemPromptHash: string | null; toolSchemaHash: string | null } {
  return {
    systemPromptHash: request.system === undefined ? null : fingerprint(request.system),
    toolSchemaHash: request.tools === undefined ? null : fingerprint(request.tools),
  };
}

export function classifyToolError(text: string): NonNullable<McpExecutionTelemetry["errorCode"]> {
  if (/invalid.*(?:argument|parameter)|validation error|required.*field|unexpected.*argument/i.test(text)) return "invalid_arguments";
  if (/permission denied|unauthorized|forbidden|not authenticated/i.test(text)) return "permission_denied";
  if (/timed out|timeout/i.test(text)) return "timeout";
  if (/rate.limit|too many requests|\b429\b/i.test(text)) return "rate_limit";
  if (/not unique|multiple matches|old_string/i.test(text)) return "edit_match";
  if (/not found|no such file|does not exist/i.test(text)) return "not_found";
  if (/cancelled|canceled|interrupted/i.test(text)) return "cancelled";
  if (/connection refused|connection reset|ENOTFOUND/i.test(text)) return "network";
  if (/exit code\s*[:=]?\s*[1-9]|exited with (?:code|status)\s*[1-9]/i.test(text)) return "nonzero_exit";
  return "tool_error";
}

export function instrumentTool<Args extends unknown[], Result extends { isError?: boolean; _meta?: Record<string, unknown> }>(
  toolSchemaHash: string,
  handler: (...args: Args) => Result | Promise<Result>,
  report?: (measurement: Omit<McpExecutionTelemetry, "server" | "toolName">) => Promise<void>,
) {
  return async (...args: Args) => {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let result: Result | { isError: true; content: Array<{ type: "text"; text: string }>; _meta?: Record<string, unknown> };
    try {
      result = await handler(...args);
    } catch (error) {
      result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
    const measurement = {
      version: 1 as const,
      executionId: randomUUID(),
      startedAt,
      toolSchemaHash,
      executionMs: Math.max(0, performance.now() - started),
      errorCode: result.isError ? classifyToolError(JSON.stringify(result)) : null,
      errorSource: result.isError ? "heuristic" as const : null,
    };
    await report?.(measurement).catch(() => undefined);
    return { ...result, _meta: { ...result._meta, "sessionboxer/telemetry": measurement } };
  };
}

export function reportMcpExecution(server: "desktop" | "sessionboxer", toolName: string) {
  return async (measurement: Omit<McpExecutionTelemetry, "server" | "toolName">): Promise<void> => {
    const port = Number(process.env.SESSIONBOXER_DAEMON_PORT ?? 7000);
    await fetch(`http://127.0.0.1:${port}/telemetry/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...measurement, server, toolName }),
      signal: AbortSignal.timeout(250),
    });
  };
}
