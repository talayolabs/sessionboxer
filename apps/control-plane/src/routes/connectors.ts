// Connectors (ADR-0060): OAuth flows to the code hosts and the servers they connect.
import { type Hono } from "hono";
import { ConnectorKind, ConnectorStartRequest } from "@sessionboxer/protocol";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

export function registerConnectorRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { connectors, publicSettings } = deps;
  api.get("/connectors/github/gh", async (c) => c.json(await connectors.ghStatus()));
  api.post("/connectors/:kind/start", async (c) => {
    const kind = ConnectorKind.parse(c.req.param("kind"));
    const req = ConnectorStartRequest.parse(await c.req.json());
    return c.json(await connectors.start(kind, req), 201);
  });
  api.get("/connectors/flows/:id", (c) => c.json(connectors.get(c.req.param("id"))));
  api.post("/connectors/servers/:id/disconnect", async (c) => {
    connectors.disconnect(c.req.param("id"));
    return c.json(await publicSettings());
  });
  // Browser lands here after authorizing on the provider's site (redirect flow).
  api.get("/connectors/:kind/callback", async (c) => {
    const kind = ConnectorKind.parse(c.req.param("kind"));
    const result = await connectors.callback(kind, c.req.query());
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Sessionboxer</title>
<body style="font:15px system-ui;margin:3em auto;max-width:32em;text-align:center">
<h2>${result.ok ? "Connected" : "Login failed"}</h2><p>${escapeHtml(result.message)}</p>
<p style="color:#666">You can close this tab and go back to Sessionboxer.</p>
<script>setTimeout(function(){window.close()},1500)</script></body>`,
      result.ok ? 200 : 400,
    );
  });
}
