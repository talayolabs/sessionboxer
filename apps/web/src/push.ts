import type { PushStatus } from "@sessionboxer/protocol";
import { api } from "./api";

/**
 * Web Push for this browser: the service worker (`/sw.js`) shows the notification and opens the
 * route it carries; the Control Plane holds one subscription per logged-in device.
 */

export type PushSupport = "ok" | "insecure" | "unsupported";

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") return "unsupported";
  return "ok";
}

/** Registers the service worker once per page; resolves to the active registration or null when unavailable. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (pushSupport() !== "ok") return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return reg;
  } catch {
    return null;
  }
}

/** Route changes requested by the service worker (a notification was tapped while the app was open). */
export function onServiceWorkerNavigate(handler: (hash: string) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => undefined;
  const listener = (evt: MessageEvent) => {
    const data: unknown = evt.data;
    if (typeof data !== "object" || data === null) return;
    const m = data as { type?: unknown; url?: unknown };
    if (m.type !== "navigate" || typeof m.url !== "string") return;
    const url = new URL(m.url, location.href);
    if (url.origin === location.origin) handler(url.hash || "#/");
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}

function toServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function browserSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

/**
 * What the Control Plane and the browser agree on. `subscribed` is only true when both hold a
 * subscription; a device the server forgot (revoke, 410 from the push service) is unsubscribed locally too.
 */
export async function pushState(): Promise<PushStatus & { permission: NotificationPermission }> {
  const status = await api.pushStatus();
  const permission = typeof Notification === "undefined" ? "denied" : Notification.permission;
  if (pushSupport() !== "ok") return { ...status, subscribed: false, permission };
  const local = await browserSubscription();
  if (status.subscribed && !local) {
    await api.pushUnsubscribe().catch(() => undefined);
    return { ...status, subscribed: false, permission };
  }
  if (!status.subscribed && local) await local.unsubscribe().catch(() => undefined);
  return { ...status, permission };
}

/** Asks for permission if needed, subscribes with the server's VAPID key and registers the subscription. */
export async function enablePush(): Promise<PushStatus> {
  const support = pushSupport();
  if (support === "insecure") throw new Error("Notifications need HTTPS (or localhost). Open Sessionboxer over the tunnel or a TLS address.");
  if (support === "unsupported") throw new Error("This browser cannot receive Web Push notifications. On iPhone, add Sessionboxer to the Home Screen first.");
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications were not allowed for this site.");
  const { publicKey } = await api.pushStatus();
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const current = sub.options.applicationServerKey;
    const same = current !== null && current !== undefined && toBase64Url(new Uint8Array(current)) === publicKey;
    if (!same) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toServerKey(publicKey) });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("The browser returned an incomplete push subscription.");
  return api.pushSubscribe({
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/** Forgets the subscription on both sides. */
export async function disablePush(): Promise<PushStatus> {
  const local = await browserSubscription().catch(() => null);
  if (local) await local.unsubscribe().catch(() => undefined);
  return api.pushUnsubscribe();
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
