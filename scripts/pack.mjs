#!/usr/bin/env node
// `npm run pack`: assembles the publishable `sessionboxer` npm package in build/sessionboxer/ from
// the built workspaces (`npm run build` first). The package mirrors the checkout's layout
// (apps/control-plane/dist, apps/web/dist, apps/cli/dist, packages/*/dist, images/sandbox/…), so
// the relative paths the Control Plane and the CLI use at runtime are the same in both, and
// @sessionboxer/protocol travels inside it as a bundled dependency. The Control Plane image
// (images/control-plane/Dockerfile) installs the same directory.
//
// `--tarball` additionally runs `npm pack` on the result and prints the tarball path.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "build", "sessionboxer");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const root = readJson(path.join(ROOT, "package.json"));
const controlPlane = readJson(path.join(ROOT, "apps/control-plane/package.json"));
const protocol = readJson(path.join(ROOT, "packages/protocol/package.json"));

/** Built directories that go in, relative to both the checkout and the package. */
const BUILT = [
  { dir: "apps/control-plane/dist", marker: "index.js" },
  { dir: "apps/web/dist", marker: "index.html" },
  { dir: "apps/cli/dist", marker: "index.js" },
  { dir: "packages/protocol/dist", marker: "index.js" },
  { dir: "packages/sandbox-daemon/dist", marker: "index.js" },
  { dir: "images/sandbox/vscode-sessionboxer", marker: "package.json" },
];
const DOCS = ["README.md", "LICENSE", "CHANGELOG.md"];

for (const { dir, marker } of BUILT) {
  if (!existsSync(path.join(ROOT, dir, marker))) {
    console.error(`${dir}/${marker} is missing; run \`npm run build\` first`);
    process.exit(1);
  }
}

// Runtime files only: no sourcemaps, declarations or tsc state.
const runtimeOnly = (src) => {
  if (statSync(src).isDirectory()) return true;
  return !/\.(map|d\.ts|tsbuildinfo)$/.test(src);
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const { dir } of BUILT) cpSync(path.join(ROOT, dir), path.join(OUT, dir), { recursive: true, filter: runtimeOnly });
for (const f of DOCS) cpSync(path.join(ROOT, f), path.join(OUT, f));

// @sessionboxer/protocol is imported by the Control Plane and the CLI by name; it ships inside the
// package (bundleDependencies) rather than as a separate npm package.
const bundled = path.join(OUT, "node_modules/@sessionboxer/protocol");
mkdirSync(bundled, { recursive: true });
cpSync(path.join(ROOT, "packages/protocol/dist"), path.join(bundled, "dist"), { recursive: true, filter: runtimeOnly });
writeFileSync(
  path.join(bundled, "package.json"),
  JSON.stringify({ name: protocol.name, version: protocol.version, type: protocol.type, exports: protocol.exports, license: "MIT" }, null, 2) + "\n",
);

const external = (deps) => Object.fromEntries(Object.entries(deps ?? {}).filter(([name]) => !name.startsWith("@sessionboxer/")));
const manifest = {
  name: "sessionboxer",
  version: root.version,
  description: root.description,
  license: "MIT",
  homepage: "https://sessionboxer.talayolabs.com",
  repository: { type: "git", url: "git+https://github.com/talayolabs/sessionboxer.git" },
  bugs: { url: "https://github.com/talayolabs/sessionboxer/issues" },
  keywords: ["coding-agent", "claude-code", "devin", "docker", "sandbox", "desktop", "acp"],
  type: "module",
  bin: { sessionboxer: "apps/cli/dist/index.js" },
  files: [...BUILT.map((b) => b.dir), ...DOCS],
  engines: root.engines,
  dependencies: {
    ...external(controlPlane.dependencies),
    ...external(protocol.dependencies),
    [protocol.name]: protocol.version,
  },
  bundleDependencies: [protocol.name],
};
writeFileSync(path.join(OUT, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`assembled sessionboxer@${manifest.version} in ${path.relative(ROOT, OUT)}/`);

if (process.argv.includes("--tarball")) {
  const res = spawnSync("npm", ["pack", "--json", "--pack-destination", path.join(ROOT, "build")], { cwd: OUT, encoding: "utf8" });
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    process.exit(res.status ?? 1);
  }
  const [info] = JSON.parse(res.stdout);
  console.log(`build/${info.filename} (${(info.size / 1024 / 1024).toFixed(1)} MB, ${info.entryCount} files)`);
}
