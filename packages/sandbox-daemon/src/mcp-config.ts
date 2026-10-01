import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { McpServerSpec } from "@sessionboxer/protocol";

/**
 * A stdio MCP server the image ships and every Agent gets without configuring it: `desktop`
 * (screenshots, input, recordings) and `sessionboxer` (the Session itself, ADR-0062; left out under
 * the `off` policy).
 */
export interface BuiltinMcp {
  name: string;
  command: string;
  args?: string[];
}

/** The ACP `mcpServers` entries for the built-in servers plus the user's. */
export function acpMcpServers(builtins: BuiltinMcp[], servers: McpServerSpec[]): McpServer[] {
  const list: McpServer[] = builtins.map((b) => ({ name: b.name, command: b.command, args: b.args ?? [], env: [] }));
  for (const s of servers) {
    if (s.transport === "stdio") {
      list.push({ name: s.name, command: s.command, args: s.args, env: s.env.map(({ name, value }) => ({ name, value })) });
    } else {
      list.push({ type: s.transport, name: s.name, url: s.url, headers: s.headers.map(({ name, value }) => ({ name, value })) });
    }
  }
  return list;
}

/**
 * Devin's model only sees MCP servers from Devin's own config (ADR-0007), so the set
 * is written to `~/.config/devin/mcp_config.json` before `devin acp` starts. The
 * file itself lives on tmpfs and is only reachable through a symlink: env values and
 * headers are secrets, and `docker commit` (Snapshots) must not capture them.
 */
export class DevinMcpConfig {
  constructor(
    private readonly configPath: string,
    private readonly tmpfsDir: string,
    /** The built-in servers as the Agent starts them (the bridge client's command line when it runs in a VM). */
    private readonly builtins: () => BuiltinMcp[],
  ) {}

  write(servers: McpServerSpec[]): void {
    const mcpServers: Record<string, unknown> = {};
    for (const b of this.builtins()) {
      mcpServers[b.name] = { command: b.command, ...(b.args && b.args.length > 0 ? { args: b.args } : {}), transport: "stdio" };
    }
    for (const s of servers) {
      mcpServers[s.name] =
        s.transport === "stdio"
          ? { command: s.command, args: s.args, env: toRecord(s.env), transport: "stdio" }
          : { url: s.url, headers: toRecord(s.headers), transport: s.transport };
    }
    mkdirSync(this.tmpfsDir, { recursive: true, mode: 0o700 });
    const target = join(this.tmpfsDir, "mcp_config.json");
    writeFileSync(target, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
    mkdirSync(dirname(this.configPath), { recursive: true });
    if (!isSymlinkTo(this.configPath, target)) {
      rmSync(this.configPath, { force: true });
      symlinkSync(target, this.configPath);
    }
  }
}

/**
 * pi's built-in MCP client reads `~/.pi/agent/mcp.json` (ADR-0075): its ACP adapter stores the
 * servers `session/new` passes but does not hand them to pi, so the set is written there before
 * `pi-acp` starts, on tmpfs behind a symlink like Devin's. Entries are declared `direct` so the
 * tools reach the model like a built-in tool (pi's default routes them through its `codemode`
 * script tool). pi rejects SSE servers, so those are left out and named in the log.
 */
export class PiMcpConfig {
  constructor(
    private readonly configPath: string,
    private readonly tmpfsDir: string,
    private readonly builtins: () => BuiltinMcp[],
    private readonly log: (msg: string) => void,
  ) {}

  write(servers: McpServerSpec[]): void {
    const mcpServers: Record<string, unknown> = {};
    for (const b of this.builtins()) {
      mcpServers[b.name] = { command: b.command, args: b.args ?? [], exposure: "direct" };
    }
    for (const s of servers) {
      if (s.transport === "stdio") {
        mcpServers[s.name] = { command: s.command, args: s.args, env: toRecord(s.env), exposure: "direct" };
      } else if (s.transport === "http") {
        mcpServers[s.name] = { url: s.url, headers: toRecord(s.headers), exposure: "direct" };
      } else {
        this.log(`mcp server ${s.name} uses SSE, which pi does not support; left out`);
      }
    }
    mkdirSync(this.tmpfsDir, { recursive: true, mode: 0o700 });
    const target = join(this.tmpfsDir, "pi-mcp.json");
    writeFileSync(target, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
    mkdirSync(dirname(this.configPath), { recursive: true });
    if (!isSymlinkTo(this.configPath, target)) {
      rmSync(this.configPath, { force: true });
      symlinkSync(target, this.configPath);
    }
  }
}

function toRecord(entries: { name: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(entries.map(({ name, value }) => [name, value]));
}

function isSymlinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}
