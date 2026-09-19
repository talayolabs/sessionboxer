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
  AskRequest,
  AttachPrRequest,
  CodeOpenParams,
  CompactionDetailsRequest,
  PrActionRequest,
  UpdatePrRequest,
  ConnectorKind,
  ConnectorStartRequest,
  CreateSessionRequest,
  ForkSessionRequest,
  RevertRequest,
  SwitchBranchRequest,
  FS_RAW_PATH,
  FS_UPLOAD_PATH,
  PromptAttachment,
  SyncRequest,
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
import { bridgeCodeSocket, codePrefix, codeTarget, forwardedHeaders, proxyCodeRequest } from "./code-proxy.js";
import { Connectors } from "./connectors.js";
import { Db } from "./db.js";
import { bridgeDesktop } from "./desktop-proxy.js";
import { SandboxDocker } from "./docker.js";
import { HostDirError, listHostDir } from "./host-dir.js";
import { HttpError, SessionManager } from "./sessions.js";
import { bridgeTerminal } from "./terminal-bridge.js";

const log = (msg: string): void => {
  process.stderr.write(`[control-plane ${new Date().toISOString()}] ${msg}\n`);
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

let settings = loadSettings();
const db = new Db(DB_FILE);
const docker = new SandboxDocker();
const sessions = new SessionManager(db, docker, () => settings, log);
const connectors = new Connectors(
  {
    get: () => settings,
    set: (next) => {
      settings = next;
      saveSettings(settings);
    },
  },
  (kind) => `http://${HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST}:${PORT}/api/connectors/${kind}/callback`,
  () => void sessions.pushMcpServersToAll(),
  log,
);

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
  if (update.mcpServers) void sessions.pushMcpServersToAll();
  if (update.claudeModels) void sessions.pushClaudeModelsToAll();
  if (update.recordingNarration) void sessions.pushRecordingPrefsToAll();
  return c.json(toPublicSettings(settings, await sessions.dockerModeAvailable()));
});

