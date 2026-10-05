// Release helper for the Sandbox image variants (ADR-0088 step 2), the shell-free part of
// .github/workflows/release.yml. One image per Dockerfile target (`<providerId>`, `base`, `all`) and
// architecture is built and pushed by digest; the join then publishes two-platform manifests.
//
//   node scripts/release-sandbox.mjs build       --target <t> --arch <amd64|arm64> --image <repo> --version <v> --digest-out <file> [--base-digest <sha256:…>] [--log <file>] [--source <url>]
//   node scripts/release-sandbox.mjs verify      --target <t> --arch <a> --image <repo> --version <v> --digest <sha256:…> [--base-digest <sha256:…>] [--log <build log>]
//   node scripts/release-sandbox.mjs manifests   --image <repo> --version <v> --digests <dir> [--targets <t,…>] [--archs amd64,arm64] [--no-latest]
//   node scripts/release-sandbox.mjs prune-cache --image <repo> [--dry-run]
//
// build: `docker buildx build` of the target for one architecture, pushed by digest to <repo>, with a registry cache
//   per target and architecture (`<repo>:buildcache-<t>-<arch>`, mode=max; only this job writes that ref). Providers and
//   `all` take `base` from the exact per-architecture base digest (a named build context, not the Dockerfile stage) and
//   import the base cache (toolchain layers) plus, for `all`, every Provider's cache so no Agent is reinstalled. No
//   extra-CA secret: release layers and caches carry no local trust (that is scripts/build-image.mjs's business).
// verify: the pushed digest's platform manifest starts with the base's exact layer descriptors (cache hits prove
//   nothing), labels are right, compressed/unpacked sizes fit the research doc's budgets (§12 step 2), and the image
//   passes scripts/release-sandbox-smoke.mjs (payload directory, `--version`, ACP initialize).
// manifests: reads `<dir>/<target>-<arch>` digest files, refuses to publish unless every target has every architecture
//   (`--targets`/`--archs` narrow both for local dry runs), then creates `<repo>:<version>-<t>` (plus plain `<version>` on the `all` index) and last the `latest-*`/`latest` aliases.
// prune-cache: deletes GHCR package versions that are untagged BuildKit cache manifests (superseded `buildcache-*`
//   exports). Never touches tagged versions, so release tags are safe; 403 is reported with the manual steps, not fatal.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_REPOSITORY, ROOT, releaseMatrix } from "./sandbox-image-targets.mjs";

export const ARCHS = ["amd64", "arm64"];
export const RUNNERS = { amd64: "ubuntu-24.04", arm64: "ubuntu-24.04-arm" };
const GB = 1e9;
/** amd64 caps in decimal GB, docs/research/sandbox-image-per-provider-variants.md §12 step 2; arm64 is provisional at +15%. */
const AMD64_BUDGETS_GB = {
  base: { unpacked: 3.2, compressed: 1.27 },
  fx: { unpacked: 3.25, compressed: 1.29 },
  "claude-code": { unpacked: 4.1, compressed: 1.65 },
  codex: { unpacked: 4.1, compressed: 1.65 },
  all: { unpacked: 6.3, compressed: 2.45 },
  provider: { unpacked: 3.6, compressed: 1.47 },
};
const ARM64_FACTOR = 1.15;
const CACHE_MEDIA_TYPE = "application/vnd.buildkit.cacheconfig.v0";
const SMOKE = path.join(ROOT, "scripts/release-sandbox-smoke.mjs");

/** `--key value` pairs and bare `--flag`s into an object; repeated keys keep the last value. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
    else args[key] = true;
  }
  return args;
}

export function cacheRef(image, target, arch) {
  return `${image}:buildcache-${target}-${arch}`;
}

/** Size budget in bytes for a target on an architecture. */
export function sizeBudget(target, arch) {
  const gb = AMD64_BUDGETS_GB[target] ?? AMD64_BUDGETS_GB.provider;
  const factor = arch === "arm64" ? ARM64_FACTOR : 1;
  return { unpacked: Math.round(gb.unpacked * factor * GB), compressed: Math.round(gb.compressed * factor * GB) };
}

/** The Provider payloads a target must contain: none for base, all of them for all, itself otherwise. */
export function expectedProviders(target, providers) {
  if (target === "base") return [];
  if (target === "all") return providers;
  if (!providers.includes(target)) throw new Error(`unknown target ${target}`);
  return [target];
}

