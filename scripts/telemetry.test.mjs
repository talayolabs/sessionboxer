import test from "node:test";
import assert from "node:assert/strict";
import { fingerprint, instrumentTool, requestFingerprints } from "../packages/protocol/dist/node-telemetry.js";
import { ToolTelemetry } from "../packages/sandbox-daemon/dist/tool-telemetry.js";
import { handleToolTelemetry } from "../packages/sandbox-daemon/dist/telemetry-http.js";
import { reportMcpExecution } from "../packages/protocol/dist/node-telemetry.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmInspector } from "../packages/sandbox-daemon/dist/llm-inspector.js";
import { AgentManager } from "../packages/sandbox-daemon/dist/agent.js";
import { Db } from "../apps/control-plane/dist/db.js";
import { Session } from "../packages/protocol/dist/index.js";
import { E2eVerification } from "../apps/control-plane/dist/e2e.js";
import { executionEvidence, mergeExecutionMeta } from "../packages/sandbox-daemon/dist/execution-evidence.js";
import { spawnSync } from "node:child_process";

test("turn context records the reported model and survives database persistence", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sessionboxer-turn-"));
  const db = new Db(":memory:");
  const stamp = new Date().toISOString();
  db.insertSession(Session.parse({ id: "fixture", title: "fixture", provider: "devin", status: "idle", workspaceSource: { type: "empty" }, containerId: null, error: null, createdAt: stamp, updatedAt: stamp }));
  const contexts = [];
  const events = {
    onPromptStarted: (context) => {
      contexts.push(context);
      db.appendEvent("fixture", { type: "turn_context", context: { ...context, version: 1, turnId: "turn", provider: "devin" } });
    },
    onStateChange: () => {}, onTurnEnded: () => {}, onError: (error) => assert.fail(error),
  };
  const agent = new AgentManager({ stateFile: join(temp, "state.json"), sessionId: "fixture", newConversation: false, cwd: temp, instructions: "private standing instructions", instructionsDelivery: "system-prompt", workspaceBriefing: () => "private briefing", builtinMcps: () => [{ name: "desktop", command: "unused" }], log: () => {} }, events);
  agent.mcpServers = [];
  agent.currentModel = "actual-model";
  agent.model = "requested-model";
  agent.ensureStarted = async () => {};
  agent.acpSessionId = "acp-fixture";
  agent.conn = { agent: { request: async () => ({ stopReason: "end_turn" }) } };
  try {
    await agent.prompt("private user request");
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].model, "actual-model");
    assert.equal(contexts[0].configuredInstructionsHash, fingerprint("private standing instructions\n\nprivate briefing"));
    const persisted = db.listEvents("fixture");
    assert.equal(persisted[0].body.type, "turn_context");
    assert.equal(persisted[0].body.context.turnId, "turn");
    assert.equal(JSON.stringify(persisted).includes("private"), false);
  } finally {
    db.connection.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("fingerprints are stable, change with definitions, and contain no source text", () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  assert.notEqual(fingerprint({ description: "old" }), fingerprint({ description: "new" }));
  const value = requestFingerprints({ system: "private instructions", tools: [{ name: "read" }] });
  assert.match(value.systemPromptHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(value).includes("private"), false);
  assert.equal(requestFingerprints({}).toolSchemaHash, null);
});

test("instrumentation preserves results and measures executions, including failures", async () => {
  const original = { content: [{ type: "text", text: "OK" }], _meta: { existing: true } };
  const run = instrumentTool("schema", async () => original);
  const result = await run();
  assert.deepEqual(result.content, original.content);
  assert.equal(result._meta.existing, true);
  assert.ok(result._meta["sessionboxer/telemetry"].executionMs >= 0);
  assert.equal(result._meta["sessionboxer/telemetry"].toolSchemaHash, "schema");
  assert.equal(original._meta["sessionboxer/telemetry"], undefined);
  const failed = await instrumentTool("schema", async () => { throw new Error("Permission denied"); })();
  assert.equal(failed.isError, true);
  assert.equal(failed._meta["sessionboxer/telemetry"].errorCode, "permission_denied");
  const signalled = await instrumentTool("schema", () => ({ isError: true, content: [{ type: "text", text: "invalid arguments" }] }))();
  assert.equal(signalled._meta["sessionboxer/telemetry"].errorCode, "invalid_arguments");
});

