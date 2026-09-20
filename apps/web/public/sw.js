// Sessionboxer service worker: Web Push only. Nothing is cached — the app is served by the
// Control Plane and must always match its API.
/// <reference lib="webworker" />

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** @returns {{ title: string, body: string, tag: string, url: string } | null} */
function parseMessage(event) {
  if (!event.data) return null;
  try {
    const m = event.data.json();
    if (typeof m.title !== "string" || typeof m.body !== "string") return null;
    return { title: m.title, body: m.body, tag: typeof m.tag === "string" ? m.tag : "sessionboxer", url: typeof m.url === "string" ? m.url : "#/" };
  } catch {
    return null;
  }
}

self.addEventListener("push", (event) => {
  const m = parseMessage(event);
  if (!m) return;
  event.waitUntil(
    self.registration.showNotification(m.title, {
      body: m.body,
      tag: m.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: m.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && typeof event.notification.data.url === "string" ? event.notification.data.url : "#/";
  const target = new URL(url, self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const app = clients.find((c) => new URL(c.url).origin === self.location.origin);
      if (app) {
        // A running page keeps its state (WebSocket, transcript); it only changes route.
        const focused = await app.focus();
        app.postMessage({ type: "navigate", url: target });
        return focused;
      }
      return self.clients.openWindow(target);
    }),
  );
});
