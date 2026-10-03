// ---------------------------------------------------------------------------
// Settings (stored in ~/.sessionboxer/config.json, 0600)
// ---------------------------------------------------------------------------

import { z } from "zod";
import { McpServerDef, PublicMcpServerDef } from "./mcp.js";
import { UtilityDef, UtilityEnvironment, DEFAULT_UTILITY_ENVIRONMENTS, ProcedureDef, PublicUtilityDef } from "./utilities.js";
import { DEFAULT_CLAUDE_MODELS, INSTRUCTIONS_MAX_CHARS, DEFAULT_INSTRUCTIONS, DEFAULT_HTML_APP_CDNS } from "./models.js";
import { SpeechSettings } from "./speech.js";
import { TunnelSettings, PublicTunnelSettings, RemoteAccess, TunnelSettingsUpdate } from "./auth.js";
import { EnvironmentAvailability, CodexLogin, CursorLogin, PiLogin, OpenCodeLogin, FxLogin, KimiLogin, CopilotLogin, VibeLogin, DockerMode } from "./common.js";
import { GitIdentity } from "./branches.js";

/**
 * When a finished desktop recording gets its captions spoken into an audio track (local TTS in
 * the Sandbox): `always`, `never`, or `ask` — by itself when the estimated extra processing is at
 * most `askAboveSeconds`, otherwise the Agent asks the user first.
 */
export const NarrationMode = z.enum(["ask", "always", "never"]);
export type NarrationMode = z.infer<typeof NarrationMode>;

export const RecordingNarration = z.object({
  mode: NarrationMode.default("ask"),
  askAboveSeconds: z.number().nonnegative().default(5),
});
export type RecordingNarration = z.infer<typeof RecordingNarration>;

/** An IPv4 block of /8 to /24 (`10.213.0.0/16`), carved into /24 networks by the Sandbox's dockerd. */
export const DOCKER_ADDRESS_POOL_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\/(?:[89]|1\d|2[0-4])$/;
/**
 * The top of 192.168.x: home routers sit at 192.168.0–1.x, Docker Desktop at 192.168.65.x, company
 * networks and Kubernetes in 10.x, WSL2 and Docker's own defaults in 172.16–31.x, Tailscale and WARP in
 * 100.64–127.x. Sixteen /24 networks for the box.
 */
export const DEFAULT_DOCKER_ADDRESS_POOL = "192.168.240.0/20";

/** The Windows editions the base disk can be installed with (dockur/windows `VERSION` codes). */
export const WINDOWS_VERSIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "11", label: "Windows 11 Pro" },
  { code: "11l", label: "Windows 11 LTSC" },
  { code: "11e", label: "Windows 11 Enterprise" },
  { code: "10", label: "Windows 10 Pro" },
  { code: "10l", label: "Windows 10 LTSC" },
  { code: "2025", label: "Windows Server 2025" },
  { code: "2022", label: "Windows Server 2022" },
];

/** The Windows VMs of `qemu-windows` Sessions (ADR-0057). */
export const WindowsSettings = z.object({
  /** Edition of the shared base disk (a `WINDOWS_VERSIONS` code); changing it means reinstalling the base. */
  version: z.string().min(1).default("11"),
  /** RAM (GB) and vCPUs each Windows VM gets, on top of its Session's Sandbox. */
  ramGb: z.number().positive().default(4),
  cpus: z.number().int().positive().default(2),
  /** Virtual size (GB) of the base disk; a Session's copy grows on demand from it. */
  diskGb: z.number().int().positive().default(64),
  /** Password of the guest's `agent` account (Administrator), generated when the base is installed. Secret. */
  password: z.string().default(""),
});
export type WindowsSettings = z.infer<typeof WindowsSettings>;

/** The Windows guest account the Sandbox's RDP and SSH clients log in with. */
export const WINDOWS_GUEST_USER = "agent";
/**
 * Where a Windows Session's Workspace lives inside the VM: the Agent and its MCP servers run in
 * Windows with this as their working directory, mirrored from the Sandbox's `/workspace` (ADR-0057).
 */
