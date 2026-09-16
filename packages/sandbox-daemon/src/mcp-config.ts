import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { McpServerSpec } from "@sessionboxer/protocol";

/** The ACP `mcpServers` entries for the built-in desktop server plus the user's. */
export function acpMcpServers(desktopCommand: string, servers: McpServerSpec[]): McpServer[] {
  const list: McpServer[] = [{ name: "desktop", command: desktopCommand, args: [], env: [] }];
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
    private readonly desktopCommand: string,
  ) {}

  write(servers: McpServerSpec[]): void {
    const mcpServers: Record<string, unknown> = {
      desktop: { command: this.desktopCommand, transport: "stdio" },
    };
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
