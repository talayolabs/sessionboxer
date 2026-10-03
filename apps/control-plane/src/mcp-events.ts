/**
 * MCP Events consumer (ADR-0081). The Control Plane holds its own connection to each registry MCP
 * server an enabled `mcp_event` automation names — one connection per subscription, so every
 * `notifications/events/*` on it belongs to that subscription and no `subscriptionId` routing is
 * needed — asks `events/list`, and then either keeps an `events/stream` request open (push) or
 * calls `events/poll` at the server's pace. Each occurrence is deduplicated on its `eventId` and
 * becomes an Automation run through `Automations.runForMcpEvent`; the cursor is persisted per
 * automation after the run is recorded, so a restart resumes where it left off when the server
 * replays. Webhook delivery (an inbound URL) is not offered.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MCP_EVENTS_ERROR_NOT_FOUND,
  MCP_EVENTS_ERROR_UNSUPPORTED,
  MCP_EVENTS_STREAM_SILENCE_MS,
  McpEventOccurrence,
  McpEventsCursorNotification,
  McpEventsListResult,
  McpEventsPollResult,
  connectorHasMcp,
  type Automation,
  type McpEventSubscription,
  type McpEventTrigger,
  type McpEventType,
  type McpEventsCatalog,
  type McpRunEvent,
  type McpServerDef,
  type McpServerEventCatalog,
  type SessionBroadcast,
  type Settings,
} from "@sessionboxer/protocol";
import type { Automations, PrRunContext } from "./automations.js";
import type { Db } from "./db.js";
import { storableEventData } from "./mcp-event-text.js";

export interface McpEventsDeps {
  db: Db;
  settings: () => Settings;
  automations: Pick<Automations, "runForMcpEvent" | "recordSkipped">;
  broadcast: (msg: SessionBroadcast) => void;
  log: (msg: string) => void;
  /** Test seams: how long to wait before reconnecting after a failure, and the catalog's cache life. */
  backoffMs?: { min: number; max: number };
  catalogTtlMs?: number;
}

const DEFAULT_BACKOFF = { min: 5_000, max: 5 * 60_000 };
const CATALOG_TTL_MS = 60_000;
const LIST_TIMEOUT_MS = 20_000;
const POLL_TIMEOUT_MS = 60_000;
/** Node clamps longer timers to 1 ms; the stream's own liveness check is the heartbeat watchdog. */
const STREAM_TIMEOUT_MS = 2_000_000_000;
const POLL_MIN_MS = 5_000;
const POLL_MAX_MS = 10 * 60_000;
const SEEN_CAP = 2_000;
const RECONCILE_MS = 30_000;
const SUBSCRIPTION_ID_META = "io.modelcontextprotocol/subscriptionId";

const EventNotification = z.object({ method: z.literal("notifications/events/event"), params: McpEventOccurrence });
const ActiveNotification = z.object({ method: z.literal("notifications/events/active"), params: McpEventsCursorNotification });
const HeartbeatNotification = z.object({ method: z.literal("notifications/events/heartbeat"), params: McpEventsCursorNotification });
const ErrorNotification = z.object({ method: z.literal("notifications/events/error"), params: z.object({ error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough() }).passthrough() });
const TerminatedNotification = z.object({ method: z.literal("notifications/events/terminated"), params: z.object({ error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough().optional() }).passthrough() });
const StreamResult = z.object({}).passthrough();

interface Subscription {
  automationId: string;
  /** The trigger and the server definition it runs against; a change to either restarts it. */
  key: string;
  trigger: McpEventTrigger;
  state: McpEventSubscription["state"];
  mode: "push" | "poll" | null;
  error: string | null;
  lastEventAt: string | null;
  closed: boolean;
  client: Client | null;
  wake: (() => void) | null;
  seen: Set<string>;
}

/** The server's command/url/headers as the registry stores them; `localhost` is this machine (the Control Plane runs here, not in a box). */
export function mcpClientTransport(def: McpServerDef): Transport {
  if (def.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    for (const { name, value } of def.env) env[name] = value;
    return new StdioClientTransport({ command: def.command, args: def.args, env, stderr: "pipe" });
  }
  const headers: Record<string, string> = {};
  for (const { name, value } of def.headers) headers[name] = value;
  const url = new URL(def.url);
  return def.transport === "sse" ? new SSEClientTransport(url, { requestInit: { headers } }) : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number, sub?: Subscription) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (sub) sub.wake = null;
      resolve();
    }
    if (sub) sub.wake = done;
  });

