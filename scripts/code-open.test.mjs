import test from "node:test";
import assert from "node:assert/strict";
import { locateFile } from "../packages/sandbox-daemon/dist/code-server.js";

const WORKSPACE = "/workspace";
const REPOS = ["frontend", "backend"];
const existsIn = (...files) => (abs) => files.includes(abs);

// The Agent names files relative to the repository it works in as often as relative to the
// Workspace root; a click in the chat should land on the file either way.
test("a path that exists under the Workspace root opens there", () => {
  const exists = existsIn("/workspace/notes.md", "/workspace/frontend/notes.md");
  assert.equal(locateFile(WORKSPACE, "notes.md", REPOS, exists), "/workspace/notes.md");
  assert.equal(locateFile(WORKSPACE, "/workspace/notes.md", REPOS, exists), "/workspace/notes.md");
});

test("a repository-relative path is looked up in each repository, in order", () => {
  const exists = existsIn("/workspace/backend/src/app.ts");
  assert.equal(locateFile(WORKSPACE, "src/app.ts", REPOS, exists), "/workspace/backend/src/app.ts");
  assert.equal(locateFile(WORKSPACE, "/workspace/src/app.ts", REPOS, exists), "/workspace/backend/src/app.ts");
  assert.equal(locateFile(WORKSPACE, "./src/app.ts", REPOS, exists), "/workspace/backend/src/app.ts");
  const both = existsIn("/workspace/frontend/src/app.ts", "/workspace/backend/src/app.ts");
  assert.equal(locateFile(WORKSPACE, "src/app.ts", REPOS, both), "/workspace/frontend/src/app.ts");
});

test("a directory at the root does not shadow a file in a repository", () => {
  const exists = (abs) => abs === "/workspace/frontend/docs/README.md";
  assert.equal(locateFile(WORKSPACE, "docs/README.md", REPOS, exists), "/workspace/frontend/docs/README.md");
});

test("a path nowhere says where it looked", () => {
  assert.throws(() => locateFile(WORKSPACE, "src/missing.ts", REPOS, () => false), /^Error: no src\/missing\.ts in the Workspace or in frontend\/, backend\/$/);
  assert.throws(() => locateFile(WORKSPACE, "src/missing.ts", [], () => false), /^Error: no src\/missing\.ts in the Workspace$/);
});

test("paths outside the Workspace are refused before any lookup", () => {
  const anything = () => true;
  assert.throws(() => locateFile(WORKSPACE, "../etc/passwd", REPOS, anything), /outside the Workspace/);
  assert.throws(() => locateFile(WORKSPACE, "/etc/passwd", REPOS, anything), /outside the Workspace/);
  assert.throws(() => locateFile(WORKSPACE, "/workspace", REPOS, anything), /outside the Workspace/);
});
