import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Claude Code's `availableModels` setting (in `~/.claude/settings.json`) is the allowlist
 * the Claude Agent SDK hands to claude-agent-acp as the model picker; aliases it does not
 * know by itself (Fable) only show up when listed there. Other keys of the file (the
 * permission mode set by the image) are kept as they are.
 */
export class ClaudeSettings {
  constructor(
    private readonly file: string,
    private readonly log: (msg: string) => void,
  ) {}

  /** Writes the allowlist; an empty list removes the key, leaving Claude's built-in models. */
  setAvailableModels(models: string[]): void {
    const settings = this.read();
    const before = JSON.stringify(settings.availableModels ?? null);
    if (models.length > 0) settings.availableModels = models;
    else delete settings.availableModels;
    const after = JSON.stringify(settings.availableModels ?? null);
    if (before === after) return;
    this.write(settings);
    this.log(`claude availableModels: ${models.length > 0 ? models.join(", ") : "(built-in)"}`);
  }

  /**
   * Serves a credential minted on the Control Plane's machine through Claude Code's `apiKeyHelper`
   * (ADR-0090): the value lands in `file` (tmpfs, owner-only), the helper is `cat` of that file, which
   * Claude Code re-runs every five minutes. An empty credential removes both.
   */
  setApiKeyHelperCredential(file: string, credential: string): void {
    const settings = this.read();
    const helper = `cat ${file}`;
    if (credential === "") {
      rmSync(file, { force: true });
      if (settings.apiKeyHelper !== helper) return;
      delete settings.apiKeyHelper;
      this.write(settings);
      this.log("claude apiKeyHelper: removed");
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, credential, { mode: 0o600 });
    chmodSync(file, 0o600);
    if (settings.apiKeyHelper === helper) return;
    settings.apiKeyHelper = helper;
    this.write(settings);
    this.log(`claude apiKeyHelper: ${helper}`);
  }

  private write(settings: Record<string, unknown>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(settings, null, 2) + "\n");
  }

  private read(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) this.log(`claude settings unreadable, rewriting: ${String(e)}`);
    }
    return {};
  }
}
