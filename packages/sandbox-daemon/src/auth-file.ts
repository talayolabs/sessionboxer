import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";

const SETTLE_MS = 400;
const SWEEP_MS = 60_000;

/**
 * A Provider's login file kept on tmpfs: Codex's `$CODEX_HOME/auth.json` (ADR-0046), Cursor's
 * `~/.config/cursor/auth.json` (ADR-0054) and OpenCode's `~/.local/share/opencode/auth.json`
 * (ADR-0076). Only that file lives on tmpfs: the rest of the Provider's directory (config, the
 * chat history `session/load` needs) stays on the container disk so Stop/Resume keeps the
 * conversation, while `docker commit` (Snapshots) never sees tokens.
 * These Providers refresh their OAuth tokens in place and rewrite the file; the watcher reports the
 * new contents so the Control Plane can store them. Should a version replace the path with a
 * regular file instead (write to temp + rename), the sweep moves it back onto tmpfs.
 */
export class AuthFile {
  private current = "";
  private watchers: FSWatcher[] = [];
  private settle: NodeJS.Timeout | null = null;
  private sweep: NodeJS.Timeout | null = null;
  private readonly dir: string;
  private readonly name: string;

  constructor(
    private readonly label: string,
    /** Where the Provider looks for the file, e.g. `/home/agent/.codex/auth.json`; becomes a symlink. */
    private readonly link: string,
    private readonly tmpfsDir: string,
    private readonly log: (msg: string) => void,
    private readonly onChanged: (authJson: string) => void,
    /**
     * Write the file at `link` itself instead of a symlink onto tmpfs: fx refuses a login file that
     * is not a regular file with mode 0600 (ADR-0077); its `~/.fx` is a volume the Snapshot never sees.
     */
    private readonly direct = false,
  ) {
    this.dir = dirname(link);
    this.name = basename(link);
  }

  private get file(): string {
    return this.direct ? this.link : join(this.tmpfsDir, `${this.label}-auth.json`);
  }

  /** Puts `authJson` in place (empty removes the login); a no-op when the file already holds it. */
  set(authJson: string): void {
    mkdirSync(this.tmpfsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.relink();
    if (authJson === "") {
      rmSync(this.file, { force: true });
      this.current = "";
      this.log(`${this.label} login removed`);
      return;
    }
    const onDisk = this.read();
    if (onDisk !== authJson) {
      writeFileSync(this.file, authJson, { mode: 0o600 });
      chmodSync(this.file, 0o600);
      this.log(`${this.label} login written to ${this.link} (${authJson.length} bytes${this.direct ? "" : " on tmpfs"})`);
    }
    this.current = authJson;
    this.start();
  }

  close(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.settle) clearTimeout(this.settle);
    if (this.sweep) clearInterval(this.sweep);
    this.settle = null;
    this.sweep = null;
  }

  private start(): void {
    if (this.watchers.length > 0) return;
    const tmpfsName = basename(this.file);
    for (const dir of new Set([this.direct ? this.dir : this.tmpfsDir, this.dir])) {
      try {
        const w = watch(dir, (_event, name) => {
          if (name === tmpfsName || name === this.name) this.schedule();
        });
        w.on("error", (e) => this.log(`${this.label} auth watcher on ${dir}: ${String(e)}`));
        this.watchers.push(w);
      } catch (e) {
        this.log(`cannot watch ${dir} for ${this.label} auth changes: ${String(e)}`);
      }
    }
    this.sweep = setInterval(() => this.check(), SWEEP_MS);
    this.sweep.unref();
  }

  private schedule(): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = null;
      this.check();
    }, SETTLE_MS);
  }

  private check(): void {
    try {
      this.relink();
      const onDisk = this.read();
      if (onDisk === "" || onDisk === this.current) return;
      try { JSON.parse(onDisk); } catch { return; }
      this.current = onDisk;
      this.log(`${this.label} refreshed its login; reporting the new ${this.name}`);
      this.onChanged(onDisk);
    } catch (e) {
      this.log(`${this.label} auth check: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The Provider's path must be a symlink onto tmpfs; a regular file there is moved over and replaced. */
  private relink(): void {
    if (this.direct) return;
    let regular = false;
    try {
      const st = lstatSync(this.link);
      if (st.isSymbolicLink() && readlinkSync(this.link) === this.file) return;
      regular = st.isFile();
    } catch {
      // nothing at the path yet
    }
    if (regular) {
      const contents = readFileSync(this.link, "utf8");
      writeFileSync(this.file, contents, { mode: 0o600 });
      this.log(`${this.label} wrote ${this.link} as a regular file; moved it onto tmpfs`);
    }
    rmSync(this.link, { force: true });
    symlinkSync(this.file, this.link);
  }

  private read(): string {
    if (!existsSync(this.file) || !statSync(this.file).isFile()) return "";
    return readFileSync(this.file, "utf8");
  }
}