export function expectedLabels(target, version, providers) {
  return {
    "org.opencontainers.image.version": version,
    "io.sessionboxer.providers": expectedProviders(target, providers).join(","),
    "io.sessionboxer.payload-format": "1",
    "io.sessionboxer.runtime": version,
  };
}

/** The `docker buildx build` argv for one target and architecture (see the header). */
export function buildArgs({ target, arch, image, version, baseDigest, providers, source, metadataFile }) {
  if (!ARCHS.includes(arch)) throw new Error(`unknown arch ${arch}`);
  if (target !== "base" && !/^sha256:[0-9a-f]{64}$/.test(baseDigest ?? "")) throw new Error(`${target} needs --base-digest sha256:…`);
  const args = [
    "buildx", "build", "--platform", `linux/${arch}`, "--target", target, "--file", "images/sandbox/Dockerfile",
    "--build-arg", `SESSIONBOXER_VERSION=${version}`,
    "--label", `org.opencontainers.image.version=${version}`, "--label", "org.opencontainers.image.licenses=MIT",
    "--progress=plain", "--metadata-file", metadataFile,
    "--output", `type=image,name=${image},push-by-digest=true,name-canonical=true,push=true`,
    "--cache-from", `type=registry,ref=${cacheRef(image, "base", arch)}`,
  ];
  if (source !== undefined) args.push("--label", `org.opencontainers.image.source=${source}`);
  if (target === "base") args.push("--cache-to", `type=registry,ref=${cacheRef(image, "base", arch)},mode=max`);
  else {
    args.push("--build-context", `base=docker-image://${image}@${baseDigest}`);
    const own = target === "all" ? providers : [target];
    for (const id of own) args.push("--cache-from", `type=registry,ref=${cacheRef(image, id, arch)}`);
    if (target !== "all") args.push("--cache-to", `type=registry,ref=${cacheRef(image, target, arch)},mode=max`);
  }
  return [...args, "."];
}

/**
 * Steps of a `--progress=plain` log that ran instead of hitting the cache: `[{ stage, step }]` for `#N [stage k/m] …` headers
 * (FROM resolves aside) that neither print `#N CACHED` nor consist only of blob downloads/extractions. BuildKit reports a hit
 * whose layers it has to fetch lazily from a registry cache as `#N sha256:… 17MB / 131MB`, `#N extracting sha256:…`, `#N DONE 3.7s`
 * — no `CACHED` line — so a step that only fetched blobs counts as cached; one with command output (`#N 1.269 …`) or
 * nothing but `DONE` (a COPY that ran) counts as run.
 */
