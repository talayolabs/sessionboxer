import { z } from "zod";
import type { CopilotLogin } from "./common.js";

/**
 * GitHub Copilot CLI's login (ADR-0082). The stored login is either a GitHub token as is (a
 * fine-grained PAT with the "Copilot Requests" permission, or an OAuth token of the Copilot or
 * GitHub CLI app) or the `~/.copilot/config.json` that `copilot login` writes when it has no OS
 * keychain and `storeTokenPlaintext` is on: a JSONC file (comment lines, then the object) with
 * `authTokens` keyed by host and login, `lastLoggedInUser` and `loggedInUsers`. Both the Control
 * Plane (validation, metadata) and the Sandbox Daemon (what to hand the CLI) read it through here.
 */
export const CopilotConfigFile = z
  .object({
    authTokens: z.record(z.string(), z.object({ token: z.string() }).passthrough()).optional(),
    lastLoggedInUser: z.object({ host: z.string().optional(), login: z.string().optional() }).passthrough().optional(),
    loggedInUsers: z.array(z.object({ host: z.string().optional(), login: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();
export type CopilotConfigFile = z.infer<typeof CopilotConfigFile>;

/** Drops the `//` comment lines Copilot puts at the top of `config.json` (nothing else is JSONC in it). */
export function stripCopilotComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/** The parsed `config.json`, `null` when `text` is not one (an API token, say). */
export function parseCopilotConfig(text: string): CopilotConfigFile | null {
  const body = stripCopilotComments(text).trim();
  if (!body.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const file = CopilotConfigFile.safeParse(parsed);
  return file.success ? file.data : null;
}

/** Whether a string looks like a GitHub token Copilot accepts (`github_pat_…`, `gho_…`, `ghu_…`); classic `ghp_` is rejected by Copilot itself. */
export function copilotTokenKind(token: string): CopilotLogin["tokenKind"] {
  if (/^github_pat_[A-Za-z0-9_]+$/.test(token)) return "pat";
  if (/^gh[ou]_[A-Za-z0-9]+$/.test(token)) return "oauth";
  return "other";
}

/** The GitHub login a `config.json` names, from `lastLoggedInUser`, else the first `loggedInUsers` entry, else the key of its token. */
export function copilotConfigLogin(file: CopilotConfigFile): string | null {
  const named = file.lastLoggedInUser?.login ?? file.loggedInUsers?.[0]?.login;
  if (named) return named;
  const key = Object.keys(file.authTokens ?? {})[0];
  return key?.split(":")[1] ?? null;
}

/**
 * The token out of a `config.json`: the entry of `lastLoggedInUser` (host and login, `:github` suffix
 * or not), else the first one. `null` when the file holds none.
 */
export function copilotConfigToken(file: CopilotConfigFile): string | null {
  const tokens = file.authTokens ?? {};
  const user = file.lastLoggedInUser;
  if (user?.host && user.login) {
    const prefix = `${user.host}:${user.login}`;
    for (const key of Object.keys(tokens)) {
      if (key === prefix || key.startsWith(`${prefix}:`)) return tokens[key]?.token ?? null;
    }
  }
  const first = Object.values(tokens)[0];
  return first?.token ?? null;
}

/** The GitHub token the stored login resolves to: the string itself, or the one inside a `config.json`. `""` when there is none. */
export function copilotToken(login: string): string {
  const trimmed = login.trim();
  if (trimmed === "") return "";
  const file = parseCopilotConfig(trimmed);
  if (!file) return trimmed.startsWith("{") || trimmed.startsWith("//") ? "" : trimmed;
  return copilotConfigToken(file) ?? "";
}

/** What the stored login is, for Settings; nothing is verified. `null` for an empty or unusable string. */
export function describeCopilotLogin(login: string): CopilotLogin | null {
  const trimmed = login.trim();
  if (trimmed === "") return null;
  const file = parseCopilotConfig(trimmed);
  if (file) {
    const token = copilotConfigToken(file);
    return token ? { kind: "config", tokenKind: copilotTokenKind(token), login: copilotConfigLogin(file) } : null;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("//") || !/^[\w.-]+$/.test(trimmed)) return null;
  return { kind: "token", tokenKind: copilotTokenKind(trimmed), login: null };
}
