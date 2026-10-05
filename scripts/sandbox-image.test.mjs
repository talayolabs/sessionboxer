// The Sandbox image's Provider variants (ADR-0088): every id in PROVIDERS has its payload stage
// (`agent-<id>`) and its final target (`<id>`) in images/sandbox/Dockerfile, `all` carries every
// payload, and `npm run build:image -- --provider …` maps to the targets and tags of the contract.
// Adding a Provider without its image variant fails here. Run after `tsc -b` (the id list parsed
// from the protocol source is checked against the compiled PROVIDERS).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEV_REPOSITORY, IMAGE_REPOSITORY, ROOT, dockerfileStages, imageTarget, parseArgs, providerIds } from "./sandbox-image-targets.mjs";

const { PROVIDERS } = await import("../packages/protocol/dist/index.js");
const ids = providerIds();
const stages = dockerfileStages();
const dockerfile = readFileSync(join(ROOT, "images/sandbox/Dockerfile"), "utf8");

/** The instructions of one stage, from its FROM to the next. */
function stageBody(name) {
  const match = dockerfile.match(new RegExp(`^FROM \\S+ AS ${name}\\s*$([\\s\\S]*?)(?=^FROM |$(?![\\s\\S]))`, "m"));
  assert.ok(match, `stage ${name}`);
  return match[1];
}

test("the ids parsed from the protocol source are PROVIDERS", () => {
  assert.deepEqual(ids, [...PROVIDERS]);
  assert.ok(ids.length >= 13);
});

test("the Dockerfile has the toolchain → base → all spine and all is the default (last) target", () => {
  const byName = new Map(stages.map((s) => [s.name, s.parent]));
  assert.equal(byName.get("toolchain"), "ubuntu:24.04");
  assert.equal(byName.get("base"), "toolchain");
  assert.equal(byName.get("all"), "base");
  assert.equal(stages.at(-1).name, "all");
});

for (const id of ids) {
  test(`${id}: an agent-${id} payload stage from toolchain and a ${id} final from base`, () => {
    const byName = new Map(stages.map((s) => [s.name, s.parent]));
    assert.equal(byName.get(`agent-${id}`), "toolchain", `FROM toolchain AS agent-${id}`);
    assert.equal(byName.get(id), "base", `FROM base AS ${id}`);
    const payload = `/opt/sessionboxer/providers/${id}`;
    assert.match(stageBody(`agent-${id}`), new RegExp(`sessionboxer-payload-manifest ${id} `), "writes its manifest");
    const final = stageBody(id);
    assert.ok(final.includes(`COPY --from=agent-${id} ${payload} ${payload}`), "copies exactly its payload");
    assert.equal((final.match(/COPY --from=agent-/g) ?? []).length, 1);
    assert.match(final, /RUN sessionboxer-link-providers/);
    assert.match(final, new RegExp(`io\\.sessionboxer\\.providers="${id}"`));
    assert.ok(stageBody("all").includes(`COPY --from=agent-${id} ${payload} ${payload}`), "all carries it");
  });
}

test("no payload stage or final target for an id outside PROVIDERS", () => {
  const extra = stages.filter((s) => s.name.startsWith("agent-") && !ids.includes(s.name.slice("agent-".length)));
  assert.deepEqual(extra, []);
  const finals = stages.filter((s) => s.parent === "base").map((s) => s.name);
  assert.deepEqual(finals, [...ids, "all"]);
});

test("the all target lists every Provider in its label, base none", () => {
  assert.match(stageBody("all"), new RegExp(`io\\.sessionboxer\\.providers="${ids.join(",")}"`));
  assert.match(stageBody("base"), /io\.sessionboxer\.providers=""/);
  assert.match(stageBody("base"), /io\.sessionboxer\.payload-format="1"/);
});

test("--provider maps to the target and tags of the contract", () => {
  assert.deepEqual(imageTarget(undefined, "1.6.0", ids), { target: "all", tags: [`${IMAGE_REPOSITORY}:1.6.0`, `${DEV_REPOSITORY}:dev`] });
  assert.deepEqual(imageTarget("codex", "1.6.0", ids), { target: "codex", tags: [`${IMAGE_REPOSITORY}:1.6.0-codex`, `${DEV_REPOSITORY}:dev-codex`] });
  assert.deepEqual(imageTarget("claude-code", "1.6.0", ids).tags, [`${IMAGE_REPOSITORY}:1.6.0-claude-code`, `${DEV_REPOSITORY}:dev-claude-code`]);
  assert.deepEqual(imageTarget("base", "1.6.0", ids), { target: "base", tags: [`${IMAGE_REPOSITORY}:1.6.0-base`, `${DEV_REPOSITORY}:dev-base`] });
  assert.deepEqual(imageTarget("all", "1.6.0", ids), { target: "all", tags: [`${IMAGE_REPOSITORY}:1.6.0-all`, `${DEV_REPOSITORY}:dev-all`] });
  assert.throws(() => imageTarget("claude", "1.6.0", ids), /unknown --provider "claude"; expected one of claude-code, devin, .*, base, all/);
});

test("--provider is consumed, everything else is forwarded to docker build", () => {
  assert.deepEqual(parseArgs(["--no-cache", "--provider", "fx", "--progress=plain"]), { provider: "fx", forwarded: ["--no-cache", "--progress=plain"] });
  assert.deepEqual(parseArgs(["--provider=base"]), { provider: "base", forwarded: [] });
  assert.deepEqual(parseArgs([]), { provider: undefined, forwarded: [] });
  assert.throws(() => parseArgs(["--provider"]), /needs a value/);
});
