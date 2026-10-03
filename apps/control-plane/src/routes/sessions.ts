// Sessions: lifecycle, conversation, snapshots, repositories, and everything proxied into the Sandbox (ADR-0005).
import { type Hono } from "hono";
import {
  AskRequest,
  AgentApprovalAnswer,
  AutoContinueRequest,
  AttachPrRequest,
  AddRepoRequest,
  UpdateRepoRequest,
  CodeOpenParams,
  CodeStartParams,
  CodeThemeParams,
  CompactionDetailsRequest,
  DaemonMcpAppsCallToolParams,
  DaemonMcpAppsReadResourceParams,
  DaemonMcpAppsResourceParams,
  PrActionRequest,
  UpdatePrRequest,
  CreateSessionRequest,
  ForkSessionRequest,
  RevertRequest,
  SwitchBranchRequest,
  FS_APP_PATH,
  FS_RAW_PATH,
  FS_UPLOAD_PATH,
  FsWatchParams,
  htmlAppCsp,
  PromptAttachment,
  SyncRequest,
  PromptRequest,
  PtyOpenParams,
  QueueRequest,
  SaveMessageRequest,
  UpdateSavedMessageRequest,
  UpdateSessionRequest,
  UsbConnectRequest,
} from "@sessionboxer/protocol";
import { bridgeCodeSocket, codePrefix, codeTarget, forwardedHeaders, proxyCodeRequest } from "../code-proxy.js";
import { bridgeDesktop } from "../desktop-proxy.js";
import { log } from "../log.js";
import { HttpError } from "../sessions.js";
import { bridgeTerminal } from "../terminal-bridge.js";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerSessionRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { sessions, settings, upgradeWebSocket } = deps;
  // Files attached on the New session screen, before a Sandbox exists to put them in (see StagedUploads).
  api.put("/uploads", async (c) => c.json(await sessions.staged.store(c.req.raw.body, c.req.query("name") ?? "", c.req.header("content-type"), c.req.header("content-length")), 201));
  api.delete("/uploads/:id", async (c) => {
    await sessions.staged.remove(c.req.param("id"));
    return c.body(null, 204);
  });

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
  // MCP Apps (ADR-0079): the views of the Session's MCP tool calls, from the Daemon's tee mirror.
  api.get("/sessions/:id/mcp-apps/resource", async (c) => {
    const params = DaemonMcpAppsResourceParams.parse({ server: c.req.query("server"), uri: c.req.query("uri") });
    return c.json(await sessions.mcpAppResource(c.req.param("id"), params));
  });
  api.get("/sessions/:id/mcp-apps/tool-results/:toolCallId", async (c) =>
    c.json(await sessions.mcpAppToolResult(c.req.param("id"), { toolCallId: c.req.param("toolCallId") })),
  );
  api.post("/sessions/:id/mcp-apps/call-tool", async (c) => {
    const params = DaemonMcpAppsCallToolParams.parse(await c.req.json());
    return c.json(await sessions.mcpAppCallTool(c.req.param("id"), params));
  });
  api.post("/sessions/:id/mcp-apps/read-resource", async (c) => {
    const params = DaemonMcpAppsReadResourceParams.parse(await c.req.json());
    return c.json(await sessions.mcpAppReadResource(c.req.param("id"), params));
  });

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

  // The queue: enqueued messages, sent one turn at a time whenever the Agent is idle.
  api.get("/sessions/:id/saved", (c) => c.json(sessions.savedMessages(c.req.param("id"))));
  api.post("/sessions/:id/saved", async (c) => {
    const req = SaveMessageRequest.parse(await c.req.json());
    return c.json(await sessions.enqueueMessage(c.req.param("id"), req.text), 201);
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

  // Usage limits (ADR-0053): continue the turn the Provider refused; poll for it every 10 s.
  api.post("/sessions/:id/usage/continue", async (c) => c.json(await sessions.continueAfterLimit(c.req.param("id"))));
  api.post("/sessions/:id/usage/auto-continue", async (c) => {
    const req = AutoContinueRequest.parse(await c.req.json());
    return c.json(sessions.setAutoContinue(c.req.param("id"), req.enabled));
  });

  // The Agent asked for permission through the `sessionboxer` MCP (ADR-0062): the chat card's Allow / Deny.
  api.post("/sessions/:id/approvals/:approvalId", async (c) => {
    const req = AgentApprovalAnswer.parse(await c.req.json());
    return c.json(await sessions.agentTools.settleApproval(c.req.param("id"), c.req.param("approvalId"), req.allow));
  });

  // End-to-end verification runs of the Session (ADR-0044).
  api.get("/sessions/:id/e2e", (c) => c.json(sessions.e2e.list(c.req.param("id"))));
  api.post("/sessions/:id/e2e/run", async (c) => c.json(await sessions.e2eRunNow(c.req.param("id")), 201));
  api.get("/sessions/:id/e2e/:runId", (c) => c.json(sessions.e2e.get(c.req.param("id"), c.req.param("runId"))));

  // Pull Requests attached to the Session (ADR-0027).
  api.get("/sessions/:id/prs", (c) => c.json(sessions.prs.list(c.req.param("id"))));
  api.post("/sessions/:id/prs", async (c) => {
    const req = AttachPrRequest.parse(await c.req.json());
    return c.json(await sessions.prs.attach(c.req.param("id"), req.ref, "manual"), 201);
  });
  api.get("/sessions/:id/prs/:prId/items", (c) => c.json(sessions.prs.items(c.req.param("id"), c.req.param("prId"))));
  api.get("/sessions/:id/prs/:prId/checks", (c) => c.json(sessions.prs.checks(c.req.param("id"), c.req.param("prId"))));
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

  // The newest Snapshots of every Session, for the "start from a snapshot" pickers (ADR-0069).
  api.get("/snapshots/recent", (c) =>
    c.json(
      sessions.recentSnapshots(
        (c.req.query("include") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      ),
    ),
  );

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

  // USB devices of the host (ADR-0055): one Session per device; connecting takes it from the Session that had it.
  api.get("/usb", async (c) => c.json(await sessions.usb.host()));
  api.post("/sessions/:id/usb", async (c) => {
    const req = UsbConnectRequest.parse(await c.req.json());
    return c.json(await sessions.usb.connect(c.req.param("id"), req.deviceId));
  });
  api.delete("/sessions/:id/usb", async (c) => c.json(await sessions.usb.disconnect(c.req.param("id"))));

  // Repositories of a running Session: add clones/copies into /workspace/<name> right away; remove
  // answers 409 with the Git state when the directory holds unpushed work (repeat with `force`).
  api.post("/sessions/:id/repos", async (c) => {
    const req = AddRepoRequest.parse(await c.req.json());
    return c.json(await sessions.addRepo(c.req.param("id"), req), 201);
  });
  api.patch("/sessions/:id/repos/:repoId", async (c) => {
    const req = UpdateRepoRequest.parse(await c.req.json());
    return c.json(await sessions.updateRepo(c.req.param("id"), c.req.param("repoId"), req));
  });
  api.delete("/sessions/:id/repos/:repoId", async (c) => {
    const force = c.req.query("force") === "1" || c.req.query("force") === "true";
    const result = await sessions.removeRepo(c.req.param("id"), c.req.param("repoId"), force);
    if (!result.ok) return c.json(result.blocked, 409);
    return c.body(null, 204);
  });

  // "Pull changes to my folder" for repositories copied from a host folder: GET is the dry run,
  // POST applies it (conflicting files only with `overwriteLocal`). `repoId` picks the folder
  // when the Session copied more than one.
  api.get("/sessions/:id/sync", async (c) => c.json(await sessions.syncPlan(c.req.param("id"), c.req.query("repoId"))));
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
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "last-modified", "cache-control", "x-content-type-options"]) {
      const v = upstream.headers.get(name);
      if (v) passed.set(name, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: passed });
  });

  // A self-contained HTML file of the Workspace, run as a sandboxed Artifact (ADR-0078): same Daemon
  // access as /fs/raw, but the response carries the Artifact CSP (its `sandbox` directive makes the
  // document's origin opaque wherever it is opened, and its sources are the configured CDN allowlist)
  // and the Daemon refuses files over 16 MiB. Not a download: `.html` on /fs/raw is an attachment.
  api.on(["GET", "HEAD"], "/sessions/:id/fs/app", async (c) => {
    const base = await sessions.daemonHttpUrl(c.req.param("id"));
    const target = new URL(FS_APP_PATH, base);
    target.searchParams.set("path", c.req.query("path") ?? "");
    const upstream = await fetch(target, { method: c.req.method });
    const passed = new Headers();
    for (const name of ["content-type", "content-length", "last-modified", "cache-control"]) {
      const v = upstream.headers.get(name);
      if (v) passed.set(name, v);
    }
    if (upstream.ok) {
      passed.set("content-security-policy", htmlAppCsp(settings.get().htmlAppCdns));
      passed.set("x-content-type-options", "nosniff");
      passed.set("referrer-policy", "no-referrer");
    }
    return new Response(upstream.body, { status: upstream.status, headers: passed });
  });
  // The App pane asks to be told when its Artifact changes; the Daemon answers with `fs_changed` broadcasts.
  api.post("/sessions/:id/fs/watch", async (c) => {
    await sessions.fsWatch(c.req.param("id"), FsWatchParams.parse(await c.req.json()));
    return c.json({ ok: true });
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
  api.post("/sessions/:id/code-server", async (c) => {
    const params = CodeStartParams.parse(await c.req.json().catch(() => ({})));
    return c.json(await sessions.codeStart(c.req.param("id"), params));
  });
  api.get("/sessions/:id/code-server", async (c) => c.json(await sessions.codeStatus(c.req.param("id"))));
  api.delete("/sessions/:id/code-server", async (c) => c.json(await sessions.codeStop(c.req.param("id"))));
  api.post("/sessions/:id/code-server/theme", async (c) => {
    await sessions.codeTheme(c.req.param("id"), CodeThemeParams.parse(await c.req.json()));
    return c.json({ ok: true });
  });
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
}
