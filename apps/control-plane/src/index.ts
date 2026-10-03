#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { ZodError } from "zod";
import { PAIR_FRAGMENT_KEY, PAIRING_TTL_MS, UpdateSettingsRequest } from "@sessionboxer/protocol";
import {
  CONFIG_FILE,
  DB_FILE,
  HOST,
  LOCAL_ORIGIN,
  PORT,
  PUBLIC_URL,
  TLS,
  TLS_CERT_FILE,
  TLS_KEY_FILE,
  TRUST_PROXY,
  VERSION,
  accessToken,
  accessTokenSource,
  applySettingsUpdate,
  ensureAccessToken,
  ensureTunnelSecret,
  ensureVapidKeys,
  loadSettings,
  remoteAccess,
  resolveBoxCredentials,
  saveSettings,
  toPublicSettings,
} from "./config.js";
import { Auth, type AuthEnv } from "./auth.js";
import { applyTrustedCas, trustedCaBundle } from "./ca-certs.js";
import { Connectors } from "./connectors.js";
import { Db } from "./db.js";
import { PROVIDER_AUTH, providersAuthChangedBy } from "./provider-auth.js";
import { SandboxDocker } from "./docker.js";
import { findDockerEngine, noDockerAdvice } from "./docker-engine.js";
import { banner, log } from "./log.js";
import { HostOrSandboxRunner, ProviderLogins } from "./provider-login.js";
import { PushNotifier } from "./push.js";
import { Automations } from "./automations.js";
import { FollowedPrs } from "./followed-prs.js";
import { McpEvents } from "./mcp-events.js";
import { PrReviews } from "./pr-reviews.js";
import { PrQa } from "./pr-qa.js";
import { HttpError, SessionManager } from "./sessions.js";
import { WindowsVms } from "./windows.js";
import { MacosVms } from "./macos.js";
import { Speech } from "./speech.js";
import { Tunnels } from "./tunnels.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerMcpEventRoutes } from "./routes/mcp-events.js";
import { registerConnectorRoutes } from "./routes/connectors.js";
import { registerFolderRoutes } from "./routes/folders.js";
import { registerPrHookRoute, registerPrRoutes } from "./routes/prs.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerPushRoutes } from "./routes/push.js";
import { registerRepositoryRoutes } from "./routes/repositories.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSpeechRoutes } from "./routes/speech.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTunnelRoutes } from "./routes/tunnels.js";
import { registerVmBaseRoutes } from "./routes/vm-bases.js";
import { registerWsRoutes } from "./routes/ws.js";
import { type RouteDeps } from "./routes/deps.js";

const WS_PING_MS = 25_000;

