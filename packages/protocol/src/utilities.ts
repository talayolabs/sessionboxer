// ---------------------------------------------------------------------------
// Utilities (ADR-0073): the external systems an Agent may investigate with — observability
// (New Relic, Grafana, Graylog, Argo CD, RabbitMQ admin…) and the applications under test
// (a QA or staging deployment) — registered once in Settings with their credentials, grouped by
// Environment (prod / staging / qa), and switched on per Session. A Utility has facets: an MCP
// server (native, joins the Session's MCP set), a web UI (the Agent logs in through the desktop
// with `${util:<name>.<credential>}` placeholders the computer-use MCP fills in), an HTTP API,
// an SSH host and a CLI. Credentials only ever reach the Sandbox on tmpfs and through `sb-util`.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { McpServerDef, McpKeyValue, PublicMcpKeyValue } from "./mcp.js";

export const UTILITY_GROUPS = ["observability", "applications"] as const;
export const UtilityGroup = z.enum(UTILITY_GROUPS);
export type UtilityGroup = z.infer<typeof UtilityGroup>;
export const UTILITY_GROUP_LABELS: Record<UtilityGroup, string> = { observability: "Observability", applications: "Applications" };

/** A name for `${util:<name>.<credential>}`, `sb-util <name>` and the MCP server it may add: lowercase, digits, `_` and `-`. */
export const UTILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Credential names with a meaning for `sb-util` and the placeholders: `user` / `password` (a login,
 * also SSH's), `token` (an API key or bearer token), `totp` (a base32 TOTP secret; `${util:x.otp}`
 * and `sb-util otp x` yield the current code), `ssh_key` (a private key PEM for the SSH facet).
 * Any other name is a plain credential the Agent reaches through `${util:x.<name>}` or `sb-util env`.
 */
export const UTILITY_CREDENTIAL_HINTS: Record<string, string> = {
  user: "Login name (also the SSH user when the facet leaves it blank)",
  password: "Login password (also SSH's, when there is no ssh_key)",
  token: "API key or bearer token",
  totp: "Base32 TOTP secret: ${util:<name>.otp} and `sb-util otp <name>` give the current code",
  ssh_key: "Private key (PEM) for the SSH facet",
};

/** A target Environment Utilities point at (`prod`, `staging`, `qa`, …); not the Session's Machine (Linux/Windows/macOS). */
export const UtilityEnvironment = z.object({
  name: z.string().regex(UTILITY_NAME_PATTERN, "lowercase letters, digits, `_` and `-` only"),
  /** Its Utilities default to read-only and the UI asks before a write-capable one is enabled. */
  production: z.boolean().default(false),
  /** Its Utilities are pre-selected for new Sessions (each Utility also has its own default). */
  enabledByDefault: z.boolean().default(true),
});
export type UtilityEnvironment = z.infer<typeof UtilityEnvironment>;
export const DEFAULT_UTILITY_ENVIRONMENTS: UtilityEnvironment[] = [
  { name: "prod", production: true, enabledByDefault: false },
  { name: "staging", production: false, enabledByDefault: true },
  { name: "qa", production: false, enabledByDefault: true },
];

/** How the Agent gets into a web UI. */
export const UTILITY_WEB_LOGINS = ["none", "basic", "form", "sso"] as const;
export const UtilityWebLogin = z.enum(UTILITY_WEB_LOGINS);
export type UtilityWebLogin = z.infer<typeof UtilityWebLogin>;
export const UTILITY_WEB_LOGIN_LABELS: Record<UtilityWebLogin, string> = {
  none: "No login",
  basic: "HTTP basic auth (user / password)",
  form: "Login form (user / password, maybe totp)",
  sso: "Single sign-on (describe the steps in the notes)",
};

/**
 * The MCP server a Utility adds to the Session (the same shape as a registry entry, minus identity):
 * `${cred:<name>}` in args, env values, the URL and headers is replaced by the Utility's credential
 * of that name when the set is resolved for the Daemon.
 */
