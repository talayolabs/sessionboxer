import type { IncomingMessage, ServerResponse } from "node:http";
import { McpExecutionTelemetry } from "@sessionboxer/protocol";

export function handleToolTelemetry(req: IncomingMessage, res: ServerResponse, record: (execution: McpExecutionTelemetry) => void): boolean {
  if (req.url !== "/telemetry/tool") return false;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) {
    res.writeHead(403).end();
    return true;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return true;
  }
  void (async () => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const execution = McpExecutionTelemetry.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    record(execution);
    res.writeHead(204).end();
  })().catch(() => {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  });
  return true;
}