let settings = ensureTunnelSecret(ensureVapidKeys(ensureAccessToken(loadSettings())));
{
  const added = applyTrustedCas(settings);
  if (added > 0) log(`trusting ${added} CA certificate${added === 1 ? "" : "s"} from this machine beyond the public ones`);
  if (added < 0) log(`Node ${process.version} cannot add this machine's CAs to its TLS clients; use NODE_EXTRA_CA_CERTS or Node >= 22.20`);
}
// Docker is checked before anything else is set up, so a missing or stopped engine ends in one
// readable message instead of a dockerode stack trace from the first API call.
const engine = findDockerEngine();
if (!engine) {
  banner(noDockerAdvice());
  process.exit(1);
}
if (engine.dockerHost) process.env.DOCKER_HOST = engine.dockerHost;
const db = new Db(DB_FILE);
const docker = new SandboxDocker();
try {
  await docker.docker.ping();
  log(`docker engine: ${engine.where}`);
} catch (e) {
  banner([
    `Docker at ${engine.where} is not answering: ${e instanceof Error ? e.message : String(e)}`,
    "",
    process.platform === "darwin"
      ? "Open OrbStack or Docker Desktop and wait until it says it is running, then run this command again."
      : "Is the Docker daemon running, and can this user use it? (sudo usermod -aG docker $USER, then log out and in)",
    "Another engine? DOCKER_HOST=unix:///path/to/docker.sock sessionboxer serve",
  ]);
  process.exit(1);
}
const push = new PushNotifier(
  db.connection,
  () => {
    if (!settings.vapid) throw new Error("no VAPID keys");
    return settings.vapid;
  },
  log,
);
const windows = new WindowsVms(
  docker.docker,
  () => settings,
  (next) => {
    settings = next;
    saveSettings(settings);
  },
  () => db.listSessions().filter((s) => s.settings.sandbox.environment === "qemu-windows").length,
  (status) => sessions.notify({ type: "windows_base", status }),
);
const macos = new MacosVms(
  docker,
  () => settings,
  (next) => {
    settings = next;
    saveSettings(settings);
  },
  () => db.listSessions().filter((s) => s.settings.sandbox.environment === "qemu-macos").length,
  (status) => sessions.notify({ type: "macos_base", status }),
);
const sessions = new SessionManager(db, docker, windows, macos, () => settings, log, (msg) => push.send(msg));
// Codex, Cursor, pi, OpenCode, fx and GitHub Copilot rotate their tokens inside the Sandbox; the rewritten login file
// replaces the stored one (unless it is older than what another Sandbox already sent, or the stored
// login is an API key) and reaches the other Sessions of that Agent.
sessions.providerAuthRefreshed = (provider, sessionId, authJson) => {
  const sync = PROVIDER_AUTH[provider];
  if (!sync.newer(authJson, sync.stored(settings))) return;
  try {
    settings = applySettingsUpdate(settings, sync.storeUpdate(authJson));
  } catch (e) {
    log(`${provider} auth from session ${sessionId} ignored: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  saveSettings(settings);
  log(`${provider} login refreshed by session ${sessionId}; stored`);
  void sessions.pushProviderAuthToAll(provider);
};
const automations = new Automations({ db, sessions, broadcast: (msg) => sessions.notify(msg), push: (msg) => push.send(msg), log });
const mcpEvents = new McpEvents({ db, settings: () => settings, automations, broadcast: (msg) => sessions.notify(msg), log });
automations.mcpServerExists = (id) => settings.mcpServers.some((m) => m.id === id);
automations.listChanged = () => mcpEvents.reconcile();
const tunnels = new Tunnels(
  LOCAL_ORIGIN,
  settings.tunnels,
  () => trustedCaBundle(settings),
  (_kind, status, all) => {
    sessions.notify({ type: "remote", remote: remoteAccess(all) });
    if (status.state === "up") log(`log in from another device at ${status.url}/#${PAIR_FRAGMENT_KEY}=${auth.createPairing().code} (one use, ${Math.round(PAIRING_TTL_MS / 60_000)} min)`);
  },
  log,
);
const auth = new Auth(db.connection, () => accessToken(settings), TRUST_PROXY, new URL(PUBLIC_URL).host, log, () => tunnels.hosts());
const dockerReachable = () =>
  docker.docker.ping().then(
    () => true,
    () => false,
  );
const publicSettings = async () =>
  toPublicSettings(
    settings,
    await sessions.dockerModeAvailable(),
    tunnels.statuses(),
    {
      "docker-linux": { available: true, reason: null },
      "qemu-windows": await windows.availability(),
      "qemu-macos": await macos.availability(),
    },
    await dockerReachable(),
  );
sessions.publicSettings = publicSettings;
sessions.automations = automations;
const followedPrs = new FollowedPrs({
  db,
  credentials: () =>
    resolveBoxCredentials(
      settings,
      settings.mcpServers.map((m) => m.id),
    ),
  automations,
  sessions: { list: () => sessions.list(), get: (id) => db.getSession(id), create: (req) => sessions.create(req) },
  attach: (sessionId, url, by) => sessions.prs.attach(sessionId, url, by),
  broadcast: (msg) => sessions.notify(msg),
  push: (msg) => push.send(msg),
  log,
});
sessions.followedPrs = followedPrs;
const prReviews = new PrReviews({
  db,
  automations,
  followedPrs,
  settings: () => settings,
  sessions: { create: (req) => sessions.create(req) },
  attach: (sessionId, url, by) => sessions.prs.attach(sessionId, url, by),
  push: (msg) => push.send(msg),
  log,
});
sessions.reviews = prReviews;
sessions.prs.onChecksChanged = (ref) => followedPrs.pollHint(ref);
new PrQa({
  db,
  automations,
  followedPrs,
  e2e: sessions.e2e,
  settings: () => settings,
  sessions: { create: (req) => sessions.create(req), daemonHttpUrl: (id) => sessions.daemonHttpUrl(id) },
  attach: (sessionId, url, by) => sessions.prs.attach(sessionId, url, by),
  push: (msg) => push.send(msg),
  log,
});
const connectors = new Connectors(
  {
    get: () => settings,
    set: (next) => {
      settings = next;
      saveSettings(settings);
    },
  },
  (kind) => `${PUBLIC_URL}/api/connectors/${kind}/callback`,
  () => void sessions.pushMcpServersToAll(),
  log,
);
const providerLogins = new ProviderLogins(
  new HostOrSandboxRunner(docker),
  {
    get: () => settings,
    set: (next) => {
      settings = next;
      saveSettings(settings);
    },
  },
  log,
);

const app = new Hono();
const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof ZodError) return c.json({ error: err.issues.map((i) => i.message).join("; ") }, 400);
  log(`unhandled: ${err.stack ?? err.message}`);
  return c.json({ error: err.message }, 500);
});

