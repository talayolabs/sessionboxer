import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pack, type Pack } from "tar-fs";

const execFileAsync = promisify(execFile);

export class HostDirError extends Error {}

/** Validates a "copy" Workspace Source path and returns its canonical form. */
export async function resolveHostDir(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new HostDirError(`Host path must be absolute: ${input}`);
  let real: string;
  try {
    real = await realpath(input);
  } catch {
    throw new HostDirError(`Host path does not exist: ${input}`);
  }
  if (!(await stat(real)).isDirectory()) throw new HostDirError(`Host path is not a directory: ${input}`);
  return real;
}

/**
 * Selects what to copy. Inside a git work tree: tracked + untracked-but-not-ignored files
 * (so node_modules, build output etc. stay behind) plus `.git` when `dir` is the repository
 * root. Elsewhere: everything (`undefined`).
 */
export async function planHostDir(dir: string): Promise<string[] | undefined> {
  let top: string;
  try {
    top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return undefined;
  }
  const listed = (await git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
    .split("\0")
    .filter((p) => p.length > 0);
  const entries: string[] = [];
  for (const rel of listed) {
    try {
      await lstat(path.join(dir, rel));
      entries.push(rel);
    } catch {
      // tracked but deleted from the working tree
    }
  }
  if ((await realpath(top)) === dir) entries.push(".git");
  return entries;
}

/** Tar stream of `dir`, optionally restricted to `entries` (directories among them recurse). */
export function packHostDir(dir: string, entries: string[] | undefined): Pack {
  return pack(dir, { entries });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}
