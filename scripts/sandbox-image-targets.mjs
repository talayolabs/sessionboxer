// The Sandbox image's Provider variants (ADR-0088): which ids exist, which Dockerfile targets they
// map to and which tags a local build gets. Shared by scripts/build-image.mjs, which runs before
// anything is compiled, so PROVIDERS is read from the protocol source, by its test, and by the
// release workflow: `node scripts/sandbox-image-targets.mjs --json` prints the build matrix
// (`{ providers, targets }`) and fails when the Dockerfile's stages do not match PROVIDERS, so a
// Provider without its image variant stops the release before anything is built.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const IMAGE_REPOSITORY = "ghcr.io/talayolabs/sessionboxer-sandbox";
export const DEV_REPOSITORY = "sessionboxer/sandbox";

/** The ids of `PROVIDERS` in packages/protocol/src/common.ts, in declaration order. */
export function providerIds(root = ROOT) {
  const source = readFileSync(path.join(root, "packages/protocol/src/common.ts"), "utf8");
  const match = source.match(/^export const PROVIDERS = \[([^\]]*)\] as const;/m);
  if (match === null) throw new Error("PROVIDERS not found in packages/protocol/src/common.ts");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Every `FROM <parent> AS <name>` of the Dockerfile, in order. */
export function dockerfileStages(root = ROOT) {
  const dockerfile = readFileSync(path.join(root, "images/sandbox/Dockerfile"), "utf8");
  return [...dockerfile.matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)\s*$/gim)].map((m) => ({ name: m[2], parent: m[1] }));
}

/**
 * The release matrix: the Provider ids and every image target (`<id>`, `base`, `all`). Throws when
 * the Dockerfile lacks an `agent-<id>` payload stage or a `<id>` final for an id, or has one for
 * an id outside PROVIDERS.
 */
export function releaseMatrix(root = ROOT) {
  const ids = providerIds(root);
  const stages = dockerfileStages(root);
  const payloads = stages.filter((s) => s.name.startsWith("agent-")).map((s) => s.name.slice("agent-".length));
  const finals = stages.filter((s) => s.parent === "base").map((s) => s.name);
  const same = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  if (!same(payloads, ids)) throw new Error(`Dockerfile agent-* stages [${payloads}] differ from PROVIDERS [${ids}]`);
  if (!same(finals, [...ids, "all"])) throw new Error(`Dockerfile final targets [${finals}] differ from PROVIDERS + all [${[...ids, "all"]}]`);
  return { providers: ids, targets: [...ids, "base", "all"] };
}

/**
 * What `--provider <selection>` builds: the Dockerfile target and the tags. No selection is the
 * all-Providers image under the plain tags (what every Control Plane expects); `all`, `base` and a
 * Provider id get the suffixed tags only, so they never overwrite `:dev` or `<repo>:<version>`.
 */
export function imageTarget(selection, version, ids = providerIds()) {
  if (selection === undefined) {
    return { target: "all", tags: [`${IMAGE_REPOSITORY}:${version}`, `${DEV_REPOSITORY}:dev`] };
  }
  if (selection !== "all" && selection !== "base" && !ids.includes(selection)) {
    throw new Error(`unknown --provider ${JSON.stringify(selection)}; expected one of ${[...ids, "base", "all"].join(", ")}`);
  }
  return { target: selection, tags: [`${IMAGE_REPOSITORY}:${version}-${selection}`, `${DEV_REPOSITORY}:dev-${selection}`] };
}

/** Splits `--provider <x>` / `--provider=<x>` out of the arguments; the rest go to `docker build`. */
export function parseArgs(argv) {
  let provider;
  const forwarded = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--provider") {
      if (i + 1 >= argv.length) throw new Error("--provider needs a value");
      provider = argv[++i];
    } else if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
    } else {
      forwarded.push(arg);
    }
  }
  return { provider, forwarded };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--json") {
    console.error("usage: node scripts/sandbox-image-targets.mjs --json");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(releaseMatrix()));
  } catch (err) {
    console.error(`sandbox-image-targets: ${err.message}`);
    process.exit(1);
  }
}
