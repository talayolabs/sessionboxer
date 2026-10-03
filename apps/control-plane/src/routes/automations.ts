import { type Hono } from "hono";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { CreateAutomationRequest, CreateScheduleRequest, SchedulePreviewRequest, UpdateAutomationRequest, UpdateScheduleRequest } from "@sessionboxer/protocol";
import { scheduleRunOf } from "../automations.js";
import { qaVideoFile } from "../pr-qa.js";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerAutomationRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { automations } = deps;
  // Scheduled tasks (ADR-0047).
  // Automations (ADR-0063); `/schedules*` is the pre-1.5 shape of the ones with a schedule trigger.
  api.get("/automations", (c) => c.json(automations.list()));
  api.post("/automations", async (c) => c.json(automations.create(CreateAutomationRequest.parse(await c.req.json())), 201));
  api.post("/automations/preview", async (c) => {
    const req = SchedulePreviewRequest.parse(await c.req.json());
    return c.json(automations.preview(req.cron, req.timezone));
  });
  api.get("/automations/:id", (c) => c.json(automations.get(c.req.param("id"))));
  api.patch("/automations/:id", async (c) => c.json(automations.update(c.req.param("id"), UpdateAutomationRequest.parse(await c.req.json()))));
  api.delete("/automations/:id", (c) => {
    automations.delete(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/automations/:id/run", async (c) => c.json(await automations.runNow(c.req.param("id")), 202));
  api.get("/automations/:id/runs", (c) => c.json(automations.listRuns(c.req.param("id"))));
  // The video of an Auto QA run, kept on the Control Plane after the run's box is gone (ADR-0066).
  api.on(["GET", "HEAD"], "/automations/runs/:runId/video", (c) => {
    const file = qaVideoFile(c.req.param("runId"));
    if (!file) return c.json({ error: "no video was kept for this run" }, 404);
    const size = statSync(file).size;
    const headers: Record<string, string> = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "private, max-age=86400" };
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    let start = 0;
    let end = size - 1;
    if (range && (range[1] !== "" || range[2] !== "")) {
      start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), size - 1) : end;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["content-length"] = String(end - start + 1);
    if (c.req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, { status: range ? 206 : 200, headers });
  });

  api.get("/schedules", (c) => c.json(automations.listSchedules()));
  api.post("/schedules", async (c) => c.json(automations.createSchedule(CreateScheduleRequest.parse(await c.req.json())), 201));
  api.post("/schedules/preview", async (c) => {
    const req = SchedulePreviewRequest.parse(await c.req.json());
    return c.json(automations.preview(req.cron, req.timezone));
  });
  api.get("/schedules/:id", (c) => c.json(automations.getSchedule(c.req.param("id"))));
  api.patch("/schedules/:id", async (c) => c.json(automations.updateSchedule(c.req.param("id"), UpdateScheduleRequest.parse(await c.req.json()))));
  api.delete("/schedules/:id", (c) => {
    automations.getSchedule(c.req.param("id"));
    automations.delete(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/schedules/:id/run", async (c) => {
    automations.getSchedule(c.req.param("id"));
    return c.json(scheduleRunOf(await automations.runNow(c.req.param("id"))), 202);
  });
  api.get("/schedules/:id/runs", (c) => c.json(automations.listScheduleRuns(c.req.param("id"))));
}
