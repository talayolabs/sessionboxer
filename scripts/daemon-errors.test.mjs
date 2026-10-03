import test from "node:test";
import assert from "node:assert/strict";
import { DAEMON_ERROR_CODES, DAEMON_ERROR_NAMES, daemonErrorName, httpStatusForDaemonError } from "../packages/protocol/dist/index.js";
import { DaemonError, jsonRpcError } from "../packages/sandbox-daemon/dist/daemon-error.js";

// The numbers are on the wire between Daemons and Control Planes of different versions (ADR-0080):
// an old Daemon still sends -32001 for "not found", an old Control Plane still maps -32003 to 409.
test("the code table keeps the numbers Daemons have always sent", () => {
  assert.deepEqual(DAEMON_ERROR_CODES, {
    not_found: -32001,
    forbidden: -32002,
    conflict: -32003,
    invalid_params: -32602,
    method_not_found: -32601,
    internal: -32000,
  });
  assert.deepEqual(DAEMON_ERROR_NAMES, {
    [-32001]: "not_found",
    [-32002]: "forbidden",
    [-32003]: "conflict",
    [-32602]: "invalid_params",
    [-32601]: "method_not_found",
    [-32000]: "internal",
  });
  assert.equal(daemonErrorName(-32003), "conflict");
  assert.equal(daemonErrorName(-1), null);
});

test("every code has one HTTP status; an unknown code is a 502", () => {
  assert.equal(httpStatusForDaemonError(DAEMON_ERROR_CODES.not_found), 404);
  assert.equal(httpStatusForDaemonError(DAEMON_ERROR_CODES.forbidden), 403);
  assert.equal(httpStatusForDaemonError(DAEMON_ERROR_CODES.conflict), 409);
  assert.equal(httpStatusForDaemonError(DAEMON_ERROR_CODES.invalid_params), 400);
  assert.equal(httpStatusForDaemonError(DAEMON_ERROR_CODES.method_not_found), 502);
  assert.equal(httpStatusForDaemonError(DAEMON_ERROR_CODES.internal), 502);
  assert.equal(httpStatusForDaemonError(-32099), 502);
  assert.equal(httpStatusForDaemonError(0), 502);
});

test("a DaemonError carries its kind's number as a plain `code`, so an old Control Plane reads it", () => {
  const e = new DaemonError("conflict", "a turn is already active");
  assert.ok(e instanceof Error);
  assert.equal(e.kind, "conflict");
  assert.equal(e.code, -32003);
  assert.equal(e.message, "a turn is already active");
  for (const kind of Object.keys(DAEMON_ERROR_CODES)) {
    assert.equal(new DaemonError(kind, "x").code, DAEMON_ERROR_CODES[kind]);
  }
});

// `jsonRpcError` is what the Daemon's RPC `handle().catch()` puts in the response's `error`.
test("on the wire a DaemonError is { code, message }; a bare Error is internal; a non-Error is stringified", () => {
  assert.deepEqual(jsonRpcError(new DaemonError("not_found", "the Agent has no session yet")), { code: -32001, message: "the Agent has no session yet" });
  assert.deepEqual(jsonRpcError(new DaemonError("invalid_params", "this Sandbox does not run Codex")), { code: -32602, message: "this Sandbox does not run Codex" });
  assert.deepEqual(jsonRpcError(new DaemonError("method_not_found", "method not found: x")), { code: -32601, message: "method not found: x" });
  assert.deepEqual(jsonRpcError(new Error("agent stdio unavailable")), { code: -32000, message: "agent stdio unavailable" });
  assert.deepEqual(jsonRpcError(Object.assign(new Error("MCP error"), { code: -32099 })), { code: -32099, message: "MCP error" });
  assert.deepEqual(jsonRpcError("boom"), { code: -32000, message: "boom" });
  assert.deepEqual(jsonRpcError(Object.assign(new Error("odd"), { code: "ENOENT" })), { code: -32000, message: "odd" });
});

test("the wire codes round-trip to the statuses the Control Plane answered before", () => {
  const status = (e) => httpStatusForDaemonError(jsonRpcError(e).code);
  assert.equal(status(new DaemonError("conflict", "a turn is already active")), 409);
  assert.equal(status(new DaemonError("not_found", "agent not ready")), 404);
  assert.equal(status(new DaemonError("invalid_params", "this Sandbox does not run pi")), 400);
  assert.equal(status(new DaemonError("forbidden", "permission denied: x")), 403);
  assert.equal(status(new Error("anything")), 502);
});
