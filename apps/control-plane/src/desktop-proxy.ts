import WebSocket from "ws";
import { bridgeSockets } from "./ws-bridge.js";

/**
 * Bridges a browser WebSocket (noVNC RFB client) to the Sandbox's websockify
 * endpoint on the private Docker network, so the Desktop never needs a host port.
 */
export function bridgeDesktop(client: WebSocket, targetUrl: string, log: (msg: string) => void): void {
  bridgeSockets(
    client,
    new WebSocket(targetUrl, ["binary"]),
    { name: "desktop", unreachable: "desktop unreachable", upstreamClosed: () => ({ code: 1011, reason: "desktop connection closed" }) },
    log,
  );
}
