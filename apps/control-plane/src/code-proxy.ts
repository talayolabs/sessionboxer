import WebSocket, { type RawData } from "ws";
import { CODE_PATH } from "@sessionboxer/protocol";

/** Hop-by-hop and framing headers that must not be copied between the two legs of the proxy. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
  "host",
  "content-length",
]);

/** Browser path of a Session's Code pane, which is also the `X-Forwarded-Prefix` VS Code gets. */
export function codePrefix(sessionId: string): string {
  return `/api/sessions/${sessionId}/code`;
}

/**
 * Headers telling openvscode-server the URL the browser sees, so the workbench it serves
 * links its assets and WebSocket under our prefix and host instead of the Daemon's.
 */
export function forwardedHeaders(prefix: string, browserHost: string | undefined, proto: string): Record<string, string> {
  const headers: Record<string, string> = { "x-forwarded-prefix": prefix, "x-forwarded-proto": proto };
  if (browserHost) headers["x-forwarded-host"] = browserHost;
  return headers;
}

/** `/api/sessions/<id>/code/x?y` → `http://daemon/code/x?y`. */
export function codeTarget(daemonBase: string, prefix: string, requestUrl: URL): URL {
  const rest = requestUrl.pathname.startsWith(prefix) ? requestUrl.pathname.slice(prefix.length) : "/";
  return new URL(`${CODE_PATH}${rest || "/"}${requestUrl.search}`, daemonBase);
}

/** Forwards one HTTP request to the Daemon's `/code` proxy and streams the answer back. */
export async function proxyCodeRequest(request: Request, target: URL, forwarded: Record<string, string>): Promise<Response> {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name)) headers.set(name, value);
  });
  // fetch transparently decodes compressed bodies while keeping the header; ask for identity.
  headers.set("accept-encoding", "identity");
  for (const [name, value] of Object.entries(forwarded)) headers.set(name, value);
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
    ...(hasBody ? { duplex: "half" as const } : {}),
  });
  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name) && name !== "content-encoding") out.set(name, value);
  });
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: out });
}

/**
 * Bridges the browser's VS Code WebSocket to the Daemon's `/code` proxy, buffering what the
 * browser sends before the upstream leg is open (VS Code talks first).
 */
export function bridgeCodeSocket(
  client: WebSocket,
  target: URL,
  forwarded: Record<string, string>,
  protocols: string | undefined,
  log: (msg: string) => void,
): void {
  const wsUrl = new URL(target);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const upstream = new WebSocket(wsUrl, protocols ? protocols.split(",").map((p) => p.trim()) : [], { headers: forwarded });
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
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(1000);
  };
  client.on("close", () => closeBoth());
  // 1004–1006 and 1015 are reserved and cannot be sent in a close frame.
  const sendable = (code: number): boolean => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014);
  upstream.on("close", (code, reason) => closeBoth(sendable(code) ? code : 1011, reason.toString()));
  client.on("error", (e) => {
    log(`code ws client error: ${e.message}`);
    closeBoth();
  });
  upstream.on("error", (e) => {
    log(`code ws upstream error: ${e.message}`);
    closeBoth(1011, "VS Code unreachable");
  });
}
