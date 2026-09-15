import WebSocket, { type RawData } from "ws";

/**
 * Bridges a browser WebSocket (noVNC RFB client) to the Sandbox's websockify
 * endpoint on the private Docker network, so the Desktop never needs a host port.
 */
export function bridgeDesktop(client: WebSocket, targetUrl: string, log: (msg: string) => void): void {
  const upstream = new WebSocket(targetUrl, ["binary"]);
  const pending: Array<{ data: RawData; binary: boolean }> = [];

  const forward = (to: WebSocket, data: RawData, binary: boolean): void => {
    if (to.readyState === WebSocket.OPEN) to.send(data, { binary });
  };

  client.on("message", (data, binary) => {
    if (upstream.readyState === WebSocket.OPEN) forward(upstream, data, binary);
    else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data, binary });
  });
  upstream.on("open", () => {
    for (const m of pending) forward(upstream, m.data, m.binary);
    pending.length = 0;
  });
  upstream.on("message", (data, binary) => forward(client, data, binary));

  const closeBoth = (code = 1000, reason = ""): void => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  };
  client.on("close", () => closeBoth());
  upstream.on("close", () => closeBoth(1011, "desktop connection closed"));
  client.on("error", (e) => {
    log(`desktop client error: ${e.message}`);
    closeBoth();
  });
  upstream.on("error", (e) => {
    log(`desktop upstream error: ${e.message}`);
    closeBoth(1011, "desktop unreachable");
  });
}
