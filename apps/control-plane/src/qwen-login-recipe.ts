import { spawn } from "node:child_process";
import type { LoginProcess, Recipe } from "./provider-login.js";
import { describeQwenLogin, normalizeQwenOauthJson } from "./qwen-login.js";

/** The two ACP requests that start Qwen Code's OAuth device flow over its `--acp` stdio (ADR-0083). */
const ACP_INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } };
const ACP_AUTHENTICATE_QWEN_OAUTH = { jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "qwen-oauth" } };

// Qwen Code's login lives in its TUI (`/auth`) and in its ACP server's `authenticate`, which runs the
// same Qwen OAuth device flow (ADR-0083): it prints "https://chat.qwen.ai/authorize?user_code=XXXXXXXX&client=qwen-code"
// and polls; the page prefills the code from the URL but the dialog shows it too.
export function qwenLoginRecipe(noBrowser: Record<string, string>): Recipe {
  return {
    bin: ["qwen"],
    args: ["--acp"],
    env: { ...noBrowser, NO_BROWSER: "1" },
    isLoginUrl: (u) => /(^|\.)qwen\.ai$/.test(u.hostname) && /authorize/i.test(u.pathname),
    code: "page",
    prompt: null,
    userCode: (text) => /[?&]user_code=([A-Za-z0-9]{4,})/.exec(text)?.[1] ?? null,
    rejected: () => null,
    files: [".qwen/oauth_creds.json"],
    result: (_output, file) => {
      if (!file) return null;
      try {
        const login = normalizeQwenOauthJson(file);
        return login && describeQwenLogin(login, "") ? { login, account: null } : null;
      } catch {
        return null;
      }
    },
    secret: (login) => ({ qwen: { QWEN_OAUTH_JSON: login } }),
    drive: {
      input: [JSON.stringify(ACP_INITIALIZE), JSON.stringify(ACP_AUTHENTICATE_QWEN_OAUTH)].map((line) => `${line}\n`).join(""),
      done: /"id":\s*2\b[^\n]*"(?:result|error)"\s*:/,
    },
  };
}

/**
 * A `drive` recipe's CLI on plain pipes: an ACP server reads its JSON-RPC from stdin only when that
 * is not a terminal (Qwen Code answers nothing on a pty). `write("\x04")` closes stdin, the EOF it exits on.
 */
export function spawnHostPiped(bin: string, args: string[], options: { cwd: string; env: Record<string, string> }, file: LoginProcess["file"], dispose: LoginProcess["dispose"]): LoginProcess {
  const proc = spawn(bin, args, { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const listeners: Array<(chunk: string) => void> = [];
  let backlog = "";
  const onChunk = (data: Buffer) => {
    const text = data.toString("utf8");
    if (listeners.length === 0) backlog += text;
    for (const fn of listeners) fn(text);
  };
  proc.stdout.on("data", onChunk);
  proc.stderr.on("data", onChunk);
  const exited = new Promise<number | null>((resolve) => {
    proc.on("error", () => resolve(null));
    proc.on("exit", (code, signal) => resolve(signal ? null : code));
  });
  return {
    onData: (fn) => {
      listeners.push(fn);
      if (backlog) {
        const text = backlog;
        backlog = "";
        fn(text);
      }
    },
    write: (text) => {
      if (text === "\x04") proc.stdin.end();
      else proc.stdin.write(text);
    },
    exited,
    kill: async () => {
      proc.kill();
    },
    file,
    dispose,
  };
}
