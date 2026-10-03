// Access (ADR-0045): who may talk to this Control Plane, its devices and the access token.
import { type Hono } from "hono";
import { AuthLoginRequest, AuthPairRedeemRequest } from "@sessionboxer/protocol";
import { accessToken, accessTokenSource, newAccessToken } from "../config.js";
import { Auth, type AuthEnv } from "../auth.js";
import { log } from "../log.js";
import { HttpError } from "../sessions.js";
import { type RouteDeps } from "./deps.js";

export function registerAuthRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { auth, settings } = deps;
  api.get("/auth/me", (c) => c.json({ principal: c.get("principal") ?? null }));
  api.post("/auth/login", async (c) => {
    const req = AuthLoginRequest.parse(await c.req.json());
    const res = auth.login(req.token, req.name, auth.clientInfo(c));
    c.header("set-cookie", res.cookie);
    return c.json(res.device, 201);
  });
  api.post("/auth/pair", (c) => c.json(auth.createPairing(), 201));
  api.post("/auth/pair/redeem", async (c) => {
    const req = AuthPairRedeemRequest.parse(await c.req.json());
    const res = auth.redeemPairing(req.code, req.name, auth.clientInfo(c));
    c.header("set-cookie", res.cookie);
    return c.json(res.device, 201);
  });
  api.post("/auth/logout", (c) => {
    const p = c.get("principal");
    if (p.kind === "device") auth.revoke(p.device.id);
    c.header("set-cookie", Auth.clearCookie(auth.clientInfo(c).secure));
    return c.body(null, 204);
  });
  api.get("/auth/devices", (c) => {
    const p = c.get("principal");
    return c.json(auth.devices(p.kind === "device" ? p.device.id : null));
  });
  api.delete("/auth/devices/:id", (c) => {
    auth.revoke(c.req.param("id"));
    return c.body(null, 204);
  });

  api.get("/auth/token", (c) => c.json({ token: accessToken(settings.get()) }));
  // A new token: every other browser has to log in again; the caller keeps its cookie and sees the token once.
  api.post("/auth/token/rotate", (c) => {
    if (accessTokenSource() === "env") throw new HttpError(409, "The access token comes from SESSIONBOXER_ACCESS_TOKEN; change it there.");
    const p = c.get("principal");
    settings.set({ ...settings.get(), accessToken: newAccessToken() });
    const keep = p.kind === "device" ? p.device.id : null;
    for (const d of auth.devices(keep)) if (!d.current) auth.revoke(d.id);
    log("access token rotated");
    return c.json({ token: settings.get().accessToken });
  });
}
