import { describeCopilotLogin, parseCopilotConfig, type Settings } from "@sessionboxer/protocol";
import { HttpError } from "./http-error.js";

/**
 * The GitHub Copilot login (ADR-0082): a GitHub token (a fine-grained PAT with the "Copilot Requests"
 * permission, or the OAuth token `copilot login` / `gh auth login` obtains) or the JSON of the
 * `~/.copilot/config.json` that `copilot login` writes; `COPILOT_GITHUB_TOKEN` in the environment overrides.
 */
export function copilotLogin(settings: Settings): string {
  return process.env.COPILOT_GITHUB_TOKEN?.trim() || settings.providerSecrets.copilot.COPILOT_LOGIN;
}

const COPILOT_LOGIN_HELP = "sign in with GitHub Copilot, paste a GitHub token with the Copilot Requests permission, or paste ~/.copilot/config.json as written by `copilot login`.";

/** Accepts a GitHub token or the JSON object of Copilot's `config.json`; `""` forgets it. Returns the token, or the JSON compacted. */
export function normalizeCopilotLogin(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (!trimmed.startsWith("{") && !trimmed.startsWith("//")) {
    if (!/^[\w.-]+$/.test(trimmed)) throw new HttpError(400, `The GitHub Copilot login must be a GitHub token or the JSON in ~/.copilot/config.json: ${COPILOT_LOGIN_HELP}`);
    return trimmed;
  }
  const file = parseCopilotConfig(trimmed);
  if (!file) throw new HttpError(400, `The GitHub Copilot login must be the JSON object in ~/.copilot/config.json, as written by \`copilot login\`; ${COPILOT_LOGIN_HELP}`);
  if (!describeCopilotLogin(trimmed)) throw new HttpError(400, "This file holds no GitHub Copilot login; run `copilot login` (with storeTokenPlaintext in ~/.copilot/settings.json) and copy the file again.");
  return JSON.stringify(file);
}

/**
 * Whether a `config.json` the Sandbox wrote should replace the stored login: Copilot's tokens do not
 * expire on a schedule, so any readable login file that differs replaces a stored file; a stored bare
 * token is never replaced (the file the Sandbox has only mirrors it).
 */
export function copilotAuthNewer(candidate: string, current: string): boolean {
  const a = describeCopilotLogin(candidate);
  if (!a || a.kind !== "config") return false;
  const file = parseCopilotConfig(candidate);
  if (!file || JSON.stringify(file) === current) return false;
  const b = describeCopilotLogin(current);
  return b === null || b.kind === "config";
}
