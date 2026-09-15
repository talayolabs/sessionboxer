import WebSocket from "ws";
import { PtyOpenParams, type TerminalClientMessage, type TerminalServerMessage } from "@sessionboxer/protocol";
import type { SessionManager } from "./sessions.js";

/**
 * Bridges a browser WebSocket to one Daemon terminal: binary frames are raw
 * bytes in both directions, text frames are JSON control messages.
 */
export async function bridgeTerminal(
  client: WebSocket,
  sessions: SessionManager,
  sessionId: string,
  ptyId: string,
  log: (msg: string) => void,
): Promise<void> {
  const control = (msg: TerminalServerMessage): void => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
  };
  const fail = (message: string, code = 1011): void => {
    control({ type: "error", message });
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, message);
  };

  let detach: (() => void) | null = null;
  try {
    const res = await sessions.terminalAttach(sessionId, ptyId, {
      output: (data) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true });
      },
      exit: (exitCode) => control({ type: "exit", exitCode }),
      detached: (reason) => {
        detach = null;
        fail(reason, 1001);
      },
    });
    detach = res.detach;
    const { scrollback, ...terminal } = res.attached;
    control({ type: "attached", terminal });
    if (scrollback) client.send(Buffer.from(scrollback, "base64"), { binary: true });
    if (terminal.exitCode !== null) control({ type: "exit", exitCode: terminal.exitCode });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
    return;
  }

  client.on("message", (data, binary) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (binary) {
      sessions.terminalInput(sessionId, ptyId, buf).catch((e: unknown) => fail(String(e)));
      return;
    }
    let msg: TerminalClientMessage;
    try {
      msg = JSON.parse(buf.toString("utf8")) as TerminalClientMessage;
    } catch {
      return;
    }
    if (msg.type === "resize") {
      const parsed = PtyOpenParams.safeParse({ cols: msg.cols, rows: msg.rows });
      if (parsed.success) {
        sessions
          .terminalResize(sessionId, ptyId, parsed.data.cols, parsed.data.rows)
          .catch((e: unknown) => log(`terminal ${ptyId} resize failed: ${String(e)}`));
      }
    }
  });
  client.on("close", () => detach?.());
  client.on("error", (e) => {
    log(`terminal ${ptyId} client error: ${e.message}`);
    detach?.();
  });
}
