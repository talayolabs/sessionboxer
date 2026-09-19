import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { rootCertificates } from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { LlmCall, LlmCallKind, LlmCallUsage, LlmRequestShape } from "@sessionboxer/protocol";

/** Per-body copy cap (decoded bytes); what follows is forwarded but not kept. */
const BODY_CAP = 4 * 1024 * 1024;
/** Calls whose bodies stay on tmpfs; older ones keep their summary only. */
const KEEP_BODIES = 40;
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a finished call's summary waits for the Agent's own updates about it (see `record`). */
const EMIT_DELAY_MS = 1000;

const EXTRA_CA_FILE = "/usr/local/share/ca-certificates/sessionboxer-extra.crt";

/** Headers that describe the hop, not the message; never forwarded. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export interface LlmInspectorOptions {
  port: number;
  /** Where the calls go: the `ANTHROPIC_BASE_URL` configured for the Sandbox, or Anthropic. */
  upstream: string;
  /** tmpfs directory for the bodies. */
  dir: string;
  log: (msg: string) => void;
  onCall: (call: LlmCall) => void;
}

/** Fields read from a Messages API request body for the summary; nothing else is parsed. */
interface MessagesRequest {
  model?: unknown;
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
}

interface MessagesUsage {
  input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  output_tokens?: unknown;
}

interface MessagesResponse {
  id?: unknown;
  stop_reason?: unknown;
  usage?: MessagesUsage;
}

interface SseEvent {
  type?: unknown;
  message?: MessagesResponse;
  delta?: { stop_reason?: unknown };
  usage?: MessagesUsage;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function jsonChars(v: unknown): number {
  if (v === undefined) return 0;
  if (typeof v === "string") return v.length;
  return JSON.stringify(v).length;
}

/** Decodes a body per its `content-encoding`; returns the bytes as they were when unknown. */
function decode(body: Buffer, encoding: string | undefined): Buffer {
  try {
    switch ((encoding ?? "identity").trim().toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return gunzipSync(body);
      case "deflate":
        return inflateSync(body);
      case "br":
        return brotliDecompressSync(body);
      default:
        return body;
    }
  } catch {
    return body;
  }
}

function shapeOf(req: MessagesRequest): LlmRequestShape {
  const system = req.system;
  const tools = Array.isArray(req.tools) ? req.tools : [];
  const messages = Array.isArray(req.messages) ? req.messages : [];
  return {
    systemBlocks: Array.isArray(system) ? system.length : typeof system === "string" ? 1 : 0,
    systemChars: jsonChars(system),
    tools: tools.length,
    toolsChars: jsonChars(req.tools),
    messages: messages.length,
    messagesChars: jsonChars(req.messages),
    maxTokens: num(req.max_tokens),
    stream: req.stream === true,
  };
}

function usageOf(u: MessagesUsage | undefined): LlmCallUsage | null {
  if (!u) return null;
  return {
    inputTokens: num(u.input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    outputTokens: num(u.output_tokens),
  };
}

/** `message.id`, `stop_reason` and `usage` from a Messages reply, JSON or SSE. */
function summarizeResponse(text: string, streamed: boolean): Pick<LlmCall, "messageId" | "stopReason" | "usage"> {
  const out: Pick<LlmCall, "messageId" | "stopReason" | "usage"> = { messageId: null, stopReason: null, usage: null };
  if (!streamed) {
    try {
      const parsed = JSON.parse(text) as MessagesResponse;
      out.messageId = str(parsed.id);
      out.stopReason = str(parsed.stop_reason);
      out.usage = usageOf(parsed.usage);
    } catch {
      // Not JSON (an HTML error page from a proxy, …).
    }
    return out;
  }
  let usage = null as LlmCallUsage | null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let ev: SseEvent;
    try {
      ev = JSON.parse(line.slice(5).trim()) as SseEvent;
    } catch {
      continue;
    }
    if (ev.type === "message_start" && ev.message) {
      out.messageId = str(ev.message.id);
      usage = usageOf(ev.message.usage);
    } else if (ev.type === "message_delta") {
      out.stopReason = str(ev.delta?.stop_reason) ?? out.stopReason;
      const delta = usageOf(ev.usage);
      if (delta) {
        usage = {
          inputTokens: delta.inputTokens ?? usage?.inputTokens ?? null,
          cacheReadTokens: delta.cacheReadTokens ?? usage?.cacheReadTokens ?? null,
          cacheWriteTokens: delta.cacheWriteTokens ?? usage?.cacheWriteTokens ?? null,
          outputTokens: delta.outputTokens ?? usage?.outputTokens ?? null,
        };
      }
    }
  }
  out.usage = usage;
  return out;
}

function kindOf(path: string, req: MessagesRequest | null): LlmCallKind {
  const p = path.split("?")[0] ?? path;
  if (p.endsWith("/v1/messages/count_tokens")) return "count_tokens";
  if (!p.endsWith("/v1/messages") || !req) return "other";
  return Array.isArray(req.tools) && req.tools.length > 0 ? "turn" : "side";
}

/** Copies up to `cap` bytes of a stream while counting all of it. */
class Capture {
  private readonly chunks: Buffer[] = [];
  bytes = 0;
  kept = 0;
  get truncated(): boolean {
    return this.bytes > this.kept;
  }
  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.kept >= BODY_CAP) return;
    const room = BODY_CAP - this.kept;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(part);
    this.kept += part.length;
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Loopback reverse proxy for the Agent's model API calls: forwards every request to the
 * configured upstream unchanged (headers included, but never recorded), streams the reply back
 * as it arrives, and keeps the decoded request and response bodies of the last `KEEP_BODIES`
 * calls on tmpfs. Summaries of every call go to `onCall`.
 */
export class LlmInspector {
  private server: Server | null = null;
  private readonly upstream: URL;
  private readonly calls: LlmCall[] = [];
  private readonly withBodies: string[] = [];
  private httpsAgent: HttpsAgent | null = null;
  private httpsAgentCa: string | null = null;
  private pendingEmit: { call: LlmCall; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly opts: LlmInspectorOptions) {
    this.upstream = new URL(opts.upstream);
  }

