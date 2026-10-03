// Global Settings: read, update, and the MCP Apps domain approvals they hold.
import { type Hono } from "hono";
import { McpAppApproveRequest, UpdateSettingsRequest } from "@sessionboxer/protocol";
import { HttpError } from "../sessions.js";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerSettingsRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { publicSettings, applySettings } = deps;
  api.get("/settings", async (c) => c.json(await publicSettings()));

  api.put("/settings", async (c) => {
    await applySettings(UpdateSettingsRequest.parse(await c.req.json()));
    return c.json(await publicSettings());
  });

  /** Approves, once per registry entry, the external domains a server's views may reach (kept on `McpServerDef.appDomains`). */
  api.post("/mcp-apps/approve", async (c) => {
    const req = McpAppApproveRequest.parse(await c.req.json());
    const current = (await publicSettings()).mcpServers;
    if (!current.some((m) => m.name === req.server)) throw new HttpError(404, `No MCP server named "${req.server}" in the registry.`);
    await applySettings({ mcpServers: current.map((m) => (m.name === req.server ? { ...m, appDomains: req.csp } : m)) });
    return c.json(await publicSettings());
  });
}