export function uncachedSteps(log) {
  const headers = new Map();
  const cached = new Set();
  const fetched = new Set();
  const ran = new Set();
  for (const line of log.split("\n")) {
    const header = line.match(/^#(\d+) \[([^\] ]+)\s+(\d+\/\d+)\] (.*)$/);
    if (header !== null) {
      if (!header[4].startsWith("FROM ")) headers.set(header[1], { stage: header[2], step: `${header[3]} ${header[4].slice(0, 60)}` });
      continue;
    }
    const hit = line.match(/^#(\d+) CACHED$/);
    if (hit !== null) { cached.add(hit[1]); continue; }
    const body = line.match(/^#(\d+) (.*)$/);
    if (body === null || /^(\.\.\.|DONE .*)$/.test(body[2])) continue;
    if (/^(sha256:[0-9a-f]{64} .*|extracting sha256:[0-9a-f]{64}.*)$/.test(body[2])) fetched.add(body[1]);
    else ran.add(body[1]);
  }
  return [...headers].filter(([n]) => !cached.has(n) && !(fetched.has(n) && !ran.has(n))).map(([, s]) => s);
}

/** The platform manifest for an architecture out of an index (or the manifest itself when there is no index). */
export function platformManifest(raw, arch) {
  if (raw.mediaType === "application/vnd.oci.image.manifest.v1+json" || raw.layers !== undefined) return { digest: undefined, manifest: raw };
  const entry = (raw.manifests ?? []).find((m) => m.platform?.os === "linux" && m.platform?.architecture === arch);
  if (entry === undefined) throw new Error(`no linux/${arch} manifest in index`);
  return { digest: entry.digest, manifest: undefined };
}

/** Throws unless `final`'s layers start with exactly `base`'s layer digests; returns the layers on top. */
export function layersOnTop(baseLayers, finalLayers) {
  const base = baseLayers.map((l) => l.digest);
  const final = finalLayers.map((l) => l.digest);
  if (final.length <= base.length) throw new Error(`final has ${final.length} layers, base ${base.length}: nothing on top`);
  const mismatch = base.findIndex((d, i) => d !== final[i]);
  if (mismatch !== -1) throw new Error(`layer ${mismatch} differs from base: ${final[mismatch]} vs ${base[mismatch]}`);
  return finalLayers.slice(base.length);
}

export function isCacheManifest(raw) {
  return raw?.config?.mediaType === CACHE_MEDIA_TYPE;
}

/** `<dir>/<target>-<arch>` files (content: the digest) into `{ "<target>-<arch>": "sha256:…" }`. */
export function readDigests(dir) {
  const digests = {};
  for (const name of readdirSync(dir)) {
    const digest = readFileSync(path.join(dir, name), "utf8").trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${name}: not a digest: ${digest}`);
    digests[name] = digest;
  }
  return digests;
}

/**
 * What the join publishes: `creates` (one index per target from its per-architecture digests; `all` also gets the
 * plain version tag) then `aliases` (`latest-*` from the versioned tags, `latest` from plain). Throws listing every
 * missing `<target>-<arch>` digest, so a failed matrix advances no tag.
 */
export function manifestPlan({ image, version, targets, digests, archs = ARCHS, latest = true }) {
  const missing = targets.flatMap((t) => archs.filter((a) => digests[`${t}-${a}`] === undefined).map((a) => `${t}-${a}`));
  if (missing.length > 0) throw new Error(`missing digests: ${missing.join(", ")}`);
  const unknown = Object.keys(digests).filter((k) => !targets.some((t) => archs.some((a) => k === `${t}-${a}`)));
  if (unknown.length > 0) throw new Error(`unexpected digests: ${unknown.join(", ")}`);
  const creates = targets.map((t) => ({
    target: t,
    tags: t === "all" ? [`${image}:${version}-all`, `${image}:${version}`] : [`${image}:${version}-${t}`],
    sources: archs.map((a) => `${image}@${digests[`${t}-${a}`]}`),
  }));
  const aliases = latest
    ? [...targets.map((t) => ({ tag: `${image}:latest-${t}`, from: `${image}:${version}-${t}` })), { tag: `${image}:latest`, from: `${image}:${version}` }]
    : [];
  return { creates, aliases };
}

/** `ghcr.io/<owner>/<package>` into the GitHub packages API path. */
export function packagePath(image, ownerType = "orgs") {
  const m = image.match(/^ghcr\.io\/([^/]+)\/(.+)$/);
  if (m === null) throw new Error(`${image} is not a ghcr.io image`);
  return `/${ownerType}/${m[1]}/packages/container/${encodeURIComponent(m[2])}`;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}\n${(r.stderr ?? "").slice(-2000)}`);
  return r.stdout;
}

const inspectRaw = (ref) => JSON.parse(run("docker", ["buildx", "imagetools", "inspect", "--raw", ref]));

function summary(lines) {
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n", { flag: "a" });
}

async function build(args) {
  const { providers } = releaseMatrix();
  const metadataFile = path.join(process.env.RUNNER_TEMP ?? "/tmp", `sandbox-${args.target}-${args.arch}.json`);
  const argv = buildArgs({ ...args, baseDigest: args["base-digest"], providers, metadataFile });
  if (args.builder !== undefined) argv.splice(2, 0, "--builder", args.builder);
  console.log(`$ docker ${argv.join(" ")}`);
  const started = Date.now();
  const log = await new Promise((resolve, reject) => {
    let out = "";
    const child = spawn("docker", argv, { cwd: ROOT, stdio: ["ignore", "inherit", "pipe"] });
    child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`docker buildx build exited ${code}`))));
  });
  if (args.log !== undefined) writeFileSync(args.log, log);
  const digest = JSON.parse(readFileSync(metadataFile, "utf8"))["containerimage.digest"];
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) throw new Error(`no containerimage.digest in ${metadataFile}`);
  mkdirSync(path.dirname(args["digest-out"]), { recursive: true });
  writeFileSync(args["digest-out"], digest + "\n");
  const agentSteps = uncachedSteps(log).filter((s) => s.stage.startsWith("agent-"));
  const lines = [`${args.target}/${args.arch}: ${digest} built in ${((Date.now() - started) / 60000).toFixed(1)} min; ${agentSteps.length} agent-* step(s) ran uncached`];
  for (const s of agentSteps) lines.push(`  ${s.stage} ${s.step}`);
  summary(lines);
  if (args.target === "all" && agentSteps.length > 0) throw new Error("all: Agent payloads were rebuilt instead of coming from the Provider caches");
}

