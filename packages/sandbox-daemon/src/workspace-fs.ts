import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import { DaemonError } from "./daemon-error.js";

/** Path-contained lookups of Workspace files for streaming them as-is (`GET /fs/raw`). */
export class WorkspaceFs {
  private readonly root: string;

  constructor(
    root: string,
    /** Brings the file at `abs` up to date before it is served (a Windows Session copies it from the VM). */
    private readonly refresh?: (rel: string, abs: string) => Promise<void>,
  ) {
    this.root = resolve(root);
  }

  /** Maps a Workspace-relative path to an absolute one, refusing to leave the root. */
  private absolute(rel: string): string {
    const abs = resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new DaemonError("invalid_params", `path escapes the workspace: ${rel}`);
    }
    return abs;
  }

  /** `absolute()` plus a realpath check, so symlinks cannot point reads outside the root either. */
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
      throw new DaemonError("forbidden", `${rel} resolves outside the workspace`);
    }
    return abs;
  }

  /** Absolute path and size of a regular file. */
  async raw(rel: string): Promise<{ abs: string; size: number; mtime: Date }> {
    if (this.refresh) await this.refresh(rel, this.absolute(rel));
    const abs = await this.contained(rel);
    let st;
    try {
      st = await fs.stat(abs);
    } catch (e) {
      throw mapError(e, rel);
    }
    if (!st.isFile()) throw new DaemonError("invalid_params", `${rel} is not a file`);
    return { abs, size: st.size, mtime: st.mtime };
  }
}

function mapError(e: unknown, rel: string): Error {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT") return new DaemonError("not_found", `not found: ${rel}`);
  if (code === "EACCES" || code === "EPERM") return new DaemonError("forbidden", `permission denied: ${rel}`);
  if (code === "EISDIR") return new DaemonError("invalid_params", `${rel} is a directory`);
  if (code === "ENOTDIR") return new DaemonError("invalid_params", `${rel} is not a directory`);
  return e instanceof Error ? e : new Error(String(e));
}
