import { z } from "zod";

export const SESSION_STATUSES = ["creating", "idle", "running", "stopped", "error"] as const;
export const SessionStatus = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const PROVIDERS = ["claude-code", "devin", "codex", "cursor", "pi", "opencode", "fx", "kimi"] as const;
export const Provider = z.enum(PROVIDERS);
export type Provider = z.infer<typeof Provider>;

export const PROVIDER_LABELS: Record<Provider, string> = {
  "claude-code": "Claude Code",
  devin: "Devin",
  codex: "Codex",
  cursor: "Cursor",
  pi: "pi",
  opencode: "OpenCode",
  fx: "fx",
  kimi: "Kimi CLI",
};

/**
 * Why a Provider cannot run in an Environment, or `null` when it can. fx ships no Windows build
 * (ADR-0077), so a `qemu-windows` Session cannot run it; the UI disables the choice with this text.
 */
export function providerUnavailableIn(provider: Provider, environment: Environment): string | null {
  if (provider === "kimi" && environment === "qemu-macos") return "Kimi CLI has no macOS x86_64 build for the QEMU · macOS guest; use Linux or Windows.";
  if (provider === "fx" && environment === "qemu-windows") return "fx has no Windows build; it runs on Linux and macOS.";
  return null;
}

/**
 * The environment the Control Plane may set on a Sandbox for its Provider: what Snapshots blank
 * out, and what follows the Agent into a VM when it runs there (ADR-0060).
 */
export const PROVIDER_ENV_KEYS: Record<Provider, readonly string[]> = {
  "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
  devin: ["WINDSURF_API_KEY"],
  // Codex's and Cursor's logins never travel as environment: the Daemon gets them over RPC and keeps them on tmpfs.
  codex: [],
  cursor: [],
  // pi's login too: its `auth.json` goes on tmpfs and its API keys into the Agent process only (ADR-0075).
  pi: [],
  opencode: [],
  // fx's login (ADR-0077) travels over RPC too: a login file goes on tmpfs, an API key into the Agent process alone.
  fx: [],
  kimi: [],
};

/** Metadata of ~/.kimi/credentials/kimi-code.json (ADR-0084); never the tokens. */
export const KimiLogin = z.object({
  kind: z.literal("oauth"),
  expiresAt: z.string().nullable(),
});
export type KimiLogin = z.infer<typeof KimiLogin>;

/**
 * What the stored fx login (ADR-0077) is: an AI Gateway API key, or the file an `fx login` wrote —
 * `auth.json` (Vercel account, `vercel`), `chatgpt-auth.json` (`codex`) or `grok-auth.json` (`grok`).
 */
export const FxLogin = z.object({
  kind: z.enum(["api-key", "vercel", "codex", "grok"]),
  /** When the login's access token expires (`expires_at`), ISO 8601; `null` for API keys or when the file does not say. */
  expiresAt: z.string().nullable(),
});
export type FxLogin = z.infer<typeof FxLogin>;

/**
 * What a Codex `auth.json` (the file `codex login` writes, ADR-0046) says about the ChatGPT
 * account it holds; read from the id token's claims, each part `null` when absent.
 */
export const CodexLogin = z.object({
  email: z.string().nullable(),
  /** ChatGPT plan the tokens belong to (`plus`, `pro`, `team`, ...). */
  plan: z.string().nullable(),
  /** When Codex last refreshed the tokens (its `last_refresh`), ISO 8601. */
  lastRefresh: z.string().nullable(),
  /** True when the file holds an API key instead of (or besides) a ChatGPT login. */
  apiKey: z.boolean(),
});
export type CodexLogin = z.infer<typeof CodexLogin>;

/**
 * What the stored Cursor login (ADR-0054) is: the `auth.json` an `agent login` wrote (a Cursor
 * subscription, refreshed by the CLI) or an API key from the Cursor dashboard.
 */
export const CursorLogin = z.object({
  kind: z.enum(["auth-json", "api-key"]),
  /** When the login's access token expires (JWT `exp`), ISO 8601; `null` for API keys or when unreadable. */
  expiresAt: z.string().nullable(),
});
export type CursorLogin = z.infer<typeof CursorLogin>;

/**
 * What the stored pi login (ADR-0075) holds, by name only: the model providers an `auth.json`
 * (pi's `/login`) has credentials for, and the API-key environment variables set beside it.
 */
export const PiLogin = z.object({
  /** Provider ids in the pasted `auth.json` (`anthropic`, `openai`, ...), with the credential kind. */
  authProviders: z.array(z.object({ id: z.string(), kind: z.enum(["oauth", "api_key", "other"]) })),
  /** Names of the API-key variables stored (`ANTHROPIC_API_KEY`, ...); never their values. */
  apiKeyNames: z.array(z.string()),
});
export type PiLogin = z.infer<typeof PiLogin>;