api.get("/connectors/github/gh", async (c) => c.json(await connectors.ghStatus()));
api.post("/connectors/:kind/start", async (c) => {
  const kind = ConnectorKind.parse(c.req.param("kind"));
  const req = ConnectorStartRequest.parse(await c.req.json());
  return c.json(await connectors.start(kind, req), 201);
});
api.get("/connectors/flows/:id", (c) => c.json(connectors.get(c.req.param("id"))));
api.post("/connectors/servers/:id/disconnect", async (c) => {
  connectors.disconnect(c.req.param("id"));
  return c.json(toPublicSettings(settings, await sessions.dockerModeAvailable()));
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

api.get("/host/dirs", async (c) => {
  try {
    return c.json(await listHostDir(c.req.query("path")));
  } catch (e) {
    if (e instanceof HostDirError) throw new HttpError(400, e.message);
    if (e instanceof Error && "code" in e && e.code === "EACCES") throw new HttpError(403, `Permission denied: ${c.req.query("path")}`);
    throw e;
  }
});

api.get("/models", (c) => c.json(sessions.providerModels()));
api.get("/options", (c) => c.json(sessions.providerOptions()));

api.get("/sessions", (c) => c.json(sessions.list()));
api.post("/sessions", async (c) => {
  const req = CreateSessionRequest.parse(await c.req.json());
  return c.json(await sessions.create(req), 201);
});
api.get("/sessions/:id", (c) => c.json(sessions.get(c.req.param("id"))));
api.patch("/sessions/:id", async (c) => {
  const req = UpdateSessionRequest.parse(await c.req.json());
  return c.json(await sessions.edit(c.req.param("id"), req));
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
  await sessions.prompt(c.req.param("id"), req);
  return c.json({ ok: true }, 202);
});
api.post("/sessions/:id/ask", async (c) => {
  const req = AskRequest.parse(await c.req.json());
  return c.json(await sessions.ask(c.req.param("id"), req.text));
});
api.post("/sessions/:id/context/report", async (c) => c.json(await sessions.contextReport(c.req.param("id"))));
api.post("/sessions/:id/context/compaction", async (c) => {
  const req = CompactionDetailsRequest.parse(await c.req.json());
  return c.json(await sessions.compactionDetails(c.req.param("id"), req));
});
api.get("/sessions/:id/llm-calls", async (c) => {
  const id = c.req.param("id");
  const { calls } = sessions.llmCalls(id);
  return c.json({ calls, withBodies: await sessions.llmCallsWithBodies(id) });
});
api.get("/sessions/:id/llm-calls/:callId", async (c) => c.json(await sessions.llmCallBody(c.req.param("id"), c.req.param("callId"))));
api.post("/sessions/:id/cancel", async (c) => {
  await sessions.cancel(c.req.param("id"));
  return c.json({ ok: true });
});
api.post("/sessions/:id/stop", async (c) => c.json(await sessions.stop(c.req.param("id"))));

// Conversation branches: "revert to here" keeps what followed as a branch; switch between them.
api.post("/sessions/:id/revert", async (c) => {
  const req = RevertRequest.parse(await c.req.json());
  return c.json(await sessions.revert(c.req.param("id"), req.seq));
});
api.post("/sessions/:id/branch", async (c) => {
  const req = SwitchBranchRequest.parse(await c.req.json());
  return c.json(await sessions.switchBranch(c.req.param("id"), req.branchId));
});

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

// Pull Requests attached to the Session (ADR-0027).
api.get("/sessions/:id/prs", (c) => c.json(sessions.prs.list(c.req.param("id"))));
api.post("/sessions/:id/prs", async (c) => {
  const req = AttachPrRequest.parse(await c.req.json());
  return c.json(await sessions.prs.attach(c.req.param("id"), req.ref, "manual"), 201);
});
api.get("/sessions/:id/prs/:prId/items", (c) => c.json(sessions.prs.items(c.req.param("id"), c.req.param("prId"))));
api.patch("/sessions/:id/prs/:prId", async (c) => {
  const req = UpdatePrRequest.parse(await c.req.json());
  return c.json(sessions.prs.update(c.req.param("id"), c.req.param("prId"), req));
});
api.delete("/sessions/:id/prs/:prId", (c) => {
  sessions.prs.detach(c.req.param("id"), c.req.param("prId"));
  return c.body(null, 204);
});
api.post("/sessions/:id/prs/:prId/refresh", async (c) => c.json(await sessions.prs.refresh(c.req.param("id"), c.req.param("prId"))));
api.post("/sessions/:id/prs/:prId/seen", (c) => {
  sessions.prs.markSeen(c.req.param("id"), c.req.param("prId"));
  return c.body(null, 204);
});
api.post("/sessions/:id/prs/actions", async (c) => {
  const req = PrActionRequest.parse(await c.req.json());
  return c.json(await sessions.prs.action(c.req.param("id"), req));
});

// Snapshots (`docker commit` of the Sandbox) and forks started from them.
api.get("/sessions/:id/snapshots", (c) => c.json(sessions.snapshots(c.req.param("id"))));
api.post("/sessions/:id/snapshots", async (c) => c.json(await sessions.snapshot(c.req.param("id"), "manual"), 201));
api.delete("/sessions/:id/snapshots", async (c) => c.json(await sessions.deleteAllSnapshots(c.req.param("id"))));
api.delete("/sessions/:id/snapshots/:snapshotId", async (c) => {
  await sessions.deleteSnapshot(c.req.param("id"), c.req.param("snapshotId"));
  return c.body(null, 204);
});
// Moves the Session onto a new Sandbox built from a full image of the current one (long: minutes).
api.post("/sessions/:id/rebuild", async (c) => c.json(await sessions.rebuild(c.req.param("id"))));
api.post("/sessions/:id/fork", async (c) => {
  const req = ForkSessionRequest.parse(await c.req.json());
  return c.json(await sessions.fork(c.req.param("id"), req), 201);
});

// "Pull changes to my folder" for Sessions started from a copy of a host folder: GET is the
// dry run, POST applies it (conflicting files only with `overwriteLocal`).
api.get("/sessions/:id/sync", async (c) => c.json(await sessions.syncPlan(c.req.param("id"))));
api.post("/sessions/:id/sync", async (c) => {
  const req = SyncRequest.parse(await c.req.json());
  return c.json(await sessions.syncPull(c.req.param("id"), req));
});
// Raw bytes of a Workspace file (videos, images, PDFs the Agent produced), streamed from the
// Daemon with Range support so the browser's <video> can seek; `download=1` for an attachment.
api.on(["GET", "HEAD"], "/sessions/:id/fs/raw", async (c) => {
  const base = await sessions.daemonHttpUrl(c.req.param("id"));
  const target = new URL(FS_RAW_PATH, base);
  target.searchParams.set("path", c.req.query("path") ?? "");
  if (c.req.query("download")) target.searchParams.set("download", "1");
  const headers: Record<string, string> = {};
  const range = c.req.header("range");
  if (range) headers.range = range;
  const upstream = await fetch(target, { method: c.req.method, headers });
  const passed = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "last-modified", "cache-control"]) {
    const v = upstream.headers.get(name);
    if (v) passed.set(name, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: passed });
});