const api = new Hono<AuthEnv>();

api.use("*", auth.middleware());

/** Stores a Settings change and pushes what changed to the live Sessions; `PUT /settings` and the Agent's registry tools. */
async function applySettingsRequest(update: UpdateSettingsRequest): Promise<void> {
  const agentToolsBefore = settings.agentTools;
  settings = applySettingsUpdate(settings, update);
  saveSettings(settings);
  if (settings.agentTools !== agentToolsBefore) void sessions.agentToolsPolicyChanged();
  if (update.extraCaCerts !== undefined || update.trustHostCaCerts !== undefined) applyTrustedCas(settings);
  if (update.mcpServers) {
    void sessions.pushMcpServersToAll();
    mcpEvents.settingsChanged();
  }
  if (update.utilities || update.utilityEnvironments || update.procedures) void sessions.pushUtilitiesToAll();
  if (update.claudeModels) void sessions.pushClaudeModelsToAll();
  for (const provider of providersAuthChangedBy(update)) void sessions.pushProviderAuthToAll(provider);
  if (update.recordingNarration) void sessions.pushRecordingPrefsToAll();
  if (update.tunnels) await tunnels.apply(settings.tunnels);
}
sessions.applySettings = applySettingsRequest;

const speech = new Speech(log);
sessions.transcribeMedia = (wav, language) => speech.transcribeTimed(wav, settings.speech, language);

const deps: RouteDeps = {
  db,
  docker,
  sessions,
  automations,
  followedPrs,
  mcpEvents,
  auth,
  push,
  windows,
  macos,
  speech,
  tunnels,
  connectors,
  providerLogins,
  settings: {
    get: () => settings,
    set: (next) => {
      settings = next;
      saveSettings(settings);
    },
  },
  publicSettings,
  applySettings: applySettingsRequest,
  upgradeWebSocket,
};
// Hono matches in registration order. Every pair of patterns that can answer the same URL lives in
// one file (scripts/route-table.txt lists them), so the order of these calls is free.
registerSystemRoutes(api, deps);
registerAuthRoutes(api, deps);
registerPushRoutes(api, deps);
registerSettingsRoutes(api, deps);
registerVmBaseRoutes(api, deps);
registerSpeechRoutes(api, deps);
registerTunnelRoutes(api, deps);
registerProviderRoutes(api, deps);
registerConnectorRoutes(api, deps);
registerFolderRoutes(api, deps);
registerSessionRoutes(api, deps);
registerAutomationRoutes(api, deps);
registerMcpEventRoutes(api, deps);
registerRepositoryRoutes(api, deps);
registerPrRoutes(api, deps);
registerWsRoutes(api, deps);
// Outside the access-token middleware: the code hosts' webhook deliveries.
registerPrHookRoute(app, deps);

