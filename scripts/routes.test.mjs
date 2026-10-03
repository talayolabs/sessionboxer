// The route table (docs/TECH-DEBT.md, round-3 fix 18): adding, removing or reordering a route is a
// conscious edit of scripts/route-table.txt (`node scripts/route-table.mjs > scripts/route-table.txt`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathsMeet, render } from "./route-table.mjs";

test("the Control Plane registers exactly the routes in scripts/route-table.txt, in that order", () => {
  assert.equal(render(), readFileSync(new URL("./route-table.txt", import.meta.url), "utf8"));
});

test("pathsMeet knows which Hono patterns can answer the same URL", () => {
  assert.equal(pathsMeet("/api/prs/follows", "/api/prs/:id"), true);
  assert.equal(pathsMeet("/api/providers/:provider/host-login", "/api/providers/login/:id"), true);
  assert.equal(pathsMeet("/api/sessions/:id/code/*", "/api/sessions/:id/code/x/y"), true);
  assert.equal(pathsMeet("/api/prs/follows/:id/hook", "/api/prs/:id/items"), false);
  assert.equal(pathsMeet("/api/automations/runs/:runId/video", "/api/automations/:id/runs"), false);
  assert.equal(pathsMeet("/api/sessions", "/api/sessions/:id"), false);
});
