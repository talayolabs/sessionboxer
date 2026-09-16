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
  ForkSessionRequest,
  FsWriteParams,
  PromptRequest,
  PtyOpenParams,
  QueueRequest,
  SaveMessageRequest,
  UpdateSavedMessageRequest,
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
import { HostDirError, listHostDir } from "./host-dir.js";
import { HttpError, SessionManager } from "./sessions.js";
import { bridgeTerminal } from "./terminal-bridge.js";

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

api.get("/settings", async (c) => c.json(toPublicSettings(settings, await sessions.dockerModeAvailable())));
api.put("/settings", async (c) => {
  const update = UpdateSettingsRequest.parse(await c.req.json());
  settings = applySettingsUpdate(settings, update);
  saveSettings(settings);
  return c.json(toPublicSettings(settings, await sessions.dockerModeAvailable()));
});

api.get("/host/dirs", async (c) => {
  try {
    return c.json(await listHostDir(c.req.query("path")));
  } catch (e) {
    if (e instanceof HostDirError) throw new HttpError(400, e.message);
    if (e instanceof Error && "code" in e && e.code === "EACCES") throw new HttpError(403, `Permission denied: ${c.req.query("path")}`);
    throw e;
  }
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

// Saved messages ("save for later") and the queue that plays them one turn at a time.
api.get("/sessions/:id/saved", (c) => c.json(sessions.savedMessages(c.req.param("id"))));
api.post("/sessions/:id/saved", async (c) => {
  const req = SaveMessageRequest.parse(await c.req.json());
  return c.json(sessions.saveMessage(c.req.param("id"), req.text), 201);
});
api.patch("/sessions/:id/saved/:messageId", async (c) => {
  const req = UpdateSavedMessageRequest.parse(await c.req.json());
  return c.json(sessions.updateSavedMessage(c.req.param("id"), c.req.param("messageId"), req));
});
api.delete("/sessions/:id/saved/:messageId", (c) => {
  sessions.deleteSavedMessage(c.req.param("id"), c.req.param("messageId"));
  return c.body(null, 204);
});
api.post("/sessions/:id/saved/:messageId/send", async (c) => {
  await sessions.sendSavedMessage(c.req.param("id"), c.req.param("messageId"));
  return c.json({ ok: true }, 202);
});
api.post("/sessions/:id/queue", async (c) => {
  const req = QueueRequest.parse(await c.req.json());
  return c.json(await sessions.setQueueRunning(c.req.param("id"), req.running));
});

// Snapshots (`docker commit` of the Sandbox) and forks started from them.
api.get("/sessions/:id/snapshots", (c) => c.json(sessions.snapshots(c.req.param("id"))));
api.post("/sessions/:id/snapshots", async (c) => c.json(await sessions.snapshot(c.req.param("id"), "manual"), 201));
api.delete("/sessions/:id/snapshots/:snapshotId", async (c) => {
  await sessions.deleteSnapshot(c.req.param("id"), c.req.param("snapshotId"));
  return c.body(null, 204);
});
api.post("/sessions/:id/fork", async (c) => {
  const req = ForkSessionRequest.parse(await c.req.json());
  return c.json(await sessions.fork(c.req.param("id"), req), 201);
});

// Workspace files, relative to the Workspace root (`path=` empty or missing for the root).
api.get("/sessions/:id/fs", async (c) => c.json(await sessions.fsList(c.req.param("id"), c.req.query("path") ?? "")));
api.get("/sessions/:id/fs/file", async (c) => c.json(await sessions.fsRead(c.req.param("id"), c.req.query("path") ?? "")));
api.put("/sessions/:id/fs/file", async (c) => {
  const req = FsWriteParams.parse(await c.req.json());
  return c.json(await sessions.fsWrite(c.req.param("id"), req.path, req.content));
});

// Terminals: shells in the Workspace, owned by the Daemon. The WebSocket carries
// raw bytes as binary frames and JSON control messages as text frames.
api.get("/sessions/:id/terminals", async (c) => c.json(await sessions.terminalList(c.req.param("id"))));
api.post("/sessions/:id/terminals", async (c) => {
  const req = PtyOpenParams.parse(await c.req.json());
  return c.json(await sessions.terminalOpen(c.req.param("id"), req.cols, req.rows), 201);
});
api.delete("/sessions/:id/terminals/:ptyId", async (c) => {
  await sessions.terminalClose(c.req.param("id"), c.req.param("ptyId"));
  return c.body(null, 204);
});
api.get(
  "/sessions/:id/terminals/:ptyId/ws",
  upgradeWebSocket((c) => {
    const id = c.req.param("id") ?? "";
    const ptyId = c.req.param("ptyId") ?? "";
    return {
      onOpen(_evt, ws) {
        if (!ws.raw) return;
        void bridgeTerminal(ws.raw, sessions, id, ptyId, log);
      },
      onError(err) {
        log(`terminal ws error: ${String(err)}`);
      },
    };
  }),
);

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
