import WebSocket, { type RawData } from "ws";

export interface BridgeOptions {
  /** Prefix of the log lines (`desktop`, `code ws`). */
  name: string;
  /** The close reason the browser gets when the upstream errors. */
  unreachable: string;
  /** What to relay to the browser when the upstream closes. */
  upstreamClosed: (code: number, reason: Buffer) => { code: number; reason: string };
}

/**
 * Pipes a browser WebSocket to an upstream one in both directions: client frames sent before the
 * upstream opens are buffered, closing or failing either side closes the other.
 */
export function bridgeSockets(client: WebSocket, upstream: WebSocket, opts: BridgeOptions, log: (msg: string) => void): void {
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
    // Always send a status code: websockify echoes a status-less close frame
    // back as the reserved code 1005, which `ws` rejects as an invalid frame.
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(1000);
  };
  client.on("close", () => closeBoth());
  upstream.on("close", (code, reason) => {
    const relayed = opts.upstreamClosed(code, reason);
    closeBoth(relayed.code, relayed.reason);
  });
  client.on("error", (e) => {
    log(`${opts.name} client error: ${e.message}`);
    closeBoth();
  });
  upstream.on("error", (e) => {
    log(`${opts.name} upstream error: ${e.message}`);
    closeBoth(1011, opts.unreachable);
  });
}
