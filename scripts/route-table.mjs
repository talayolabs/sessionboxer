// The Control Plane's HTTP routes as `METHOD /path`, in registration order, read from the source
// (the app in `index.ts` connects to Docker and listens as it loads, so `app.routes` is not
// reachable without an engine). Hono matches in registration order, so the `# overlaps` section
// lists every pair of routes that can answer the same URL and which of the two wins; that part of
// the table is the one that must not change when routes move between files.
//
// Covered: every `api.<method>(path, …)` (mounted under /api) in `index.ts` and in the
// `routes/*.ts` files, expanded in the order `index.ts` calls their `register*Routes`, plus the
// `app.<method>("/api/…")` routes outside the access-token middleware. Middleware (`use`) and the
// web UI's static fallback are not API routes and are left out.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("../apps/control-plane/src/", import.meta.url);
const METHODS = "get|post|put|patch|delete|all";

function read(file) {
  return readFileSync(new URL(file, SRC), "utf8");
}

/** `[{ offset, method, path }]` for every route registered on `app` in the given source text. */
function routesOn(app, source, prefix) {
  const found = [];
  for (const m of source.matchAll(new RegExp(`\\b${app}\\.(${METHODS})\\(\\s*"([^"]+)"`, "g"))) {
    found.push({ offset: m.index, method: m[1].toUpperCase(), path: prefix + m[2] });
  }
  for (const m of source.matchAll(new RegExp(`\\b${app}\\.on\\(\\s*\\[([^\\]]+)\\]\\s*,\\s*"([^"]+)"`, "g"))) {
    const methods = [...m[1].matchAll(/"([A-Z]+)"/g)].map((x) => x[1]).join(",");
    found.push({ offset: m.index, method: methods, path: prefix + m[2] });
  }
  return found;
}

/** `{ registerXRoutes: "routes/x.ts" }` from the imports of `index.ts`. */
function registerImports(index) {
  const map = {};
  for (const m of index.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/routes\/([\w-]+)\.js"/g)) {
    for (const name of m[1].split(",").map((s) => s.trim()).filter(Boolean)) map[name] = `routes/${m[2]}.ts`;
  }
  return map;
}

export function routeTable() {
  const index = read("index.ts");
  const files = registerImports(index);
  const entries = [
    ...routesOn("api", index, "/api"),
    ...routesOn("app", index, "").filter((r) => r.path.startsWith("/api")),
  ];
  for (const m of index.matchAll(/\b(register\w+Routes?)\(\s*(api|app)\s*,/g)) {
    const file = files[m[1]];
    if (!file) throw new Error(`${m[1]} is called in index.ts but not imported from ./routes/`);
    const prefix = m[2] === "api" ? "/api" : "";
    entries.push({ offset: m.index, routes: routesOn(m[2], read(file), prefix).sort((a, b) => a.offset - b.offset) });
  }
  entries.sort((a, b) => a.offset - b.offset);
  return entries.flatMap((e) => (e.routes ? e.routes : [e])).map(({ method, path }) => ({ method, path }));
}

const methodsOf = (r) => r.method.split(",");
const methodsMeet = (a, b) => a.method === "ALL" || b.method === "ALL" || methodsOf(a).some((m) => methodsOf(b).includes(m));

/** Whether two Hono patterns can match one URL: literals must agree, `:param` takes any one segment, a trailing `*` the rest. */
export function pathsMeet(a, b) {
  const as = a.split("/");
  const bs = b.split("/");
  for (let i = 0; ; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === "*" || y === "*") return true;
    if (x === undefined || y === undefined) return x === y;
    if (x !== y && !x.startsWith(":") && !y.startsWith(":")) return false;
  }
}

export function overlaps(table) {
  const out = [];
  for (let i = 0; i < table.length; i++) {
    for (let j = i + 1; j < table.length; j++) {
      if (methodsMeet(table[i], table[j]) && pathsMeet(table[i].path, table[j].path)) out.push([table[i], table[j]]);
    }
  }
  return out;
}

export function render() {
  const table = routeTable();
  const line = (r) => `${r.method} ${r.path}`;
  return [
    `# ${table.length} routes, in registration order`,
    ...table.map(line),
    "",
    "# overlaps: the earlier route answers URLs both patterns match",
    ...overlaps(table).map(([a, b]) => `${line(a)}  before  ${line(b)}`).sort(),
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.stdout.write(render());
