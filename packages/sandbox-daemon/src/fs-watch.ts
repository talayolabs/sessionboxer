import { promises as fs, watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { FS_WATCH_MAX, type FsChangedParams } from "@sessionboxer/protocol";
import { DaemonError } from "./daemon-error.js";

const SETTLE_MS = 150;

/**
 * Workspace files the UI shows and wants to follow (an HTML Artifact in the App pane, ADR-0078).
 * Each is watched through its parent directory, so an editor that writes a temporary file and
 * renames it over the original is seen too; bursts of events settle for a moment and come out as
 * one `fs/changed` notification. At most `FS_WATCH_MAX` files are followed, the least recently
 * asked for dropped first; nothing is polled. A VM Session's files live in the guest and its
 * mirror only moves when a file is served, so changes there are not reported.
 */
export class FsWatches {
  private readonly root: string;
  private readonly watches = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    root: string,
    private readonly notify: (change: FsChangedParams) => void,
    private readonly log: (msg: string) => void,
  ) {
    this.root = resolve(root);
  }

  async watch(rel: string): Promise<void> {
    const abs = resolve(this.root, rel);
    if (abs === this.root || !abs.startsWith(this.root + sep)) throw new DaemonError("invalid_params", `path escapes the workspace: ${rel}`);
    const existing = this.watches.get(rel);
    if (existing) {
      // Most recently asked for: moves to the end of the eviction order.
      this.watches.delete(rel);
      this.watches.set(rel, existing);
      return;
    }
    const dir = dirname(abs);
    try {
      if (!(await fs.stat(dir)).isDirectory()) throw new DaemonError("invalid_params", `${rel} is not in a directory`);
    } catch (e) {
      if (e instanceof DaemonError) throw e;
      throw new DaemonError("not_found", `not found: ${rel}`);
    }
    const name = basename(abs);
    const watcher = watch(dir, { persistent: false }, (_eventType, changed) => {
      if (changed !== null && changed !== undefined && changed.toString() !== name) return;
      this.schedule(rel, abs);
    });
    watcher.on("error", (e) => {
      this.log(`fs watch ${rel} failed: ${String(e)}`);
      this.drop(rel);
    });
    this.watches.set(rel, watcher);
    while (this.watches.size > FS_WATCH_MAX) {
      const oldest = this.watches.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  private schedule(rel: string, abs: string): void {
    const pending = this.timers.get(rel);
    if (pending) clearTimeout(pending);
    this.timers.set(
      rel,
      setTimeout(() => {
        this.timers.delete(rel);
        fs.stat(abs).then(
          (st) => this.notify({ path: rel, exists: st.isFile() }),
          () => this.notify({ path: rel, exists: false }),
        );
      }, SETTLE_MS),
    );
  }

  private drop(rel: string): void {
    this.watches.get(rel)?.close();
    this.watches.delete(rel);
    const pending = this.timers.get(rel);
    if (pending) clearTimeout(pending);
    this.timers.delete(rel);
  }

  close(): void {
    for (const rel of [...this.watches.keys()]) this.drop(rel);
  }
}
