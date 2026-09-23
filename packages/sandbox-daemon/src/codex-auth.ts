import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

const SETTLE_MS = 400;
const SWEEP_MS = 60_000;

/**
 * Codex's ChatGPT login (`$CODEX_HOME/auth.json`, ADR-0046). Only that file lives on tmpfs: the
 * rest of `~/.codex` (config, session rollouts that `session/load` needs) stays on the container
 * disk so Stop/Resume keeps the conversation, while `docker commit` (Snapshots) never sees tokens.
 * Codex refreshes the OAuth tokens in place and rewrites the file; the watcher reports the new
 * contents so the Control Plane can store them. Should a Codex version replace the path with a
 * regular file instead (write to temp + rename), the sweep moves it back onto tmpfs.
 */
export class CodexAuth {
  private current = "";
  private watchers: FSWatcher[] = [];
  private settle: NodeJS.Timeout | null = null;
  private sweep: NodeJS.Timeout | null = null;

  constructor(
    private readonly codexHome: string,
    private readonly tmpfsDir: string,
    private readonly log: (msg: string) => void,
    private readonly onChanged: (authJson: string) => void,
  ) {}

  private get file(): string {
    return join(this.tmpfsDir, "codex-auth.json");
  }

  private get link(): string {
    return join(this.codexHome, "auth.json");
  }

  /** Puts `authJson` in place (empty removes the login); a no-op when the file already holds it. */
  set(authJson: string): void {
    mkdirSync(this.tmpfsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.codexHome, { recursive: true, mode: 0o700 });
    this.relink();
    if (authJson === "") {
      rmSync(this.file, { force: true });
      this.current = "";
      this.log("codex login removed");
      return;
    }
    const onDisk = this.read();
    if (onDisk !== authJson) {
      writeFileSync(this.file, authJson, { mode: 0o600 });
      this.log(`codex login written to ${this.link} (${authJson.length} bytes on tmpfs)`);
    }
    this.current = authJson;
    this.start();
  }

  private start(): void {
    if (this.watchers.length > 0) return;
    for (const dir of [this.tmpfsDir, this.codexHome]) {
      try {
        const w = watch(dir, (_event, name) => {
          if (name === "codex-auth.json" || name === "auth.json") this.schedule();
        });
        w.on("error", (e) => this.log(`codex auth watcher on ${dir}: ${String(e)}`));
        this.watchers.push(w);
      } catch (e) {
        this.log(`cannot watch ${dir} for codex auth changes: ${String(e)}`);
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
      JSON.parse(onDisk);
      this.current = onDisk;
      this.log("codex refreshed its login; reporting the new auth.json");
      this.onChanged(onDisk);
    } catch (e) {
      this.log(`codex auth check: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** `auth.json` must be a symlink onto tmpfs; a regular file there is moved over and replaced. */
  private relink(): void {
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
      this.log(`codex wrote ${this.link} as a regular file; moved it onto tmpfs`);
    }
    rmSync(this.link, { force: true });
    symlinkSync(this.file, this.link);
  }

  private read(): string {
    if (!existsSync(this.file) || !statSync(this.file).isFile()) return "";
    return readFileSync(this.file, "utf8");
  }
}