function verify(args) {
  const { providers } = releaseMatrix();
  const { target, arch, image, version } = args;
  const ref = `${image}@${args.digest}`;
  const expected = expectedProviders(target, providers);
  const index = inspectRaw(ref);
  const platform = platformManifest(index, arch);
  const manifestDigest = platform.digest ?? args.digest;
  const manifest = platform.manifest ?? inspectRaw(`${image}@${manifestDigest}`);
  const lines = [`### ${target} linux/${arch}`, `digest ${args.digest} (platform manifest ${manifestDigest}), ${manifest.layers.length} layers`];

  if (target !== "base") {
    if (args["base-digest"] === undefined) throw new Error(`${target} needs --base-digest to prove the shared layers`);
    const baseIndex = inspectRaw(`${image}@${args["base-digest"]}`);
    const basePlatform = platformManifest(baseIndex, arch);
    const base = basePlatform.manifest ?? inspectRaw(`${image}@${basePlatform.digest}`);
    const top = layersOnTop(base.layers, manifest.layers);
    lines.push(`shares base's ${base.layers.length} layers exactly; ${top.length} layer(s) on top, ${(top.reduce((s, l) => s + l.size, 0) / 1e6).toFixed(1)} MB compressed`);
  }

  run("docker", ["pull", "--quiet", `${image}@${manifestDigest}`]);
  const config = JSON.parse(run("docker", ["image", "inspect", `${image}@${manifestDigest}`]))[0].Config;
  const labels = config.Labels ?? {};
  for (const [k, v] of Object.entries(expectedLabels(target, version, providers))) {
    if (labels[k] !== v) throw new Error(`label ${k}=${JSON.stringify(labels[k])}, expected ${JSON.stringify(v)}`);
  }
  lines.push(`labels ok: io.sessionboxer.providers=${JSON.stringify(labels["io.sessionboxer.providers"])}`);

  const compressed = manifest.layers.reduce((s, l) => s + l.size, 0);
  const unpacked = run("docker", ["history", "--human=false", "--format", "{{.Size}}", `${image}@${manifestDigest}`])
    .split("\n").filter((l) => l !== "").reduce((s, l) => s + Number(l), 0);
  const budget = sizeBudget(target, arch);
  lines.push(`size ${(compressed / GB).toFixed(3)} GB compressed (cap ${(budget.compressed / GB).toFixed(3)}), ${(unpacked / GB).toFixed(3)} GB unpacked (cap ${(budget.unpacked / GB).toFixed(3)})`);
  summary(lines);
  if (compressed > budget.compressed || unpacked > budget.unpacked) throw new Error(`${target}/${arch} is over its size budget`);

  const smoke = spawnSync("docker", ["run", "--rm", "-v", `${SMOKE}:/tmp/smoke.mjs:ro`, `${image}@${manifestDigest}`, "node", "/tmp/smoke.mjs", expected.join(",") || "-"], { stdio: "inherit", timeout: 30 * 60_000 });
  if (smoke.status !== 0) throw new Error(`smoke test failed (${smoke.status})`);
  if (args["digest-out"] !== undefined) {
    mkdirSync(path.dirname(args["digest-out"]), { recursive: true });
    writeFileSync(args["digest-out"], args.digest + "\n");
  }
}

