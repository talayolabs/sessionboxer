import { CONNECTORS, type McpTransport, type PublicMcpKeyValue, type PublicMcpServerDef } from "@sessionboxer/protocol";

export const TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: "stdio (command)",
  http: "HTTP (streamable)",
  sse: "SSE",
};

/** Keys that usually carry credentials get the write-only treatment when imported. */
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|auth|credential|bearer)/i;

export function newMcpServer(): PublicMcpServerDef {
  return {
    id: crypto.randomUUID(),
    name: "",
    transport: "stdio",
    command: "",
    args: [],
    env: [],
    url: "",
    headers: [],
    enabledByDefault: true,
    connector: null,
  };
}

/** Splits a command line into arguments, honouring single and double quotes and backslashes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) cur += line.charAt(++i);
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line.charAt(++i);
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

export function joinArgs(args: string[]): string {
  return args.map((a) => (a === "" || /[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a)).join(" ");
}

export function summarize(s: PublicMcpServerDef): string {
  if (s.connector) {
    const label = CONNECTORS[s.connector.kind].label;
    const where = s.connector.host ? ` (${s.connector.host})` : "";
    return s.connector.account ? `${label}${where} · @${s.connector.account}` : `${label}${where} · not connected`;
  }
  if (s.transport === "stdio") return [s.command, ...s.args].join(" ");
  return s.url;
}

function kvFromRecord(rec: unknown, where: string): PublicMcpKeyValue[] {
  if (rec === undefined || rec === null) return [];
  if (typeof rec !== "object" || Array.isArray(rec)) throw new Error(`${where} must be an object`);
  return Object.entries(rec as Record<string, unknown>).map(([name, value]) => {
    if (typeof value !== "string") throw new Error(`${where}.${name} must be a string`);
    return { name, value, secret: SECRET_KEY.test(name) };
  });
}

/**
 * Parses a Claude Desktop / Cursor style `{"mcpServers": {name: {...}}}` blob (a bare
 * `{name: {...}}` map works too) into registry entries. Env vars and headers whose
 * names look like credentials are marked secret.
 */
export function importMcpJson(text: string): PublicMcpServerDef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
  const root = parsed as Record<string, unknown>;
  const map = (typeof root.mcpServers === "object" && root.mcpServers !== null ? root.mcpServers : root) as Record<string, unknown>;
  const out: PublicMcpServerDef[] = [];
  for (const [name, raw] of Object.entries(map)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`"${name}" must be an object`);
    const def = raw as Record<string, unknown>;
    const url = typeof def.url === "string" ? def.url : "";
    const command = typeof def.command === "string" ? def.command : "";
    const type = typeof def.type === "string" ? def.type : typeof def.transport === "string" ? def.transport : "";
    const transport: McpTransport = type === "sse" ? "sse" : type === "http" || type === "streamable-http" || type === "streamable_http" ? "http" : url && !command ? "http" : "stdio";
    if (transport === "stdio" && !command) throw new Error(`"${name}" has neither a command nor a url`);
    const args = Array.isArray(def.args) ? def.args : [];
    if (!args.every((a): a is string => typeof a === "string")) throw new Error(`"${name}".args must be strings`);
    out.push({
      id: crypto.randomUUID(),
      name: name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^[_-]+/, "").slice(0, 64) || "server",
      transport,
      command,
      args,
      env: kvFromRecord(def.env, `"${name}".env`),
      url,
      headers: kvFromRecord(def.headers, `"${name}".headers`),
      enabledByDefault: !(def.disabled === true),
      connector: null,
    });
  }
  if (out.length === 0) throw new Error("No servers found in the JSON.");
  return out;
}
