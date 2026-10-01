import type { SessionUpdate, ToolExecutionTelemetry } from "@sessionboxer/protocol";
import { classifyToolError } from "@sessionboxer/protocol/node-telemetry";
import { executionEvidence, mergeExecutionMeta } from "./execution-evidence.js";

type Call = { start: number | null; startedAt: string | null; name: string | null; input: unknown; meta: Record<string, unknown>; structuredOutput: Record<string, unknown>; locations: Array<{ path: string }>; output: unknown; content: unknown; done: boolean; mcp: { server: string; tool: string; isError: boolean } | null };

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class ToolTelemetry {
  private calls = new Map<string, Call>();
  private turnId: string | null = null;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  begin(turnId: string): void {
    this.calls.clear();
    this.turnId = turnId;
  }

  end(): void {
    this.calls.clear();
    this.turnId = null;
  }

  /** The exact MCP result behind an ACP tool call, as the tee saw it (ADR-0078); only counts when it arrives before the call completes. */
  attachExact(toolCallId: string, info: { server: string; tool: string; isError: boolean }): void {
    let call = this.calls.get(toolCallId);
    if (!call) {
      if (this.calls.size >= 10_000) return;
      call = { start: null, startedAt: null, name: null, input: null, meta: {}, structuredOutput: {}, locations: [], output: null, content: null, done: false, mcp: null };
      this.calls.set(toolCallId, call);
    }
    if (!call.done) call.mcp = info;
  }

  observe(update: SessionUpdate): ToolExecutionTelemetry | null {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;
    const id = update.toolCallId;
    let call = this.calls.get(id);
    if (!call) {
      if (this.calls.size >= 10_000) return null;
      call = { start: update.sessionUpdate === "tool_call" ? this.clock() : null, startedAt: update.sessionUpdate === "tool_call" ? new Date().toISOString() : null, name: null, input: null, meta: {}, structuredOutput: {}, locations: [], output: null, content: null, done: false, mcp: null };
      this.calls.set(id, call);
    }
    if (call.done) return null;
    call.meta = mergeExecutionMeta(call.meta, object(update._meta));
    const meta = call.meta;
    if (update.rawInput !== undefined && Object.keys(object(update.rawInput)).length) call.input = update.rawInput;
    if (update.locations?.length) call.locations = update.locations;
    call.structuredOutput = { ...call.structuredOutput, ...object(update.rawOutput) };
    const name = object(update).name ?? object(meta.claudeCode).toolName ?? meta["cognition.ai/inferenceToolName"];
    if (typeof name === "string") call.name = name;
    if (update.rawOutput !== undefined && update.rawOutput !== null) call.output = update.rawOutput;
    if (update.content?.length) call.content = update.content;
    if (update.status !== "completed" && update.status !== "failed") return null;
    call.done = true;
    const output = { ...call.structuredOutput, ...object(call.output) };
    const measured = object(object(output._meta)["sessionboxer/telemetry"]);
    const valid = measured.version === 1;
    const resultIsError = typeof output.isError === "boolean" ? output.isError : call.mcp ? call.mcp.isError : null;
    const failed = update.status === "failed" || resultIsError === true;
    const execution = executionEvidence(call.name, call.input, meta, call.structuredOutput, call.locations);
    const processError = execution.processOutcome === "failed" ? "nonzero_exit" : execution.processOutcome === "timed_out" ? "timeout" : execution.processOutcome === "signalled" ? "signalled" : execution.processOutcome === "interrupted" ? "cancelled" : execution.transportOutcome === "failed" ? "transport_error" : null;
    const result: ToolExecutionTelemetry = {
      version: 2,
      execution,
      turnId: this.turnId,
      toolCallId: id,
      toolName: call.name,
      status: update.status,
      startedAt: call.startedAt,
      observedDurationMs: call.start === null ? null : Math.max(0, this.clock() - call.start),
      executionId: valid && typeof measured.executionId === "string" && /^[a-f0-9-]{36}$/.test(measured.executionId) ? measured.executionId : null,
      executionMs: valid && typeof measured.executionMs === "number" && Number.isFinite(measured.executionMs) && measured.executionMs >= 0 ? measured.executionMs : null,
      toolSchemaHash: valid && typeof measured.toolSchemaHash === "string" && /^[a-f0-9]{64}$/.test(measured.toolSchemaHash) ? measured.toolSchemaHash : null,
      resultIsError,
      errorCode: processError ?? (failed ? execution.processOutcome === "succeeded" ? "tool_error" : classifyToolError(JSON.stringify(call.output ?? call.content ?? "")) : null),
      errorSource: processError ? "structured" : failed ? execution.processOutcome === "succeeded" ? "acp_status" : "heuristic" : null,
      ...(call.mcp ? { mcp: { server: call.mcp.server, tool: call.mcp.tool, exact: true as const } } : {}),
    };
    call.output = null;
    call.content = null;
    call.input = null;
    call.meta = {};
    call.structuredOutput = {};
    call.locations = [];
    call.mcp = null;
    return result;
  }
}