function manifests(args) {
  const targets = args.targets === undefined ? releaseMatrix().targets : args.targets.split(",");
  const archs = args.archs === undefined ? ARCHS : args.archs.split(",");
  const plan = manifestPlan({ image: args.image, version: args.version, targets, digests: readDigests(args.digests), archs, latest: args["no-latest"] !== true });
  const lines = [`### ${args.image}:${args.version} manifests`];
  const digestOf = (tag) => run("docker", ["buildx", "imagetools", "inspect", "--format", "{{json .Manifest.Digest}}", tag]).trim().replace(/"/g, "");
  for (const c of plan.creates) {
    run("docker", ["buildx", "imagetools", "create", ...c.tags.flatMap((t) => ["-t", t]), ...c.sources], { stdio: ["ignore", "inherit", "inherit"] });
    const created = inspectRaw(c.tags[0]);
    for (const a of archs) platformManifest(created, a);
    const digest = digestOf(c.tags[0]);
    for (const t of c.tags.slice(1)) if (digestOf(t) !== digest) throw new Error(`${t} is not ${c.tags[0]}`);
    lines.push(`${c.tags.map((t) => t.slice(t.lastIndexOf(":") + 1)).join(" = ")} → ${digest} (${archs.join(", ")})`);
  }
  for (const a of plan.aliases) {
    run("docker", ["buildx", "imagetools", "create", "-t", a.tag, a.from], { stdio: ["ignore", "inherit", "inherit"] });
    if (digestOf(a.tag) !== digestOf(a.from)) throw new Error(`${a.tag} is not ${a.from}`);
    lines.push(`${a.tag.slice(a.tag.lastIndexOf(":") + 1)} → ${a.from.slice(a.from.lastIndexOf(":") + 1)}`);
  }
  summary(lines);
}

async function pruneCache(args) {
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined) throw new Error("GITHUB_TOKEN is not set");
  const base = `https://api.github.com${packagePath(args.image, args["owner-type"])}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const manual = `manual step: GitHub → packages → ${args.image.split("/").pop()} → versions: delete the untagged versions whose manifest config is ${CACHE_MEDIA_TYPE}; keep every tagged version.`;
  const versions = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${base}/versions?per_page=100&page=${page}`, { headers });
    if (res.status === 403 || res.status === 404) { console.warn(`::warning::cannot list package versions (${res.status}); ${manual}`); return; }
    if (!res.ok) throw new Error(`GET ${base}/versions: ${res.status}`);
    const batch = await res.json();
    versions.push(...batch);
    if (batch.length < 100) break;
  }
  const untagged = versions.filter((v) => (v.metadata?.container?.tags ?? []).length === 0);
  let deleted = 0, bytes = 0;
  for (const v of untagged) {
    let raw;
    try { raw = inspectRaw(`${args.image}@${v.name}`); } catch { continue; }
    if (!isCacheManifest(raw)) continue;
    const size = raw.layers.reduce((s, l) => s + l.size, 0);
    if (args["dry-run"] === true) { console.log(`would delete ${v.name} (${(size / 1e6).toFixed(0)} MB)`); bytes += size; continue; }
    const res = await fetch(`${base}/versions/${v.id}`, { method: "DELETE", headers });
    if (res.status === 403) { console.warn(`::warning::cannot delete package versions (403); ${manual}`); return; }
    if (!res.ok && res.status !== 404) throw new Error(`DELETE version ${v.id}: ${res.status}`);
    deleted++; bytes += size;
  }
  summary([`prune-cache: ${versions.length} package versions, ${untagged.length} untagged; ${args["dry-run"] === true ? "would delete" : `deleted ${deleted}`} superseded cache manifests referencing ${(bytes / GB).toFixed(2)} GB`]);
}

const COMMANDS = { build, verify, manifests, "prune-cache": pruneCache };
const REQUIRED = {
  build: ["target", "arch", "image", "version", "digest-out"],
  verify: ["target", "arch", "image", "version", "digest"],
  manifests: ["image", "version", "digests"],
  "prune-cache": ["image"],
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (COMMANDS[command] === undefined) {
    console.error(`usage: node scripts/release-sandbox.mjs <${Object.keys(COMMANDS).join("|")}> --key value …`);
    process.exit(2);
  }
  try {
    const args = parseArgs(rest);
    args.image ??= IMAGE_REPOSITORY;
    const missing = REQUIRED[command].filter((k) => typeof args[k] !== "string");
    if (missing.length > 0) throw new Error(`${command} needs --${missing.join(", --")}`);
    await COMMANDS[command](args);
  } catch (err) {
    const cause = err.cause instanceof Error ? ` (${[err.cause.code, err.cause.message].filter(Boolean).join(": ")})` : "";
    console.error(`release-sandbox ${command}: ${err.message}${cause}`);
    process.exit(1);
  }
}
