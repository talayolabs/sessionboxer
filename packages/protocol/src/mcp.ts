// ---------------------------------------------------------------------------
// MCP servers: registered once in Settings, enabled per Session. The built-in
// `desktop` server is implicit and always on. Enabling/disabling restarts the
// Agent in place (ACP `session/load`), so the conversation is kept.
// ---------------------------------------------------------------------------

import { z } from "zod";

export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export const McpTransport = z.enum(MCP_TRANSPORTS);
export type McpTransport = z.infer<typeof McpTransport>;

/** Environment variable (stdio) or HTTP header (http/sse); `secret` values are never sent back to the UI. */
export const McpKeyValue = z.object({
  name: z.string().min(1).max(200),
  value: z.string().max(10_000).default(""),
  secret: z.boolean().default(false),
});
export type McpKeyValue = z.infer<typeof McpKeyValue>;

/** Names become tool prefixes (`mcp__<name>__<tool>`), so keep them identifier-like; `desktop` is reserved. */
export const MCP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export const MCP_RESERVED_NAMES = ["desktop"] as const;

// Connectors: presets for well-known code hosts whose login the Control Plane runs
// itself, so the user clicks "Connect" instead of pasting tokens into headers. A GitHub
// entry is that host's remote MCP server plus a Sandbox login; a Bitbucket (Data Center)
// entry is a Sandbox login only (there is no MCP server to add), so its `url` is empty and
// it is left out of the Agent's MCP set. The same preset can be added several times, once
// per account (or per Bitbucket host).
export const CONNECTOR_KINDS = ["github", "bitbucket"] as const;
export const ConnectorKind = z.enum(CONNECTOR_KINDS);
export type ConnectorKind = z.infer<typeof ConnectorKind>;

export const CONNECTORS: Record<
  ConnectorKind,
  { label: string; url: string; readonlyUrl: string; scopes: string[]; defaultClientId: string; tokenHeader: string }
> = {
  github: {
    label: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    readonlyUrl: "https://api.githubcopilot.com/mcp/readonly",
    scopes: ["repo", "workflow", "read:org", "read:user", "user:email", "gist", "notifications", "project"],
    /** The "Sessionboxer" OAuth App on github.com (Device Flow enabled); Settings can point at another. */
    defaultClientId: "Ov23liy480AEYdv2nOiD",
    tokenHeader: "Authorization",
  },
  bitbucket: {
    label: "Bitbucket",
    url: "",
    readonlyUrl: "",
    scopes: [],
    defaultClientId: "",
    tokenHeader: "Authorization",
  },
};

/** Whether an entry of this kind is an MCP server too, or (Bitbucket) only a Sandbox login. */
export function connectorHasMcp(kind: ConnectorKind): boolean {
  return CONNECTORS[kind].url !== "";
}

/** Login state of a registry entry made from a Connector; the token itself lives in `headers`. */
export const McpConnector = z.object({
  kind: ConnectorKind,
  /** Account the stored token belongs to (`login`), `null` until connected. */
  account: z.string().nullable().default(null),
  connectedAt: z.string().nullable().default(null),
  /** Set when the OAuth App issues expiring tokens; Sessionboxer does not refresh them. */
  expiresAt: z.string().nullable().default(null),
  /** Bitbucket: the Data Center host the token is for (`bitbucket.example.com`); `null` for GitHub. */
  host: z.string().nullable().default(null),
});
export type McpConnector = z.infer<typeof McpConnector>;

/** The origins a MCP App view declares in `_meta.ui.csp` (spec 2026-01-26), and what a user approves. */
export const McpUiCsp = z.object({
  connectDomains: z.array(z.string().max(500)).max(50).default([]),
  resourceDomains: z.array(z.string().max(500)).max(50).default([]),
  frameDomains: z.array(z.string().max(500)).max(50).default([]),
  baseUriDomains: z.array(z.string().max(500)).max(50).default([]),
});
export type McpUiCsp = z.infer<typeof McpUiCsp>;

export const McpServerDef = z.object({
  id: z.string().min(1),
  name: z.string().regex(MCP_NAME_PATTERN, "letters, digits, `_` and `-` only"),
  transport: McpTransport,
  /** stdio: program run inside the Sandbox (`npx`, `uvx`, `node`, …). */
  command: z.string().max(4000).default(""),
  args: z.array(z.string().max(4000)).default([]),
  env: z.array(McpKeyValue).default([]),
  /** http/sse: `localhost` and `127.0.0.1` are rewritten to the Sandbox's host alias. */
  url: z.string().max(4000).default(""),
  headers: z.array(McpKeyValue).default([]),
  /** Pre-selected for new Sessions. */
  enabledByDefault: z.boolean().default(true),
  connector: McpConnector.nullable().default(null),
  /**
   * External origins the user allowed this server's MCP App views to reach (ADR-0079); `null`
   * until the first approval. A view's CSP only opens for origins listed here.
   */
  appDomains: McpUiCsp.nullable().default(null),
});
export type McpServerDef = z.infer<typeof McpServerDef>;

/**
 * `McpServerDef` as seen by the UI: secret values are replaced by `null` when set (and by `""` when
 * empty). Sending `null` back keeps the stored value, so the form can round-trip without knowing it.
 */
export const PublicMcpKeyValue = McpKeyValue.extend({ value: z.string().max(10_000).nullable() });
export type PublicMcpKeyValue = z.infer<typeof PublicMcpKeyValue>;
export const PublicMcpServerDef = McpServerDef.extend({
  env: z.array(PublicMcpKeyValue).default([]),
  headers: z.array(PublicMcpKeyValue).default([]),
});
export type PublicMcpServerDef = z.infer<typeof PublicMcpServerDef>;

/** What the Daemon gets: resolved definitions of the Session's enabled servers, secrets included. */
export const McpServerSpec = McpServerDef.omit({ enabledByDefault: true, connector: true, appDomains: true });
export type McpServerSpec = z.infer<typeof McpServerSpec>;
