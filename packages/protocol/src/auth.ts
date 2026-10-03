// ---------------------------------------------------------------------------
// Access: who may talk to the Control Plane (`/api/auth/...`)
// ---------------------------------------------------------------------------

import { z } from "zod";
import { PrActivity } from "./pull-requests.js";

/**
 * A browser that logged in: it holds a long-lived HttpOnly cookie whose secret is stored hashed.
 * `id` is what the Devices list shows and what revocation names.
 */
export const AuthDevice = z.object({
  id: z.string(),
  /** Label given at login, else derived from the user agent ("Chrome on Android"). */
  name: z.string(),
  userAgent: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  /** Client address of the last request, as the Control Plane saw it (proxy-forwarded when `X-Forwarded-For` is trusted). */
  lastIp: z.string(),
  /** Whether this is the device making the request. */
  current: z.boolean(),
  /** Whether this browser registered for Web Push notifications (see `PushStatus`). */
  push: z.boolean(),
});
export type AuthDevice = z.infer<typeof AuthDevice>;

export const AUTH_DEVICE_NAME_MAX = 80;

/** Exchanges the access token for a device cookie. */
export const AuthLoginRequest = z.object({
  token: z.string().min(1),
  name: z.string().max(AUTH_DEVICE_NAME_MAX).default(""),
});
export type AuthLoginRequest = z.infer<typeof AuthLoginRequest>;

/** Exchanges a one-time pairing code (from a QR / link made by a logged-in device) for a device cookie. */
export const AuthPairRedeemRequest = z.object({
  code: z.string().min(1),
  name: z.string().max(AUTH_DEVICE_NAME_MAX).default(""),
});
export type AuthPairRedeemRequest = z.infer<typeof AuthPairRedeemRequest>;

/** A pairing code: single use, valid until `expiresAt`; the UI puts it in `<origin>/#pair=<code>`. */
export const AuthPairing = z.object({
  code: z.string(),
  expiresAt: z.string(),
});
export type AuthPairing = z.infer<typeof AuthPairing>;

export const PAIRING_TTL_MS = 5 * 60_000;
/** Hash fragment carrying a pairing code, optionally followed by `&next=<route>` to land on. */
export const PAIR_FRAGMENT_KEY = "pair";

/** Who the current request is: a logged-in browser (`device`) or a bearer of the access token (`token`, CLI/scripts). */
export const AuthPrincipal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), device: AuthDevice }),
  z.object({ kind: z.literal("token") }),
]);
export type AuthPrincipal = z.infer<typeof AuthPrincipal>;

/**
 * The ways the Control Plane can make itself reachable from outside the local network, each a
 * child process it supervises while the transport is enabled in `Settings.tunnels`:
 * - `cloudflare`: `cloudflared tunnel --url` (no account), a random `https://….trycloudflare.com`, new at every start;
 * - `sessionboxer`: `frpc` dialling a Sessionboxer tunnel server (frps), a stable `https://<name>.<server domain>`;
 * - `ssh`: `ssh -R` to a server of yours, reached at the URL you give (your reverse proxy) or `http://<host>:<port>`.
 */
export const TunnelKind = z.enum(["cloudflare", "sessionboxer", "ssh"]);
export type TunnelKind = z.infer<typeof TunnelKind>;
export const TUNNEL_KINDS = TunnelKind.options;

/** Runtime state of one transport. `error` is the last failure while `starting`/`error`. */
export const TunnelStatus = z.object({
  state: z.enum(["off", "starting", "up", "error"]),
  url: z.string().nullable(),
  error: z.string().nullable(),
  /** Version of the program in use (`cloudflared`, `frpc`, `ssh`), once found or downloaded. */
  version: z.string().nullable(),
});
export type TunnelStatus = z.infer<typeof TunnelStatus>;

export const TunnelStatuses = z.object({ cloudflare: TunnelStatus, sessionboxer: TunnelStatus, ssh: TunnelStatus });
export type TunnelStatuses = z.infer<typeof TunnelStatuses>;

