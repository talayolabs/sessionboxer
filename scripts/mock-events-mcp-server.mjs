#!/usr/bin/env node
// A stdio MCP server that speaks the experimental MCP Events extension (ADR-0081), for
// scripts/mcp-events.test.mjs and for trying the Automations trigger by hand: register it as
// `node scripts/mock-events-mcp-server.mjs`. It offers one event type, `ticket.created`, produces
// MOCK_EVENTS_COUNT occurrences (evt_1, evt_2, …), one every MOCK_EVENTS_INTERVAL_MS on a stream,
// all at once on a poll, and replays from a cursor (the index of the last delivered occurrence).
//   MOCK_EVENTS_DELIVERY   "push,poll" (default), "push" or "poll": what events/list advertises
//   MOCK_EVENTS_COUNT      how many occurrences exist (default 3)
//   MOCK_EVENTS_INTERVAL_MS  stream pace (default 200)
//   MOCK_EVENTS_HEARTBEAT_MS stream heartbeat (default 1000)
//   MOCK_EVENTS_DUPLICATE  "1": every occurrence is delivered twice (dedupe test)
//   MOCK_EVENTS_PAGE       poll page size (default 50; sets hasMore)
//   MOCK_EVENTS_NONE       "1": a plain MCP server with no events/* at all
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const env = process.env;
const delivery = (env.MOCK_EVENTS_DELIVERY ?? "push,poll").split(",").map((s) => s.trim()).filter(Boolean);
const count = Number(env.MOCK_EVENTS_COUNT ?? 3);
const intervalMs = Number(env.MOCK_EVENTS_INTERVAL_MS ?? 200);
const heartbeatMs = Number(env.MOCK_EVENTS_HEARTBEAT_MS ?? 1000);
const duplicate = env.MOCK_EVENTS_DUPLICATE === "1";
const pageSize = Number(env.MOCK_EVENTS_PAGE ?? 50);

const EVENT = "ticket.created";
const occurrences = Array.from({ length: count }, (_, i) => ({
  eventId: `evt_${i + 1}`,
  name: EVENT,
  timestamp: new Date(Date.UTC(2026, 1, 19, 15, 30, i)).toISOString(),
  data: { ticketId: i + 1, title: `Ticket ${i + 1}`, priority: i % 2 === 0 ? "high" : "low" },
}));
const after = (cursor) => (cursor === null || cursor === undefined ? 0 : Number(cursor));

const server = new Server({ name: "mock-events", version: "0.0.1" }, { capabilities: {} });
const Any = z.object({ method: z.string(), params: z.object({}).passthrough().optional() });
const req = (method) => Any.extend({ method: z.literal(method) });

if (env.MOCK_EVENTS_NONE !== "1") {
  server.setRequestHandler(req("events/list"), () => ({
    events: [
      {
        name: EVENT,
        description: "A support ticket was opened",
        delivery,
        inputSchema: { type: "object", properties: { priority: { type: "string", enum: ["high", "low"] } } },
        payloadSchema: { type: "object", properties: { ticketId: { type: "integer" }, title: { type: "string" }, priority: { type: "string" } } },
      },
    ],
  }));

  server.setRequestHandler(req("events/poll"), (r) => {
    const { name, cursor, maxEvents } = r.params ?? {};
    if (name !== EVENT) throw Object.assign(new Error(`unknown event ${name}`), { code: -32011 });
    const from = after(cursor);
    const page = Math.min(pageSize, maxEvents ?? 50);
    const slice = occurrences.slice(from, from + page);
    const events = duplicate ? slice.flatMap((o) => [o, o]) : slice;
    const last = from + slice.length;
    return { events, cursor: String(last), truncated: false, hasMore: last < occurrences.length, nextPollMs: 100 };
  });

  server.setRequestHandler(req("events/stream"), (r, extra) => {
    const { name, cursor } = r.params ?? {};
    if (name !== EVENT) throw Object.assign(new Error(`unknown event ${name}`), { code: -32011 });
    const meta = { "io.modelcontextprotocol/subscriptionId": extra.requestId };
    let index = after(cursor);
    const notify = (method, params) => server.notification({ method, params: { ...params, _meta: meta } });
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(ticker);
        clearInterval(heart);
        resolve({});
      };
      void notify("notifications/events/active", { cursor: String(index) });
      const ticker = setInterval(() => {
        const o = occurrences[index];
        if (!o) return;
        index += 1;
        void notify("notifications/events/event", { ...o, cursor: String(index) });
        if (duplicate) void notify("notifications/events/event", { ...o, cursor: String(index) });
      }, intervalMs);
      const heart = setInterval(() => void notify("notifications/events/heartbeat", { cursor: String(index) }), heartbeatMs);
      extra.signal.addEventListener("abort", finish);
    });
  });
}

await server.connect(new StdioServerTransport());