export const UtilityMcpFacet = McpServerDef.omit({ id: true, name: true, enabledByDefault: true, connector: true, appDomains: true });
export type UtilityMcpFacet = z.infer<typeof UtilityMcpFacet>;
export const UtilityWebFacet = z.object({
  url: z.string().max(4000).default(""),
  login: UtilityWebLogin.default("form"),
});
export type UtilityWebFacet = z.infer<typeof UtilityWebFacet>;
/** An HTTP API: `sb-util curl <name> <path>` adds the headers (`${cred:token}` filled in) to the base URL. */
export const UtilityHttpFacet = z.object({
  baseUrl: z.string().max(4000).default(""),
  headers: z.array(McpKeyValue).default([]),
});
export type UtilityHttpFacet = z.infer<typeof UtilityHttpFacet>;
/** An SSH host: `sb-util ssh <name> [cmd]` and `sb-util tunnel <name> <local>:<host>:<port>` use the `ssh_key` or `password` credential. */
export const UtilitySshFacet = z.object({
  host: z.string().max(500).default(""),
  port: z.number().int().positive().max(65535).default(22),
  /** Blank takes the `user` credential. */
  user: z.string().max(200).default(""),
  /** A jump host (`user@bastion[:port]`) for `ssh -J`. */
  jump: z.string().max(500).default(""),
});
export type UtilitySshFacet = z.infer<typeof UtilitySshFacet>;
/** A command-line client: `sb-util env <name> -- <command>` runs it with `env` set (`${cred:<name>}` filled in). */
export const UtilityCliFacet = z.object({
  /** How to install the client in the Sandbox when it is missing, for the Agent (`pip install …`, `curl … | sh`). */
  install: z.string().max(4000).default(""),
  env: z.array(McpKeyValue).default([]),
});
export type UtilityCliFacet = z.infer<typeof UtilityCliFacet>;

export const UtilityDef = z.object({
  id: z.string().min(1),
  name: z.string().regex(UTILITY_NAME_PATTERN, "lowercase letters, digits, `_` and `-` only"),
  /** Shown in the UI; the name when blank. */
  label: z.string().max(200).default(""),
  group: UtilityGroup.default("observability"),
  /** A `Settings.utilityEnvironments` name. */
  environment: z.string().min(1).max(64),
  /** The preset it was made from (`newrelic`, `grafana`, …), for the UI's hints; `null` for a custom one. */
  preset: z.string().max(64).nullable().default(null),
  /** Stored with the definition; `secret` ones are write-only for the UI (see `UTILITY_CREDENTIAL_HINTS`). */
  credentials: z.array(McpKeyValue).default([]),
  /** The Agent is told not to change anything through it (and MCP presets run with their read-only flags). */
  readOnly: z.boolean().default(true),
  /** What the Agent should know: where things are, how the login goes, what to look at first. Never credentials. */
  notes: z.string().max(20_000).default(""),
  /** Pre-selected for new Sessions (when its Environment is too). */
  enabledByDefault: z.boolean().default(true),
  mcp: UtilityMcpFacet.nullable().default(null),
  web: UtilityWebFacet.nullable().default(null),
  http: UtilityHttpFacet.nullable().default(null),
  ssh: UtilitySshFacet.nullable().default(null),
  cli: UtilityCliFacet.nullable().default(null),
});
export type UtilityDef = z.infer<typeof UtilityDef>;

/** `UtilityDef` as the UI sees it: secret values are `null` when set (sending `null` back keeps them). */
export const PublicUtilityDef = UtilityDef.extend({
  credentials: z.array(PublicMcpKeyValue).default([]),
  mcp: UtilityMcpFacet.extend({ env: z.array(PublicMcpKeyValue).default([]), headers: z.array(PublicMcpKeyValue).default([]) })
    .nullable()
    .default(null),
  http: UtilityHttpFacet.extend({ headers: z.array(PublicMcpKeyValue).default([]) }).nullable().default(null),
  cli: UtilityCliFacet.extend({ env: z.array(PublicMcpKeyValue).default([]) }).nullable().default(null),
});
export type PublicUtilityDef = z.infer<typeof PublicUtilityDef>;

/**
 * Presets for common Utilities: the facets and credential names a kind of system takes, filled in
 * from one URL. `${url}` in a preset is the URL the user gives; `${cred:<name>}` stays in the
 * definition and is resolved per Session.
 */