export class McpEvents {
  private readonly subs = new Map<string, Subscription>();
  private readonly catalogCache = new Map<string, McpServerEventCatalog>();
  private timer: NodeJS.Timeout | null = null;
  private readonly backoff: { min: number; max: number };
  private readonly catalogTtl: number;

  constructor(private readonly deps: McpEventsDeps) {
    this.backoff = deps.backoffMs ?? DEFAULT_BACKOFF;
    this.catalogTtl = deps.catalogTtlMs ?? CATALOG_TTL_MS;
  }

  start(): void {
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), RECONCILE_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.subs.values()].map((sub) => this.close(sub)));
    this.subs.clear();
  }

  /** The registry changed: subscriptions on a changed or removed server reconnect or end; the catalog is asked again. */
  settingsChanged(): void {
    this.catalogCache.clear();
    this.reconcile();
  }

  /** Starts, keeps or ends subscriptions so that exactly the enabled `mcp_event` automations have one. */
  reconcile(): void {
    const wanted = new Map<string, { automation: Automation; trigger: McpEventTrigger; def: McpServerDef | undefined }>();
    for (const automation of this.deps.db.automations.list()) {
      if (!automation.enabled || automation.trigger.type !== "mcp_event") continue;
      wanted.set(automation.id, { automation, trigger: automation.trigger, def: this.serverDef(automation.trigger.serverId) });
    }
    let changed = false;
    for (const [id, sub] of this.subs) {
      const want = wanted.get(id);
      if (want && want.def && keyOf(want.trigger, want.def) === sub.key) continue;
      this.subs.delete(id);
      void this.close(sub);
      changed = true;
    }
    for (const [id, want] of wanted) {
      if (this.subs.has(id)) continue;
      const sub: Subscription = {
        automationId: id,
        key: want.def ? keyOf(want.trigger, want.def) : `missing:${want.trigger.serverId}`,
        trigger: want.trigger,
        state: "connecting",
        mode: null,
        error: null,
        lastEventAt: null,
        closed: false,
        client: null,
        wake: null,
        seen: new Set(),
      };
      this.subs.set(id, sub);
      void this.run(sub);
      changed = true;
    }
    if (changed) this.broadcast();
  }

  statuses(): McpEventSubscription[] {
    return [...this.subs.values()].map((s) => ({
      automationId: s.automationId,
      state: s.state,
      mode: s.mode,
      error: s.error,
      lastEventAt: s.lastEventAt,
      hasCursor: this.deps.db.automations.getMcpCursor(s.automationId) !== null,
    }));
  }

  /** What every registry server offers (`events/list`, cached a minute), with the live subscriptions. */
  async catalog(refresh = false): Promise<McpEventsCatalog> {
    if (refresh) this.catalogCache.clear();
    const servers = this.deps.settings().mcpServers.filter((s) => !s.connector || connectorHasMcp(s.connector.kind));
    const entries = await Promise.all(
      servers.map(async (def) => {
        const cached = this.catalogCache.get(def.id);
        if (cached && Date.now() - Date.parse(cached.checkedAt) < this.catalogTtl) return cached;
        const entry = await this.discover(def);
        this.catalogCache.set(def.id, entry);
        return entry;
      }),
    );
    return { servers: entries, subscriptions: this.statuses() };
  }

  private async discover(def: McpServerDef): Promise<McpServerEventCatalog> {
    const checkedAt = new Date().toISOString();
    const base = { serverId: def.id, server: def.name, checkedAt };
    let client: Client | null = null;
    try {
      client = await this.connect(def, `catalog ${def.name}`);
      const events = await listEvents(client);
      if (events === null) return { ...base, state: "none", error: null, events: [] };
      return { ...base, state: "ok", error: null, events };
    } catch (e) {
      return { ...base, state: "error", error: message(e), events: [] };
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  private serverDef(id: string): McpServerDef | undefined {
    return this.deps.settings().mcpServers.find((s) => s.id === id && (!s.connector || connectorHasMcp(s.connector.kind)));
  }

  private async connect(def: McpServerDef, label: string): Promise<Client> {
    const client = new Client({ name: "sessionboxer", version: "1.5.0" }, { capabilities: {} });
    const transport = mcpClientTransport(def);
    await client.connect(transport);
    if (transport instanceof StdioClientTransport && transport.stderr) {
      transport.stderr.on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").trim();
        if (line) this.deps.log(`mcp-events ${label}: ${line.slice(0, 400)}`);
      });
    }
    return client;
  }

  // --- One subscription ----------------------------------------------------------------------------

  private async run(sub: Subscription): Promise<void> {
    let wait = this.backoff.min;
    while (!sub.closed) {
      const startedAt = Date.now();
      try {
        this.setState(sub, "connecting", null);
        const def = this.serverDef(sub.trigger.serverId);
        if (!def) throw new Error("The MCP server is no longer in the registry.");
        const client = await this.connect(def, def.name);
        sub.client = client;
        try {
          const types = await listEvents(client);
          if (types === null) throw new Error(`"${def.name}" does not offer MCP Events (no events/list).`);
          const type = types.find((t) => t.name === sub.trigger.event);
          if (!type) throw new Error(`"${def.name}" offers no event "${sub.trigger.event}" (it has: ${types.map((t) => t.name).join(", ") || "none"}).`);
          sub.mode = pickMode(sub.trigger.delivery, type);
          this.broadcast();
          if (sub.mode === "push") await this.stream(sub, client, def);
          else await this.poll(sub, client, def);
        } finally {
          sub.client = null;
          await client.close().catch(() => undefined);
        }
        if (!sub.closed) this.setState(sub, "connecting", "The server ended the stream; reconnecting.");
      } catch (e) {
        if (sub.closed) break;
        this.setState(sub, "error", message(e));
        this.deps.log(`mcp-events automation ${sub.automationId}: ${message(e)}`);
      }
      if (sub.closed) break;
      // A connection that held for a while earns a fresh backoff.
      if (Date.now() - startedAt > 60_000) wait = this.backoff.min;
      await sleep(wait, sub);
      wait = Math.min(wait * 2, this.backoff.max);
    }
  }

  private async stream(sub: Subscription, client: Client, def: McpServerDef): Promise<void> {
    let lastSignal = Date.now();
    let terminated: string | null = null;
    const cursor = (params: { cursor?: string | null; truncated?: boolean }) => {
      lastSignal = Date.now();
      if (params.cursor !== undefined) this.deps.db.automations.setMcpCursor(sub.automationId, params.cursor);
      if (params.truncated) this.deps.log(`mcp-events automation ${sub.automationId}: the server skipped events (stale cursor).`);
    };
    client.setNotificationHandler(ActiveNotification, (n) => cursor(n.params));
    client.setNotificationHandler(HeartbeatNotification, (n) => cursor(n.params));
    client.setNotificationHandler(ErrorNotification, (n) => {
      lastSignal = Date.now();
      this.deps.log(`mcp-events automation ${sub.automationId}: server error ${n.params.error.message ?? ""} (${n.params.error.code ?? "?"}), stream stays open`);
    });
    client.setNotificationHandler(TerminatedNotification, (n) => {
      terminated = `The server ended the subscription${n.params.error?.message ? `: ${n.params.error.message}` : "."}`;
      void client.close();
    });
    client.setNotificationHandler(EventNotification, async (n) => {
      lastSignal = Date.now();
      const meta = n.params._meta as Record<string, unknown> | undefined;
      void meta?.[SUBSCRIPTION_ID_META];
      await this.onEvent(sub, def, n.params);
      if (n.params.cursor !== undefined) this.deps.db.automations.setMcpCursor(sub.automationId, n.params.cursor);
    });
    const watchdog = setInterval(() => {
      if (Date.now() - lastSignal > MCP_EVENTS_STREAM_SILENCE_MS) {
        terminated = `No event or heartbeat for ${Math.round(MCP_EVENTS_STREAM_SILENCE_MS / 1000)} s; reconnecting.`;
        void client.close();
      }
    }, 5_000);
    watchdog.unref();
    this.setState(sub, "listening", null);
    try {
      await client.request(
        { method: "events/stream", params: { name: sub.trigger.event, arguments: sub.trigger.arguments, cursor: this.deps.db.automations.getMcpCursor(sub.automationId) } },
        StreamResult,
        { timeout: STREAM_TIMEOUT_MS },
      );
    } catch (e) {
      if (terminated) throw new Error(terminated);
      throw e;
    } finally {
      clearInterval(watchdog);
    }
    if (terminated) throw new Error(terminated);
  }

  private async poll(sub: Subscription, client: Client, def: McpServerDef): Promise<void> {
    this.setState(sub, "polling", null);
    while (!sub.closed) {
      const result = await client.request(
        { method: "events/poll", params: { name: sub.trigger.event, arguments: sub.trigger.arguments, cursor: this.deps.db.automations.getMcpCursor(sub.automationId), maxEvents: 50 } },
        McpEventsPollResult,
        { timeout: POLL_TIMEOUT_MS },
      );
      for (const occurrence of result.events) await this.onEvent(sub, def, occurrence);
      this.deps.db.automations.setMcpCursor(sub.automationId, result.cursor);
      if (result.truncated) this.deps.log(`mcp-events automation ${sub.automationId}: the server skipped events (stale cursor).`);
      if (sub.closed) break;
      if (result.hasMore) continue;
      await sleep(Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, result.nextPollMs ?? 30_000)), sub);
    }
  }

  /** One occurrence: deduplicated on its id, checked against the limits, then a run. */
  private async onEvent(sub: Subscription, def: McpServerDef, occurrence: McpEventOccurrence): Promise<void> {
    if (occurrence.name !== sub.trigger.event) return;
    if (sub.seen.has(occurrence.eventId) || this.deps.db.automations.hasMcpRunFor(sub.automationId, occurrence.eventId)) return;
    sub.seen.add(occurrence.eventId);
    if (sub.seen.size > SEEN_CAP) sub.seen.delete(sub.seen.values().next().value!);
    const automation = this.deps.db.automations.get(sub.automationId);
    if (!automation || !automation.enabled) return;
    sub.lastEventAt = new Date().toISOString();
    const ctx: PrRunContext & { mcpEvent: McpRunEvent } = {
      mcpEvent: { serverId: def.id, server: def.name, name: occurrence.name, eventId: occurrence.eventId, timestamp: occurrence.timestamp, data: storableEventData(occurrence.data) },
      eventLabel: `${def.name} ${occurrence.name}`,
    };
    try {
      const active = this.deps.db.automations.listActiveRuns(automation.id).length;
      if (active >= automation.limits.maxConcurrent) {
        this.deps.automations.recordSkipped(automation, "mcp_event", `${automation.limits.maxConcurrent} run${automation.limits.maxConcurrent === 1 ? "" : "s"} still going.`, ctx);
      } else if (automation.runsToday >= automation.limits.maxRunsPerDay) {
        this.deps.automations.recordSkipped(automation, "mcp_event", `Daily cap reached (${automation.limits.maxRunsPerDay} runs in 24 hours).`, ctx);
      } else {
        await this.deps.automations.runForMcpEvent(automation, ctx);
      }
    } catch (e) {
      this.deps.log(`mcp-events automation ${sub.automationId}: run failed to start: ${message(e)}`);
    }
    this.broadcast();
  }

  private setState(sub: Subscription, state: McpEventSubscription["state"], error: string | null): void {
    sub.state = state;
    sub.error = error;
    this.broadcast();
  }

  private async close(sub: Subscription): Promise<void> {
    sub.closed = true;
    sub.state = "off";
    sub.wake?.();
    await sub.client?.close().catch(() => undefined);
  }

  private broadcast(): void {
    this.deps.broadcast({ type: "mcp_event_subscriptions", subscriptions: this.statuses() });
  }
}

