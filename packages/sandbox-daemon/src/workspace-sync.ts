import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { FS_TAR_PATH, FsTarRequest, type SyncFile, type SyncManifest } from "@sessionboxer/protocol";

const execFileAsync = promisify(execFile);
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Never part of a manifest: `.git` is not synced, the rest is build output nobody wants copied back. */
const SKIPPED_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__"]);

/**
 * Describes the Workspace for "Pull changes to my folder": every file with its hash, listed
 * the way git sees it when the Workspace is a repository (tracked + untracked-but-not-ignored,
 * so `node_modules` and the like stay in the box), otherwise by walking everything.
 */
export async function workspaceManifest(root: string): Promise<SyncManifest> {
  const listed = await gitListing(root);
  const files: SyncFile[] = [];
  for (const rel of listed ?? (await walk(root))) {
    const entry = await describe(root, rel);
    if (entry) files.push(entry);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, git: listed !== null };
}

async function gitListing(root: string): Promise<string[] | null> {
  try {
    const { stdout: top } = await execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"]);
    if ((await fs.realpath(top.trim())) !== (await fs.realpath(root))) return null;
  } catch {
    return null;
  }
  const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout.split("\0").filter((p) => p.length > 0 && p !== ".git" && !p.startsWith(".git/"));
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIPPED_DIRS.has(d.name)) await visit(abs);
      } else if (d.isFile() || d.isSymbolicLink()) {
        out.push(relative(root, abs).split(sep).join("/"));
      }
    }
  };
  await visit(root);
  return out;
}

async function describe(root: string, rel: string): Promise<SyncFile | null> {
  const abs = join(root, rel);
  let st;
  try {
    st = await fs.lstat(abs);
  } catch {
    return null; // listed by git but gone from the working tree
  }
  if (st.isSymbolicLink()) {
    return { path: rel, size: 0, executable: false, sha256: null, link: await fs.readlink(abs) };
  }
  if (!st.isFile()) return null;
  return { path: rel, size: st.size, executable: (st.mode & 0o111) !== 0, sha256: await sha256(abs), link: null };
}

function sha256(abs: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(abs)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/**
 * `POST /fs/tar` with `{ paths: [...] }`: streams those Workspace files as a tar archive
 * (the box's own `tar`, paths fed on stdin), for the Control Plane to unpack on the host.
 */
export function serveTar(root: string, req: IncomingMessage, res: ServerResponse, log: (msg: string) => void): boolean {
  const url = new URL(req.url ?? "/", "http://daemon");
  if (url.pathname !== FS_TAR_PATH) return false;
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return true;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) req.destroy();
    else chunks.push(c);
  });
  req.on("end", () => {
    let paths: string[];
    try {
      paths = FsTarRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).paths;
      const absRoot = resolve(root);
      for (const p of paths) {
        const abs = resolve(absRoot, p);
        if (p === "" || !abs.startsWith(absRoot + sep)) throw new Error(`path escapes the workspace: ${p}`);
      }
    } catch (e) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end(e instanceof Error ? e.message : String(e));
      return;
    }
    // --no-recursion + explicit list: exactly the requested files, no directory walking.
    const tar = spawn("tar", ["-c", "--no-recursion", "--null", "-T", "-", "-f", "-"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    tar.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    res.writeHead(200, { "Content-Type": "application/x-tar" });
    tar.stdout.pipe(res);
    tar.on("error", (e) => {
      log(`tar failed to start: ${String(e)}`);
      res.destroy();
    });
    tar.on("close", (code) => {
      if (code !== 0) {
        log(`tar exited ${code}: ${stderr.trim().slice(-500)}`);
        res.destroy();
      }
    });
    res.on("close", () => tar.kill());
    tar.stdin.on("error", () => undefined);
    tar.stdin.end(paths.map((p) => `${p}\0`).join(""));
  });
  return true;
}
