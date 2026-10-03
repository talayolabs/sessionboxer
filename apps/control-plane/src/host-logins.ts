import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeCopilotLogin, type Provider } from "@sessionboxer/protocol";
import { describeGeminiLogin, normalizeGeminiLogin } from "./gemini-login.js";
import { describeKimiLogin, normalizeKimiLogin } from "./kimi-login.js";
import { describeVibeLogin, normalizeVibeLogin } from "./vibe-login.js";
import { describeGrokLogin, normalizeGrokLogin } from "./grok-login.js";
import {
  codexLogin,
  describeCursorLogin,
  describeFxLogin,
  describeOpenCodeLogin,
  describePiLogin,
  normalizeCodexAuthJson,
  normalizeCopilotLogin,
  normalizeCursorLogin,
  normalizeFxLogin,
  normalizeOpenCodeAuthJson,
  normalizePiAuthJson,
} from "./config.js";

// --- the host's own logins -----------------------------------------------------------------

/** What the Provider's CLI holds on this machine: a non-secret account label and, when copyable, the login itself. */
export function readHostLogin(provider: Provider, home = homedir()): { account: string | null; login?: string } | null {
  switch (provider) {
    case "claude-code": {
      const account = claudeHostAccount(home);
      return account ? { account } : null;
    }
    case "devin": {
      const text = readFirst(devinCredentialsPaths(home));
      if (text === null) return null;
      const creds = parseDevinCredentials(text);
      return { account: creds.account ?? "signed in with `devin auth login`", ...(creds.token ? { login: creds.token } : {}) };
    }
    case "codex": {
      const text = readFirst([join(process.env.CODEX_HOME?.trim() || join(home, ".codex"), "auth.json")]);
      if (text === null) return null;
      let login: string;
      try {
        login = normalizeCodexAuthJson(text);
      } catch {
        return null;
      }
      const who = codexLogin(login);
      if (!login || !who) return null;
      return { account: who.email ? (who.plan ? `${who.email} (${who.plan})` : who.email) : who.apiKey ? "an API key" : "signed in with `codex login`", login };
    }
    case "cursor": {
      const text = readFirst(cursorAuthPaths(home));
      if (text === null) return null;
      let login: string;
      try {
        login = normalizeCursorLogin(text);
      } catch {
        return null;
      }
      const what = describeCursorLogin(login);
      if (!login || !what) return null;
      return { account: what.kind === "api-key" ? "an API key" : "signed in with `agent login`", login };
    }
    case "pi": {
      const text = readFirst([join(process.env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent"), "auth.json")]);
      if (text === null) return null;
      let login: string;
      try {
        login = normalizePiAuthJson(text);
      } catch {
        return null;
      }
      const what = describePiLogin(login, "");
      if (!login || !what) return null;
      return { account: `signed in with pi's /login (${what.authProviders.map((p) => p.id).join(", ")})`, login };
    }
    case "opencode": {
      const text = readFirst([opencodeAuthPath(home)]);
      if (text === null) return null;
      let login: string;
      try {
        login = normalizeOpenCodeAuthJson(text);
      } catch {
        return null;
      }
      const what = describeOpenCodeLogin(login);
      if (!login || !what) return null;
      return { account: `signed in with \`opencode auth login\` (${what.providers.map((p) => p.id).join(", ")})`, login };
    }
    case "fx": {
      // The Vercel login only: `fx login codex`/`grok` write other files, pasted in Settings instead.
      const text = readFirst([join(home, ".fx/auth.json")]);
      if (text === null) return null;
      let login: string;
      try {
        login = normalizeFxLogin(text);
      } catch {
        return null;
      }
      const what = describeFxLogin(login);
      if (!login || !what) return null;
      return { account: what.kind === "api-key" ? "an API key" : "signed in with `fx login`", login };
    }
    case "grok": {
      const text = readFirst([join(process.env.GROK_HOME?.trim() || join(home, ".grok"), "auth.json")]);
      if (text === null) return null;
      let login: string;
      try {
        login = normalizeGrokLogin(text);
      } catch {
        return null;
      }
      const what = describeGrokLogin(login);
      if (!login || !what) return null;
      return { account: what.email ?? "signed in with `grok login`", login };
    }
    case "gemini": {
      const text = readFirst([join(home, ".gemini", "oauth_creds.json")]);
      if (text === null) return null;
      let login: string;
      try {
        login = normalizeGeminiLogin(text);
      } catch {
        return null;
      }
      const what = describeGeminiLogin(login);
      if (!login || !what) return null;
      return { account: what.email ?? "signed in with Gemini CLI's Login with Google", login };
    }
    case "vibe": {
      // Vibe keeps the key in the OS keyring when there is one; `~/.vibe/.env` is where it lands otherwise.
      const text = readFirst([join(home, ".vibe/.env")]);
      if (text === null) return null;
      let login: string;
      try {
        login = normalizeVibeLogin(text);
      } catch {
        return null;
      }
      return login && describeVibeLogin(login) ? { account: "a Mistral API key from ~/.vibe/.env", login } : null;
    }
    case "copilot": {
      // Only a `config.json` holding the token (storeTokenPlaintext): a login kept in the OS keychain cannot be copied.
      const text = readFirst([join(process.env.COPILOT_HOME?.trim() || join(home, ".copilot"), "config.json")]);
      if (text === null) return null;
      let login: string;
      try {
        login = normalizeCopilotLogin(text);
      } catch {
        return null;
      }
      const what = describeCopilotLogin(login);
      if (!login || !what) return null;
      return { account: what.login ? `${what.login} (signed in with \`copilot login\`)` : "signed in with `copilot login`", login };
    }
    case "kimi": {
      const text = readFirst([join(home, ".kimi/credentials/kimi-code.json")]);
      if (text === null) return null;
      try {
        const login = normalizeKimiLogin(text);
        return describeKimiLogin(login) ? { account: null, login } : null;
      } catch {
        return null;
      }
    }
  }
}

/** Where `opencode auth login` writes on every OS (OpenCode uses XDG paths on Windows and macOS too). */
function opencodeAuthPath(home: string): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return join(xdg || join(home, ".local", "share"), "opencode", "auth.json");
}

/** "e-mail (Plan)" from Claude Code's `~/.claude.json` `oauthAccount`, the CLI's non-secret account record. */
export function claudeHostAccount(home = homedir()): string | null {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || home;
  const json = readJson(join(dir, ".claude.json"));
  const account = json && typeof json === "object" && "oauthAccount" in json ? json.oauthAccount : null;
  if (!account || typeof account !== "object") return null;
  const str = (key: string): string | null => {
    const v = (account as Record<string, unknown>)[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const who = str("emailAddress") ?? str("displayName") ?? str("fullName");
  if (!who) return null;
  const plan = str("organizationType")?.replace(/^claude_/, "");
  return plan ? `${who} (${plan[0]!.toUpperCase()}${plan.slice(1)})` : who;
}

function readJson(path: string): unknown {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : null;
  } catch {
    return null;
  }
}

function devinCredentialsPaths(home: string): string[] {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return [
    ...(xdg ? [join(xdg, "devin/credentials.toml")] : []),
    join(home, ".local/share/devin/credentials.toml"),
    join(home, "Library/Application Support/devin/credentials.toml"),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, "devin/credentials.toml")] : []),
  ];
}

function cursorAuthPaths(home: string): string[] {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return [
    ...(xdg ? [join(xdg, "cursor/auth.json")] : []),
    join(home, ".config/cursor/auth.json"),
    join(home, ".cursor/auth.json"),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, "Cursor/auth.json")] : []),
  ];
}

/**
 * `credentials.toml` as `devin auth login` writes it: flat `key = "value"` lines. The token is the
 * value whose key names a key/token; the account any e-mail-looking value.
 */
export function parseDevinCredentials(toml: string): { token: string | null; account: string | null } {
  const pairs = new Map<string, string>();
  for (const line of toml.split("\n")) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (m) pairs.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? "");
  }
  const find = (re: RegExp): string | null => {
    for (const [key, value] of pairs) if (value !== "" && re.test(key)) return value;
    return null;
  };
  // The CLI's own field is the API key (`api_key`/`windsurf_api_key`); a `session_token` is not what `devin acp` wants.
  const token = find(/api[_-]?key/) ?? find(/(^|_)token$|secret/);
  const account = find(/email|display_name|^(user|account|login)$/) ?? [...pairs.values()].find((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) ?? null;
  return { token, account };
}

export function readFirst(paths: string[]): string | null {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }
  return null;
}
