import { promises as fs } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import {
  FS_MAX_FILE_BYTES,
  type FsChange,
  type FsEntry,
  type FsListResult,
  type FsReadResult,
  type FsWriteResult,
} from "@sessionboxer/protocol";

const CHANGE_DEBOUNCE_MS = 150;
const CHANGE_BATCH_MAX = 500;
/** Never watched: huge and never edited by hand in the UI. */
const UNWATCHED_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", ".cache"]);

export class FsError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Read/write access to the Workspace for the UI's file tree and editor, plus a
 * debounced change feed so open editors learn about writes made by the Agent.
 */
export class WorkspaceFs {
  private readonly root: string;
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, FsChange>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    root: string,
    private readonly onChanges: (changes: FsChange[]) => void,
    private readonly log: (msg: string) => void,
  ) {
    this.root = resolve(root);
  }

  /** Maps a Workspace-relative path to an absolute one, refusing to leave the root. */
  private absolute(rel: string): string {
    const abs = resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new FsError(-32602, `path escapes the workspace: ${rel}`);
    }
    return abs;
  }

  /** `absolute()` plus a realpath check, so symlinks cannot point reads/writes outside the root either. */
  private async contained(rel: string): Promise<string> {
    const abs = this.absolute(rel);
    let real;
    try {
      real = await fs.realpath(abs);
    } catch (e) {
      throw mapError(e, rel);
    }
    const realRoot = await fs.realpath(this.root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new FsError(-32002, `${rel} resolves outside the workspace`);
    }
    return abs;
  }

  private relativeOf(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }

  async list(rel: string): Promise<FsListResult> {
    const dir = this.absolute(rel);
    let names;
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      throw mapError(e, rel);
    }
    const entries: FsEntry[] = [];
    for (const d of names) {
      const type: FsEntry["type"] = d.isDirectory() ? "dir" : d.isFile() ? "file" : d.isSymbolicLink() ? "symlink" : "other";
      let size = 0;
      let mtime = new Date(0).toISOString();
      try {
        const st = await fs.stat(resolve(dir, d.name));
        size = st.size;
        mtime = st.mtime.toISOString();
        if (type === "symlink") entries.push({ name: d.name, type: st.isDirectory() ? "dir" : "file", size, mtime });
        else entries.push({ name: d.name, type, size, mtime });
      } catch {
        entries.push({ name: d.name, type: type === "symlink" ? "other" : type, size, mtime });
      }
    }
    entries.sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name));
    return { path: this.relativeOf(dir), entries };
  }

  async read(rel: string): Promise<FsReadResult> {
    const abs = await this.contained(rel);
    let st;
    try {
      st = await fs.stat(abs);
    } catch (e) {
      throw mapError(e, rel);
    }
    if (st.isDirectory()) throw new FsError(-32602, `${rel} is a directory`);
    const base = { path: this.relativeOf(abs), size: st.size, mtime: st.mtime.toISOString() };
    if (st.size > FS_MAX_FILE_BYTES) return { ...base, binary: false, truncated: true };
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) return { ...base, binary: true, truncated: false };
    return { ...base, content: buf.toString("utf8"), binary: false, truncated: false };
  }

  /** Absolute path and size of a regular file, for streaming it as-is (`GET /fs/raw`). */
  async raw(rel: string): Promise<{ abs: string; size: number; mtime: Date }> {
    const abs = await this.contained(rel);
    let st;
    try {
      st = await fs.stat(abs);
    } catch (e) {
      throw mapError(e, rel);
    }
    if (!st.isFile()) throw new FsError(-32602, `${rel} is not a file`);
    return { abs, size: st.size, mtime: st.mtime };
  }

  async write(rel: string, content: string): Promise<FsWriteResult> {
    const abs = this.absolute(rel);
    if (abs === this.root) throw new FsError(-32602, "cannot write the workspace root");
    // Existing file: it may be a symlink, follow it. New file: its parent may be.
    const exists = await fs.access(abs).then(
      () => true,
      () => false,
    );
    await this.contained(exists ? rel : this.relativeOf(dirname(abs)));
    try {
      await fs.writeFile(abs, content, "utf8");
      const st = await fs.stat(abs);
      return { path: this.relativeOf(abs), size: st.size, mtime: st.mtime.toISOString() };
    } catch (e) {
      throw mapError(e, rel);
    }
  }

  startWatching(): void {
    if (this.watcher) return;
    const root = this.root;
    this.watcher = watch(root, {
      ignoreInitial: true,
      ignored: (path) => relative(root, path).split(sep).some((p) => UNWATCHED_DIRS.has(p)),
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    const queue = (kind: FsChange["kind"], isDir: boolean) => (path: string) => {
      const rel = this.relativeOf(path);
      if (rel === "") return;
      this.pending.set(rel, { path: rel, kind, isDir });
      if (this.pending.size >= CHANGE_BATCH_MAX) this.flush();
      else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), CHANGE_DEBOUNCE_MS);
    };
    this.watcher
      .on("add", queue("created", false))
      .on("change", queue("modified", false))
      .on("unlink", queue("deleted", false))
      .on("addDir", queue("created", true))
      .on("unlinkDir", queue("deleted", true))
      .on("error", (e) => this.log(`fs watcher error: ${String(e)}`));
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    const changes = [...this.pending.values()];
    this.pending = new Map();
    this.onChanges(changes);
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}

function mapError(e: unknown, rel: string): Error {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT") return new FsError(-32001, `not found: ${rel}`);
  if (code === "EACCES" || code === "EPERM") return new FsError(-32002, `permission denied: ${rel}`);
  if (code === "EISDIR") return new FsError(-32602, `${rel} is a directory`);
  if (code === "ENOTDIR") return new FsError(-32602, `${rel} is not a directory`);
  return e instanceof Error ? e : new Error(String(e));
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** NUL bytes or invalid UTF-8 in the head of the file: not something Monaco should show as text. */
function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 8000));
  for (const b of head) if (b === 0) return true;
  try {
    // The head may split a multi-byte sequence; a full decode is bounded by FS_MAX_FILE_BYTES anyway.
    utf8.decode(buf);
    return false;
  } catch {
    return true;
  }
}
