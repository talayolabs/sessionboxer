import { randomBytes } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { FS_UPLOAD_PATH, MAX_UPLOAD_BYTES, UPLOADS_DIR, contentTypeFor, type PromptAttachment } from "@sessionboxer/protocol";

/** Keeps `/.sessionboxer/` out of `git status` (and so out of commits and of Pull-to-folder) without touching tracked files. */
const GIT_EXCLUDE_LINE = "/.sessionboxer/";

/**
 * Stores files the user attaches to a prompt: `PUT /fs/upload?name=<file name>`, bytes as the
 * body. Each file gets its own random directory under `UPLOADS_DIR`, so equal names never
 * collide and the Agent sees the original name.
 */
export class Uploads {
  private excluded = false;

  constructor(
    private readonly workspace: string,
    private readonly log: (msg: string) => void,
  ) {}

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://daemon");
    if (url.pathname !== FS_UPLOAD_PATH) return false;
    if (req.method !== "PUT") {
      res.writeHead(405, { Allow: "PUT" }).end();
      return true;
    }
    this.store(req, url.searchParams.get("name") ?? "")
      .then((attachment) => res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify(attachment)))
      .catch((e: unknown) => {
        const status = e instanceof UploadError ? e.status : 500;
        if (!(e instanceof UploadError)) this.log(`upload failed: ${String(e)}`);
        if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(e instanceof Error ? e.message : String(e));
      });
    return true;
  }

  private async store(req: IncomingMessage, rawName: string): Promise<PromptAttachment> {
    const name = safeName(rawName);
    if (!name) throw new UploadError(400, "the upload needs a file name (?name=)");
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > MAX_UPLOAD_BYTES) throw new UploadError(413, `files over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB cannot be attached`);

    const rel = join(UPLOADS_DIR, randomBytes(4).toString("hex"), name);
    const abs = join(this.workspace, rel);
    await fs.mkdir(join(abs, ".."), { recursive: true });
    await this.ensureGitExclude();

    let size = 0;
    const counter = async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) throw new UploadError(413, `files over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB cannot be attached`);
        yield chunk;
      }
    };
    try {
      await pipeline(req, counter, createWriteStream(abs, { mode: 0o644 }));
    } catch (e) {
      await fs.rm(join(abs, ".."), { recursive: true, force: true });
      throw e;
    }
    const mimeType = mimeTypeOf(req.headers["content-type"], name);
    this.log(`stored upload ${rel} (${size} bytes, ${mimeType})`);
    return { path: rel, name, size, mimeType };
  }

  private async ensureGitExclude(): Promise<void> {
    if (this.excluded) return;
    const gitDir = join(this.workspace, ".git");
    try {
      if (!(await fs.stat(gitDir)).isDirectory()) return;
    } catch {
      return;
    }
    const file = join(gitDir, "info", "exclude");
    let current = "";
    try {
      current = await fs.readFile(file, "utf8");
    } catch {
      // no exclude file yet
    }
    if (!current.split("\n").some((line) => line.trim() === GIT_EXCLUDE_LINE)) {
      await fs.mkdir(join(gitDir, "info"), { recursive: true });
      await fs.appendFile(file, `${current.endsWith("\n") || current === "" ? "" : "\n"}${GIT_EXCLUDE_LINE}\n`);
    }
    this.excluded = true;
  }
}

class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The file's base name with path separators and control characters removed; `""` when nothing usable is left. */
function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean === "" || clean === "." || clean === ".." ? "" : clean.slice(0, 255);
}

/** The browser's type when it has one, else by extension, else octet-stream. */
function mimeTypeOf(header: string | string[] | undefined, name: string): string {
  const given = (Array.isArray(header) ? header[0] : header)?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (given && given !== "application/octet-stream") return given;
  return contentTypeFor(name).split(";")[0]?.trim() ?? "application/octet-stream";
}
