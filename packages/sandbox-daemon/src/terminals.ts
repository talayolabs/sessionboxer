import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { PTY_SCROLLBACK_BYTES, type PtyAttachResult, type PtyInfo } from "@sessionboxer/protocol";
import { caEnv } from "./ca-env.js";

const EXITED_RETENTION_MS = 5 * 60_000;
const SHELL = process.env.SHELL && process.env.SHELL !== "" ? process.env.SHELL : "/bin/bash";

interface Terminal {
  info: PtyInfo;
  proc: pty.IPty | null;
  scrollback: Buffer[];
  scrollbackBytes: number;
  reaper: NodeJS.Timeout | null;
}

export interface TerminalHandlers {
  onOutput: (id: string, data: Buffer) => void;
  onExit: (id: string, exitCode: number) => void;
}

export class TerminalError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Interactive shells in the Workspace. Output is forwarded live and the tail
 * is kept so a (re)attaching UI can repaint what it missed.
 */
export class Terminals {
  private readonly terminals = new Map<string, Terminal>();

  constructor(
    private readonly cwd: string,
    private readonly handlers: TerminalHandlers,
    private readonly log: (msg: string) => void,
  ) {}

  list(): PtyInfo[] {
    return [...this.terminals.values()].map((t) => t.info);
  }

  open(cols: number, rows: number): PtyInfo {
    const id = randomUUID().slice(0, 8);
    const proc = pty.spawn(SHELL, ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: this.cwd,
      env: { ...process.env, ...caEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
    });
    const term: Terminal = {
      info: { id, cols, rows, exitCode: null, createdAt: new Date().toISOString() },
      proc,
      scrollback: [],
      scrollbackBytes: 0,
      reaper: null,
    };
    this.terminals.set(id, term);
    proc.onData((data) => {
      const buf = Buffer.from(data, "utf8");
      this.retain(term, buf);
      this.handlers.onOutput(id, buf);
    });
    proc.onExit(({ exitCode }) => {
      term.proc = null;
      term.info = { ...term.info, exitCode };
      term.reaper = setTimeout(() => this.terminals.delete(id), EXITED_RETENTION_MS);
      this.handlers.onExit(id, exitCode);
      this.log(`terminal ${id} exited (${exitCode})`);
    });
    this.log(`terminal ${id} opened (${cols}x${rows}, pid ${proc.pid})`);
    return term.info;
  }

  attach(id: string): PtyAttachResult {
    const term = this.get(id);
    return { ...term.info, scrollback: Buffer.concat(term.scrollback).toString("base64") };
  }

  input(id: string, data: string): void {
    const term = this.get(id);
    if (!term.proc) throw new TerminalError(-32003, `terminal ${id} has exited`);
    term.proc.write(Buffer.from(data, "base64").toString("utf8"));
  }

  resize(id: string, cols: number, rows: number): void {
    const term = this.get(id);
    term.info = { ...term.info, cols, rows };
    if (!term.proc) return;
    try {
      term.proc.resize(cols, rows);
    } catch (e) {
      this.log(`terminal ${id} resize failed: ${String(e)}`);
    }
  }

  close(id: string): void {
    const term = this.terminals.get(id);
    if (!term) return;
    if (term.reaper) clearTimeout(term.reaper);
    this.terminals.delete(id);
    term.proc?.kill("SIGHUP");
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  private get(id: string): Terminal {
    const term = this.terminals.get(id);
    if (!term) throw new TerminalError(-32001, `terminal ${id} not found`);
    return term;
  }

  private retain(term: Terminal, buf: Buffer): void {
    term.scrollback.push(buf);
    term.scrollbackBytes += buf.length;
    while (term.scrollbackBytes > PTY_SCROLLBACK_BYTES && term.scrollback.length > 1) {
      const dropped = term.scrollback.shift();
      if (dropped) term.scrollbackBytes -= dropped.length;
    }
  }
}