test("MCP measurements reach the daemon without exposing arguments or outputs", async () => {
  const records = [];
  const server = createServer((req, res) => {
    if (!handleToolTelemetry(req, res, (record) => records.push(record))) res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const previousPort = process.env.SESSIONBOXER_DAEMON_PORT;
  process.env.SESSIONBOXER_DAEMON_PORT = String(server.address().port);
  const url = `http://127.0.0.1:${server.address().port}/telemetry/tool`;
  try {
    await instrumentTool(fingerprint("schema"), async (input) => ({ content: [{ type: "text", text: input }] }), reportMcpExecution("desktop", "wait"))("private");
    assert.equal(records.length, 1);
    assert.equal(records[0].toolName, "wait");
    assert.equal(JSON.stringify(records).includes("private"), false);
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 400);
    assert.equal((await fetch(url, { method: "POST", body: "x".repeat(9000) })).status, 413);
    assert.equal(records.length, 1);
  } finally {
    if (previousPort === undefined) delete process.env.SESSIONBOXER_DAEMON_PORT;
    else process.env.SESSIONBOXER_DAEMON_PORT = previousPort;
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
});

test("the actual Sessionboxer MCP publishes definitions and reports successful and failed handlers", async () => {
  const records = [];
  const server = createServer((req, res) => {
    if (handleToolTelemetry(req, res, (record) => records.push(record))) return;
    if (req.url === "/sessionboxer") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.args?.query === "fail") res.writeHead(409).end("Permission denied");
        else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify("fixture guide"));
      });
    } else res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["packages/sessionboxer-mcp/dist/index.js"], env: { ...process.env, SESSIONBOXER_DAEMON_PORT: String(server.address().port) }, stderr: "pipe" });
  const client = new Client({ name: "telemetry-test", version: "1" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "docs"));
    const result = await client.callTool({ name: "docs", arguments: { query: "test" } });
    assert.equal(result.content[0].text, "fixture guide");
    assert.match(result._meta["sessionboxer/telemetry"].toolSchemaHash, /^[a-f0-9]{64}$/);
    const failed = await client.callTool({ name: "docs", arguments: { query: "fail" } });
    assert.equal(failed.isError, true);
    assert.equal(records.length, 2);
    assert.equal(records[1].errorCode, "permission_denied");
    assert.equal(records[0].toolSchemaHash, records[1].toolSchemaHash);
    const invalid = await client.callTool({ name: "docs", arguments: {} });
    assert.equal(invalid.isError, true);
    assert.equal(records.length, 2);
    const desktopTransport = new StdioClientTransport({ command: process.execPath, args: ["packages/computer-use-mcp/dist/index.js"], env: { ...process.env, SESSIONBOXER_DAEMON_PORT: String(server.address().port) }, stderr: "pipe" });
    const desktop = new Client({ name: "desktop-telemetry-test", version: "1" });
    try {
      await desktop.connect(desktopTransport);
      const status = await desktop.callTool({ name: "recording_status", arguments: {} });
      assert.equal(status.isError, undefined);
      assert.equal(records.length, 3);
      assert.equal(records[2].server, "desktop");
      assert.equal(records[2].toolName, "recording_status");
    } finally {
      await desktop.close();
      await desktopTransport.close();
    }
  } finally {
    await client.close();
    await transport.close();
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
});

test("the inspector persists prompt/schema fingerprints even when saved request bodies are truncated", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sessionboxer-telemetry-"));
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "fixture", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } })));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const calls = [];
  const inspector = new LlmInspector({ port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`, dir: join(temp, "bodies"), log: () => {}, onCall: (call) => calls.push(call) });
  try {
    await inspector.start();
    const payload = { model: "fixture-model", system: "private-system", tools: [{ name: "read", input_schema: { type: "object" } }], messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024) }] };
    const response = await fetch(`http://127.0.0.1:${inspector.server.address().port}/v1/messages`, { method: "POST", body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    await response.text();
    inspector.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].requestTruncated, true);
    assert.equal(calls[0].shape.systemPromptHash, requestFingerprints(payload).systemPromptHash);
    assert.equal(calls[0].shape.toolSchemaHash, requestFingerprints(payload).toolSchemaHash);
    assert.equal(JSON.stringify(calls).includes("private-system"), false);
  } finally {
    inspector.flush();
    if (inspector.server) {
      inspector.server.close();
      inspector.server.closeAllConnections();
      await once(inspector.server, "close");
    }
    upstream.close();
    upstream.closeAllConnections();
    await once(upstream, "close");
    await rm(temp, { recursive: true, force: true });
  }
});