function keyOf(trigger: McpEventTrigger, def: McpServerDef): string {
  return JSON.stringify([trigger, def.transport, def.command, def.args, def.env, def.url, def.headers]);
}

/** Push when offered and allowed, poll otherwise; a server that only does webhooks cannot be subscribed to from here. */
export function pickMode(delivery: McpEventTrigger["delivery"], type: McpEventType): "push" | "poll" {
  const offers = (mode: "push" | "poll") => type.delivery.includes(mode);
  if (delivery === "push") {
    if (offers("push")) return "push";
    throw new Error(`Event "${type.name}" does not offer push delivery (it offers: ${type.delivery.join(", ") || "none"}).`);
  }
  if (delivery === "poll") {
    if (offers("poll")) return "poll";
    throw new Error(`Event "${type.name}" does not offer poll delivery (it offers: ${type.delivery.join(", ") || "none"}).`);
  }
  if (offers("push")) return "push";
  if (offers("poll")) return "poll";
  throw new Error(`Event "${type.name}" offers only ${type.delivery.join(", ") || "no"} delivery; Sessionboxer consumes push or poll.`);
}

/** Every page of `events/list`; `null` when the server has no such method. */
async function listEvents(client: Client): Promise<McpEventType[] | null> {
  const events: McpEventType[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    let result: McpEventsListResult;
    try {
      result = await client.request({ method: "events/list", params: cursor ? { cursor } : {} }, McpEventsListResult, { timeout: LIST_TIMEOUT_MS });
    } catch (e) {
      if (e instanceof McpError && (e.code === ErrorCode.MethodNotFound || e.code === MCP_EVENTS_ERROR_NOT_FOUND || e.code === MCP_EVENTS_ERROR_UNSUPPORTED)) return null;
      throw e;
    }
    events.push(...result.events);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return events;
}
