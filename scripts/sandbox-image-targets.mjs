// The Sandbox image's Provider variants (ADR-0088): which ids exist, which Dockerfile targets they
// map to and which tags a local build gets. Shared by scripts/build-image.mjs, which runs before
// anything is compiled, so PROVIDERS is read from the protocol source, and by its test.
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