export interface UtilityPreset {
  label: string;
  group: UtilityGroup;
  /** Credential names it asks for, the first ones required (see `UTILITY_CREDENTIAL_HINTS`). */
  credentials: string[];
  /** What a URL is for it, for the form ("the Grafana base URL"). */
  urlHint: string;
  web: UtilityWebFacet | null;
  http: UtilityHttpFacet | null;
  cli: UtilityCliFacet | null;
  mcp: UtilityMcpFacet | null;
  notes: string;
}
export const UTILITY_PRESETS: Record<string, UtilityPreset> = {
  newrelic: {
    label: "New Relic",
    group: "observability",
    credentials: ["user", "password", "token", "totp"],
    urlHint: "New Relic One URL (https://one.newrelic.com or https://one.eu.newrelic.com)",
    web: { url: "${url}", login: "form" },
    http: { baseUrl: "https://api.newrelic.com/graphql", headers: [{ name: "API-Key", value: "${cred:token}", secret: true }] },
    cli: null,
    mcp: null,
    notes:
      "NRQL through NerdGraph: `sb-util curl newrelic -X POST -d '{\"query\":\"{ actor { account(id: ACCOUNT) { nrql(query: \\\"SELECT count(*) FROM Transaction SINCE 1 hour ago\\\") { results } } } }\"}'` (needs a User API key as `token`). The web UI (APM, Logs, Errors inbox) is at the URL; log in with the `user` / `password` placeholders.",
  },
  grafana: {
    label: "Grafana",
    group: "observability",
    credentials: ["user", "password", "token"],
    urlHint: "Grafana base URL",
    web: { url: "${url}", login: "form" },
    http: { baseUrl: "${url}/api", headers: [{ name: "Authorization", value: "Bearer ${cred:token}", secret: true }] },
    cli: null,
    mcp: null,
    notes:
      "Dashboards and Explore in the web UI; the HTTP API (`/api/search`, `/api/dashboards/uid/<uid>`, `/api/ds/query`) with a service-account `token`. Loki/Prometheus queries go through `/api/ds/query` with the datasource uid from `/api/datasources`.",
  },
  graylog: {
    label: "Graylog",
    group: "observability",
    credentials: ["user", "password", "token"],
    urlHint: "Graylog web URL",
    web: { url: "${url}", login: "form" },
    http: { baseUrl: "${url}/api", headers: [{ name: "X-Requested-By", value: "sessionboxer", secret: false }] },
    cli: null,
    mcp: null,
    notes:
      "Search with the REST API: `sb-util curl graylog '/search/universal/relative?query=<q>&range=3600'` (basic auth from `user` / `password`, or `token` as the user with password `token`). Streams and saved searches in the web UI.",
  },
  argocd: {
    label: "Argo CD",
    group: "observability",
    credentials: ["user", "password", "token"],
    urlHint: "Argo CD server URL",
    web: { url: "${url}", login: "form" },
    http: { baseUrl: "${url}/api/v1", headers: [{ name: "Authorization", value: "Bearer ${cred:token}", secret: true }] },
    cli: {
      install: "curl -sSL -o /tmp/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64 && install -m 755 /tmp/argocd ~/.local/bin/argocd",
      env: [
        { name: "ARGOCD_SERVER", value: "${url}", secret: false },
        { name: "ARGOCD_AUTH_TOKEN", value: "${cred:token}", secret: true },
        { name: "ARGOCD_OPTS", value: "--grpc-web", secret: false },
      ],
    },
    mcp: null,
    notes: "Applications, sync status and history: `sb-util env argocd -- argocd app list`, `argocd app get <app>`, `argocd app history <app>`; the same at `/api/v1/applications` over HTTP.",
  },
  rabbitmq: {
    label: "RabbitMQ management",
    group: "observability",
    credentials: ["user", "password"],
    urlHint: "Management UI URL (usually port 15672)",
    web: { url: "${url}", login: "form" },
    http: { baseUrl: "${url}/api", headers: [] },
    cli: null,
    mcp: null,
    notes: "Queues, consumers and rates: `sb-util curl rabbitmq /queues` (basic auth from `user` / `password`), `/overview`, `/connections`; the Queues tab of the web UI shows the same.",
  },
  mongodb: {
    label: "MongoDB",
    group: "applications",
    credentials: ["uri"],
    urlHint: "Not used: the connection string is the `uri` credential (mongodb://user:pass@host/db)",
    web: null,
    http: null,
    cli: { install: "", env: [{ name: "MONGODB_URI", value: "${cred:uri}", secret: true }] },
    mcp: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "mongodb-mcp-server", "--readOnly"],
      env: [{ name: "MDB_MCP_CONNECTION_STRING", value: "${cred:uri}", secret: true }],
      url: "",
      headers: [],
    },
    notes: "The MCP server exposes find/aggregate/schema tools read-only; `sb-util env mongodb -- mongosh \"$MONGODB_URI\"` for an interactive shell (install mongosh first if missing).",
  },
  webapp: {
    label: "Web application",
    group: "applications",
    credentials: ["user", "password", "totp"],
    urlHint: "The application's URL",
    web: { url: "${url}", login: "form" },
    http: null,
    cli: null,
    mcp: null,
    notes: "",
  },
  ssh: {
    label: "SSH host",
    group: "applications",
    credentials: ["user", "password", "ssh_key"],
    urlHint: "Not used: host, port, user and jump host are the SSH facet",
    web: null,
    http: null,
    cli: null,
    mcp: null,
    notes: "`sb-util ssh <name> [command]`; `sb-util tunnel <name> <localPort>:<remoteHost>:<remotePort>` for a port forward.",
  },
};

