#!/usr/bin/env node
// `npm run dist -w @sessionboxer/desktop`: packages the Electron tray shell (apps/desktop) with
// electron-builder. The Control Plane it runs is the published `sessionboxer` npm package, assembled
// by scripts/pack.mjs and `npm install`ed (with its dependencies, prebuilt better-sqlite3 included)
// into build/desktop-server/; electron-builder copies that into the app as resources/server/, where
// apps/desktop/src/server.ts finds node_modules/sessionboxer/apps/control-plane/dist/index.js. The
// package keeps the checkout's layout, so the Control Plane's relative paths (../../web/dist, the
// sandbox-daemon dist it copies into containers) resolve the same way they do everywhere else.
//
// `npm run build` first. Extra arguments go to electron-builder (`--dir`, `--mac`, `--linux deb`, …).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = path.join(ROOT, "build", "sessionboxer");
const SERVER = path.join(ROOT, "build", "desktop-server");
const DESKTOP = path.join(ROOT, "apps", "desktop");

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

run(process.execPath, [path.join(ROOT, "scripts", "pack.mjs")], ROOT);

const { version } = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
const tarball = spawnSync("npm", ["pack", "--json", "--pack-destination", path.join(ROOT, "build")], { cwd: PACKAGE, encoding: "utf8", shell: process.platform === "win32" });
if (tarball.status !== 0) {
  process.stderr.write(tarball.stderr);
  process.exit(tarball.status ?? 1);
}
const [{ filename }] = JSON.parse(tarball.stdout);

// A throwaway package whose only dependency is the tarball: `npm install` resolves and lays out the
// Control Plane's dependency tree exactly as `npm install -g sessionboxer` would.
rmSync(SERVER, { recursive: true, force: true });
mkdirSync(SERVER, { recursive: true });
writeFileSync(path.join(SERVER, "package.json"), JSON.stringify({ name: "sessionboxer-desktop-server", private: true, version }, null, 2) + "\n");
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts", path.join(ROOT, "build", filename)], SERVER);
console.log(`Control Plane sessionboxer@${version} installed in ${path.relative(ROOT, SERVER)}/`);

run("npx", ["electron-builder", "--config", "electron-builder.yml", ...process.argv.slice(2)], DESKTOP);
