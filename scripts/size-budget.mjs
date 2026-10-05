#!/usr/bin/env node
// The "boiled frog" monitor (docs/TECH-DEBT.md, round 3): no source file grows past its budget
// unnoticed. Every .ts/.tsx under apps/ and packages/ must stay within DEFAULT lines, except the
// files listed in BUDGET, which may not grow past the number next to them (their size when the
// budget was set, rounded up to the next ten). Shrinking a file is free; lowering its number is
// the one-line follow-up. Adding a line here is a decision, not an accident — say why in the commit.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT = 600;
const BUDGET = {
  "apps/control-plane/src/sessions.ts": 3000,
  "apps/control-plane/src/agent-tools.ts": 1180,
  "packages/sandbox-daemon/src/agent.ts": 1150,
  "apps/control-plane/src/db.ts": 1120,
  "apps/control-plane/src/pull-requests.ts": 1060,
  "apps/control-plane/src/followed-prs.ts": 1060,
  "apps/control-plane/src/config.ts": 1050,
  "packages/sandbox-daemon/src/index.ts": 1040,
  "packages/sandbox-daemon/src/guest.ts": 1030,
  "packages/protocol/src/themes.ts": 1000,
  "apps/web/src/SessionSettingsForm.tsx": 810,
  "apps/web/src/Transcript.tsx": 880,
  "apps/control-plane/src/macos.ts": 830,
  "apps/control-plane/src/github-pr.ts": 820,
  "apps/web/src/Prs.tsx": 820,
  "apps/web/src/Composer.tsx": 780,
  "apps/control-plane/src/docker.ts": 770,
  "apps/control-plane/src/provider-login.ts": 760,
  "packages/computer-use-mcp/src/recording.ts": 760,
  "packages/sessionboxer-mcp/src/index.ts": 760,
  "apps/web/src/UtilitiesEditor.tsx": 730,
  "apps/control-plane/src/pr-store.ts": 720,
  "apps/control-plane/src/automations.ts": 740,
  "apps/web/src/Devices.tsx": 710,
  "apps/web/src/settings/ProvidersSettings.tsx": 700,
  "apps/web/src/Sidebar.tsx": 650,
  "packages/sandbox-daemon/src/mcp-mirror.ts": 640,
  "apps/web/src/PullRequests.tsx": 610,
};

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) yield path;
  }
}

function lineCount(path) {
  const text = readFileSync(path, "utf8");
  return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const over = [];
const seen = new Set();
for (const top of ["apps", "packages"]) {
  for (const path of sourceFiles(join(ROOT, top))) {
    const rel = relative(ROOT, path);
    seen.add(rel);
    const lines = lineCount(path);
    const limit = BUDGET[rel] ?? DEFAULT;
    if (lines > limit) over.push({ rel, lines, limit });
  }
}
const gone = Object.keys(BUDGET).filter((rel) => !seen.has(rel));

for (const { rel, lines, limit } of over) console.error(`${rel}: ${lines} lines, budget ${limit}`);
for (const rel of gone) console.error(`${rel}: listed in the budget but no longer exists — drop its line`);
if (over.length > 0 || gone.length > 0) {
  console.error(
    `\n${over.length} file(s) over budget. Split the file (docs/TECH-DEBT.md has the precedents) or, if the growth is a decision, raise its line in scripts/size-budget.mjs and say why in the commit.`,
  );
  process.exit(1);
}
console.log(`size budget: ${seen.size} files checked, ${Object.keys(BUDGET).length} with their own line budget, none over.`);
