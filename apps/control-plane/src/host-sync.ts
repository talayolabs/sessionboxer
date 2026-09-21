import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { SyncManifest, type SyncEntry, type SyncFile, type SyncPlan, type SyncResult } from "@sessionboxer/protocol";
import { extract } from "tar-fs";
import { DATA_DIR } from "./config.js";

const execFileAsync = promisify(execFile);
const SKIPPED_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const BASELINES_DIR = path.join(DATA_DIR, "sync");

/**
 * The host folder described like the Daemon describes the Workspace (`workspace-sync.ts`):
 * git's view (tracked + untracked-but-not-ignored, minus `.git`) inside a work tree, every file
 * elsewhere. `dir` must be canonical (see `resolveHostDir`).
 */
export async function hostManifest(dir: string): Promise<SyncManifest> {
  const listed = await gitListing(dir);
  const files: SyncFile[] = [];
  for (const rel of listed ?? (await walk(dir))) {
    const entry = await describe(dir, rel);
    if (entry) files.push(entry);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, git: listed !== null };
}

async function gitListing(dir: string): Promise<string[] | null> {
  try {
    await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
  const { stdout } = await execFileAsync("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout.split("\0").filter((p) => p.length > 0 && p !== ".git" && !p.startsWith(".git/"));
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIPPED_DIRS.has(d.name)) await visit(abs);
      } else if (d.isFile() || d.isSymbolicLink()) {
        out.push(path.relative(root, abs).split(path.sep).join("/"));
      }
    }
  };
  await visit(root);
  return out;
}

async function describe(root: string, rel: string): Promise<SyncFile | null> {
  const abs = path.join(root, rel);
  let st;
  try {
    st = await lstat(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return { path: rel, size: 0, executable: false, sha256: null, link: await readlink(abs) };
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

// --- Baselines --------------------------------------------------------------

/**
 * What the host folder looked like when it was copied into the box / last pulled, per copied
 * repository, so a later pull can tell a box change from a host change (three-way). Under
 * ~/.sessionboxer/sync as `<sessionId>-<repoId>.json` (`<sessionId>.json` for Sessions whose
 * one copied folder is the Workspace root).
 */
export class SyncBaselines {
  private file(sessionId: string, repoId: string | null): string {
    return path.join(BASELINES_DIR, repoId === null ? `${sessionId}.json` : `${sessionId}-${repoId}.json`);
  }

  async read(sessionId: string, repoId: string | null): Promise<SyncManifest | null> {
    try {
      return SyncManifest.parse(JSON.parse(await readFile(this.file(sessionId, repoId), "utf8")));
    } catch {
      return null;
    }
  }

  async write(sessionId: string, repoId: string | null, manifest: SyncManifest): Promise<void> {
    await mkdir(BASELINES_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${this.file(sessionId, repoId)}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest), { mode: 0o600 });
    await rename(tmp, this.file(sessionId, repoId));
  }

  async remove(sessionId: string, repoId: string | null): Promise<void> {
    await rm(this.file(sessionId, repoId), { force: true });
  }

  /** Every record of a Session (all its repositories). */
  async removeAll(sessionId: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(BASELINES_DIR);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === `${sessionId}.json` || name.startsWith(`${sessionId}-`)) await rm(path.join(BASELINES_DIR, name), { force: true });
    }
  }
}

// --- Planning -----------------------------------------------------------------

function same(a: SyncFile | undefined, b: SyncFile | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.sha256 === b.sha256 && a.link === b.link && a.executable === b.executable;
}

function byPath(m: SyncManifest): Map<string, SyncFile> {
  return new Map(m.files.map((f) => [f.path, f]));
}

/** A symlink is only written if it stays inside the folder (what tar-fs enforces on extraction). */
function blockedReason(f: SyncFile): string | null {
  if (f.link === null) return null;
  const root = "/folder";
  const target = path.posix.resolve(path.posix.dirname(`${root}/${f.path}`), f.link);
  if (path.posix.isAbsolute(f.link) || (target !== root && !target.startsWith(`${root}/`))) {
    return `symlink to ${f.link} points outside the folder`;
  }
  return null;
}

/**
 * Compares the box (`box`) with the host folder (`host`) file by file. With a baseline
 * (the state after the copy / last pull) changes are attributed: box-only changes are applied,
 * host-only changes kept, both-sides changes flagged as conflicts. Without one, adds and updates
 * are applied and deletes flagged (a file only the host has may well be new host work).
 */