/**
 * How the Control Plane is reached remotely. `publicUrl` is what links and OAuth callbacks use
 * (`SESSIONBOXER_PUBLIC_URL`, else derived from the bind address); `tls` whether it serves HTTPS itself.
 * A pairing link carries the URL of the transport chosen for it (`pairingOrigin`).
 */
export const RemoteAccess = z.object({
  publicUrl: z.string(),
  tls: z.boolean(),
  /** Where the access token comes from; `env` cannot be rotated from the UI. */
  accessTokenSource: z.enum(["settings", "env"]),
  /** `X-Forwarded-*` from a reverse proxy are believed (`SESSIONBOXER_TRUST_PROXY=1`). */
  trustProxy: z.boolean(),
  tunnels: TunnelStatuses,
});
export type RemoteAccess = z.infer<typeof RemoteAccess>;

/** What a pairing link can point at: the configured public URL, or one of the transports. */
export const PairingTransport = z.enum(["local", ...TUNNEL_KINDS]);
export type PairingTransport = z.infer<typeof PairingTransport>;

/** The origin a pairing link over `transport` carries; `null` while that transport is not up. */
export function pairingOrigin(remote: RemoteAccess, transport: PairingTransport): string | null {
  if (transport === "local") return remote.publicUrl;
  const t = remote.tunnels[transport];
  return t.state === "up" && t.url ? t.url : null;
}

/** The Sessionboxer tunnel server a laptop dials by default (talayolabs' frps + registry). */
export const DEFAULT_TUNNEL_SERVER = "https://tunnel-sessionboxer.talayolabs.com";
/** What a tunnel name may look like (the server enforces the same rule and a list of reserved names). */
export const TUNNEL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

/** `GET <server>/api/v1/info`: how to reach a Sessionboxer tunnel server's frps and what URLs it hands out. */
export const TunnelServerInfo = z.object({
  service: z.literal("sessionboxer-tunnel"),
  domain: z.string().min(1),
  frps: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535), tls: z.boolean(), token: z.string().nullable() }),
  nameRule: z.string(),
  frpVersion: z.string(),
  grafana: z.string().nullable().optional(),
});
export type TunnelServerInfo = z.infer<typeof TunnelServerInfo>;

/** `GET <server>/api/v1/names/<name>` (proxied by the Control Plane as `GET /api/tunnels/sessionboxer/names/:name`). */
export const TunnelNameCheck = z.object({ name: z.string(), available: z.boolean(), reserved: z.boolean() });
export type TunnelNameCheck = z.infer<typeof TunnelNameCheck>;

/** Per-transport configuration (`Settings.tunnels`); `enabled` keeps the transport running across restarts. */
export const TunnelSettings = z.object({
  cloudflare: z.object({ enabled: z.boolean().default(false) }).default({}),
  sessionboxer: z
    .object({
      enabled: z.boolean().default(false),
      server: z.string().default(DEFAULT_TUNNEL_SERVER),
      /** The subdomain this laptop takes on the server; empty means a name derived from the hostname. */
      name: z.string().default(""),
      /** Generated once; the server binds the name to it at first login. Never shown. */
      secret: z.string().default(""),
    })
    .default({}),
  ssh: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default(""),
      port: z.number().int().min(1).max(65535).default(22),
      user: z.string().default(""),
      /** Private key file; empty uses the default keys and the agent. */
      identityFile: z.string().default(""),
      /** Port sshd listens on for the reverse forward (`-R`). */
      remotePort: z.number().int().min(1).max(65535).default(4000),
      /** `all` binds every interface on the server (needs `GatewayPorts yes`); `localhost` for a reverse proxy running there. */
      remoteBind: z.enum(["all", "localhost"]).default("all"),
      /** What the phone opens; empty means `http://<host>:<remotePort>`. */
      publicUrl: z.string().default(""),
    })
    .default({}),
});
export type TunnelSettings = z.infer<typeof TunnelSettings>;

