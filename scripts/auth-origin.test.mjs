import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { Auth } from "../apps/control-plane/dist/auth.js";
import { HttpError } from "../apps/control-plane/dist/http-error.js";

const auth = new Auth(new Database(":memory:"), () => "secret-token", false, "sessionboxer.example", () => undefined);
const app = new Hono();
app.onError((e, c) => c.text(e.message, e instanceof HttpError ? e.status : 500));
app.use("/api/*", auth.middleware());
app.on(["GET", "HEAD"], "/api/sessions/:id/fs/raw", (c) => c.text("raw"));
app.on(["GET", "HEAD"], "/api/sessions/:id/fs/app", (c) => c.text("app"));
app.get("/api/sessions", (c) => c.text("sessions"));
app.post("/api/sessions/:id/fs/watch", (c) => c.text("watch"));
app.post("/api/auth/login", (c) => c.text("login"));

const bearer = { authorization: "Bearer secret-token", host: "sessionboxer.example" };
const req = (path, init = {}) => app.request(path, { ...init, headers: { ...bearer, ...(init.headers ?? {}) } });

test("an opaque origin (a sandboxed HTML Artifact) reaches only the Workspace file routes", async () => {
  assert.equal((await req("/api/sessions/s1/fs/raw?path=a.mp4", { headers: { origin: "null" } })).status, 200);
  assert.equal((await req("/api/sessions/s1/fs/app?path=a.html", { method: "HEAD", headers: { origin: "null" } })).status, 200);
  assert.equal((await req("/api/sessions", { headers: { origin: "null" } })).status, 403);
  assert.equal((await req("/api/sessions/s1/fs/watch", { method: "POST", headers: { origin: "null" } })).status, 403);
  assert.equal((await req("/api/auth/login", { method: "POST", headers: { origin: "null" } })).status, 403);
});

test("the file routes still need a login without an Origin, as a frame's own navigation sends none", async () => {
  const res = await app.request("/api/sessions/s1/fs/app?path=a.html", { headers: { host: "sessionboxer.example" } });
  assert.equal(res.status, 401);
});

test("the page's own origin and the public host pass; another origin does not", async () => {
  assert.equal((await req("/api/sessions", { headers: { origin: "http://sessionboxer.example" } })).status, 200);
  assert.equal((await req("/api/sessions", { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await req("/api/sessions")).status, 200);
});

test("allowsNullOrigin is GET/HEAD of the two file routes only", () => {
  assert.equal(Auth.allowsNullOrigin("GET", "/sessions/abc/fs/raw"), true);
  assert.equal(Auth.allowsNullOrigin("HEAD", "/sessions/abc/fs/app"), true);
  assert.equal(Auth.allowsNullOrigin("POST", "/sessions/abc/fs/app"), false);
  assert.equal(Auth.allowsNullOrigin("GET", "/sessions/abc/fs/watch"), false);
  assert.equal(Auth.allowsNullOrigin("GET", "/sessions/abc/fs/raw/extra"), false);
});
