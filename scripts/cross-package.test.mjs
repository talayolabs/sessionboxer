// Knowledge that lives in two packages on purpose (the Electron shell packs no workspace packages;
// the protocol runs in the browser too): pinned so the copies cannot drift apart silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dockerSocketCandidates as controlPlaneCandidates } from "../apps/control-plane/dist/docker-engine.js";
import { dockerSocketCandidates as desktopCandidates } from "../apps/desktop/dist/docker.js";
import { totpCode } from "../packages/protocol/dist/index.js";

test("the Control Plane and the desktop shell look for the Docker socket in the same places, in the same order", () => {
  const runtime = process.env.XDG_RUNTIME_DIR;
  try {
    delete process.env.XDG_RUNTIME_DIR;
    assert.deepEqual(desktopCandidates(), controlPlaneCandidates());
    assert.ok(controlPlaneCandidates().length >= 7);
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    assert.deepEqual(desktopCandidates(), controlPlaneCandidates());
    assert.ok(controlPlaneCandidates().includes("/run/user/1000/docker.sock"));
  } finally {
    if (runtime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = runtime;
  }
});

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (base32 below); the 8-digit codes there are
// 94287082, 07081804, 14050471, 89005924 — six digits keep the last six.
test("totpCode answers the RFC 6238 test vectors", async () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(await totpCode(secret, 59_000), "287082");
  assert.equal(await totpCode(secret, 1_111_111_109_000), "081804");
  assert.equal(await totpCode(secret, 1_111_111_111_000), "050471");
  assert.equal(await totpCode(secret, 1_234_567_890_000), "005924");
  assert.equal(await totpCode(secret, 59_000, 8), "94287082");
});
