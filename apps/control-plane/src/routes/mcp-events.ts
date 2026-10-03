import { type Hono } from "hono";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

/** MCP Events (ADR-0081): what the registry's servers offer to subscribe to, and the live subscriptions. */
export function registerMcpEventRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  api.get("/mcp-events/catalog", async (c) => c.json(await deps.mcpEvents.catalog(c.req.query("refresh") === "1")));
  api.get("/mcp-events/subscriptions", (c) => c.json(deps.mcpEvents.statuses()));
}
