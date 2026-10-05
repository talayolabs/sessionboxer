// The release helper's pure parts (scripts/release-sandbox.mjs): the generated matrix, the per-target
// `docker buildx build` arguments (exact base digest, one cache ref per target and architecture, no
// extra-CA secret), the layer-prefix proof, the size budgets and labels, and the manifest/alias plan
// that refuses an incomplete matrix. The docker/registry side is exercised by the local dry run in
// the workflow header, not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ARCHS, buildArgs, cacheRef, expectedLabels, expectedProviders, isCacheManifest, layersOnTop, manifestPlan,
  packagePath, parseArgs, platformManifest, readDigests, sizeBudget, uncachedSteps,
} from "./release-sandbox.mjs";
import { IMAGE_REPOSITORY, ROOT, providerIds, releaseMatrix } from "./sandbox-image-targets.mjs";

const providers = providerIds();
const base = "sha256:" + "a".repeat(64);
const image = IMAGE_REPOSITORY;
const layer = (c) => ({ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: `sha256:${c.repeat(64)}`, size: 10 });

test("releaseMatrix lists PROVIDERS plus base and all, and --json prints it", () => {
  const m = releaseMatrix();
  assert.deepEqual(m.providers, providers);
  assert.deepEqual(m.targets, [...providers, "base", "all"]);
  const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/sandbox-image-targets.mjs"), "--json"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), m);
});

test("releaseMatrix fails when the Dockerfile targets differ from PROVIDERS", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sbx-matrix-"));
  const write = (file, text) => { execFileSync("mkdir", ["-p", path.dirname(path.join(root, file))]); writeFileSync(path.join(root, file), text); };
  write("packages/protocol/src/common.ts", 'export const PROVIDERS = ["codex", "fx"] as const;\n');
  const stages = (ids, finals = ids) => ["FROM ubuntu AS toolchain", ...ids.map((i) => `FROM toolchain AS agent-${i}`), "FROM toolchain AS base", ...finals.map((i) => `FROM base AS ${i}`), "FROM base AS all"].join("\n") + "\n";
  write("images/sandbox/Dockerfile", stages(["fx", "codex"]));
  assert.deepEqual(releaseMatrix(root), { providers: ["codex", "fx"], targets: ["codex", "fx", "base", "all"] });
  write("images/sandbox/Dockerfile", stages(["codex", "fx", "extra"]));
  assert.throws(() => releaseMatrix(root), /agent-\* stages .*extra/);
  write("images/sandbox/Dockerfile", stages(["codex", "fx"], ["codex"]));
  assert.throws(() => releaseMatrix(root), /final targets/);
});

test("parseArgs reads --key value pairs and bare flags", () => {
  assert.deepEqual(parseArgs(["--target", "codex", "--dry-run", "--arch", "arm64"]), { target: "codex", "dry-run": true, arch: "arm64" });
  assert.throws(() => parseArgs(["codex"]), /unexpected argument/);
});

test("cache refs are one per target and architecture", () => {
  assert.equal(cacheRef(image, "base", "amd64"), `${image}:buildcache-base-amd64`);
  assert.equal(cacheRef(image, "claude-code", "arm64"), `${image}:buildcache-claude-code-arm64`);
});

test("build args: base writes only the base cache, no extra-CA secret, pushed by digest", () => {
  const args = buildArgs({ target: "base", arch: "amd64", image, version: "1.6.0", providers, source: "https://github.com/talayolabs/sessionboxer", metadataFile: "/tmp/m.json" });
  assert.equal(args[0], "buildx");
  assert.ok(args.includes("--platform") && args[args.indexOf("--platform") + 1] === "linux/amd64");
  assert.equal(args[args.indexOf("--target") + 1], "base");
  assert.ok(args.includes("SESSIONBOXER_VERSION=1.6.0"));
  assert.ok(args.includes(`type=image,name=${image},push-by-digest=true,name-canonical=true,push=true`));
  assert.deepEqual(args.filter((a) => a.startsWith("type=registry")), [
    `type=registry,ref=${image}:buildcache-base-amd64`,
    `type=registry,ref=${image}:buildcache-base-amd64,mode=max`,
  ]);
  assert.ok(!args.includes("--secret") && !args.some((a) => a.includes("EXTRA_CA")));
  assert.ok(!args.includes("--build-context"));
  assert.equal(args.at(-1), ".");
});