/**
 * What the stored OpenCode login (ADR-0076) holds: the model providers an `auth.json` written by
 * `opencode auth login` has credentials for, each an OAuth login (refreshed by OpenCode), an API
 * key or a well-known token; nothing secret.
 */
export const OpenCodeLogin = z.object({
  providers: z.array(
    z.object({
      /** OpenCode's provider id (`anthropic`, `openai`, `opencode`, `google`, …). */
      id: z.string(),
      kind: z.enum(["oauth", "api", "wellknown"]),
      /** When the OAuth access token expires, ISO 8601; `null` for keys or when absent. */
      expiresAt: z.string().nullable(),
    }),
  ),
});
export type OpenCodeLogin = z.infer<typeof OpenCodeLogin>;

/**
 * How a Sandbox gets its own Docker daemon: `sysbox` runs it under the Sysbox
 * runtime (unprivileged, isolation intact), `privileged` falls back to
 * `--privileged` (root-equivalent on the host), `none` ships no daemon.
 */
export const DOCKER_MODES = ["none", "sysbox", "privileged"] as const;
export const DockerMode = z.enum(DOCKER_MODES);
export type DockerMode = z.infer<typeof DockerMode>;

export const DOCKER_MODE_LABELS: Record<DockerMode, string> = {
  none: "no Docker",
  sysbox: "Docker (Sysbox)",
  privileged: "Docker (privileged)",
};

/**
 * Where a Session's desktop runs (ADR-0057). `docker-linux` is the Sandbox container's own XFCE
 * desktop; `qemu-windows` adds a Windows VM (QEMU/KVM in a sidecar container) whose desktop fills
 * the Sandbox's screen over RDP, so the Agent, its tools and the repositories stay on the Linux
 * side; `qemu-macos` does the same with a macOS VM (OpenCore, dockur/macos) shown over VNC
 * (ADR-0059).
 */
export const ENVIRONMENTS = ["docker-linux", "qemu-windows", "qemu-macos"] as const;
export const Environment = z.enum(ENVIRONMENTS);
export type Environment = z.infer<typeof Environment>;

export const ENVIRONMENT_LABELS: Record<Environment, string> = {
  "docker-linux": "Docker · Linux",
  "qemu-windows": "QEMU · Windows",
  "qemu-macos": "QEMU · macOS",
};

/** Why Snapshot / Fork / Rebuild are refused for `qemu-windows` Sessions (ADR-0057). */
export const WINDOWS_NO_SNAPSHOT =
  "Snapshots, forks and rebuilds are not available for Windows Sessions yet: the VM disk is outside the Sandbox's image.";
/** The same for `qemu-macos` Sessions (ADR-0059). */
export const MACOS_NO_SNAPSHOT =
  "Snapshots, forks and rebuilds are not available for macOS Sessions yet: the VM disk is outside the Sandbox's image.";

/** The Environments whose desktop is a VM next to the Sandbox, with the reason their Sessions cannot be snapshotted. */
export const VM_NO_SNAPSHOT: Partial<Record<Environment, string>> = {
  "qemu-windows": WINDOWS_NO_SNAPSHOT,
  "qemu-macos": MACOS_NO_SNAPSHOT,
};

/**
 * The Environments whose Agent runs inside the VM rather than in the Linux Sandbox (ADR-0057):
 * repositories, MCP servers and the Terminal are the guest's; the Linux side keeps the desktop
 * bridge, recordings and a mirror of the Workspace for downloads and sync.
 */
export const VM_AGENT_IN_GUEST: Partial<Record<Environment, string>> = {
  "qemu-windows":
    "The agent, its MCP servers, git and the Terminal run inside the Windows VM; the Workspace is C:\\workspace there. VS Code is not available for Windows Sessions yet: edit through the agent, the Terminal or the desktop.",
  "qemu-macos":
    "The agent, its MCP servers, git and the Terminal (zsh) run inside the macOS VM; the Workspace is /Users/agent/workspace there. VS Code is not available for macOS Sessions yet: edit through the agent, the Terminal or the desktop.",
};

/** Whether an Environment can be picked on this host, and if not, why (one sentence for the UI). */
export const EnvironmentAvailability = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
});
export type EnvironmentAvailability = z.infer<typeof EnvironmentAvailability>;

export const WorkspaceSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("empty") }),
  z.object({ type: z.literal("git"), url: z.string().min(1), ref: z.string().min(1).optional() }),
  z.object({ type: z.literal("copy"), path: z.string().min(1) }),
  /** The Sandbox started from another Session's Snapshot image (whole filesystem, not just the Workspace). */
  z.object({
    type: z.literal("fork"),
    sessionId: z.string(),
    snapshotId: z.string(),
    /** Human-readable origin, e.g. "My session @ snapshot 3", kept even if the origin is deleted. */
    label: z.string(),
  }),
]);
export type WorkspaceSource = z.infer<typeof WorkspaceSource>;
