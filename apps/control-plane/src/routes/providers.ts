// Providers: sign-in flows, and the models and options each one offers.
import { type Hono } from "hono";
import { Provider, ProviderLoginCodeRequest } from "@sessionboxer/protocol";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";
import { claudeHostSettingsUpdate } from "../claude-api-credential.js";

export function registerProviderRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { sessions, providerLogins, publicSettings, applySettings, claudeApiLogin } = deps;
  // The Claude API configuration of this machine's ~/.claude/settings.json (gateway URL, apiKeyHelper) copied into Settings (ADR-0090).
  api.post("/claude-api/import-host", async (c) => {
    await applySettings({ claudeApi: claudeHostSettingsUpdate() });
    return c.json(await publicSettings());
  });
  // The gateway's login command, for when its credential expired (ADR-0090): runs here, output goes back to the browser.
  api.post("/claude-api/login", (c) => c.json(claudeApiLogin.start()));
  api.get("/claude-api/login", (c) => c.json(claudeApiLogin.current()));
  api.delete("/claude-api/login", (c) => c.json(claudeApiLogin.cancel()));
  // Provider sign-in (ADR-0058): the CLI on this machine or in a throwaway container, the browser here, the code passed along.
  api.get("/providers/:provider/host-login", (c) => c.json(providerLogins.hostLogin(Provider.parse(c.req.param("provider")))));
  api.post("/providers/:provider/host-login/import", async (c) => {
    providerLogins.importHostLogin(Provider.parse(c.req.param("provider")));
    return c.json(await publicSettings());
  });
  api.post("/providers/:provider/login", (c) => c.json(providerLogins.start(Provider.parse(c.req.param("provider"))), 201));
  api.get("/providers/login/:id", (c) => c.json(providerLogins.get(c.req.param("id"))));
  api.post("/providers/login/:id/code", async (c) => {
    const { code } = ProviderLoginCodeRequest.parse(await c.req.json());
    return c.json(providerLogins.submit(c.req.param("id"), code));
  });
  api.delete("/providers/login/:id", (c) => {
    providerLogins.cancel(c.req.param("id"));
    return c.body(null, 204);
  });

  api.get("/models", (c) => c.json(sessions.providerModels()));
  api.get("/options", (c) => c.json(sessions.providerOptions()));
}