test("build args: a Provider takes base from the exact digest and writes only its own cache ref", () => {
  const args = buildArgs({ target: "codex", arch: "arm64", image, version: "1.6.0", baseDigest: base, providers, metadataFile: "/tmp/m.json" });
  assert.equal(args[args.indexOf("--build-context") + 1], `base=docker-image://${image}@${base}`);
  const from = args.flatMap((a, i) => (a === "--cache-from" ? [args[i + 1]] : []));
  const to = args.flatMap((a, i) => (a === "--cache-to" ? [args[i + 1]] : []));
  assert.deepEqual(from, [`type=registry,ref=${image}:buildcache-base-arm64`, `type=registry,ref=${image}:buildcache-codex-arm64`]);
  assert.deepEqual(to, [`type=registry,ref=${image}:buildcache-codex-arm64,mode=max`]);
  assert.throws(() => buildArgs({ target: "codex", arch: "amd64", image, version: "1.6.0", providers, metadataFile: "/tmp/m.json" }), /base-digest/);
  assert.throws(() => buildArgs({ target: "codex", arch: "x86", image, version: "1.6.0", baseDigest: base, providers, metadataFile: "/tmp/m.json" }), /arch/);
});

test("build args: all imports every Provider cache and writes none", () => {
  const args = buildArgs({ target: "all", arch: "amd64", image, version: "1.6.0", baseDigest: base, providers, metadataFile: "/tmp/m.json" });
  const from = args.flatMap((a, i) => (a === "--cache-from" ? [args[i + 1]] : []));
  assert.deepEqual(from, ["base", ...providers].map((t) => `type=registry,ref=${image}:buildcache-${t}-amd64`));
  assert.ok(!args.includes("--cache-to"));
});

test("uncachedSteps reports steps without a CACHED line, ignoring FROM resolves", () => {
  const log = [
    "#6 [toolchain 1/7] FROM docker.io/library/ubuntu:24.04@sha256:abc",
    "#6 DONE 0.0s",
    "#7 [toolchain 2/7] RUN apt-get install",
    "#7 CACHED",
    "#18 [agent-copilot 1/3] RUN curl …",
    "#18 1.269 /tmp/copilot.tgz: OK",
    "#18 DONE 7.9s",
    "#19 [agent-grok 1/3] RUN curl …",
    "#19 CACHED",
    "#60 [all  3/14] COPY --from=agent-codex /opt/sessionboxer/providers/codex /opt/sessionboxer/providers/codex",
    "#60 DONE 0.3s",
  ].join("\n");
  assert.deepEqual(uncachedSteps(log).map((s) => s.stage), ["agent-copilot", "all"]);
  assert.match(uncachedSteps(log)[0].step, /^1\/3 RUN curl/);
});

test("platformManifest picks the architecture's manifest out of an index", () => {
  const index = { mediaType: "application/vnd.oci.image.index.v1+json", manifests: [
    { digest: "sha256:1", platform: { os: "linux", architecture: "amd64" } },
    { digest: "sha256:2", platform: { os: "linux", architecture: "arm64" } },
    { digest: "sha256:3", platform: { os: "unknown", architecture: "unknown" } },
  ] };
  assert.equal(platformManifest(index, "arm64").digest, "sha256:2");
  assert.throws(() => platformManifest({ manifests: index.manifests.slice(0, 1) }, "arm64"), /no linux\/arm64/);
  const manifest = { mediaType: "application/vnd.oci.image.manifest.v1+json", layers: [] };
  assert.equal(platformManifest(manifest, "amd64").manifest, manifest);
});

test("layersOnTop demands base's exact layer digests as a prefix", () => {
  const baseLayers = [layer("a"), layer("b")];
  assert.deepEqual(layersOnTop(baseLayers, [layer("a"), layer("b"), layer("c")]), [layer("c")]);
  assert.throws(() => layersOnTop(baseLayers, [layer("a"), layer("b")]), /nothing on top/);
  assert.throws(() => layersOnTop(baseLayers, [layer("a"), layer("x"), layer("c")]), /layer 1 differs/);
});

test("size budgets follow the research doc, arm64 at +15%", () => {
  assert.deepEqual(sizeBudget("base", "amd64"), { unpacked: 3_200_000_000, compressed: 1_270_000_000 });
  assert.deepEqual(sizeBudget("codex", "amd64"), sizeBudget("claude-code", "amd64"));
  assert.equal(sizeBudget("codex", "amd64").unpacked, 4_100_000_000);
  assert.deepEqual(sizeBudget("devin", "amd64"), { unpacked: 3_600_000_000, compressed: 1_470_000_000 });
  assert.equal(sizeBudget("fx", "amd64").compressed, 1_290_000_000);
  assert.equal(sizeBudget("all", "amd64").unpacked, 6_300_000_000);
  assert.equal(sizeBudget("all", "arm64").compressed, Math.round(2.45 * 1.15 * 1e9));
});

