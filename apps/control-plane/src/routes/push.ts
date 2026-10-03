// Web Push subscriptions of the logged-in browsers.
import { type Hono } from "hono";
import { PushSubscribeRequest } from "@sessionboxer/protocol";
import { HttpError } from "../sessions.js";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerPushRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { push } = deps;
  // Web Push: one subscription per device (the browser's PushManager gives it), gone with the device.
  api.get("/push", (c) => {
    const p = c.get("principal");
    return c.json(push.status(p.kind === "device" ? p.device.id : null));
  });
  api.put("/push", async (c) => {
    const p = c.get("principal");
    if (p.kind !== "device") throw new HttpError(403, "Only a logged-in browser can subscribe to notifications.");
    push.subscribe(p.device.id, PushSubscribeRequest.parse(await c.req.json()));
    return c.json(push.status(p.device.id));
  });
  api.delete("/push", (c) => {
    const p = c.get("principal");
    if (p.kind !== "device") throw new HttpError(403, "Only a logged-in browser can unsubscribe.");
    push.unsubscribe(p.device.id);
    return c.json(push.status(p.device.id));
  });
  api.post("/push/test", (c) => {
    const p = c.get("principal");
    if (p.kind !== "device") throw new HttpError(403, "Only a logged-in browser can test its notifications.");
    if (!push.status(p.device.id).subscribed) throw new HttpError(409, "This browser is not subscribed.");
    push.send({ title: "Sessionboxer", body: "Notifications reach this device.", tag: "sessionboxer-test", url: "#/settings" }, p.device.id);
    return c.body(null, 204);
  });
}