  get upstreamUrl(): string {
    return this.upstream.toString();
  }

  get listening(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    rmSync(this.opts.dir, { recursive: true, force: true });
    mkdirSync(this.opts.dir, { recursive: true });
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        this.opts.log(`llm inspector: ${String(e)}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        if (!res.writableEnded) res.end(JSON.stringify({ type: "error", error: { type: "sessionboxer_inspector_error", message: String(e) } }));
      });
    });
    server.keepAliveTimeout = 65_000;
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.opts.log(`llm inspector listening on 127.0.0.1:${this.opts.port} -> ${this.upstream.origin}${this.upstream.pathname === "/" ? "" : this.upstream.pathname}`);
  }

  /** Emits the summary still held back, if any (the turn ended: nothing more is coming for it). */
  flush(): void {
    const pending = this.pendingEmit;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingEmit = null;
    this.opts.onCall(pending.call);
  }

  list(): { calls: LlmCall[]; withBodies: string[] } {
    return { calls: [...this.calls], withBodies: [...this.withBodies] };
  }

  body(id: string): { call: LlmCall | null; request: string | null; response: string | null } {
    const call = this.calls.find((c) => c.id === id) ?? null;
    if (!call || !this.withBodies.includes(id)) return { call, request: null, response: null };
    return { call, request: this.readBody(id, "request"), response: this.readBody(id, "response") };
  }

  private readBody(id: string, part: "request" | "response"): string | null {
    const file = `${this.opts.dir}/${id}.${part}`;
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  private agentFor(): HttpsAgent {
    const extra = existsSync(EXTRA_CA_FILE) ? readFileSync(EXTRA_CA_FILE, "utf8") : "";
    if (!this.httpsAgent || this.httpsAgentCa !== extra) {
      this.httpsAgent?.destroy();
      this.httpsAgent = new HttpsAgent({ keepAlive: true, ca: extra ? [...rootCertificates, extra] : undefined });
      this.httpsAgentCa = extra;
    }
    return this.httpsAgent;
  }

  private forwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || HOP_HEADERS.has(name.toLowerCase())) continue;
      out[name] = value;
    }
    out.host = this.upstream.host;
    return out;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.flush();
    const startedAt = new Date();
    const started = performance.now();
    const requestCapture = new Capture();
    const requestChunks: Buffer[] = [];
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      requestChunks.push(buf);
    }
    const rawRequest = Buffer.concat(requestChunks);
    const decodedRequest = decode(rawRequest, req.headers["content-encoding"]);
    requestCapture.push(decodedRequest);

    const path = req.url ?? "/";
    const basePath = this.upstream.pathname.replace(/\/$/, "");
    let parsedRequest: MessagesRequest | null = null;
    try {
      const parsed: unknown = JSON.parse(decodedRequest.toString("utf8"));
      if (parsed && typeof parsed === "object") parsedRequest = parsed as MessagesRequest;
    } catch {
      // Not a JSON body.
    }

    const call: LlmCall = {
      id: randomUUID(),
      ordinal: 0,
      kind: kindOf(path, parsedRequest),
      method: req.method ?? "GET",
      path,
      model: parsedRequest ? str(parsedRequest.model) : null,
      status: null,
      error: null,
      startedAt: startedAt.toISOString(),
      durationMs: null,
      requestBytes: requestCapture.bytes,
      requestTruncated: requestCapture.truncated,
      responseBytes: 0,
      responseTruncated: false,
      streamed: false,
      messageId: null,
      stopReason: null,
      usage: null,
      shape: parsedRequest && isMessagesPath(path) ? shapeOf(parsedRequest) : null,
    };

    const headers = this.forwardHeaders(req.headers);
    headers["content-length"] = String(rawRequest.length);
    const isHttps = this.upstream.protocol === "https:";
    const options = {
      method: call.method,
      host: this.upstream.hostname,
      port: this.upstream.port || (isHttps ? 443 : 80),
      path: `${basePath}${path}`,
      headers,
      timeout: UPSTREAM_TIMEOUT_MS,
      ...(isHttps ? { agent: this.agentFor() } : {}),
    };

    const responseCapture = new Capture();
    const rawResponseChunks: Buffer[] = [];
    let responseEncoding: string | undefined;
    await new Promise<void>((resolve) => {
      const finish = (error: string | null): void => {
        call.error = call.error ?? error;
        call.durationMs = Math.round(performance.now() - started);
        resolve();
      };
      const upstreamReq = (isHttps ? httpsRequest : httpRequest)(options, (upstreamRes) => {
        call.status = upstreamRes.statusCode ?? null;
        responseEncoding = upstreamRes.headers["content-encoding"];
        call.streamed = (upstreamRes.headers["content-type"] ?? "").toLowerCase().includes("text/event-stream");
        const outHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined || HOP_HEADERS.has(name.toLowerCase())) continue;
          outHeaders[name] = value;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        if (call.streamed) res.flushHeaders();
        upstreamRes.on("data", (chunk: Buffer) => {
          rawResponseChunks.push(chunk);
          res.write(chunk);
        });
        upstreamRes.on("end", () => {
          res.end();
          finish(null);
        });
        upstreamRes.on("error", (e) => {
          res.destroy();
          finish(`upstream response failed: ${e.message}`);
        });
      });
      upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream timed out")));
      upstreamReq.on("error", (e) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "sessionboxer_inspector_error", message: `upstream ${this.upstream.origin}: ${e.message}` } }));
        } else {
          res.destroy();
        }
        finish(`upstream ${this.upstream.origin}: ${e.message}`);
      });
      req.on("close", () => {
        if (!res.writableEnded) {
          upstreamReq.destroy();
          finish("client closed the connection");
        }
      });
      upstreamReq.end(rawRequest);
    });

    const rawResponse = Buffer.concat(rawResponseChunks);
    const decodedResponse = decode(rawResponse, responseEncoding);
    responseCapture.push(decodedResponse);
    call.responseBytes = responseCapture.bytes;
    call.responseTruncated = responseCapture.truncated;
    Object.assign(call, summarizeResponse(decodedResponse.toString("utf8"), call.streamed));

    this.record(call, requestCapture.buffer(), responseCapture.buffer());
  }

  private record(call: LlmCall, request: Buffer, response: Buffer): void {
    this.calls.push(call);
    try {
      writeFileSync(`${this.opts.dir}/${call.id}.request`, request);
      writeFileSync(`${this.opts.dir}/${call.id}.response`, response);
      this.withBodies.push(call.id);
      while (this.withBodies.length > KEEP_BODIES) {
        const evicted = this.withBodies.shift();
        if (!evicted) break;
        rmSync(`${this.opts.dir}/${evicted}.request`, { force: true });
        rmSync(`${this.opts.dir}/${evicted}.response`, { force: true });
      }
    } catch (e) {
      this.opts.log(`llm inspector: could not keep the bodies of ${call.id}: ${String(e)}`);
    }
    this.opts.log(
      `llm ${call.kind} ${call.method} ${call.path} -> ${call.status ?? "-"} ${call.requestBytes}B/${call.responseBytes}B ${call.durationMs ?? "?"}ms${call.error ? ` (${call.error})` : ""}`,
    );
    // The Agent reports the tool calls of a reply after reading it to the end, so the summary
    // goes out once those updates had their chance: after a pause, or when the next call starts.
    this.flush();
    this.pendingEmit = {
      call,
      timer: setTimeout(() => this.flush(), EMIT_DELAY_MS),
    };
  }
}

function isMessagesPath(path: string): boolean {
  const p = path.split("?")[0] ?? path;
  return p.endsWith("/v1/messages") || p.endsWith("/v1/messages/count_tokens");
}
