import {
  CRED_PLACEHOLDER_PATTERN,
  MCP_RESERVED_NAMES,
  UTILITY_NAME_PATTERN,
  type DaemonUtilitiesSetParams,
  type McpKeyValue,
  type McpServerSpec,
  type ProcedureDef,
  type PublicMcpKeyValue,
  type PublicUtilityDef,
  type Settings,
  type UtilityDef,
  type UtilityEnvironment,
  type UtilitySpec,
} from "@sessionboxer/protocol";
import { rewriteHostUrl } from "./config.js";
import { HttpError } from "./http-error.js";

/**
 * The Utilities registry (ADR-0073), alongside the MCP registry in `config.ts`: what the UI sees
 * (secrets hidden), how its edits merge back (null keeps a secret), and what a Session's enabled
 * set resolves to for the Daemon — one `UtilitySpec` per Utility with the credentials filled in,
 * plus the MCP servers of their MCP facets, which join the Session's ordinary MCP set.
 */

const hide = (kv: McpKeyValue): PublicMcpKeyValue => ({ ...kv, value: kv.secret && kv.value !== "" ? null : kv.value });

export function toPublicUtility(def: UtilityDef): PublicUtilityDef {
  return {
    ...def,
    credentials: def.credentials.map(hide),
    mcp: def.mcp ? { ...def.mcp, env: def.mcp.env.map(hide), headers: def.mcp.headers.map(hide) } : null,
    http: def.http ? { ...def.http, headers: def.http.headers.map(hide) } : null,
    cli: def.cli ? { ...def.cli, env: def.cli.env.map(hide) } : null,
  };
}