test("failed telemetry delivery does not fail a tool", async () => {
  const result = await instrumentTool("schema", () => ({ content: [{ type: "text", text: "OK" }] }), async () => { throw new Error("offline"); })();
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, "OK");
});

test("ACP telemetry folds partial updates, ignores duplicate terminals, and separates clock sources", () => {
  let clock = 100;
  const tracker = new ToolTelemetry(() => clock);
  tracker.begin("turn-1");
  assert.equal(tracker.observe({ sessionUpdate: "tool_call", toolCallId: "a", title: "read", kind: "read", status: "pending", _meta: { claudeCode: { toolName: "Read" } } }), null);
  clock = 120;
  tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "a", rawInput: { file_path: "private-path" } });
  clock = 160;
  const result = tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed", rawOutput: { content: [{ type: "text", text: "secret output" }], _meta: { "sessionboxer/telemetry": { version: 1, executionMs: 4, toolSchemaHash: "a".repeat(64), errorCode: null } } } });
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.toolName, "Read");
  assert.equal(result.observedDurationMs, 60);
  assert.equal(result.executionMs, 4);
  assert.equal(result.toolSchemaHash, "a".repeat(64));
  assert.equal(JSON.stringify(result).includes("private-path"), false);
  assert.equal(JSON.stringify(result).includes("secret output"), false);
  assert.equal(tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }), null);
  tracker.end();
  tracker.begin("turn-2");
  const orphan = tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "failed" });
  assert.equal(orphan.observedDurationMs, null);
  assert.equal(orphan.executionMs, null);
  assert.equal(orphan.turnId, "turn-2");
});

test("structured terminal exits survive streaming updates and override contradictory output text", () => {
  const tracker = new ToolTelemetry();
  tracker.begin("t");
  tracker.observe({ sessionUpdate: "tool_call", toolCallId: "structured", title: "exec", rawInput: { command: "private command", workdir: "/workspace/private" }, _meta: { "cognition.ai/inferenceToolName": "exec" } });
  tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "structured", status: "in_progress", _meta: { terminal_exit: { terminal_id: "private-process", exit_code: 7, signal: null } } });
  const failed = tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "structured", status: "completed", rawOutput: "Exit code: 0" });
  assert.equal(failed.execution.exitCode, 7);
  assert.equal(failed.execution.processOutcome, "failed");
  assert.equal(failed.execution.transportOutcome, "unknown");
  assert.equal(failed.execution.sources.exitCode, "terminal_exit");
  assert.equal(failed.errorSource, "structured");
  assert.equal(failed.errorCode, "nonzero_exit");
  assert.equal(JSON.stringify(failed).includes("private"), false);
  tracker.observe({ sessionUpdate: "tool_call", toolCallId: "ok", title: "exec", _meta: { "cognition.ai/inferenceToolName": "exec", terminal_exit: { exit_code: 0, signal: null } } });
  const ok = tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "ok", status: "completed", rawOutput: "quoted example: Exit code: 1" });
  assert.equal(ok.execution.processOutcome, "succeeded");
  assert.equal(ok.errorCode, null);
});

test("background wait limits and negative exit sentinels are not process failures", () => {
  const tracker = new ToolTelemetry();
  tracker.begin("t");
  tracker.observe({ sessionUpdate: "tool_call", toolCallId: "bg", title: "Bash", name: "Bash" });
  const result = tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "bg", status: "completed", _meta: { claudeCode: { toolResponse: { backgroundTaskId: "private-task", timedOutAfterMs: 1000, interrupted: false } } } });
  assert.equal(result.execution.waitTimedOut, true);
  assert.equal(result.execution.timedOut, null);
  assert.equal(result.execution.processOutcome, "running");
  tracker.observe({ sessionUpdate: "tool_call", toolCallId: "sentinel", title: "exec", _meta: { "cognition.ai/inferenceToolName": "exec" } });
  const sentinel = tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "sentinel", status: "completed", _meta: { terminal_exit: { exit_code: -1, signal: null } } });
  assert.equal(sentinel.execution.exitCode, null);
  assert.equal(sentinel.execution.processOutcome, "unknown");
});