export const WINDOWS_GUEST_WORKSPACE = "C:\\workspace";
/**
 * TCP port on the Sandbox where the Daemon bridges Linux-side services to the Agent in the VM:
 * the desktop MCP (screenshots and input over RDP) and git credentials (the accounts the user
 * connected). Only reachable from the Session's own network; every connection carries a token.
 */
export const GUEST_BRIDGE_PORT = 7002;

/** The macOS releases the base disk can be installed with (dockur/macos `VERSION` codes). */
export const MACOS_VERSIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "15", label: "macOS 15 Sequoia" },
  { code: "14", label: "macOS 14 Sonoma" },
  { code: "13", label: "macOS 13 Ventura" },
  { code: "12", label: "macOS 12 Monterey" },
  { code: "11", label: "macOS 11 Big Sur" },
];

/** The macOS VMs of `qemu-macos` Sessions (ADR-0059). */
export const MacosSettings = z.object({
  /** Release of the shared base disk (a `MACOS_VERSIONS` code); changing it means reinstalling the base. */
  version: z.string().min(1).default("15"),
  /** RAM (GB) and vCPUs each macOS VM gets, on top of its Session's Sandbox. */
  ramGb: z.number().positive().default(4),
  cpus: z.number().int().positive().default(2),
  /** Virtual size (GB) of the base disk; a Session's copy grows on demand from it. */
  diskGb: z.number().int().positive().default(64),
  /** Password of the guest's `agent` account, generated when the base install starts and typed by the user during setup. Secret. */
  password: z.string().default(""),
  /**
   * An ed25519 key pair generated when the base is provisioned; the public half is in the guest
   * account's `authorized_keys`, the private half (PEM, secret) goes to each Session's Sandbox so
   * the Daemon's ssh/scp need no password.
   */
  sshKey: z.string().default(""),
  sshPublicKey: z.string().default(""),
});
export type MacosSettings = z.infer<typeof MacosSettings>;

/** The macOS guest account the Sandbox's VNC and SSH clients log in with. */
export const MACOS_GUEST_USER = "agent";
/** The Workspace inside the macOS VM (the guest account's home is `/Users/agent`). */
export const MACOS_GUEST_WORKSPACE = "/Users/agent/workspace";