export function planSync(repoId: string, dir: string, box: SyncManifest, host: SyncManifest, baseline: SyncManifest | null): SyncPlan {
  const b = byPath(box);
  const h = byPath(host);
  const base = baseline ? byPath(baseline) : null;
  const entries: SyncEntry[] = [];
  let unchanged = 0;
  let localOnly = 0;
  for (const p of new Set([...b.keys(), ...h.keys()])) {
    const inBox = b.get(p);
    const onHost = h.get(p);
    if (same(inBox, onHost)) {
      if (inBox) unchanged++;
      continue;
    }
    const was = base?.get(p);
    // Host still as recorded: the box moved. Box still as recorded: the host moved.
    const hostUntouched = base !== null && same(onHost, was);
    const boxUntouched = base !== null && same(inBox, was);
    if (boxUntouched) {
      localOnly++;
      continue;
    }
    if (inBox) {
      entries.push({
        path: p,
        action: onHost ? "update" : "add",
        size: inBox.size,
        conflict: base !== null && !hostUntouched,
        blocked: blockedReason(inBox),
      });
    } else {
      entries.push({ path: p, action: "delete", size: 0, conflict: !hostUntouched, blocked: null });
    }
  }
  entries.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { repoId, path: dir, entries, unchanged, localOnly, threeWay: baseline !== null, computedAt: new Date().toISOString() };
}

/** Entries a pull applies: everything non-conflicting, plus conflicts when the user overrides; never blocked ones. */
export function selectEntries(plan: SyncPlan, overwriteLocal: boolean): { apply: SyncEntry[]; skipped: SyncEntry[] } {
  const apply: SyncEntry[] = [];
  const skipped: SyncEntry[] = [];
  for (const e of plan.entries) (e.blocked === null && (overwriteLocal || !e.conflict) ? apply : skipped).push(e);
  return { apply, skipped };
}

/**
 * The baseline after a pull: the box's state for every file now identical on both sides or
 * just applied; the old record for files left alone (host-only changes, skipped conflicts).
 */
export function nextBaseline(box: SyncManifest, host: SyncManifest, baseline: SyncManifest | null, applied: SyncEntry[]): SyncManifest {
  const b = byPath(box);
  const h = byPath(host);
  const next = new Map(baseline ? byPath(baseline) : []);
  for (const [p, f] of b) if (same(f, h.get(p))) next.set(p, f);
  for (const p of next.keys()) if (!b.has(p) && !h.has(p)) next.delete(p);
  for (const e of applied) {
    const f = b.get(e.path);
    if (f) next.set(e.path, f);
    else next.delete(e.path);
  }
  const files = [...next.values()].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { files, git: box.git };
}

// --- Applying -------------------------------------------------------------------

/** Refuses paths whose existing ancestors lead outside `dir` (a symlinked directory on the host). */
async function assertInside(dir: string, rel: string): Promise<string> {
  const abs = path.resolve(dir, rel);
  if (abs === dir || !abs.startsWith(dir + path.sep)) throw new Error(`refusing to write outside the folder: ${rel}`);
  let probe = path.dirname(abs);
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== dir && !real.startsWith(dir + path.sep)) {
        throw new Error(`refusing to write through a symlink that leaves the folder: ${rel}`);
      }
      return abs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      probe = path.dirname(probe);
    }
  }
}

/**
 * Unpacks the box's tar of `adds`/`updates` into `dir` (only the expected paths, symlinks kept
 * as symlinks, never escaping), removes `deletes`, then prunes directories the deletes emptied.
 */
export async function applySync(repoId: string, dir: string, entries: SyncEntry[], tar: Readable | null): Promise<SyncResult> {
  const writes = entries.filter((e) => e.action !== "delete");
  const deletes = entries.filter((e) => e.action === "delete");
  const expected = new Map<string, SyncEntry>();
  for (const e of writes) expected.set(await assertInside(dir, e.path), e);
  for (const e of deletes) await assertInside(dir, e.path);

  let bytes = 0;
  if (writes.length > 0) {
    if (!tar) throw new Error("no archive for the files to write");
    const seen = new Set<string>();
    await pipeline(
      tar,
      extract(dir, {
        ignore: (name, header) => {
          if (header?.type === "directory") return true;
          const want = expected.get(path.resolve(name));
          if (!want || (header?.type !== "file" && header?.type !== "symlink")) return true;
          seen.add(want.path);
          bytes += header.size;
          return false;
        },
      }),
    );
    const missing = writes.filter((e) => !seen.has(e.path));
    if (missing.length > 0) {
      throw new Error(`the box did not send ${missing.length} file(s) (changed meanwhile?): ${missing[0]?.path}`);
    }
  }
  for (const e of deletes) {
    const abs = path.resolve(dir, e.path);
    try {
      await unlink(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    let parent = path.dirname(abs);
    while (parent !== dir && parent.startsWith(dir + path.sep)) {
      try {
        await rmdir(parent);
      } catch {
        break;
      }
      parent = path.dirname(parent);
    }
  }
  return {
    repoId,
    path: dir,
    added: writes.filter((e) => e.action === "add").length,
    updated: writes.filter((e) => e.action === "update").length,
    deleted: deletes.length,
    skipped: 0,
    bytes,
  };
}
