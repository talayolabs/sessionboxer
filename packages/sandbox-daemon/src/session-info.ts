import { promises as fs, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SESSION_INFO_PATH, SessionInfo } from "@sessionboxer/protocol";

/** Somewhere else the file has to be too: the VM the Agent runs in (Windows/macOS Sessions). */
export interface SessionInfoMirror {
  /** The file's path as the Agent sees it. */
  readonly path: string;
  write(content: string): Promise<void>;
}

/**
 * The Session's identity for the Agent (ADR-0062): `.sessionboxer/session.json` in the Workspace,
 * written from what the Control Plane sends (`sessionInfoSet`) at boot and whenever it changes, and
 * the paragraph of the briefing that tells the Agent what it is running inside of. The file survives
 * a restart (it is read back at boot) so `whoami`-less Agents still find it before the Control Plane
 * reconnects.
 */
export class SessionInfoFile {
  private info: SessionInfo | null;
  /** The mirror's writes, one after the other; the first waits for the VM to boot, so `set` does not. */
  private mirrorChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: string,
    private readonly log: (msg: string) => void,
    private readonly mirror?: SessionInfoMirror,
  ) {
    this.info = this.read();
  }

  get current(): SessionInfo | null {
    return this.info;
  }

  /** The file's path as the Agent sees it. */
  get path(): string {
    return this.mirror?.path ?? join(this.workspace, SESSION_INFO_PATH);
  }

  async set(info: SessionInfo): Promise<void> {
    const content = JSON.stringify(SessionInfo.parse(info), null, 2) + "\n";
    const file = join(this.workspace, SESSION_INFO_PATH);
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    this.info = info;
    if (this.mirror) {
      const mirror = this.mirror;
      this.mirrorChain = this.mirrorChain.then(() => mirror.write(content)).catch((e: unknown) => this.log(`could not write ${mirror.path} in the VM: ${String(e)}`));
    }
  }

  /** The briefing paragraph; empty until the Control Plane has sent the Session's identity. */
  briefing(): string {
    const s = this.info;
    if (!s) return "";
    const env = { "docker-linux": "a Linux Sandbox (Docker)", "qemu-windows": "a Windows VM", "qemu-macos": "a macOS VM" }[s.environment];
    const lines = [
      `You are the Agent of the Sessionboxer Session "${s.title}" (id \`${s.id}\`, ${env}${s.forkedFrom ? `, forked from "${s.forkedFrom.title}"` : ""}${
        s.createdBy ? `, created by the Agent of "${s.createdBy.title}"` : ""
      }). Sessionboxer runs one or more Sessions like this one, each in its own Sandbox with its own Agent; the user`,
      "watches this one in a browser with Chat, Desktop, Terminal, Code, PRs, Verification and Context panes and may be looking",
      `at another Session right now. Your identity is in \`${this.path}\` (${SESSION_INFO_PATH} in the Workspace) and the`,
      "`sessionboxer` MCP is how you act on Sessionboxer itself: `whoami` (this Session live: status, usage, queue, open",
      "panes, terminals, PRs), `docs` (the user guide), `pr_attach`/`pr_list`/`pr_items`/`pr_mark_addressed`, `snapshot`,",
      "`queue_add`/`queue_list`, `title_set`, `verify`, `notify`, `terminal_list`/`terminal_read`, `transcribe_media` (speech to text",
      "with timestamps for an attached video or audio file), `ui_open`, and the `e2e_*`",
      s.agentTools === "all"
        ? "tools of a verification run. This Session may also list, read, message, create, fork and stop other Sessions (`sessions_list`, `session_*`, `schedule_*`)."
        : "tools of a verification run. Tools that reach other Sessions are not available to this Session.",
    ];
    return lines.join("\n");
  }

  private read(): SessionInfo | null {
    try {
      return SessionInfo.parse(JSON.parse(readFileSync(join(this.workspace, SESSION_INFO_PATH), "utf8")));
    } catch {
      return null;
    }
  }
}
