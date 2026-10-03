// ---------------------------------------------------------------------------
// MCP Apps (ADR-0079): the `io.modelcontextprotocol/ui` extension, spec 2026-01-26. The Agent's
// MCP servers are reached through a transparent per-server tee (`packages/mcp-tee`); the Daemon
// mirrors what passes and the web transcript hosts the views.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { McpUiCsp, McpServerSpec } from "./mcp.js";

export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
/** The Daemon's WebSocket path a tee connects to: `/mcp-tee/<server name>`, loopback only. */
export const MCP_TEE_PATH = "/mcp-tee";
/** Environment variable the Daemon sets on the tee's process (the Agent passes its environment on). */
export const MCP_TEE_PORT_ENV = "SESSIONBOXER_DAEMON_PORT";
/** Prefix of the JSON-RPC ids the tee uses for Daemon-originated requests (the Agent's ids are numbers). */
export const MCP_TEE_ID_PREFIX = "sbx-tee:";

/** A tool result exactly as the server sent it; `structuredContent` and `_meta` are what the view renders. */
export const McpToolResult = z
  .object({
    content: z.array(z.unknown()).default([]),
    structuredContent: z.record(z.unknown()).optional(),
    _meta: z.record(z.unknown()).optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();
export type McpToolResult = z.infer<typeof McpToolResult>;

/** `_meta.ui` of a tool as the server lists it. */
export const McpToolUiMeta = z
  .object({
    resourceUri: z.string().optional(),
    visibility: z.array(z.enum(["model", "app"])).optional(),
  })
  .passthrough();
export type McpToolUiMeta = z.infer<typeof McpToolUiMeta>;

/** `_meta.ui` of a `ui://` resource as the server serves it. */
export const McpResourceUiMeta = z
  .object({
    csp: McpUiCsp.partial().optional(),
    permissions: z.record(z.unknown()).optional(),
    domain: z.string().optional(),
    prefersBorder: z.boolean().optional(),
  })
  .passthrough();
export type McpResourceUiMeta = z.infer<typeof McpResourceUiMeta>;

/** An Agent tool call matched to its exact MCP exchange, for a tool that has a view. */
export const McpAppCall = z.object({
  toolCallId: z.string(),
  server: z.string(),
  tool: z.string(),
  resourceUri: z.string(),
  arguments: z.record(z.unknown()).nullable(),
});
export type McpAppCall = z.infer<typeof McpAppCall>;

export const DaemonMcpAppsResourceParams = z.object({ server: z.string().min(1), uri: z.string().min(1) });
export type DaemonMcpAppsResourceParams = z.infer<typeof DaemonMcpAppsResourceParams>;
export const DaemonMcpAppsResourceResult = z.object({
  server: z.string(),
  uri: z.string(),
  mimeType: z.string(),
  html: z.string(),
  meta: McpResourceUiMeta,
  sha256: z.string(),
});
export type DaemonMcpAppsResourceResult = z.infer<typeof DaemonMcpAppsResourceResult>;

export const DaemonMcpAppsToolResultParams = z.object({ toolCallId: z.string().min(1) });
export type DaemonMcpAppsToolResultParams = z.infer<typeof DaemonMcpAppsToolResultParams>;
export const DaemonMcpAppsToolResultResult = z.object({
  call: McpAppCall,
  /** `null` while the server has not answered yet. */
  result: McpToolResult.nullable(),
  /** The tool as listed by the server (name, description, schema, `_meta`), for the view's host context. */
  tool: z.record(z.unknown()).nullable(),
});
export type DaemonMcpAppsToolResultResult = z.infer<typeof DaemonMcpAppsToolResultResult>;

export const DaemonMcpAppsCallToolParams = z.object({
  /** The card's call: the tool must belong to that call's server (no cross-server calls). */
  toolCallId: z.string().min(1),
  server: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.unknown()).default({}),
});
export type DaemonMcpAppsCallToolParams = z.infer<typeof DaemonMcpAppsCallToolParams>;

export const DaemonMcpAppsReadResourceParams = z.object({
  toolCallId: z.string().min(1),
  server: z.string().min(1),
  uri: z.string().min(1),
});
export type DaemonMcpAppsReadResourceParams = z.infer<typeof DaemonMcpAppsReadResourceParams>;
export const DaemonMcpAppsReadResourceResult = z.object({ contents: z.array(z.unknown()) }).passthrough();
export type DaemonMcpAppsReadResourceResult = z.infer<typeof DaemonMcpAppsReadResourceResult>;

export const DaemonMcpAppsToolsParams = z.object({ server: z.string().min(1) });
export type DaemonMcpAppsToolsParams = z.infer<typeof DaemonMcpAppsToolsParams>;
export const DaemonMcpAppsToolsResult = z.object({ tools: z.array(z.record(z.unknown())) });
export type DaemonMcpAppsToolsResult = z.infer<typeof DaemonMcpAppsToolsResult>;

/** What the UI gets for a view: the Daemon's resource plus the registry's approvals for its server. */
export const McpAppResourceResponse = DaemonMcpAppsResourceResult.extend({
  approvedDomains: McpUiCsp.nullable(),
  /** Whether the server has a registry entry approvals can be stored on (Utilities' servers have none). */
  approvable: z.boolean(),
});
export type McpAppResourceResponse = z.infer<typeof McpAppResourceResponse>;

export const McpAppApproveRequest = z.object({ server: z.string().min(1), csp: McpUiCsp });
export type McpAppApproveRequest = z.infer<typeof McpAppApproveRequest>;

/** Messages the tee sends the Daemon over its WebSocket. */
export const McpTeeToDaemon = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), server: z.string().min(1), pid: z.number().int().optional() }),
  /** A copy of every JSON-RPC message between the Agent and the server, in the order the tee saw them. */
  z.object({ type: z.literal("traffic"), from: z.enum(["agent", "server"]), message: z.record(z.unknown()), at: z.number() }),
  /** The server's answer to a Daemon-originated request (`id` as the Daemon gave it). */
  z.object({ type: z.literal("response"), id: z.string(), result: z.unknown().optional(), error: z.unknown().optional() }),
  z.object({ type: z.literal("log"), message: z.string() }),
]);
export type McpTeeToDaemon = z.infer<typeof McpTeeToDaemon>;

/** Messages the Daemon sends the tee. */
export const McpTeeFromDaemon = z.discriminatedUnion("type", [
  /** The real server to connect to (command/args/env or url/headers): answers `hello`. */
  z.object({ type: z.literal("spec"), spec: McpServerSpec }),
  z.object({ type: z.literal("request"), id: z.string(), method: z.string(), params: z.unknown().optional() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type McpTeeFromDaemon = z.infer<typeof McpTeeFromDaemon>;
