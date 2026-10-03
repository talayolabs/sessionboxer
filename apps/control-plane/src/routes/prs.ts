import { type Hono } from "hono";
import {
  AttachFollowedPrRequest,
  CreatePrFollowRequest,
  RunPrAutomationRequest,
  StartPrSessionRequest,
  UpdatePrFollowRequest,
  PrFollowHookRequest,
} from "@sessionboxer/protocol";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerPrRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { followedPrs } = deps;
  // Followed pull requests (ADR-0064): `/prs/follows*` before `/prs/:id`.
  api.get("/prs/accounts", (c) => c.json(followedPrs.accounts()));
  api.get("/prs/people", (c) => c.json(followedPrs.people()));
  api.get("/prs/follows", (c) => c.json(followedPrs.listFollows()));
  api.post("/prs/follows", async (c) => c.json(followedPrs.follow(CreatePrFollowRequest.parse(await c.req.json())), 201));
  api.patch("/prs/follows/:id", async (c) => c.json(followedPrs.setFollowEnabled(c.req.param("id"), UpdatePrFollowRequest.parse(await c.req.json()).enabled)));
  api.delete("/prs/follows/:id", (c) => {
    followedPrs.unfollow(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/prs/follows/:id/poll", async (c) => {
    await followedPrs.pollFollowNow(c.req.param("id"));
    return c.json(followedPrs.listFollows());
  });
  api.get("/prs/follows/:id/hook", (c) => c.json(followedPrs.hookInfo(c.req.param("id"))));
  api.post("/prs/follows/:id/hook", async (c) => c.json(await followedPrs.enableHook(c.req.param("id"), PrFollowHookRequest.parse(await c.req.json().catch(() => ({}))).url), 201));
  api.delete("/prs/follows/:id/hook", async (c) => c.json(await followedPrs.disableHook(c.req.param("id"))));
  api.get("/prs", (c) => c.json(followedPrs.list({ state: c.req.query("state") === "open" ? "open" : "all", ...(c.req.query("repo") ? { repo: c.req.query("repo")! } : {}) })));
  api.get("/prs/:id", (c) => c.json(followedPrs.get(c.req.param("id"))));
  api.get("/prs/:id/items", (c) => c.json(followedPrs.items(c.req.param("id"))));
  api.get("/prs/:id/checks", (c) => c.json(followedPrs.checks(c.req.param("id"))));
  api.get("/prs/:id/events", (c) => c.json(followedPrs.events(c.req.param("id"))));
  api.get("/prs/:id/runs", (c) => c.json(followedPrs.runs(c.req.param("id"))));
  api.post("/prs/:id/refresh", async (c) => c.json(await followedPrs.refresh(c.req.param("id"))));
  api.post("/prs/:id/seen", (c) => c.json(followedPrs.markSeen(c.req.param("id"))));
  api.post("/prs/:id/attach", async (c) => c.json(await followedPrs.attachTo(c.req.param("id"), AttachFollowedPrRequest.parse(await c.req.json()).sessionId), 201));
  api.post("/prs/:id/session", async (c) => c.json(await followedPrs.startSession(c.req.param("id"), StartPrSessionRequest.parse(await c.req.json())), 201));
  api.post("/prs/:id/run", async (c) => c.json(await followedPrs.runAutomation(c.req.param("id"), RunPrAutomationRequest.parse(await c.req.json()).automationId), 202));
}

export function registerPrHookRoute(app: Hono, deps: RouteDeps): void {
  const { followedPrs } = deps;
  // Webhook deliveries (ADR-0067): outside the access-token middleware, verified with the follow's secret;
  // the payload is only a hint of which PRs to poll now.
  app.post("/api/hooks/:provider/:followId", async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "github" && provider !== "bitbucket") return c.json({ error: "unknown hook" }, 404);
    const length = Number(c.req.header("content-length") ?? "0");
    if (length > 1024 * 1024) return c.json({ error: "delivery too large" }, 413);
    const raw = await c.req.text();
    const r = followedPrs.onHook(
      provider,
      c.req.param("followId"),
      { signature: c.req.header(provider === "github" ? "x-hub-signature-256" : "x-hub-signature"), event: c.req.header(provider === "github" ? "x-github-event" : "x-event-key"), length },
      raw,
    );
    return c.json(r.body, r.status);
  });
}
