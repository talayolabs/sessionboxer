import { type Hono } from "hono";
import { CreateFolderRequest, UpdateFolderRequest } from "@sessionboxer/protocol";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerFolderRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { sessions } = deps;
  // Sidebar folders the Sessions are filed under (ADR-0074).
  api.get("/folders", (c) => c.json(sessions.folders()));
  api.post("/folders", async (c) => c.json(sessions.createFolder(CreateFolderRequest.parse(await c.req.json())), 201));
  api.patch("/folders/:id", async (c) => c.json(sessions.renameFolder(c.req.param("id"), UpdateFolderRequest.parse(await c.req.json()))));
  api.delete("/folders/:id", (c) => {
    sessions.deleteFolder(c.req.param("id"));
    return c.body(null, 204);
  });
}