app.route("/api", api);

// Production: serve the built web UI from apps/web/dist; in dev, Vite proxies /api.
const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: webDist }));
  app.get("*", serveStatic({ root: webDist, path: "index.html" }));
}

await windows.init().catch((e: unknown) => log(`windows: ${e instanceof Error ? e.message : String(e)}`));
await macos.init().catch((e: unknown) => log(`macos: ${e instanceof Error ? e.message : String(e)}`));
await sessions.boot();
automations.start();
followedPrs.start();
mcpEvents.start();
void sessions.staged.sweep();
setInterval(() => void sessions.staged.sweep(), 60 * 60 * 1000).unref();
if (TLS && (TLS_CERT_FILE === "" || TLS_KEY_FILE === "")) {
  throw new Error("SESSIONBOXER_TLS_CERT and SESSIONBOXER_TLS_KEY must be set together.");
}
const server = serve(
  {
    fetch: app.fetch,
    hostname: HOST,
    port: PORT,
    ...(TLS ? { createServer: createHttpsServer, serverOptions: { cert: readFileSync(TLS_CERT_FILE), key: readFileSync(TLS_KEY_FILE) } } : {}),
  },
  (info) => {
    log(`sessionboxer ${VERSION} listening on ${TLS ? "https" : "http"}://${info.address}:${info.port}${PUBLIC_URL ? ` (public URL ${PUBLIC_URL})` : ""}`);
    const pairing = auth.createPairing();
    banner([
      `Sessionboxer ${VERSION} is ready. Open this link to log in:`,
      "",
      `  ${PUBLIC_URL}/#${PAIR_FRAGMENT_KEY}=${pairing.code}`,
      "",
      `One use, valid for ${Math.round(PAIRING_TTL_MS / 60_000)} minutes.`,
      accessTokenSource() === "env"
        ? "Another browser: paste the SESSIONBOXER_ACCESS_TOKEN on its login page."
        : "Another browser: `sessionboxer token` prints a token for its login page.",
    ]);
    log(
      accessTokenSource() === "env"
        ? "access token: from SESSIONBOXER_ACCESS_TOKEN"
        : `access token: in ${CONFIG_FILE} (\`sessionboxer token\` prints it; paste it on the login page of any other browser)`,
    );
    void tunnels.apply(settings.tunnels);
  },
);
injectWebSocket(server);

// Idle tunnels and proxies drop quiet WebSockets (Cloudflare after 100 s); a ping every 25 s keeps
// every browser connection (UI, terminals, Desktop, Code) alive and finds the ones that went away.
const keepalive = setInterval(() => {
  for (const ws of wss.clients) {
    const alive = ws as typeof ws & { isAlive?: boolean };
    if (alive.isAlive === false) {
      ws.terminate();
      continue;
    }
    alive.isAlive = false;
    ws.ping();
  }
}, WS_PING_MS);
wss.on("connection", (ws) => {
  const alive = ws as typeof ws & { isAlive?: boolean };
  alive.isAlive = true;
  ws.on("pong", () => {
    alive.isAlive = true;
  });
});

const shutdown = (): void => {
  log("shutting down");
  const exit = (): void => {
    clearInterval(keepalive);
    automations.stop();
    followedPrs.stop();
    void mcpEvents.stop();
    tunnels.close();
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