/** A preset's facets with `${url}` filled in (a trailing `/` dropped). */
export function applyUtilityPreset(preset: UtilityPreset, url: string): Pick<UtilityDef, "web" | "http" | "cli" | "mcp"> {
  const base = url.trim().replace(/\/+$/, "");
  const fill = (s: string) => s.replace(/\$\{url\}/g, base);
  const kvs = (list: McpKeyValue[]) => list.map((kv) => ({ ...kv, value: fill(kv.value) }));
  return {
    web: preset.web ? { ...preset.web, url: fill(preset.web.url) } : null,
    http: preset.http ? { baseUrl: fill(preset.http.baseUrl), headers: kvs(preset.http.headers) } : null,
    cli: preset.cli ? { install: preset.cli.install, env: kvs(preset.cli.env) } : null,
    mcp: preset.mcp ? { ...preset.mcp, args: preset.mcp.args.map(fill), env: kvs(preset.mcp.env), url: fill(preset.mcp.url), headers: kvs(preset.mcp.headers) } : null,
  };
}

/** The Utility's facets and credentials as the Sandbox Daemon gets them (secrets included, placeholders filled in). */
export const UtilitySpec = z.object({
  name: z.string(),
  label: z.string(),
  group: UtilityGroup,
  environment: z.string(),
  production: z.boolean(),
  readOnly: z.boolean(),
  notes: z.string(),
  credentials: z.array(z.object({ name: z.string(), value: z.string() })),
  /** The name its MCP server has in the Agent's set (`null` without an MCP facet). */
  mcp: z.string().nullable(),
  web: UtilityWebFacet.nullable(),
  http: z.object({ baseUrl: z.string(), headers: z.array(z.object({ name: z.string(), value: z.string() })) }).nullable(),
  ssh: UtilitySshFacet.nullable(),
  cli: z.object({ install: z.string(), env: z.array(z.object({ name: z.string(), value: z.string() })) }).nullable(),
});
export type UtilitySpec = z.infer<typeof UtilitySpec>;

/** Where the Daemon writes what the Agent may use (no secrets: credential names only). */
export const UTILITIES_MANIFEST_PATH = ".sessionboxer/utilities.json";
export const UtilitiesManifest = z.object({
  environments: z.array(z.object({ name: z.string(), production: z.boolean() })),
  utilities: z.array(
    UtilitySpec.omit({ credentials: true, http: true, cli: true }).extend({
      credentials: z.array(z.string()),
      /** `${util:<name>.otp}` works: a `totp` credential is stored. */
      otp: z.boolean(),
      http: z.object({ baseUrl: z.string(), headers: z.array(z.string()) }).nullable(),
      cli: z.object({ install: z.string(), env: z.array(z.string()) }).nullable(),
    }),
  ),
  /** Registered but off for this Session (the user can switch them on in Session settings; `utilities_enable` asks). */
  available: z.array(z.object({ name: z.string(), label: z.string(), group: UtilityGroup, environment: z.string() })),
  /** Names of the procedure skills materialised for this Session (`~/.claude/skills/<name>/SKILL.md`). */
  procedures: z.array(z.string()),
});
export type UtilitiesManifest = z.infer<typeof UtilitiesManifest>;

/** Where the Daemon keeps each enabled Utility's credentials for `sb-util` and the placeholders: tmpfs, `0600`. */
export const UTILITY_CREDENTIALS_DIR = "/dev/shm/sessionboxer/utilities";

