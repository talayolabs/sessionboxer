import type { Guest } from "./guest.js";

/** A `qemu-windows` Session (ADR-0057): the Agent runs inside the Windows VM; its desktop is what the screenshot and input tools act on. */
export function windowsBriefing(guest: Guest | null): string {
  if (guest?.os !== "windows") return "";
  return [
    `This is a Windows Session: you are running inside a Windows VM as its user \`${guest.cfg.user}\`, an administrator. Your shell is`,
    `Windows (cmd/PowerShell; run PowerShell cmdlets through \`powershell -Command\`), your Workspace is \`${guest.workspace}\` and the`,
    "repositories below are in it; git, node/npm/npx, uv/uvx and the MCP servers configured for this Session all run in Windows.",
    "Use Windows paths. `gh` is not installed in the VM; git push/pull work with the connected GitHub accounts.",
    "",
    "The screenshot, mouse and keyboard tools show and drive this Windows desktop (rendered over RDP; a few key combinations",
    "the RDP client keeps, such as Win-key shortcuts, may not arrive). Recordings are made of that desktop too.",
  ].join("\n");
}

/** A `qemu-macos` Session (ADR-0059, ADR-0061): the Agent runs inside the macOS VM; its desktop is what the screenshot and input tools act on. */
export function macosBriefing(guest: Guest | null): string {
  if (guest?.os !== "macos") return "";
  return [
    `This is a macOS Session: you are running inside a macOS VM as its user \`${guest.cfg.user}\`, an administrator (sudo asks for a`,
    `password you do not have; stay in your home). Your shell is zsh, your Workspace is \`${guest.workspace}\` and the repositories`,
    "below are in it; git (Apple's Command Line Tools), node/npm/npx, uv/uvx and the MCP servers configured for this Session all run in",
    "macOS. Use POSIX paths. `gh` is not installed in the VM; git push/pull work with the connected GitHub accounts. `open <file>`,",
    "`open -a <App>` and `osascript` act on the logged-in desktop, which is the one the screenshot tool shows.",
    "",
    "The screenshot, mouse and keyboard tools show and drive this macOS desktop (rendered over VNC; Command is the `super` key",
    "there, so `super+c` copies; key combinations the VNC viewer keeps, such as `ctrl+alt+shift` and F8/Scroll Lock, may not",
    "arrive). Recordings are made of that desktop too.",
  ].join("\n");
}
