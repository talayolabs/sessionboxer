import type { Provider } from "@sessionboxer/protocol";
import type { Guest, GuestProviderFile } from "./guest.js";
import { grokGuestFiles } from "./grok-login.js";
import type { FxLoginKind } from "./provider-files.js";

/** Where this Daemon keeps each Provider's config and login, so the guest's copies mirror them. */
export interface GuestProviderPaths {
  codexHome: string;
  cursorAuthPath: string;
  piAgentDir: string;
  fxAuthPaths: Record<FxLoginKind, string>;
  vibeHome: string;
  grokHome: string;
  qwenHome: string;
  qwenAuthPath: string;
  opencodeAuthPath: string;
  copilotHome: string;
}

/**
 * The Provider's files that travel into the VM before each Agent start (the ones the image and this
 * Daemon keep here), at the paths the Provider reads on Windows or macOS; logins come back after
 * each turn so refreshed tokens reach the Control Plane. The briefing goes where the Provider reads
 * its user-level instructions (Cursor: `AGENTS.md` at the drive root on Windows, in the home on macOS).
 */
export function guestProviderFiles(provider: Provider, guest: Guest | null, home: string, p: GuestProviderPaths): GuestProviderFile[] {
  const { codexHome, cursorAuthPath, piAgentDir, fxAuthPaths, vibeHome, grokHome, qwenHome, qwenAuthPath, opencodeAuthPath, copilotHome } = p;
  const guestBriefingFile = `${home}/.sessionboxer/${guest?.os === "macos" ? "macos" : "windows"}-briefing.md`;
  return (
    {
      "claude-code": [
        { local: `${home}/.claude/settings.json`, guest: ".claude/settings.json" },
        { local: guestBriefingFile, guest: ".claude/CLAUDE.md" },
      ],
      codex: [
        { local: `${codexHome}/config.toml`, guest: ".codex/config.toml" },
        { local: guestBriefingFile, guest: ".codex/AGENTS.md" },
        { local: `${codexHome}/auth.json`, guest: ".codex/auth.json", pullBack: true },
      ],
      cursor: [
        { local: `${home}/.cursor/cli-config.json`, guest: ".cursor/cli-config.json" },
        { local: guestBriefingFile, guest: guest?.os === "macos" ? `${guest.homeDir()}/AGENTS.md` : "C:\\AGENTS.md" },
        { local: cursorAuthPath, guest: ".cursor/auth.json", pullBack: true },
      ],
      pi: [
        { local: `${piAgentDir}/settings.json`, guest: ".pi/agent/settings.json" },
        { local: `${piAgentDir}/mcp.json`, guest: ".pi/agent/mcp.json" },
        { local: guestBriefingFile, guest: ".pi/agent/AGENTS.md" },
        { local: `${piAgentDir}/auth.json`, guest: ".pi/agent/auth.json", pullBack: true },
      ],
      kimi: [
        { local: `${home}/.kimi/config.toml`, guest: ".kimi/config.toml" },
        { local: guestBriefingFile, guest: "C:\\AGENTS.md" },
        { local: `${home}/.kimi/credentials/kimi-code.json`, guest: ".kimi/credentials/kimi-code.json", pullBack: true, mode: 0o600 },
      ],
      fx: [
        { local: guestBriefingFile, guest: ".fx/AGENTS.md" },
        { local: fxAuthPaths.vercel, guest: ".fx/auth.json", pullBack: true, mode: 0o600 },
        { local: fxAuthPaths.codex, guest: ".fx/chatgpt-auth.json", pullBack: true, mode: 0o600 },
        { local: fxAuthPaths.grok, guest: ".fx/grok-auth.json", pullBack: true, mode: 0o600 },
      ],
      vibe: [
        { local: guestBriefingFile, guest: ".vibe/AGENTS.md" },
        { local: `${vibeHome}/trusted_folders.toml`, guest: ".vibe/trusted_folders.toml" },
        { local: `${vibeHome}/.env`, guest: ".vibe/.env", pullBack: true, mode: 0o600 },
      ],
      grok: grokGuestFiles(grokHome, guestBriefingFile),
      qwen: [
        { local: `${qwenHome}/settings.json`, guest: ".qwen/settings.json" },
        { local: guestBriefingFile, guest: ".qwen/QWEN.md" },
        { local: qwenAuthPath, guest: ".qwen/oauth_creds.json", pullBack: true, mode: 0o600 },
      ],
      gemini: [
        { local: `${home}/.gemini/settings.json`, guest: ".gemini/settings.json" },
        { local: guestBriefingFile, guest: ".gemini/GEMINI.md" },
        { local: `${home}/.gemini/oauth_creds.json`, guest: ".gemini/oauth_creds.json", pullBack: true, mode: 0o600 },
      ],
      devin: [
        { local: `${home}/.config/devin/config.json`, guest: ".config/devin/config.json" },
        { local: `${home}/.config/devin/mcp_config.json`, guest: ".config/devin/mcp_config.json" },
        // Where the Devin CLI reads its files on macOS is not pinned down (unverified on a real Mac): both places get them.
        ...(guest?.os === "macos"
          ? [
              { local: `${home}/.config/devin/config.json`, guest: ".devin/config.json" },
              { local: `${home}/.config/devin/mcp_config.json`, guest: ".devin/mcp_config.json" },
            ]
          : []),
        { local: guestBriefingFile, guest: ".claude/CLAUDE.md" },
      ],
      // OpenCode's paths are XDG-style on every OS (`~/.config/opencode`, `~/.local/share/opencode`).
      opencode: [
        { local: `${home}/.config/opencode/opencode.json`, guest: ".config/opencode/opencode.json" },
        { local: guestBriefingFile, guest: ".config/opencode/AGENTS.md" },
        { local: opencodeAuthPath, guest: ".local/share/opencode/auth.json", pullBack: true },
      ],
      copilot: [
        { local: `${copilotHome}/settings.json`, guest: ".copilot/settings.json" },
        { local: `${copilotHome}/mcp-config.json`, guest: ".copilot/mcp-config.json" },
        { local: guestBriefingFile, guest: ".copilot/copilot-instructions.md" },
        { local: `${copilotHome}/config.json`, guest: ".copilot/config.json", pullBack: true },
      ],
    } satisfies Record<Provider, GuestProviderFile[]>
  )[provider];
}
