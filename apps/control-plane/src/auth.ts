import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { PAIRING_TTL_MS, type AuthDevice, type AuthPairing, type AuthPrincipal } from "@sessionboxer/protocol";
import { HttpError } from "./http-error.js";

export const COOKIE_NAME = "sessionboxer_device";
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;
/** Failed logins allowed per client address in `FAIL_WINDOW_MS` before it is told to wait. */
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
/** `last_seen_at` is rewritten at most this often per device. */
const SEEN_THROTTLE_MS = 60_000;

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_ip TEXT NOT NULL
);
`;

interface DeviceRow {
  id: string;
  secret_hash: string;
  name: string;
  user_agent: string;
  created_at: string;
  last_seen_at: string;
  last_ip: string;
}

export interface ClientInfo {
  userAgent: string;
  ip: string;
  /** The request came in over HTTPS (directly or, when the proxy is trusted, at the proxy). */
  secure: boolean;
}

export interface LoginResult {
  device: AuthDevice;
  /** `Set-Cookie` value logging the browser in. */
  cookie: string;
}

type Variables = { principal: AuthPrincipal };
/** Hono environment the middleware needs: `c.get("principal")` after it ran. */
export type AuthEnv = { Variables: Variables };

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function isLoopback(ip: string): boolean {
  return ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** "Chrome on Android", "Safari on iPhone"… from a user agent; the device's default label. */
export function describeUserAgent(ua: string): string {
  if (ua === "") return "Unknown device";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  if (browser === "" && os === "") return ua.slice(0, 40);
  return browser === "" ? os : os === "" ? browser : `${browser} on ${os}`;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Who may talk to the API: browsers hold a device cookie minted from the access token (or a
 * pairing code a logged-in device made), scripts send the token itself as a bearer. Every `/api`
 * request and every WebSocket upgrade passes `middleware()`; loopback is not trusted, since a
 * tunnel or reverse proxy connects from there too.
 */
export class Auth {
  private readonly pairings = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly db: Database.Database,
    private readonly token: () => string,
    private readonly trustProxy: boolean,
    /** Host of `SESSIONBOXER_PUBLIC_URL`: what a browser's Origin says behind a proxy that rewrites `Host`. */
    private readonly publicHost: string,
    private readonly log: (msg: string) => void,
    /**
     * Hostname of the quick tunnel while it runs. cloudflared connects from this machine and keeps
     * the visitor's `Host`, so a loopback request carrying it is the tunnel's and its
     * `X-Forwarded-*` are believed (only a process on this machine could forge them).
     */
    private readonly tunnelHost: () => string | null = () => null,
  ) {
    this.db.exec(AUTH_SCHEMA);
  }

  /** Requests that need no login: the health probe and the logins themselves. */
  static isPublic(method: string, path: string): boolean {
    if (path === "/health" && method === "GET") return true;
    if (path === "/auth/login" && method === "POST") return true;
    if (path === "/auth/pair/redeem" && method === "POST") return true;
    if (path === "/auth/me" && method === "GET") return true;
    return false;
  }

  middleware(): MiddlewareHandler<AuthEnv> {
    return async (c, next) => {
      this.rejectCrossOrigin(c);
      const principal = this.authenticate(c);
      if (!principal) {
        const path = c.req.path.replace(/^\/api/, "");
        if (Auth.isPublic(c.req.method, path)) return next();
        throw new HttpError(401, "Login required.");
      }
      c.set("principal", principal);
      return next();
    };
  }

  /**
   * A cross-site page cannot make the browser use the cookie (`SameSite=Lax` keeps it from
   * fetches and WebSockets it opens), but the check costs nothing and covers older browsers.
   */
  private rejectCrossOrigin(c: Context): void {
    const origin = c.req.header("origin");
    if (!origin || origin === "null") return;
    const host = (this.forwarded(c) && c.req.header("x-forwarded-host")?.split(",")[0]?.trim()) || c.req.header("host") || "";
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, "Bad Origin header.");
    }
    const o = originHost.toLowerCase();
    if (o !== host.toLowerCase() && o !== this.publicHost.toLowerCase()) throw new HttpError(403, "Cross-origin requests are not allowed.");
  }

  /** Bearer access token, else device cookie; null when neither is valid. */
  authenticate(c: Context): AuthPrincipal | null {
    const auth = c.req.header("authorization");
    if (auth) {
      const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
      const token = this.token();
      if (m && token !== "" && safeEqual(m[1]!.trim(), token)) return { kind: "token" };
      return null;
    }
    const cookie = parseCookie(c.req.header("cookie"), COOKIE_NAME);
    if (!cookie) return null;
    const dot = cookie.indexOf(".");
    if (dot < 0) return null;
    const id = cookie.slice(0, dot);
    const secret = cookie.slice(dot + 1);
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
    if (!row || !safeEqual(sha256(secret), row.secret_hash)) return null;
    this.touch(row, this.clientInfo(c).ip);
    return { kind: "device", device: this.toDevice(row, row.id) };
  }

  private remoteAddress(c: Context): string {
    try {
      return getConnInfo(c).remote.address ?? "";
    } catch {
      return ""; // not a Node request (tests)
    }
  }

  /** Whether this request's `X-Forwarded-*` headers are trusted: a configured proxy, or the quick tunnel. */
  private forwarded(c: Context): boolean {
    if (this.trustProxy) return true;
    const tunnel = this.tunnelHost();
    if (!tunnel) return false;
    const host = (c.req.header("host") ?? "").toLowerCase();
    return host === tunnel.toLowerCase() && isLoopback(this.remoteAddress(c));
  }

  clientInfo(c: Context): ClientInfo {
    let ip = this.remoteAddress(c);
    let secure = new URL(c.req.url).protocol === "https:";
    if (this.forwarded(c)) {
      const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (fwd) ip = fwd;
      const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
      if (proto) secure = proto === "https";
    }
    return { userAgent: c.req.header("user-agent") ?? "", ip, secure };
  }

  /** Access token → device cookie; wrong tokens count against the client address. */
  login(token: string, name: string, client: ClientInfo): LoginResult {
    this.checkFailures(client.ip);
    const expected = this.token();
    if (expected === "" || !safeEqual(token.trim(), expected)) {
      this.recordFailure(client.ip);
      this.log(`login refused from ${client.ip || "?"} (${describeUserAgent(client.userAgent)})`);
      throw new HttpError(401, "Wrong access token.");
    }
    this.failures.delete(client.ip);
    return this.createDevice(name, client);
  }

  /** Makes a one-time pairing code for another device to redeem within `PAIRING_TTL_MS`. */
  createPairing(): AuthPairing {
    this.sweepPairings();
    const code = randomBytes(16).toString("base64url");
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pairings.set(code, expiresAt);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  redeemPairing(code: string, name: string, client: ClientInfo): LoginResult {
    this.checkFailures(client.ip);
    this.sweepPairings();
    const expiresAt = this.pairings.get(code.trim());
    if (expiresAt === undefined) {
      this.recordFailure(client.ip);
      throw new HttpError(401, "This pairing code is invalid, already used or expired; make a new one on a logged-in device.");
    }
    this.pairings.delete(code.trim());
    this.failures.delete(client.ip);
    return this.createDevice(name, client);
  }

  devices(currentId: string | null): AuthDevice[] {
    const rows = this.db.prepare("SELECT * FROM devices ORDER BY last_seen_at DESC").all() as DeviceRow[];
    return rows.map((r) => this.toDevice(r, currentId));
  }

  revoke(id: string): void {
    const res = this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    if (res.changes === 0) throw new HttpError(404, "No such device.");
    this.lastTouched.delete(id);
  }

  revokeAll(): number {
    const res = this.db.prepare("DELETE FROM devices").run();
    this.lastTouched.clear();
    return res.changes;
  }

  /** `Set-Cookie` that logs the browser out. */
  static clearCookie(secure: boolean): string {
    return Auth.cookie("", 0, secure);
  }

  private static cookie(value: string, maxAge: number, secure: boolean): string {
    const parts = [`${COOKIE_NAME}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
    if (secure) parts.push("Secure");
    return parts.join("; ");
  }

  private createDevice(name: string, client: ClientInfo): LoginResult {
    const id = randomBytes(8).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const row: DeviceRow = {
      id,
      secret_hash: sha256(secret),
      name: name.trim() || describeUserAgent(client.userAgent),
      user_agent: client.userAgent.slice(0, 300),
      created_at: now,
      last_seen_at: now,
      last_ip: client.ip,
    };
    this.db
      .prepare(
        "INSERT INTO devices (id, secret_hash, name, user_agent, created_at, last_seen_at, last_ip) VALUES (@id, @secret_hash, @name, @user_agent, @created_at, @last_seen_at, @last_ip)",
      )
      .run(row);
    this.log(`device ${id} logged in: ${row.name} from ${client.ip || "?"}`);
    return { device: this.toDevice(row, id), cookie: Auth.cookie(`${id}.${secret}`, COOKIE_MAX_AGE_S, client.secure) };
  }

  private touch(row: DeviceRow, ip: string): void {
    const now = Date.now();
    const last = this.lastTouched.get(row.id) ?? 0;
    if (now - last < SEEN_THROTTLE_MS && ip === row.last_ip) return;
    this.lastTouched.set(row.id, now);
    const iso = new Date(now).toISOString();
    this.db.prepare("UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?").run(iso, ip, row.id);
    row.last_seen_at = iso;
    row.last_ip = ip;
  }

  private toDevice(row: DeviceRow, currentId: string | null): AuthDevice {
    return {
      id: row.id,
      name: row.name,
      userAgent: row.user_agent,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      lastIp: row.last_ip,
      current: row.id === currentId,
    };
  }

  private sweepPairings(): void {
    const now = Date.now();
    for (const [code, expiresAt] of this.pairings) if (expiresAt <= now) this.pairings.delete(code);
  }

  private checkFailures(ip: string): void {
    const f = this.failures.get(ip);
    if (!f) return;
    if (f.resetAt <= Date.now()) {
      this.failures.delete(ip);
      return;
    }
    if (f.count >= FAIL_LIMIT) {
      const wait = Math.ceil((f.resetAt - Date.now()) / 60_000);
      throw new HttpError(429, `Too many failed logins; try again in ${wait} min.`);
    }
  }

  private recordFailure(ip: string): void {
    const now = Date.now();
    const f = this.failures.get(ip);
    if (!f || f.resetAt <= now) this.failures.set(ip, { count: 1, resetAt: now + FAIL_WINDOW_MS });
    else f.count += 1;
  }
}