test("expected payloads and labels per target", () => {
  assert.deepEqual(expectedProviders("base", providers), []);
  assert.deepEqual(expectedProviders("all", providers), providers);
  assert.deepEqual(expectedProviders("kimi", providers), ["kimi"]);
  assert.throws(() => expectedProviders("claude", providers), /unknown target/);
  assert.deepEqual(expectedLabels("fx", "1.6.0", providers), {
    "org.opencontainers.image.version": "1.6.0",
    "io.sessionboxer.providers": "fx",
    "io.sessionboxer.payload-format": "1",
    "io.sessionboxer.runtime": "1.6.0",
  });
  assert.equal(expectedLabels("base", "1.6.0", providers)["io.sessionboxer.providers"], "");
  assert.equal(expectedLabels("all", "1.6.0", providers)["io.sessionboxer.providers"], providers.join(","));
});

test("manifestPlan publishes every target then the aliases, and refuses an incomplete matrix", () => {
  const { targets } = releaseMatrix();
  const digests = Object.fromEntries(targets.flatMap((t) => ARCHS.map((a) => [`${t}-${a}`, `sha256:${(t + a).padEnd(64, "0").replace(/[^0-9a-f]/g, "0").slice(0, 64)}`])));
  const plan = manifestPlan({ image, version: "1.6.0", targets, digests });
  assert.equal(plan.creates.length, 15);
  const all = plan.creates.find((c) => c.target === "all");
  assert.deepEqual(all.tags, [`${image}:1.6.0-all`, `${image}:1.6.0`]);
  assert.deepEqual(all.sources, [`${image}@${digests["all-amd64"]}`, `${image}@${digests["all-arm64"]}`]);
  assert.deepEqual(plan.creates.find((c) => c.target === "claude-code").tags, [`${image}:1.6.0-claude-code`]);
  assert.deepEqual(plan.creates.find((c) => c.target === "base").tags, [`${image}:1.6.0-base`]);
  assert.equal(plan.aliases.length, 16);
  assert.deepEqual(plan.aliases.at(-1), { tag: `${image}:latest`, from: `${image}:1.6.0` });
  assert.deepEqual(plan.aliases[0], { tag: `${image}:latest-claude-code`, from: `${image}:1.6.0-claude-code` });
  assert.deepEqual(manifestPlan({ image, version: "1.6.0", targets, digests, latest: false }).aliases, []);
  const incomplete = { ...digests };
  delete incomplete["kimi-arm64"];
  assert.throws(() => manifestPlan({ image, version: "1.6.0", targets, digests: incomplete }), /missing digests: kimi-arm64/);
  assert.throws(() => manifestPlan({ image, version: "1.6.0", targets, digests: { ...digests, "claude-amd64": base } }), /unexpected digests: claude-amd64/);
  const amd64Only = manifestPlan({ image, version: "1.6.0", targets: ["base", "all"], digests: { "base-amd64": base, "all-amd64": base }, archs: ["amd64"] });
  assert.equal(amd64Only.creates.length, 2);
});

test("readDigests reads <target>-<arch> files and rejects non-digests", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sbx-digests-"));
  writeFileSync(path.join(dir, "base-amd64"), base + "\n");
  assert.deepEqual(readDigests(dir), { "base-amd64": base });
  writeFileSync(path.join(dir, "fx-amd64"), "latest\n");
  assert.throws(() => readDigests(dir), /fx-amd64: not a digest/);
});

test("cache manifests are told apart by their BuildKit config media type", () => {
  assert.ok(isCacheManifest({ config: { mediaType: "application/vnd.buildkit.cacheconfig.v0" }, layers: [] }));
  assert.ok(!isCacheManifest({ config: { mediaType: "application/vnd.oci.image.config.v1+json" }, layers: [] }));
  assert.ok(!isCacheManifest({ manifests: [] }));
});

test("packagePath maps the image to the GitHub packages API", () => {
  assert.equal(packagePath(image), "/orgs/talayolabs/packages/container/sessionboxer-sandbox");
  assert.equal(packagePath("ghcr.io/me/a/b", "users"), "/users/me/packages/container/a%2Fb");
  assert.throws(() => packagePath("docker.io/x/y"), /not a ghcr.io image/);
});
