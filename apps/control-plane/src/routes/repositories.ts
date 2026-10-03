import { type Hono } from "hono";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerRepositoryRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { db } = deps;
  // Repositories named anywhere, for the inputs' suggestions (ADR-0068).
  api.get("/repositories", (c) => c.json(db.repos.list()));
  api.delete("/repositories/:id", (c) => {
    if (!db.repos.forget(c.req.param("id"))) return c.json({ error: "no such repository" }, 404);
    return c.body(null, 204);
  });
}