test("signals, explicit timeouts and declared diagnostic exits remain distinct", () => {
  for (const [fields, outcome] of [[{ exitCode: 1 }, "failed"], [{ terminationSignal: "SIGTERM" }, "signalled"], [{ timedOut: true }, "timed_out"]]) {
    const tracker = new ToolTelemetry();
    tracker.begin("t");
    tracker.observe({ sessionUpdate: "tool_call", toolCallId: "x", title: "exec", rawInput: { command: "test fixture" }, _meta: { "cognition.ai/inferenceToolName": "exec", "sessionboxer/diagnostic": { expectedExitCodes: [1] } } });
    const result = tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed", _meta: { "sessionboxer/execution": { ...fields, transportOutcome: "succeeded" } } });
    assert.equal(result.execution.processOutcome, outcome);
    assert.equal(result.execution.transportOutcome, "succeeded");
    assert.deepEqual(result.execution.expectedExitCodes, [1]);
  }
});

test("runtime and offline extraction agree on supported structured evidence", () => {
  const samples = [
    ["exec", { command: "echo café", workdir: "/workspace/repo", file_path: "src/a.ts" }, { terminal_exit: { exit_code: 1, signal: null, terminal_id: "terminal" } }, {}],
    ["Bash", {}, { claudeCode: { toolResponse: { backgroundTaskId: "task", timedOutAfterMs: 1000, interrupted: false } } }, {}],
    ["exec", {}, { "sessionboxer/diagnostic": { expectedExitCodes: [1] }, "sessionboxer/execution": { transportOutcome: "succeeded" } }, { exitCode: 0, timedOut: false }],
    ["read", {}, {}, { exitCode: 7 }],
    ["TaskOutput", { task_id: "task" }, { claudeCode: { toolResponse: { task: { task_id: "task", exitCode: 2 } } } }, {}],
    ["exec", { workdir: "relative", file_path: "a.ts" }, {}, { terminationSignal: "SIGTERM" }],
  ];
  const python = spawnSync("python3", ["-c", "import sys,json; sys.path.insert(0,'scripts'); from execution_evidence import execution_evidence; print(json.dumps([execution_evidence(*v) for v in json.load(sys.stdin)]))"], { input: JSON.stringify(samples), encoding: "utf8", timeout: 10_000 });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(samples.map((sample) => executionEvidence(...sample)), JSON.parse(python.stdout));
  const merged = mergeExecutionMeta({ claudeCode: { toolResponse: { task: { task_id: "t" }, interrupted: false } } }, { claudeCode: { toolName: "TaskOutput", toolResponse: { task: { exitCode: 0 } } } });
  assert.deepEqual(merged.claudeCode.toolResponse.task, { task_id: "t", exitCode: 0 });
});

test("existing stale-run reconciliation aborts unfinished runs even for a cached running Session", () => {
  const db = new Db(":memory:");
  const stamp = new Date().toISOString();
  db.insertSession(Session.parse({ id: "fixture", title: "fixture", provider: "devin", status: "running", workspaceSource: { type: "empty" }, containerId: null, error: null, createdAt: stamp, updatedAt: stamp }));
  const unfinished = db.insertE2eRun("fixture", 1, "running");
  const finished = db.insertE2eRun("fixture", 2, "passed");
  const reconciler = new E2eVerification({ db, getSession: (id) => db.getSession(id), appendEvent: (id, body) => db.appendEvent(id, body), broadcast: () => {}, log: () => {} });
  try {
    reconciler.closeStale();
    assert.equal(db.getE2eRun("fixture", unfinished.id).status, "aborted");
    assert.match(db.getE2eRun("fixture", unfinished.id).skipReason, /Control Plane restarted/);
    assert.equal(db.getE2eRun("fixture", finished.id).status, "passed");
  } finally {
    db.connection.close();
  }
});

test("ACP telemetry retains early output and distinguishes completed transport from tool failure", () => {
  const tracker = new ToolTelemetry();
  tracker.begin("t");
  tracker.observe({ sessionUpdate: "tool_call", toolCallId: "x", title: "x", _meta: { "cognition.ai/inferenceToolName": "exec" } });
  tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "x", rawOutput: { isError: true, content: [{ type: "text", text: "timed out" }] } });
  const result = tracker.observe({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed" });
  assert.equal(result.status, "completed");
  assert.equal(result.errorCode, "timeout");
  assert.equal(result.resultIsError, true);
  assert.equal(result.toolName, "exec");
});
