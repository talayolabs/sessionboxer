// Health, the Sandbox image and the host's folders: what the Control Plane itself answers about this machine.
import { type Hono } from "hono";
import { HostDirError, listHostDir } from "../host-dir.js";
import { parseImageSelector } from "../sandbox-images.js";
import { sandboxImage } from "../config.js";
import { HttpError } from "../sessions.js";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerSystemRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { docker } = deps;
  api.get("/health", (c) => c.json({ ok: true }));

  // `?provider=<id>|base` picks the image (ADR-0088); GET only looks, nothing downloads until something needs the image.
  api.get("/sandbox-image", async (c) => c.json(await docker.images.inspect(sandboxImage(parseImageSelector(c.req.query("provider"))))));
  // Starts the pull ahead of a Session, or retries one that failed (a network drop, a registry outage); a no-op while one runs or once the image is here.
  api.post("/sandbox-image/pull", async (c) => c.json(await docker.images.prefetch(sandboxImage(parseImageSelector(c.req.query("provider"))))));

  api.get("/host/dirs", async (c) => {
    try {
      return c.json(await listHostDir(c.req.query("path")));
    } catch (e) {
      if (e instanceof HostDirError) throw new HttpError(400, e.message);
      if (e instanceof Error && "code" in e && e.code === "EACCES") throw new HttpError(403, `Permission denied: ${c.req.query("path")}`);
      throw e;
    }
  });
}
