// The browser's live feed (ADR-0005): every broadcast of the Control Plane on one WebSocket, plus what the page tells back.
import { type Hono } from "hono";
import { UiClientMessage, type SessionBroadcast } from "@sessionboxer/protocol";
import { log } from "../log.js";
import { type AuthEnv } from "../auth.js";
import { type RouteDeps } from "./deps.js";

export function registerWsRoutes(api: Hono<AuthEnv>, deps: RouteDeps): void {
  const { sessions, push, upgradeWebSocket } = deps;
  api.get(
    "/ws",
    upgradeWebSocket((c) => {
      const p = c.get("principal");
      const deviceId = p.kind === "device" ? p.device.id : null;
      let unsubscribe: (() => void) | null = null;
      let visible = false;
      const viewerKey = {};
      const setVisible = (v: boolean): void => {
        if (v === visible || deviceId === null) return;
        visible = v;
        if (v) push.pageShown(deviceId);
        else push.pageHidden(deviceId);
      };
      return {
        onOpen(_evt, ws) {
          unsubscribe = sessions.subscribe((msg) => ws.send(JSON.stringify(msg)));
        },
        onMessage(evt, ws) {
          let raw: unknown;
          try {
            raw = JSON.parse(String(evt.data));
          } catch {
            return;
          }
          const parsed = UiClientMessage.safeParse(raw);
          if (!parsed.success) return;
          if (parsed.data.type === "visibility") setVisible(parsed.data.visible);
          else if (parsed.data.type === "viewing") sessions.setViewer(viewerKey, parsed.data.sessionId ? { sessionId: parsed.data.sessionId, pane: parsed.data.pane ?? "chat" } : null);
          else if (parsed.data.type === "ping") ws.send(JSON.stringify({ type: "pong" } satisfies SessionBroadcast));
        },
        onClose() {
          unsubscribe?.();
          setVisible(false);
          sessions.setViewer(viewerKey, null);
        },
        onError(err) {
          log(`ui ws error: ${String(err)}`);
        },
      };
    }),
  );
}
