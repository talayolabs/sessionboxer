import type Database from "better-sqlite3";
import type { PushMessage, PushStatus, PushSubscribeRequest } from "@sessionboxer/protocol";
import { HttpError } from "./http-error.js";
import { deliver, type VapidKeys } from "./web-push.js";

interface SubscriptionRow {
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** RFC 8292 wants a contact for the push service's operator; the project page is what we have. */
const VAPID_SUBJECT = "https://sessionboxer.talayolabs.com";

/**
 * Web Push to the browsers that asked for it (one subscription per logged-in device, gone with
 * the device). A push goes to every subscribed device except those with a page on screen right
 * now — they watch the change happen over their WebSocket; a phone that is asleep has none.
 */
export class PushNotifier {
  /** Device id → number of its UI WebSockets whose page is currently visible. */
  private readonly visible = new Map<string, number>();

  constructor(
    private readonly db: Database.Database,
    private readonly vapid: () => VapidKeys,
    private readonly log: (msg: string) => void,
  ) {}

  status(deviceId: string | null): PushStatus {
    const subscribed = deviceId !== null && this.db.prepare("SELECT 1 FROM push_subscriptions WHERE device_id = ?").get(deviceId) !== undefined;
    return { publicKey: this.vapid().publicKey, subscribed };
  }

  /** Registers (or replaces) the browser's subscription for the device that sent it. */
  subscribe(deviceId: string, sub: PushSubscribeRequest): void {
    const url = new URL(sub.endpoint);
    if (url.protocol !== "https:") throw new HttpError(400, "Push endpoints must be https.");
    this.db
      .prepare(
        "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at",
      )
      .run(deviceId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString());
    this.log(`push: device ${deviceId} subscribed at ${url.host}`);
  }

  unsubscribe(deviceId: string): void {
    const res = this.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?").run(deviceId);
    if (res.changes > 0) this.log(`push: device ${deviceId} unsubscribed`);
  }

  /** A UI WebSocket of this device reported its page on screen. */
  pageShown(deviceId: string): void {
    this.visible.set(deviceId, (this.visible.get(deviceId) ?? 0) + 1);
  }

  /** …and hidden again (or the socket closed while it was visible). */
  pageHidden(deviceId: string): void {
    const n = (this.visible.get(deviceId) ?? 0) - 1;
    if (n <= 0) this.visible.delete(deviceId);
    else this.visible.set(deviceId, n);
  }

  /** To every subscribed device without a visible page, or `only` that device (a test), in the background. */
  send(message: PushMessage, only?: string): void {
    const rows = (
      only ? this.db.prepare("SELECT * FROM push_subscriptions WHERE device_id = ?").all(only) : this.db.prepare("SELECT * FROM push_subscriptions").all()
    ) as SubscriptionRow[];
    const targets = only ? rows : rows.filter((r) => !this.visible.has(r.device_id));
    if (targets.length === 0) return;
    const payload = JSON.stringify(message);
    for (const row of targets) {
      void deliver(row.endpoint, { p256dh: row.p256dh, auth: row.auth }, payload, this.vapid(), VAPID_SUBJECT).then(
        (res) => {
          if (res.ok) return;
          if (res.gone) {
            this.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?").run(row.device_id, row.endpoint);
            this.log(`push: device ${row.device_id} subscription gone (${res.status}), forgotten`);
          } else this.log(`push: device ${row.device_id} failed: ${res.error}`);
        },
        (e: unknown) => this.log(`push: device ${row.device_id} failed: ${String(e)}`),
      );
    }
  }
}
