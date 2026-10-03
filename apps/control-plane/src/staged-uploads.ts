import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { FS_UPLOAD_PATH, MAX_UPLOAD_BYTES, PromptAttachment, contentTypeFor, type StagedUpload } from "@sessionboxer/protocol";
import { DATA_DIR } from "./config.js";
import { HttpError } from "./http-error.js";

const STAGING_DIR = join(DATA_DIR, "staging");
const STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Sits next to the file, keeping what the browser said the file was. */
const META_FILE = ".meta.json";

/** A staged file on disk, taken off the store by a create request. */
export type StagedFile = { staged: StagedUpload; path: string; dir: string };

const ID = /^[0-9a-f]{16}$/;
/** Claimed files move to `<id>.claimed`, out of reach of `remove()` (the browser deletes what it staged when the screen is left). */
const CLAIMED = ".claimed";

/**
 * Files attached on the New session screen, before there is a Sandbox to put them in: kept under
 * `<data>/staging/<id>/<name>` until the Session's Sandbox is up, then `PUT` into it through the
 * Daemon's upload endpoint like any other prompt attachment. Files nobody claims (the screen was
 * left, the Control Plane restarted) are swept after `STAGED_MAX_AGE_MS`.
 */
export class StagedUploads {
  constructor(private readonly log: (msg: string) => void) {}

  async store(body: ReadableStream<Uint8Array> | null, rawName: string, contentType: string | undefined, declaredLength: string | undefined): Promise<StagedUpload> {
    const name = safeName(rawName);
    if (!name) throw new HttpError(400, "the upload needs a file name (?name=)");
    if (!body) throw new HttpError(400, "the upload has no body");
    if (Number(declaredLength ?? "0") > MAX_UPLOAD_BYTES) throw new HttpError(413, `files over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB cannot be attached`);
    const id = randomBytes(8).toString("hex");
    const dir = join(STAGING_DIR, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let size = 0;
    const counter = async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, `files over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB cannot be attached`);
        yield chunk;
      }
    };
    const mimeType = mimeTypeOf(contentType, name);
    try {
      await pipeline(Readable.fromWeb(body as NodeReadableStream), counter, createWriteStream(join(dir, name), { mode: 0o600 }));
      await writeFile(join(dir, META_FILE), JSON.stringify({ mimeType }), { mode: 0o600 });
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    return { id, name, size, mimeType };
  }

  async remove(id: string): Promise<void> {
    if (!ID.test(id)) return;
    await rm(join(STAGING_DIR, id), { recursive: true, force: true });
  }

  /** Takes the files behind `ids` off the store, in order; a 400 names the first one that is not there any more. */
  async claim(ids: string[]): Promise<StagedFile[]> {
    const files: StagedFile[] = [];
    try {
      for (const id of ids) {
        if (!ID.test(id)) throw new HttpError(400, `unknown attachment ${id}`);
        const dir = join(STAGING_DIR, id + CLAIMED);
        await rename(join(STAGING_DIR, id), dir).catch(() => undefined);
        const name = (await readdir(dir).catch(() => [])).find((n) => n !== META_FILE);
        if (!name) throw new HttpError(400, `the attachment ${id} is no longer available; attach the file again`);
        const path = join(dir, name);
        const { size } = await stat(path);
        const meta = await readFile(join(dir, META_FILE), "utf8")
          .then((raw) => JSON.parse(raw) as { mimeType?: string })
          .catch((): { mimeType?: string } => ({}));
        files.push({ staged: { id, name, size, mimeType: meta.mimeType || contentTypeFor(name) }, path, dir });
      }
    } catch (e) {
      await this.release(files);
      throw e;
    }
    return files;
  }

  /** Puts claimed files back on the store, for a create request that failed after claiming them. */
  async release(files: StagedFile[]): Promise<void> {
    for (const { staged, dir } of files) await rename(dir, join(STAGING_DIR, staged.id)).catch(() => undefined);
  }

  /** Streams the files into a Sandbox through its Daemon and drops them from the store; answers with the prompt attachments. */
  async pushInto(daemonBase: string, files: StagedFile[]): Promise<PromptAttachment[]> {
    const out: PromptAttachment[] = [];
    for (const { staged, path, dir } of files) {
      const target = new URL(FS_UPLOAD_PATH, daemonBase);
      target.searchParams.set("name", staged.name);
      const res = await fetch(target, {
        method: "PUT",
        headers: { "content-type": staged.mimeType, "content-length": String(staged.size) },
        body: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
        ...{ duplex: "half" as const },
      });
      if (!res.ok) throw new Error(`${staged.name}: ${(await res.text()) || `upload failed (${res.status})`}`);
      out.push(PromptAttachment.parse(await res.json()));
      await rm(dir, { recursive: true, force: true });
    }
    return out;
  }

  /** Drops staged files older than a day; called at start-up and then now and again. */
  async sweep(): Promise<void> {
    const ids = await readdir(STAGING_DIR).catch(() => []);
    const cutoff = Date.now() - STAGED_MAX_AGE_MS;
    let swept = 0;
    for (const id of ids) {
      const dir = join(STAGING_DIR, id);
      const info = await stat(dir).catch(() => null);
      if (!info || info.mtimeMs > cutoff) continue;
      await rm(dir, { recursive: true, force: true });
      swept++;
    }
    if (swept > 0) this.log(`staged uploads: swept ${swept} unclaimed file(s)`);
  }
}

/** The browser's type when it has one, else by extension, else octet-stream (as the Daemon does). */
function mimeTypeOf(header: string | undefined, name: string): string {
  const given = header?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (given && given !== "application/octet-stream") return given;
  return contentTypeFor(name).split(";")[0]?.trim() ?? "application/octet-stream";
}

function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean === "" || clean === "." || clean === ".." ? "" : clean.slice(0, 255);
}
