#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { ZodError } from "zod";
import {
  CreateSessionRequest,
  PromptRequest,
  UpdateSessionRequest,
  UpdateSettingsRequest,
} from "@sessionboxer/protocol";
import {
  DB_FILE,
  HOST,
  PORT,
  applySettingsUpdate,
  loadSettings,
  saveSettings,
  toPublicSettings,
} from "./config.js";
import { Db } from "./db.js";
import { bridgeDesktop } from "./desktop-proxy.js";
import { SandboxDocker } from "./docker.js";
import { HttpError, SessionManager } from "./sessions.js";

const log = (msg: string): void => {
  process.stderr.write(`[control-plane ${new Date().toISOString()}] ${msg}\n`);
};

let settings = loadSettings();
const db = new Db(DB_FILE);
const docker = new SandboxDocker();
const sessions = new SessionManager(db, docker, () => settings, log);

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof ZodError) return c.json({ error: err.issues.map((i) => i.message).join("; ") }, 400);
  log(`unhandled: ${err.stack ?? err.message}`);
  return c.json({ error: err.message }, 500);
});

const api = new Hono();

api.get("/health", (c) => c.json({ ok: true }));

api.get("/settings", (c) => c.json(toPublicSettings(settings)));
api.put("/settings", async (c) => {
  const update = UpdateSettingsRequest.parse(await c.req.json());
  settings = applySettingsUpdate(settings, update);
  saveSettings(settings);
  return c.json(toPublicSettings(settings));
});

api.get("/sessions", (c) => c.json(sessions.list()));
api.post("/sessions", async (c) => {
  const req = CreateSessionRequest.parse(await c.req.json());
  return c.json(await sessions.create(req), 201);
});
api.get("/sessions/:id", (c) => c.json(sessions.get(c.req.param("id"))));
api.patch("/sessions/:id", async (c) => {
  const req = UpdateSessionRequest.parse(await c.req.json());
  return c.json(sessions.rename(c.req.param("id"), req.title));
});
api.delete("/sessions/:id", async (c) => {
  await sessions.delete(c.req.param("id"));
  return c.body(null, 204);
});
api.get("/sessions/:id/events", (c) => {
  const after = Number(c.req.query("after") ?? 0);
  return c.json(sessions.events(c.req.param("id"), Number.isFinite(after) ? after : 0));
});
api.post("/sessions/:id/prompt", async (c) => {
  const req = PromptRequest.parse(await c.req.json());
  await sessions.prompt(c.req.param("id"), req.text);
  return c.json({ ok: true }, 202);
});
api.post("/sessions/:id/cancel", async (c) => {
  await sessions.cancel(c.req.param("id"));
  return c.json({ ok: true });
});
api.post("/sessions/:id/stop", async (c) => c.json(await sessions.stop(c.req.param("id"))));
api.post("/sessions/:id/resume", async (c) => c.json(await sessions.resume(c.req.param("id"))));

// noVNC endpoint for the UI: a plain RFB-over-WebSocket stream, proxied to the Sandbox.
api.get(
  "/sessions/:id/desktop",
  upgradeWebSocket(async (c) => {
    const target = await sessions.desktopUrl(c.req.param("id") ?? "");
    return {
      onOpen(_evt, ws) {
        if (!ws.raw) return;
        bridgeDesktop(ws.raw, target, log);
      },
      onError(err) {
        log(`desktop ws error: ${String(err)}`);
      },
    };
  }),
);

api.get(
  "/ws",
  upgradeWebSocket(() => {
    let unsubscribe: (() => void) | null = null;
    return {
      onOpen(_evt, ws) {
        unsubscribe = sessions.subscribe((msg) => ws.send(JSON.stringify(msg)));
      },
      onClose() {
        unsubscribe?.();
      },
      onError(err) {
        log(`ui ws error: ${String(err)}`);
      },
    };
  }),
);

app.route("/api", api);

// Production: serve the built web UI from apps/web/dist; in dev, Vite proxies /api.
const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: webDist }));
  app.get("*", serveStatic({ root: webDist, path: "index.html" }));
}

await sessions.boot();
const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  log(`listening on http://${info.address}:${info.port}`);
});
injectWebSocket(server);

const shutdown = (): void => {
  log("shutting down");
  void sessions.shutdown().finally(() => {
    db.close();
    server.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