export const Settings = z.object({
  gitUserName: z.string().default(""),
  gitUserEmail: z.string().default(""),
  sandboxCpus: z.number().positive().default(2),
  sandboxMemoryGb: z.number().positive().default(4),
  dockerInSandbox: z.boolean().default(false),
  /**
   * Addresses the dockerd inside a Docker-enabled Sandbox hands to its own networks (`--bip` and
   * `--default-address-pool`, /24 each). Empty means Docker's default, `172.17.0.0/16` and up, which
   * hides any company or VPN host in those ranges from the Sandbox. Applies to Sandboxes created afterwards.
   */
  sandboxDockerAddressPool: z
    .string()
    .regex(DOCKER_ADDRESS_POOL_PATTERN, "an IPv4 block like 10.213.0.0/16 (/8 to /24)")
    .or(z.literal(""))
    .default(DEFAULT_DOCKER_ADDRESS_POOL),
  windows: WindowsSettings.default({}),
  macos: MacosSettings.default({}),
  /** `docker commit` the Sandbox after every Agent turn; off unless switched on (ADR-0044). */
  autoSnapshot: z.boolean().default(false),
  /** Automatic Snapshots kept per Session (oldest pruned first); 0 keeps all. */
  snapshotKeep: z.number().int().nonnegative().default(10),
  /**
   * After every completed turn, have the Agent verify its work end to end on the desktop (a
   * hidden follow-up turn that plans test cases, records them and fixes what fails; see `E2eRun`).
   * Default for new Sessions; off unless switched on (ADR-0044).
   */
  e2eVerify: z.boolean().default(false),
  /**
   * What the `sessionboxer` MCP in each Sandbox lets the Agent do (ADR-0062): nothing (`off`, the
   * server is not passed to it), its own Session (`session`), or every Session (`all`, the default).
   * Default for new Sessions; each Session can override it.
   */
  agentTools: z.enum(["off", "session", "all"]).default("all"),
  /** Each Session an Agent asks to create (under `all`) waits for the user's Allow in the chat; denied after 10 minutes unattended. */
  approveCreate: z.boolean().default(true),
  /** Sessions alive at once that Agents created, over all Sessions (each Agent also has its own cap of `AGENT_CHILDREN_PER_SESSION`). */
  agentChildrenCap: z.number().int().nonnegative().default(10),
  mcpServers: z.array(McpServerDef).default([]),
  /** The Utilities Agents may investigate with (ADR-0073); each Session picks which are on. */
  utilities: z.array(UtilityDef).default([]),
  /** The target Environments Utilities belong to (`prod`, `staging`, `qa`, …). */
  utilityEnvironments: z.array(UtilityEnvironment).default(DEFAULT_UTILITY_ENVIRONMENTS),
  /** Debugging procedures, materialised as skills in the Sandboxes whose Utilities they name (ADR-0073). */
  procedures: z.array(ProcedureDef).default([]),
  /**
   * Model aliases Claude Code may offer (its `availableModels` setting, written to the Sandbox's
   * `~/.claude/settings.json`); `default` is always kept. Empty leaves Claude's built-in list.
   */
  claudeModels: z.array(z.string().min(1)).default(DEFAULT_CLAUDE_MODELS),
  /**
   * Standing instructions every new Session's Agent gets (editable per Session at creation), on top
   * of the Sandbox briefing: delivered as system prompt or first-prompt prefix, see `instructionsDelivery`.
   */
  instructions: z.string().max(INSTRUCTIONS_MAX_CHARS).default(DEFAULT_INSTRUCTIONS),
  /** Origins (scheme + host) an HTML Artifact may import scripts, styles, images and fonts from (ADR-0078). */
  htmlAppCdns: z.array(z.string().url()).default(DEFAULT_HTML_APP_CDNS),
  recordingNarration: RecordingNarration.default({}),
  /** Speech to text in the composer: which Whisper model runs on this machine and in what language. */
  speech: SpeechSettings.default({}),
  /**
   * Copy the CA certificates this machine trusts beyond the public ones (corporate proxies,
   * Cloudflare WARP, mitmproxy…) into every Sandbox's trust store, so TLS works there too.
   */
  trustHostCaCerts: z.boolean().default(true),
  /** Additional CA certificates for Sandboxes, PEM (`-----BEGIN CERTIFICATE-----` blocks). */
  extraCaCerts: z.string().default(""),
  /**
   * Where Claude Code sends its API requests (`ANTHROPIC_BASE_URL`), e.g. a company Claude proxy.
   * Empty follows the Control Plane's own `ANTHROPIC_BASE_URL`, else Anthropic. `authToken` /
   * `apiKey` become `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` in the Sandbox, for proxies with
   * their own credential; empty sends neither (Claude uses the OAuth token).
   */
  claudeApi: z
    .object({
      baseUrl: z.string().default(""),
      authToken: z.string().default(""),
      apiKey: z.string().default(""),
    })
    .default({}),
  providerSecrets: z
    .object({
      "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.string().default("") }).default({}),
      devin: z.object({ WINDSURF_API_KEY: z.string().default("") }).default({}),
      /** The whole `~/.codex/auth.json` of a `codex login` (ChatGPT subscription); Codex's refreshes flow back here. */
      codex: z.object({ CODEX_AUTH_JSON: z.string().default("") }).default({}),
      /** Either the whole `auth.json` of an `agent login` (Cursor subscription) or a Cursor API key (ADR-0054). */
      cursor: z.object({ CURSOR_LOGIN: z.string().default("") }).default({}),
      /** pi's `~/.pi/agent/auth.json` (its `/login`) and/or API keys as `NAME=value` lines, one per model provider (ADR-0075). */
      pi: z.object({ PI_AUTH_JSON: z.string().default(""), PI_API_KEYS: z.string().default("") }).default({}),
      /** The whole `auth.json` of an `opencode auth login`, or an OpenCode Zen API key (ADR-0076). */
      opencode: z.object({ OPENCODE_AUTH_JSON: z.string().default("") }).default({}),
      /** An AI Gateway API key, or the whole login file an `fx login` wrote (`auth.json`, `chatgpt-auth.json`, `grok-auth.json`; ADR-0077). */
      fx: z.object({ FX_LOGIN: z.string().default("") }).default({}),
      kimi: z.object({ KIMI_LOGIN: z.string().default("") }).default({}),
    copilot: z.object({ COPILOT_LOGIN: z.string().default("") }).default({}),
      /** A Mistral API key, or the `~/.vibe/.env` file Mistral Vibe wrote at sign-in (ADR-0085). */
      vibe: z.object({ VIBE_LOGIN: z.string().default("") }).default({}),
    })
    .default({}),
  /** OAuth App used by each Connector's login; empty `clientId` means the built-in one. */
  connectors: z
    .object({
      github: z.object({ clientId: z.string().default(""), clientSecret: z.string().default("") }).default({}),
    })
    .default({}),
  /**
   * The access token every browser and CLI must present once (`SESSIONBOXER_ACCESS_TOKEN` overrides it);
   * generated at first start. Never leaves the Control Plane except through `rotate`.
   */
  accessToken: z.string().default(""),
  /** The transports that make this Control Plane reachable from outside (see `TunnelKind`). */
  tunnels: TunnelSettings.default({}),
  /** VAPID key pair (P-256, base64url) signing this Control Plane's Web Pushes; generated at first start. */
  vapid: z.object({ publicKey: z.string(), privateKey: z.string() }).nullable().default(null),
});
export type Settings = z.infer<typeof Settings>;

