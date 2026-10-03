// ---------------------------------------------------------------------------
// Workspace files. Paths are relative to the Workspace root; the Daemon rejects escapes.
// ---------------------------------------------------------------------------

// Raw (binary) Workspace files are served over HTTP rather than JSON-RPC, so the browser can
// stream a video with Range requests: Daemon `GET /fs/raw?path=…`, proxied by the Control Plane
// as `GET /api/sessions/:id/fs/raw?path=…[&download=1]`.
export const FS_RAW_PATH = "/fs/raw";
/**
 * A self-contained HTML file of the Workspace, served to run as a sandboxed "Artifact" (ADR-0078):
 * Daemon `GET /fs/app?path=…`, proxied as `GET /api/sessions/:id/fs/app?path=…`. Same file access as
 * `/fs/raw`, but the response carries a `Content-Security-Policy` whose `sandbox` directive gives the
 * document an opaque origin wherever it is opened, and files above `HTML_APP_MAX_BYTES` are refused
 * (413). `/fs/raw` keeps serving `.html` as an attachment that never runs.
 */
export const FS_APP_PATH = "/fs/app";
export const HTML_APP_MAX_BYTES = 16 * 1024 * 1024;
/** Inline cards run an HTML Artifact on sight up to this size; bigger ones wait for Run. */
export const HTML_APP_AUTORUN_BYTES = 2 * 1024 * 1024;
/** The CSP an HTML Artifact runs under: opaque origin, no network but the CDN allowlist, nothing framed or submitted. */
export function htmlAppCsp(cdns: readonly string[]): string {
  const allow = cdns.length ? ` ${cdns.join(" ")}` : "";
  return [
    "sandbox allow-scripts allow-pointer-lock",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval'${allow}`,
    `style-src 'unsafe-inline'${allow}`,
    `img-src data: blob:${allow}`,
    `font-src data:${allow}`,
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
/**
 * `PUT /fs/upload?name=<file name>` with the bytes as the body (and their `Content-Type`) stores a
 * prompt attachment under `UPLOADS_DIR` and answers with the `PromptAttachment`.
 */
export const FS_UPLOAD_PATH = "/fs/upload";
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