// A file for the next prompt: bytes in the body, stored by the Daemon under the Workspace's
// uploads folder; answers with the `PromptAttachment` to put on `POST /sessions/:id/prompt`.
api.put("/sessions/:id/uploads", async (c) => {
  const base = await sessions.daemonHttpUrl(c.req.param("id"));
  const target = new URL(FS_UPLOAD_PATH, base);
  target.searchParams.set("name", c.req.query("name") ?? "");
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "content-length"]) {
    const v = c.req.header(name);
    if (v) headers[name] = v;
  }
  const upstream = await fetch(target, { method: "PUT", headers, body: c.req.raw.body, ...{ duplex: "half" as const } }).catch(() => {
    throw new HttpError(503, "The Sandbox is still starting; retry the upload in a moment.");
  });
  if (!upstream.ok) return c.json({ error: (await upstream.text()) || `upload failed (${upstream.status})` }, upstream.status === 413 || upstream.status === 400 ? upstream.status : 502);
  return c.json(PromptAttachment.parse(await upstream.json()), 201);
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

// Code pane: VS Code (openvscode-server) inside the Sandbox. Lifecycle under /code-server;
// the workbench itself, assets and its WebSocket are proxied under /code/* with the browser
// prefix forwarded, which is what the pane's iframe loads.
api.post("/sessions/:id/code-server", async (c) => c.json(await sessions.codeStart(c.req.param("id"))));
api.get("/sessions/:id/code-server", async (c) => c.json(await sessions.codeStatus(c.req.param("id"))));
api.delete("/sessions/:id/code-server", async (c) => c.json(await sessions.codeStop(c.req.param("id"))));
api.post("/sessions/:id/code-server/open", async (c) => {
  await sessions.codeOpen(c.req.param("id"), CodeOpenParams.parse(await c.req.json()));
  return c.json({ ok: true });
});
const forwardedFor = (c: { req: { header: (name: string) => string | undefined } }, id: string): Record<string, string> =>
  forwardedHeaders(codePrefix(id), c.req.header("x-forwarded-host") ?? c.req.header("host"), c.req.header("x-forwarded-proto") ?? "http");
api.get(
  "/sessions/:id/code/*",
  upgradeWebSocket(async (c) => {
    const id = c.req.param("id") ?? "";
    const target = codeTarget(await sessions.daemonHttpUrl(id), codePrefix(id), new URL(c.req.url));
    const forwarded = forwardedFor(c, id);
    const protocols = c.req.header("sec-websocket-protocol");
    return {
      onOpen(_evt, ws) {
        if (!ws.raw) return;
        bridgeCodeSocket(ws.raw, target, forwarded, protocols, log);
      },
      onError(err) {
        log(`code ws error: ${String(err)}`);
      },
    };
  }),
);
api.all("/sessions/:id/code", async (c) => {
  const id = c.req.param("id");
  return proxyCodeRequest(c.req.raw, codeTarget(await sessions.daemonHttpUrl(id), codePrefix(id), new URL(c.req.url)), forwardedFor(c, id));
});
api.all("/sessions/:id/code/*", async (c) => {
  const id = c.req.param("id");
  return proxyCodeRequest(c.req.raw, codeTarget(await sessions.daemonHttpUrl(id), codePrefix(id), new URL(c.req.url)), forwardedFor(c, id));
});

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
  const exit = (): void => {
    db.close();
    server.close();
    process.exit(0);
  };
  sessions.shutdown().then(exit, exit);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// A background task that fails without a handler must not take the whole Control Plane down.
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
process.on("uncaughtException", (e) => {
  log(`uncaught exception: ${e.stack ?? e.message}`);
});