/** `TunnelSettings` as the UI sees it: the frp secret replaced by whether it exists. */
export const PublicTunnelSettings = TunnelSettings.extend({
  sessionboxer: TunnelSettings.shape.sessionboxer.removeDefault().omit({ secret: true }).extend({ secretSet: z.boolean() }),
});
export type PublicTunnelSettings = z.infer<typeof PublicTunnelSettings>;

/** Partial update of `TunnelSettings`; omitted fields keep what is stored. */
export const TunnelSettingsUpdate = z.object({
  cloudflare: TunnelSettings.shape.cloudflare.removeDefault().partial().optional(),
  sessionboxer: TunnelSettings.shape.sessionboxer.removeDefault().omit({ secret: true }).partial().optional(),
  ssh: TunnelSettings.shape.ssh.removeDefault().partial().optional(),
});
export type TunnelSettingsUpdate = z.infer<typeof TunnelSettingsUpdate>;

// --- Web Push -------------------------------------------------------------------------------------
// A phone that is asleep has no WebSocket; the browser's push service (RFC 8030) wakes its service
// worker instead. The Control Plane signs each push with its VAPID key (RFC 8292) and encrypts the
// payload to the subscription's keys (RFC 8291), so nothing readable passes the push service.

/** What `PushManager.subscribe()` gave the browser; the keys are stored for encryption and never returned. */
export const PushSubscribeRequest = z.object({
  endpoint: z.string().url().max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequest>;

/** Push state for the requesting device. `publicKey` is the VAPID public key, base64url, for `applicationServerKey`. */
export const PushStatus = z.object({
  publicKey: z.string(),
  subscribed: z.boolean(),
});
export type PushStatus = z.infer<typeof PushStatus>;

/** The (encrypted) body of a push: what the service worker shows and where a tap lands (a hash route). */
export const PushMessage = z.object({
  title: z.string(),
  body: z.string(),
  /** Notifications with the same tag replace each other. */
  tag: z.string(),
  /** Hash route to open, e.g. `#/sessions/<id>/pr/<prId>`. */
  url: z.string(),
});
export type PushMessage = z.infer<typeof PushMessage>;

/**
 * What the UI tells the Control Plane over its WebSocket. `visibility` says whether the page is on
 * screen: a device with a visible page gets no push (it sees the change live), every other device does.
 * `ping` asks for a `pong`: how the page finds out that a socket the browser still calls open is dead.
 */
export const UiClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("visibility"), visible: z.boolean() }),
  z.object({ type: z.literal("ping") }),
  /** Which Session page and pane this browser shows (`null`: none); what `whoami` reports as the user's open panes (ADR-0062). */
  z.object({ type: z.literal("viewing"), sessionId: z.string().nullable(), pane: z.string().max(40).nullable() }),
]);
export type UiClientMessage = z.infer<typeof UiClientMessage>;

/** Where a notification about a Session (or one of its PRs) should land. */
export function sessionRoute(sessionId: string, pane?: "prs" | `pr:${string}`): string {
  const base = `#/sessions/${sessionId}`;
  if (!pane) return base;
  return pane === "prs" ? `${base}/prs` : `${base}/pr/${pane.slice(3)}`;
}

/** One line about new activity on a PR ("3 new items from @a, @b (changes requested); check failed: CI"). */
export function prActivityLine(p: PrActivity): string {
  const parts: string[] = [];
  if (p.count > 0) {
    const who = p.authors.length <= 2 ? p.authors.map((a) => `@${a}`).join(", ") : `@${p.authors[0]} and ${p.authors.length - 1} others`;
    parts.push(`${p.count} new ${p.count === 1 ? "item" : "items"} from ${who}${p.changesRequested ? " (changes requested)" : ""}`);
  }
  if (p.failedChecks.length > 0) {
    const names = p.failedChecks.slice(0, 3).join(", ") + (p.failedChecks.length > 3 ? ` +${p.failedChecks.length - 3}` : "");
    parts.push(`${p.failedChecks.length === 1 ? "check failed" : `${p.failedChecks.length} checks failed`}: ${names}`);
  }
  return parts.join("; ");
}
