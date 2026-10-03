// ---------------------------------------------------------------------------
// MCP Events (ADR-0081): the experimental `events/*` extension, as the design sketch of
// modelcontextprotocol/experimental-ext-triggers-events describes it. A user's MCP server produces
// event occurrences; the Control Plane is the consumer and turns them into Automation runs. Push
// (`events/stream`) and poll (`events/poll`) are supported; webhook delivery is not (it needs an
// inbound URL).
// ---------------------------------------------------------------------------

import { z } from "zod";

/** `_meta` key that ties a `notifications/events/*` message to its `events/stream` request. */
export const MCP_EVENTS_SUBSCRIPTION_META = "io.modelcontextprotocol/subscriptionId";
/** The sketch's error codes a consumer has to recognise. */
export const MCP_EVENTS_ERROR_NOT_FOUND = -32011;
export const MCP_EVENTS_ERROR_UNSUPPORTED = -32014;
/** Subscription arguments as stored on a trigger: JSON of at most this many characters. */
export const MCP_EVENT_ARGUMENTS_MAX_CHARS = 8000;
/** Event payloads handed to prompts are cut at this many characters of JSON. */
export const MCP_EVENT_DATA_MAX_CHARS = 16_000;
/** A push stream with neither an event nor a heartbeat for this long is dead (the sketch says 2× the 30 s heartbeat). */
export const MCP_EVENTS_STREAM_SILENCE_MS = 90_000;

export const McpEventDelivery = z.enum(["poll", "push", "webhook"]);
export type McpEventDelivery = z.infer<typeof McpEventDelivery>;

/** One entry of `events/list`: what a server offers to subscribe to. */
export const McpEventType = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    delivery: z.array(McpEventDelivery).default([]),
    inputSchema: z.record(z.unknown()).optional(),
    payloadSchema: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type McpEventType = z.infer<typeof McpEventType>;

export const McpEventsListResult = z.object({ events: z.array(McpEventType).default([]), nextCursor: z.string().optional() }).passthrough();
export type McpEventsListResult = z.infer<typeof McpEventsListResult>;

/** An `EventOccurrence`: an entry of `events/poll`, the params of `notifications/events/event`. */
export const McpEventOccurrence = z
  .object({
    eventId: z.string().min(1),
    name: z.string().min(1),
    timestamp: z.string(),
    data: z.record(z.unknown()).default({}),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();
export type McpEventOccurrence = z.infer<typeof McpEventOccurrence>;

export const McpEventsPollResult = z
  .object({
    events: z.array(McpEventOccurrence).default([]),
    cursor: z.string().nullable().default(null),
    truncated: z.boolean().optional(),
    hasMore: z.boolean().optional(),
    nextPollMs: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type McpEventsPollResult = z.infer<typeof McpEventsPollResult>;

/** `notifications/events/active` and `notifications/events/heartbeat`: the cursor moves on. */
export const McpEventsCursorNotification = z.object({ cursor: z.string().nullable().optional(), truncated: z.boolean().optional() }).passthrough();

/** The event an Automation run was fired by, as the run row keeps it. */
export const McpRunEvent = z.object({
  /** The registry id and name of the server, at the time of the run. */
  serverId: z.string(),
  server: z.string(),
  name: z.string(),
  eventId: z.string(),
  timestamp: z.string(),
  data: z.record(z.unknown()),
});
export type McpRunEvent = z.infer<typeof McpRunEvent>;

/** What the Control Plane knows about one registry server's events (`GET /api/mcp-events/catalog`). */
export const McpServerEventCatalog = z.object({
  serverId: z.string(),
  server: z.string(),
  /** `ok`: `events/list` answered (maybe with no event types); `none`: the server has no `events/*`; `error`: could not ask. */
  state: z.enum(["ok", "none", "error"]),
  error: z.string().nullable(),
  events: z.array(McpEventType),
  checkedAt: z.string(),
});
export type McpServerEventCatalog = z.infer<typeof McpServerEventCatalog>;

export const McpEventSubscriptionState = z.enum(["connecting", "listening", "polling", "error", "off"]);
export type McpEventSubscriptionState = z.infer<typeof McpEventSubscriptionState>;

/** The live state of one Automation's subscription, broadcast as `mcp_event_subscriptions`. */
export const McpEventSubscription = z.object({
  automationId: z.string(),
  state: McpEventSubscriptionState,
  mode: z.enum(["push", "poll"]).nullable(),
  error: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  /** Whether a cursor is persisted (the server replays from it after a restart). */
  hasCursor: z.boolean(),
});
export type McpEventSubscription = z.infer<typeof McpEventSubscription>;

export const McpEventsCatalog = z.object({ servers: z.array(McpServerEventCatalog), subscriptions: z.array(McpEventSubscription) });
export type McpEventsCatalog = z.infer<typeof McpEventsCatalog>;