/** Settings as returned to the UI: secrets replaced by a boolean "is set". */
export const PublicSettings = Settings.omit({ providerSecrets: true, mcpServers: true, utilities: true, connectors: true, claudeApi: true, accessToken: true, vapid: true, tunnels: true, windows: true, macos: true }).extend({
  mcpServers: z.array(PublicMcpServerDef),
  utilities: z.array(PublicUtilityDef),
  windows: WindowsSettings.omit({ password: true }),
  macos: MacosSettings.omit({ password: true, sshKey: true, sshPublicKey: true }),
  /** Which Environments a Session created now can run in on this host. */
  environments: z.object({
    "docker-linux": EnvironmentAvailability,
    "qemu-windows": EnvironmentAvailability,
    "qemu-macos": EnvironmentAvailability,
  }),
  tunnels: PublicTunnelSettings,
  claudeApi: z.object({
    baseUrl: z.string(),
    authTokenSet: z.boolean(),
    apiKeySet: z.boolean(),
    /** What a Sandbox created now gets as `ANTHROPIC_BASE_URL`, and where it comes from. */
    effectiveBaseUrl: z.string(),
    effectiveBaseUrlSource: z.enum(["settings", "env", "default"]),
  }),
  providerSecretsSet: z.object({
    "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.boolean() }),
    devin: z.object({ WINDSURF_API_KEY: z.boolean() }),
    codex: z.object({ CODEX_AUTH_JSON: z.boolean() }),
    cursor: z.object({ CURSOR_LOGIN: z.boolean() }),
    pi: z.object({ PI_AUTH_JSON: z.boolean(), PI_API_KEYS: z.boolean() }),
    opencode: z.object({ OPENCODE_AUTH_JSON: z.boolean() }),
    fx: z.object({ FX_LOGIN: z.boolean() }),
    kimi: z.object({ KIMI_LOGIN: z.boolean() }),
    copilot: z.object({ COPILOT_LOGIN: z.boolean() }),
    vibe: z.object({ VIBE_LOGIN: z.boolean() }),
  }),
  /** The account behind the stored Codex `auth.json`; `null` when none is stored. */
  codexLogin: CodexLogin.nullable(),
  /** What the stored Cursor login is; `null` when none is stored. */
  cursorLogin: CursorLogin.nullable(),
  /** What the stored pi login holds (names only); `null` when none is stored. */
  piLogin: PiLogin.nullable(),
  /** Which model providers the stored OpenCode `auth.json` covers; `null` when none is stored. */
  opencodeLogin: OpenCodeLogin.nullable(),
  /** What the stored fx login is; `null` when none is stored. */
  fxLogin: FxLogin.nullable(),
  kimiLogin: KimiLogin.nullable(),
  copilotLogin: CopilotLogin.nullable(),
  /** What the stored Mistral Vibe login is; `null` when none is stored. */
  vibeLogin: VibeLogin.nullable(),
  connectors: z.object({
    github: z.object({ clientId: z.string(), clientSecretSet: z.boolean() }),
  }),
  /** Mode a Docker-enabled Session created now would get, given the host's runtimes. */
  dockerModeAvailable: DockerMode.exclude(["none"]),
  /** Whether the Docker engine answered a ping just now: the runtime every Session needs, VM Environments included. */
  dockerReachable: z.boolean(),
  /** OS the Control Plane runs on (Node's `process.platform`): Sysbox exists on Linux only, so the UI words Docker warnings accordingly. */
  hostPlatform: z.string(),
  /** Subjects of the non-public CA certificates found in this machine's trust store. */
  hostCaCerts: z.array(z.string()),
  /** `user.name` / `user.email` of the host's own git config, the fallback when the Settings identity is blank. */
  hostGitIdentity: GitIdentity,
  /** How this Control Plane is reached from elsewhere (see `RemoteAccess`). */
  remote: RemoteAccess,
});
export type PublicSettings = z.infer<typeof PublicSettings>;