/** `${util:<name>.<credential>}` (or `.otp`) in text the Agent has typed or run. */
export const UTIL_PLACEHOLDER_PATTERN = /\$\{util:([a-z0-9][a-z0-9_-]*)\.([A-Za-z0-9_-]+)\}/g;
/** `${cred:<name>}` inside a Utility's own facets. */
export const CRED_PLACEHOLDER_PATTERN = /\$\{cred:([A-Za-z0-9_-]+)\}/g;

/**
 * A debugging procedure (ADR-0073): an Agent Skill (`SKILL.md` with `name` and `description`
 * frontmatter, the body in Markdown) that says how to investigate something with the Utilities,
 * materialised into the Sandbox's skills directory for Sessions whose Utilities it names.
 */
export const PROCEDURE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A starting point for the first procedure: the generic incident walk, to be made specific to the user's Utilities. */
export const INCIDENT_PROCEDURE_TEMPLATE = {
  name: "investigate-an-incident",
  description: "Use when something is broken or slow in an Environment (an alert, a user report, a failing check): find what changed and where it fails, with the Utilities on for the Session, before proposing a fix.",
  body: `# Investigate an incident

Read \`.sessionboxer/utilities.json\` first: it lists the Utilities on for this Session by Environment. Stay in the Environment the incident is about; production Utilities are read-only — look, do not change.

## 1. Pin down the symptom
- What fails, since when, for whom, how often. Ask if the report does not say.
- Write the time window down (UTC); every query below uses it.

## 2. What changed
- Deploys / rollouts in the window (Argo CD, the CI, the release notes): \`utilities_get\` the deploy Utility and check the apps of the affected service.
- Configuration or feature flags, dependencies (database, queue, third parties) that had incidents.

## 3. Where it fails
- Errors and latency for the service (New Relic / Grafana): error rate, p95, throughput per endpoint, compared with the day before.
- Logs around the first failure (Graylog / the logs Utility): search the trace or request id, the error message, the host.
- One failing request end to end (a trace): which hop breaks, what it returns.
- The dependency itself when the trace points at it (queue depth and consumers in RabbitMQ, slow queries in MongoDB).

## 4. Reproduce when it is safe
- In a non-production Environment (qa / staging): open the application Utility (\`utilities_open\`), do what the user did, watch the logs.

## 5. Conclude
- Cause (or the two or three candidates, with what would tell them apart), evidence (queries, screenshots, log lines), blast radius, and the fix or mitigation you propose.
- If this procedure needed a step that is not written here, propose the improved version with \`procedure_save\`.
`,
} as const;
export const ProcedureDef = z.object({
  id: z.string().min(1),
  name: z.string().regex(PROCEDURE_NAME_PATTERN, "lowercase letters, digits and `-` only"),
  /** When to use it, for the skill's frontmatter (what the Agent reads before opening the body). */
  description: z.string().min(1).max(1024),
  body: z.string().max(200_000).default(""),
  /** Utility names it needs; empty means any Session with Utilities on gets it. */
  utilities: z.array(z.string()).default([]),
  /** Environments it applies to; empty means all. */
  environments: z.array(z.string()).default([]),
  source: z.enum(["user", "agent"]).default("user"),
  enabled: z.boolean().default(true),
});
export type ProcedureDef = z.infer<typeof ProcedureDef>;

/** The `SKILL.md` text of a procedure. */
export function procedureSkillMarkdown(p: Pick<ProcedureDef, "name" | "description" | "body">): string {
  const description = p.description.replace(/\s+/g, " ").trim().replace(/"/g, "'");
  return `---\nname: ${p.name}\ndescription: "${description}"\n---\n\n${p.body.trim()}\n`;
}

/** A `SKILL.md` back into its parts; `null` when it has no frontmatter with a name and a description. */
export function parseProcedureSkill(text: string): { name: string; description: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const front: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  const name = front.name ?? "";
  const description = front.description ?? "";
  if (!PROCEDURE_NAME_PATTERN.test(name) || description === "") return null;
  return { name, description, body: m[2]!.trim() };
}

/** The current TOTP code (RFC 6238, SHA-1) for a base32 secret; WebCrypto, so it runs in Node and the browser. */
export async function totpCode(secretBase32: string, now = Date.now(), digits = 6, period = 30): Promise<string> {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(now / 1000 / period);
  const msg = new Uint8Array(8);
  for (let i = 7, c = counter; i >= 0; i--, c = Math.floor(c / 256)) msg[i] = c % 256;
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
  const offset = h[19]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const bytes = new Uint8Array(new ArrayBuffer(out.length));
  bytes.set(out);
  return bytes;
}