/** The whole registry as sent by the UI, with `null` secrets filled from what is stored; validated. */
export function mergeUtilities(current: UtilityDef[], incoming: PublicUtilityDef[], environments: UtilityEnvironment[]): UtilityDef[] {
  const byId = new Map(current.map((u) => [u.id, u]));
  const ids = new Set<string>();
  const keys = new Set<string>();
  const envNames = new Set(environments.map((e) => e.name));
  return incoming.map((pub) => {
    const prev = byId.get(pub.id);
    const name = pub.name.trim();
    if (!UTILITY_NAME_PATTERN.test(name)) throw new HttpError(400, `Utility name "${name}" must be lowercase letters, digits, "_" or "-".`);
    if ((MCP_RESERVED_NAMES as readonly string[]).includes(name) || name === "sessionboxer") throw new HttpError(400, `Utility name "${name}" is reserved.`);
    if (!envNames.has(pub.environment)) throw new HttpError(400, `Utility "${name}" names an unknown Environment "${pub.environment}".`);
    const key = `${name}@${pub.environment}`;
    if (keys.has(key)) throw new HttpError(400, `Two Utilities are called "${name}" in "${pub.environment}".`);
    if (ids.has(pub.id)) throw new HttpError(400, `Duplicate Utility id "${pub.id}".`);
    keys.add(key);
    ids.add(pub.id);
    const fill = (list: PublicMcpKeyValue[], prevList: McpKeyValue[]): McpKeyValue[] =>
      list
        .filter((kv) => kv.name.trim() !== "")
        .map((kv) => ({ name: kv.name.trim(), secret: kv.secret, value: kv.value ?? prevList.find((p) => p.name === kv.name.trim())?.value ?? "" }));
    const mcp = pub.mcp ? { ...pub.mcp, command: pub.mcp.command.trim(), url: pub.mcp.url.trim(), env: fill(pub.mcp.env, prev?.mcp?.env ?? []), headers: fill(pub.mcp.headers, prev?.mcp?.headers ?? []) } : null;
    if (mcp && mcp.transport === "stdio" && mcp.command === "") throw new HttpError(400, `Utility "${name}": the MCP facet needs a command.`);
    if (mcp && mcp.transport !== "stdio" && !/^https?:\/\//.test(mcp.url)) throw new HttpError(400, `Utility "${name}": the MCP facet needs an http(s) URL.`);
    const web = pub.web ? { ...pub.web, url: pub.web.url.trim() } : null;
    if (web && web.url !== "" && !/^https?:\/\//.test(web.url)) throw new HttpError(400, `Utility "${name}": the web URL must start with http(s)://.`);
    const http = pub.http ? { baseUrl: pub.http.baseUrl.trim(), headers: fill(pub.http.headers, prev?.http?.headers ?? []) } : null;
    if (http && http.baseUrl !== "" && !/^https?:\/\//.test(http.baseUrl)) throw new HttpError(400, `Utility "${name}": the HTTP base URL must start with http(s)://.`);
    const ssh = pub.ssh ? { ...pub.ssh, host: pub.ssh.host.trim(), user: pub.ssh.user.trim(), jump: pub.ssh.jump.trim() } : null;
    const cli = pub.cli ? { install: pub.cli.install.trim(), env: fill(pub.cli.env, prev?.cli?.env ?? []) } : null;
    return { ...pub, name, label: pub.label.trim(), credentials: fill(pub.credentials, prev?.credentials ?? []), mcp, web, http, ssh, cli };
  });
}

/** Environments as sent by the UI: unique valid names; the ones Utilities point at cannot go. */
export function mergeUtilityEnvironments(incoming: UtilityEnvironment[], utilities: UtilityDef[]): UtilityEnvironment[] {
  const names = new Set<string>();
  const out = incoming.map((e) => {
    const name = e.name.trim();
    if (!UTILITY_NAME_PATTERN.test(name)) throw new HttpError(400, `Environment name "${name}" must be lowercase letters, digits, "_" or "-".`);
    if (names.has(name)) throw new HttpError(400, `Duplicate Environment "${name}".`);
    names.add(name);
    return { ...e, name };
  });
  for (const u of utilities) if (!names.has(u.environment)) throw new HttpError(400, `Environment "${u.environment}" still has Utilities (${u.name}); move or delete them first.`);
  return out;
}

/** Procedures as sent by the UI: unique valid names. */
export function mergeProcedures(incoming: ProcedureDef[]): ProcedureDef[] {
  const names = new Set<string>();
  for (const p of incoming) {
    if (names.has(p.name)) throw new HttpError(400, `Duplicate procedure "${p.name}".`);
    names.add(p.name);
  }
  return incoming.map((p) => ({ ...p, description: p.description.trim(), body: p.body.trim() }));
}

/** Ids of the registry entries a new Session starts with when the request does not say: the Utility's and its Environment's defaults both on. */
export function defaultUtilitiesEnabled(settings: Settings): string[] {
  const envOn = new Set(settings.utilityEnvironments.filter((e) => e.enabledByDefault).map((e) => e.name));
  return settings.utilities.filter((u) => u.enabledByDefault && envOn.has(u.environment)).map((u) => u.id);
}

/** Keeps only ids that still exist in the registry. */
export function knownUtilityIds(settings: Settings, ids: string[]): string[] {
  const known = new Set(settings.utilities.map((u) => u.id));
  return ids.filter((id) => known.has(id));
}

export function utilityLabel(u: Pick<UtilityDef, "name" | "label">): string {
  return u.label.trim() === "" ? u.name : u.label;
}

/** `${cred:<name>}` in a facet value → the Utility's credential; unknown names stay as written (the Agent will see them). */
function fillCreds(text: string, credentials: McpKeyValue[]): string {
  return text.replace(CRED_PLACEHOLDER_PATTERN, (m, name: string) => credentials.find((c) => c.name === name)?.value ?? m);
}

export interface ResolvedUtilities {
  /** What the Daemon writes to tmpfs and the manifest. */
  specs: UtilitySpec[];
  /** The MCP servers of the enabled Utilities' MCP facets, named after the Utility. */
  mcpServers: McpServerSpec[];
  /** Registered but off for this Session. */
  available: DaemonUtilitiesSetParams["available"];
  environments: DaemonUtilitiesSetParams["environments"];
}

/**
 * The enabled Utilities, credentials filled in. An MCP facet's server is called after the Utility;
 * when that name is taken (the same Utility in two Environments, or a registry MCP server) it is
 * `<name>-<environment>` — and the manifest tells the Agent which.
 */
export function resolveUtilities(settings: Settings, enabledIds: string[], mcpNamesTaken: Iterable<string>): ResolvedUtilities {
  const enabled = new Set(enabledIds);
  const on = settings.utilities.filter((u) => enabled.has(u.id));
  const off = settings.utilities.filter((u) => !enabled.has(u.id));
  const production = new Set(settings.utilityEnvironments.filter((e) => e.production).map((e) => e.name));
  const taken = new Set<string>([...mcpNamesTaken, ...MCP_RESERVED_NAMES, "sessionboxer"]);
  const nameCount = new Map<string, number>();
  for (const u of on) nameCount.set(u.name, (nameCount.get(u.name) ?? 0) + 1);
  const mcpServers: McpServerSpec[] = [];
  const specs: UtilitySpec[] = on.map((u) => {
    const creds = u.credentials.filter((c) => c.value !== "");
    const kvs = (list: McpKeyValue[]) => list.map((kv) => ({ name: kv.name, value: fillCreds(kv.value, creds) }));
    let mcpName: string | null = null;
    if (u.mcp) {
      mcpName = (nameCount.get(u.name) ?? 0) > 1 || taken.has(u.name) ? `${u.name}-${u.environment}` : u.name;
      for (let i = 2; taken.has(mcpName); i++) mcpName = `${u.name}-${u.environment}-${i}`;
      taken.add(mcpName);
      mcpServers.push({
        id: `utility:${u.id}`,
        name: mcpName,
        transport: u.mcp.transport,
        command: u.mcp.command,
        args: u.mcp.args.map((a) => fillCreds(a, creds)),
        env: u.mcp.env.map((kv) => ({ ...kv, value: fillCreds(kv.value, creds) })),
        url: u.mcp.url ? rewriteHostUrl(fillCreds(u.mcp.url, creds)) : "",
        headers: u.mcp.headers.map((kv) => ({ ...kv, value: fillCreds(kv.value, creds) })),
      });
    }
    return {
      name: u.name,
      label: utilityLabel(u),
      group: u.group,
      environment: u.environment,
      production: production.has(u.environment),
      readOnly: u.readOnly,
      notes: u.notes,
      credentials: creds.map((c) => ({ name: c.name, value: c.value })),
      mcp: mcpName,
      web: u.web && u.web.url !== "" ? { ...u.web, url: rewriteHostUrl(u.web.url) } : null,
      http: u.http && u.http.baseUrl !== "" ? { baseUrl: rewriteHostUrl(fillCreds(u.http.baseUrl, creds)), headers: kvs(u.http.headers) } : null,
      ssh: u.ssh && u.ssh.host !== "" ? u.ssh : null,
      cli: u.cli ? { install: u.cli.install, env: kvs(u.cli.env) } : null,
    };
  });
  return {
    specs,
    mcpServers,
    available: off.map((u) => ({ name: u.name, label: utilityLabel(u), group: u.group, environment: u.environment })),
    environments: settings.utilityEnvironments.map((e) => ({ name: e.name, production: e.production })),
  };
}

/** The procedures a Session with these Utilities on gets as skills: enabled, and naming one of them (or none) and one of their Environments (or none). */
export function proceduresFor(settings: Settings, specs: UtilitySpec[]): DaemonUtilitiesSetParams["procedures"] {
  const names = new Set(specs.map((s) => s.name));
  const envs = new Set(specs.map((s) => s.environment));
  return settings.procedures
    .filter((p) => p.enabled && p.body.trim() !== "")
    .filter((p) => p.utilities.length === 0 || p.utilities.some((n) => names.has(n)))
    .filter((p) => p.environments.length === 0 || p.environments.some((e) => envs.has(e)))
    .map((p) => ({ name: p.name, description: p.description, body: p.body }));
}

/** Everything the Daemon gets in `utilities/set` for a Session. */
export function daemonUtilitiesParams(settings: Settings, enabledIds: string[], mcpNamesTaken: Iterable<string>): DaemonUtilitiesSetParams {
  const r = resolveUtilities(settings, enabledIds, mcpNamesTaken);
  return { environments: r.environments, utilities: r.specs, available: r.available, procedures: proceduresFor(settings, r.specs) };
}
