// The Sessionboxer tunnel server (ADR-0071): what it says about itself and whether a name is free.
import { type Hono } from "hono";
import { HttpError } from "../sessions.js";
import { checkTunnelName, tunnelName, tunnelServerInfo } from "../tunnel-frp.js";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerTunnelRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { settings } = deps;
  /** What the configured (or given) Sessionboxer tunnel server says about itself, and the name this laptop would take there. */
  api.get("/tunnels/sessionboxer/server", async (c) => {
    const server = c.req.query("server")?.trim() || settings.get().tunnels.sessionboxer.server;
    const info = await tunnelServerInfo(server).catch((e: unknown) => {
      throw new HttpError(502, e instanceof Error ? e.message : String(e));
    });
    return c.json({ server, info, name: tunnelName(settings.get().tunnels.sessionboxer) });
  });

  api.get("/tunnels/sessionboxer/names/:name", async (c) => {
    const server = c.req.query("server")?.trim() || settings.get().tunnels.sessionboxer.server;
    const check = await checkTunnelName(server, c.req.param("name").trim().toLowerCase()).catch((e: unknown) => {
      throw new HttpError(502, e instanceof Error ? e.message : String(e));
    });
    return c.json(check);
  });
}
