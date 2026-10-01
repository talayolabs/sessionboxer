import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_HTML_APP_CDNS, FS_APP_PATH, FS_RAW_PATH, HTML_APP_MAX_BYTES, contentTypeFor, htmlAppCsp, mediaKind } from "@sessionboxer/protocol";
import { FsError, type WorkspaceFs } from "./workspace-fs.js";

const MAX_AGE_HEADERS = { "Cache-Control": "no-cache", "Accept-Ranges": "bytes" };

/**
 * `GET /fs/raw?path=<workspace-relative>[&download=1]`: streams a Workspace file with its
 * media type and byte-range support, which is what `<video>` needs to seek. HTML is the one
 * kind that never runs from here: it goes out as an attachment, and `GET /fs/app?path=…` serves
 * it to run under the Artifact CSP (ADR-0078). Anything else on the Daemon's HTTP side is a 404
 * (the JSON-RPC API lives on the WebSocket upgrade).
 */
export async function serveRawFile(workspaceFs: WorkspaceFs, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://daemon");
  const app = url.pathname === FS_APP_PATH;
  if ((url.pathname !== FS_RAW_PATH && !app) || (req.method !== "GET" && req.method !== "HEAD")) {
    res.writeHead(404).end();
    return;
  }
  const rel = url.searchParams.get("path") ?? "";
  const html = mediaKind(rel) === "html";
  if (app && !html) {
    res.writeHead(415, { "Content-Type": "text/plain" }).end("Only .html/.htm files run as an app.");
    return;
  }
  let file;
  try {
    file = await workspaceFs.raw(rel);
  } catch (e) {
    const status = e instanceof FsError ? (e.code === -32001 ? 404 : e.code === -32002 ? 403 : 400) : 500;
    res.writeHead(status, { "Content-Type": "text/plain" }).end(e instanceof Error ? e.message : String(e));
    return;
  }
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  if (app) {
    if (file.size > HTML_APP_MAX_BYTES) {
      res.writeHead(413, { "Content-Type": "text/plain" }).end(`${name} is ${file.size} bytes; an HTML app may be at most ${HTML_APP_MAX_BYTES} bytes.`);
      return;
    }
    // The Control Plane replaces the CSP with one built from the configured CDN allowlist; this is the floor.
    const headers = {
      "Cache-Control": "no-store",
      "Content-Type": contentTypeFor(rel),
      "Content-Length": String(file.size),
      "Content-Security-Policy": htmlAppCsp(DEFAULT_HTML_APP_CDNS),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Last-Modified": file.mtime.toUTCString(),
    };
    res.writeHead(200, headers);
    if (req.method === "HEAD" || file.size === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(file.abs);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return;
  }
  const disposition = `${url.searchParams.get("download") || html ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`;
  const headers: Record<string, string> = {
    ...MAX_AGE_HEADERS,
    "Content-Type": contentTypeFor(rel),
    "Content-Disposition": disposition,
    "Last-Modified": file.mtime.toUTCString(),
  };
  if (html) headers["X-Content-Type-Options"] = "nosniff";
  const range = parseRange(req.headers.range, file.size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${file.size}` }).end();
    return;
  }
  const [start, end] = range ?? [0, file.size - 1];
  headers["Content-Length"] = String(file.size === 0 ? 0 : end - start + 1);
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || file.size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(file.abs, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function parseRange(header: string | undefined, size: number): [number, number] | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (size === 0) return "unsatisfiable";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "unsatisfiable";
  return [start, end];
}