export const UpdateSettingsRequest = Settings.omit({ mcpServers: true, utilities: true, connectors: true, claudeApi: true, accessToken: true, vapid: true, tunnels: true, windows: true, macos: true }).partial().extend({
  /** Whole registry; `null` secret values keep what is stored for that server/name. */
  mcpServers: z.array(PublicMcpServerDef).optional(),
  /** Whole registry; `null` secret values keep what is stored for that Utility/credential. */
  utilities: z.array(PublicUtilityDef).optional(),
  windows: WindowsSettings.omit({ password: true }).partial().optional(),
  macos: MacosSettings.omit({ password: true, sshKey: true, sshPublicKey: true }).partial().optional(),
  tunnels: TunnelSettingsUpdate.optional(),
  /** Omitted secret fields keep what is stored; `""` forgets it. */
  claudeApi: z.object({ baseUrl: z.string(), authToken: z.string(), apiKey: z.string() }).partial().optional(),
  providerSecrets: z
    .object({
      "claude-code": z.object({ CLAUDE_CODE_OAUTH_TOKEN: z.string() }).partial(),
      devin: z.object({ WINDSURF_API_KEY: z.string() }).partial(),
      codex: z.object({ CODEX_AUTH_JSON: z.string() }).partial(),
      cursor: z.object({ CURSOR_LOGIN: z.string() }).partial(),
      pi: z.object({ PI_AUTH_JSON: z.string(), PI_API_KEYS: z.string() }).partial(),
      opencode: z.object({ OPENCODE_AUTH_JSON: z.string() }).partial(),
      fx: z.object({ FX_LOGIN: z.string() }).partial(),
      kimi: z.object({ KIMI_LOGIN: z.string() }).partial(),
      copilot: z.object({ COPILOT_LOGIN: z.string() }).partial(),
      vibe: z.object({ VIBE_LOGIN: z.string() }).partial(),
    })
    .partial()
    .optional(),
  /** `clientSecret: ""` forgets the stored secret (device-code login is used then). */
  connectors: z
    .object({
      github: z.object({ clientId: z.string(), clientSecret: z.string() }).partial(),
    })
    .partial()
    .optional(),
});
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequest>;
