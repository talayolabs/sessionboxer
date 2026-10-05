import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import * as pty from "node-pty";
import { describeCopilotLogin, type Provider, type ProviderHostLogin, type ProviderLoginFlow, type Settings, type UpdateSettingsRequest } from "@sessionboxer/protocol";
import { applySettingsUpdate, codexLogin, describeCursorLogin, describeFxLogin, normalizeCodexAuthJson, normalizeCopilotLogin, normalizeCursorLogin, normalizeFxLogin } from "./config.js";
import { parseDevinCredentials, readFirst, readHostLogin } from "./host-logins.js";

export { claudeHostAccount, parseDevinCredentials, readHostLogin } from "./host-logins.js";
import { describeVibeLogin, normalizeVibeLogin } from "./vibe-login.js";
import { describeGrokLogin, normalizeGrokLogin } from "./grok-login.js";
import type { SandboxDocker, TtyProcess } from "./docker.js";
import { kimiLoginRecipe } from "./kimi-login-recipe.js";
import { qwenLoginRecipe, spawnHostPiped } from "./qwen-login-recipe.js";
import { HttpError } from "./http-error.js";

/**
 * Provider sign-in without a terminal (ADR-0058). Every Provider CLI has a browser login that
 * needs no callback to the machine the CLI runs on: it prints a sign-in URL, the user signs in in a
 * browser, and either the page hands out a code the CLI wants pasted back (Claude Code, Devin), the
 * CLI hands out a code to type into the page (Codex), or the CLI just polls until the page is done
 * (Cursor), or the CLI is an ACP server whose `authenticate` starts the device flow (Qwen Code).
 * Sessionboxer runs that CLI on a pty — the one installed on this machine when there is
 * one, else in a throwaway container from the Sandbox image — with a scratch home so the login of
 * the person running the Control Plane is never touched, hands the URL to the Settings page (so it
 * opens in the browser the user is already signed in with, saved passwords and all), types the
 * pasted code back, and stores what the CLI ends up with as the Provider's login in Settings.
 * Neither the sign-in nor any credential store ever lives in a Session's Sandbox.
 */

const FLOW_TTL_MS = 15 * 60_000;
/** Time for the CLI to start (a container to boot) and print its URL. */
const URL_WAIT_MS = 120_000;
/** Time for the CLI to redeem the pasted code. */
const EXCHANGE_WAIT_MS = 90_000;
const OUTPUT_CAP = 512 * 1024;
const CREDENTIALS_MARK = "@@SESSIONBOXER-CREDENTIALS@@";
const CLAUDE_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
const TTY_COLUMNS = 400;

/** How the one-time code travels between the CLI and the sign-in page. */
export type CodeExchange = "paste" | "page" | "none";

export interface Recipe {
  /** The CLI's names on PATH (the first is the Sandbox image's), and the arguments of its login. */
  bin: string[];
  args: string[];
  /** Keeps the CLI from opening a browser where it runs: the Settings page opens the URL in the user's. */
  env: Record<string, string>;
  /** The sign-in page among the URLs the CLI printed. */
  isLoginUrl(url: URL): boolean;
  code: CodeExchange;
  /** `paste`: the CLI's paste-the-code prompt (plain text); typing before it is up is lost. */
  prompt: RegExp | null;
  /** `page`: the code the CLI shows for the page, out of its plain-text output. */
  userCode(text: string): string | null;
  /** Why the CLI rejected the pasted code, from the plain text it printed since; `null` while it is still redeeming. */
  rejected(text: string): string | null;
  /** Where the CLI writes its login, relative to its home (one per operating system); `[]` when it only prints it. */
  files: string[];
  /** Files to put in the CLI's scratch home before it starts (relative path → contents): a setting its login needs. */
  seed?: Record<string, string>;
  /** The login to store (and a non-secret account label) from the CLI's complete output and the file it wrote, after it exited 0. */
  result(output: string, file: string | null): { login: string; account: string | null } | null;
  secret(login: string): NonNullable<UpdateSettingsRequest["providerSecrets"]>;
  /**
   * For a CLI that is an ACP server rather than a login command: `input` is typed as soon as it
   * runs (the `initialize` and `authenticate` requests), and once `done` matches its plain-text
   * output (the `authenticate` response) it gets EOF, so it exits and the login file can be read.
   */
  drive?: { input: string; done: RegExp };
}

const noBrowser = { BROWSER: platform() === "win32" ? "" : "true", NO_OPEN_BROWSER: "1" };
const BROWSER_OPENERS = ["xdg-open", "open", "sensible-browser", "x-www-browser", "gnome-open", "kde-open", "wslview"];

/**
 * One recipe per Provider whose CLI has a paste-a-code login. OpenCode has none: its logins are per
 * model provider and each is a browser OAuth that calls back to the CLI's local port, or an API
 * key typed into an interactive prompt (ADR-0076); the user pastes its `auth.json` instead. Nor
 * has Gemini CLI: its Login with Google (`NO_BROWSER=1` prints the URL and asks for the code) lives
 * only in its full-screen TUI, which does not quit on a pty once logged in, and `gemini -p` refuses
 * to log in (ADR-0081); the user pastes its `oauth_creds.json` instead.
 */

export const RECIPES: Partial<Record<Provider, Recipe>> = {
  kimi: kimiLoginRecipe(noBrowser),
  "claude-code": {
    bin: ["claude"],
    args: ["setup-token"],
    env: noBrowser,
    isLoginUrl: (u) => /(^|\.)claude\.(com|ai)$/.test(u.hostname) && /authorize/.test(u.pathname),
    code: "paste",
    prompt: /Paste code here/i,
    userCode: () => null,
    // The CLI redraws the line piecemeal ("Requ st failed…"), so only the status code is quoted.
    rejected: (text) => {
      if (!/OAuth error/i.test(text)) return null;
      const status = /status code (\d+)/i.exec(text)?.[1];
      return status ? `OAuth error, status ${status}` : "OAuth error";
    },
    files: [],
    result: (output) => {
      const login = CLAUDE_TOKEN_RE.exec(output)?.[0];
      return login ? { login, account: null } : null;
    },
    secret: (login) => ({ "claude-code": { CLAUDE_CODE_OAUTH_TOKEN: login } }),
  },
  devin: {
    bin: ["devin"],
    args: ["auth", "login", "--force-manual-token-flow"],
    env: noBrowser,
    isLoginUrl: (u) => /(^|\.)devin\.ai$/.test(u.hostname),
    code: "paste",
    prompt: /Paste the code/i,
    userCode: () => null,
    rejected: (text) => /^\s*Error:\s*([^\n]*)/im.exec(text)?.[1]?.trim() ?? null,
    files: [".local/share/devin/credentials.toml", "Library/Application Support/devin/credentials.toml", "AppData/Roaming/devin/credentials.toml"],
    result: (_output, file) => {
      const creds = file ? parseDevinCredentials(file) : null;
      return creds?.token ? { login: creds.token, account: creds.account } : null;
    },
    secret: (login) => ({ devin: { WINDSURF_API_KEY: login } }),
  },
  codex: {
    bin: ["codex"],
    args: ["login", "--device-auth"],
    env: noBrowser,
    isLoginUrl: (u) => /(^|\.)openai\.com$/.test(u.hostname) && /device/.test(u.pathname),
    code: "page",
    prompt: null,
    // "Enter this one-time code (expires in 15 minutes)" then the code on its own line.
    userCode: (text) => /one-time code[^\n]*\n\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\s*$/im.exec(text)?.[1] ?? null,
    rejected: () => null,
    files: [".codex/auth.json"],
    result: (_output, file) => {
      if (!file) return null;
      let login: string;
      try {
        login = normalizeCodexAuthJson(file);
      } catch {
        return null;
      }
      const who = codexLogin(login);
      const account = who?.email ? (who.plan ? `${who.email} (${who.plan})` : who.email) : null;
      return login ? { login, account } : null;
    },
    secret: (login) => ({ codex: { CODEX_AUTH_JSON: login } }),
  },
  cursor: {
    bin: ["cursor-agent", "agent"],
    args: ["login"],
    env: noBrowser,
    isLoginUrl: (u) => /(^|\.)cursor\.(com|sh)$/.test(u.hostname) && /login/i.test(u.pathname),
    code: "none",
    prompt: null,
    userCode: () => null,
    rejected: () => null,
    files: [".config/cursor/auth.json", ".cursor/auth.json", "AppData/Roaming/Cursor/auth.json"],
    result: (_output, file) => {
      if (!file) return null;
      try {
        const login = normalizeCursorLogin(file);
        return login && describeCursorLogin(login) ? { login, account: null } : null;
      } catch {
        return null;
      }
    },
    secret: (login) => ({ cursor: { CURSOR_LOGIN: login } }),
  },
  // pi has no login command: its `/login` lives in the TUI, so there is no browser sign-in (`bin: []`;
  // `start` refuses). The recipe still says where its `auth.json` is and how a login is stored (ADR-0075).
  pi: {
    bin: [],
    args: [],
    env: {},
    isLoginUrl: () => false,
    code: "none",
    prompt: null,
    userCode: () => null,
    rejected: () => null,
    files: [".pi/agent/auth.json"],
    result: () => null,
    secret: (login) => (login.trimStart().startsWith("{") ? { pi: { PI_AUTH_JSON: login } } : { pi: { PI_API_KEYS: login } }),
  },
  // `fx login` is Vercel's device flow (ADR-0077): fx prints "Open https://vercel.com/oauth/device?user_code=XXXX-XXXX"
  // and "Code: XXXX-XXXX", then polls; the page prefills the code from the URL but the dialog shows it too.
  fx: {
    bin: ["fx"],
    args: ["login", "vercel"],
    env: { ...noBrowser, FX_NO_OPEN_BROWSER: "1" },
    isLoginUrl: (u) => /(^|\.)vercel\.com$/.test(u.hostname) && /device/i.test(u.pathname),
    code: "page",
    prompt: null,
    userCode: (text) => /^\s*Code:\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\s*$/im.exec(text)?.[1] ?? null,
    rejected: () => null,
    files: [".fx/auth.json"],
    result: (_output, file) => {
      if (!file) return null;
      try {
        const login = normalizeFxLogin(file);
        return login && describeFxLogin(login) ? { login, account: null } : null;
      } catch {
        return null;
      }
    },
    secret: (login) => ({ fx: { FX_LOGIN: login } }),
  },
  // `copilot login --device-code` is GitHub's device flow (ADR-0082): Copilot prints "To authenticate, visit
  // https://github.com/login/device and enter code XXXX-XXXX", then polls. The token lands in
  // ~/.copilot/config.json only when the scratch home's settings allow plaintext storage (else the OS keychain).
  copilot: {
    bin: ["copilot"],
    args: ["login", "--device-code"],
    env: { ...noBrowser, COPILOT_AUTO_UPDATE: "false" },
    isLoginUrl: (u) => /(^|\.)github\.com$/.test(u.hostname) && /\/login\/device/.test(u.pathname),
    code: "page",
    prompt: null,
    userCode: (text) => /enter code[:\s]+([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)/i.exec(text)?.[1] ?? null,
    rejected: () => null,
    files: [".copilot/config.json"],
    seed: { ".copilot/settings.json": '{ "storeTokenPlaintext": true }\n' },
    result: (_output, file) => {
      if (!file) return null;
      try {
        const login = normalizeCopilotLogin(file);
        const who = describeCopilotLogin(login);
        return login && who ? { login, account: who.login } : null;
      } catch {
        return null;
      }
    },
    secret: (login) => ({ copilot: { COPILOT_LOGIN: login } }),
  },
  // Mistral Vibe has no login command for a terminal (ADR-0085): its sign-in is an ACP `authenticate` with a
  // delegated browser method that hands out the console.mistral.ai URL and completes when the page did.
  // `sessionboxer-vibe-login` (in the Sandbox image) drives `vibe-acp` through it, printing
  // "Open https://console.mistral.ai/…"; Vibe then writes the API key it got to `~/.vibe/.env` (no keyring).
  vibe: {
    bin: ["sessionboxer-vibe-login"],
    args: [],
    env: { ...noBrowser, VIBE_ENABLE_AUTO_UPDATE: "false", VIBE_TEST_DISABLE_KEYRING: "1" },
    isLoginUrl: (u) => /(^|\.)mistral\.ai$/.test(u.hostname) && /authenticate/i.test(u.pathname),
    code: "none",
    prompt: null,
    userCode: () => null,
    rejected: (text) => /^Error:\s*([^\n]*)/m.exec(text)?.[1]?.trim() ?? null,
    files: [".vibe/.env"],
    result: (_output, file) => {
      if (!file) return null;
      try {
        const login = normalizeVibeLogin(file);
        return login && describeVibeLogin(login) ? { login, account: null } : null;
      } catch {
        return null;
      }
    },
    secret: (login) => ({ vibe: { VIBE_LOGIN: login } }),
  },
  // `grok login --device-auth` is xAI's device flow (ADR-0086): Grok Build prints "To sign in, open this URL in
  // your browser:", `https://accounts.x.ai/oauth2/device?user_code=XXXX-XXXX`, "Confirm this code in your
  // browser:" and the code on a line of its own, then polls xAI; the page prefills the code from the URL.
  grok: {
    bin: ["grok"],
    args: ["login", "--device-auth"],
    env: { ...noBrowser, GROK_DISABLE_AUTOUPDATER: "1" },
    isLoginUrl: (u) => /(^|\.)x\.ai$/.test(u.hostname) && /device/i.test(u.pathname),
    code: "page",
    prompt: null,
    userCode: (text) => /^\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\s*$/m.exec(text)?.[1] ?? null,
    rejected: (text) => (/denied|expired|rejected/i.test(text) ? "xAI did not confirm the code" : null),
    files: [".grok/auth.json"],
    result: (_output, file) => {
      if (!file) return null;
      try {
        const login = normalizeGrokLogin(file);
        return login && describeGrokLogin(login) ? { login, account: describeGrokLogin(login)?.email ?? null } : null;
      } catch {
        return null;
      }
    },
    secret: (login) => ({ grok: { GROK_LOGIN: login } }),
  },
  qwen: qwenLoginRecipe(noBrowser),
};

/** A driven CLI that ignores EOF (a Windows console) is killed this long after `done`; its login file is read all the same. */
const DRIVE_EXIT_WAIT_MS = 5_000;

interface SettingsStore {
  get(): Settings;
  set(next: Settings): void;
}

/** A login CLI on a pty, wherever it runs, with the file it left in its scratch home. */
export interface LoginProcess extends TtyProcess {
  /** The first of the recipe's `files` the CLI wrote, once it exited; `null` when none. */
  file(): Promise<string | null>;
  /** Frees the scratch home (and whatever else the run took). */
  dispose(): Promise<void>;
}

/** Where a sign-in's CLI runs. */
export interface LoginRunner {
  spawn(recipe: Recipe, id: string, provider: Provider): Promise<LoginProcess>;
}

interface Flow {
  state: ProviderLoginFlow;
  recipe: Recipe;
  proc: LoginProcess | null;
  output: string;
  /** A submitted code the CLI's prompt was not yet ready for. */
  pendingCode: string | null;
  /** Where in `output` the code was typed; what follows is the CLI's verdict. */
  typedAt: number;
  /** A `drive` recipe's CLI was told to exit (EOF) after `done` matched. */
  driven: boolean;
  timer: NodeJS.Timeout | null;
}

export class ProviderLogins {
  private readonly flows = new Map<string, Flow>();

  constructor(
    private readonly runner: LoginRunner,
    private readonly settings: SettingsStore,
    private readonly log: (msg: string) => void,
    private readonly recipes: Partial<Record<Provider, Recipe>> = RECIPES,
  ) {}

  /** Starts a sign-in for `provider`, replacing one still in progress. */
  start(provider: Provider): ProviderLoginFlow {
    for (const f of this.flows.values()) {
      if (f.state.provider === provider && !finished(f.state)) this.fail(f, "Replaced by a newer sign-in, from another tab or device.");
    }
    this.sweep();
    const recipe = this.recipes[provider];
    if (!recipe || recipe.bin.length === 0) throw new HttpError(409, `${label(provider)} has no sign-in from the browser; paste its login instead.`);
    const flow: Flow = {
      state: {
        id: randomUUID(),
        provider,
        status: "starting",
        url: null,
        pasteCode: recipe.code === "paste",
        userCode: null,
        account: null,
        error: null,
        expiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString(),
      },
      recipe,
      proc: null,
      output: "",
      pendingCode: null,
      typedAt: 0,
      driven: false,
      timer: null,
    };
    this.flows.set(flow.state.id, flow);
    void this.boot(flow);
    return flow.state;
  }

  get(id: string): ProviderLoginFlow {
    const flow = this.flows.get(id);
    if (!flow) throw new HttpError(404, "Unknown sign-in; start again.");
    return flow.state;
  }

  /** Types the code the sign-in page showed into the waiting CLI. */
  submit(id: string, code: string): ProviderLoginFlow {
    const flow = this.flows.get(id);
    if (!flow) throw new HttpError(404, "Unknown sign-in; start again.");
    if (!flow.state.pasteCode) throw new HttpError(409, `${label(flow.state.provider)} does not take a code; finish signing in on the page.`);
    if (flow.state.status !== "awaiting_code" || !flow.proc) throw new HttpError(409, `The sign-in is ${describe(flow.state.status)}.`);
    if (/[\r\n]/.test(code)) throw new HttpError(400, "The code is a single line.");
    this.arm(flow, EXCHANGE_WAIT_MS, "The code was not accepted in time; start again.");
    flow.state = { ...flow.state, status: "exchanging" };
    flow.pendingCode = code;
    this.typePending(flow);
    return flow.state;
  }

  private typePending(flow: Flow): void {
    if (flow.pendingCode === null || !flow.proc || !flow.recipe.prompt?.test(stripTerminal(flow.output))) return;
    flow.typedAt = flow.output.length;
    flow.proc.write(`${flow.pendingCode}\r`);
    flow.pendingCode = null;
  }

  cancel(id: string): void {
    const flow = this.flows.get(id);
    if (!flow) return;
    if (!finished(flow.state)) this.fail(flow, "Cancelled.");
    this.flows.delete(id);
  }

  /** What this machine offers for `provider`: a sign-in, and the CLI's own login here when there is one. */
  hostLogin(provider: Provider): ProviderHostLogin {
    const host = readHostLogin(provider);
    return { signIn: this.recipes[provider] !== undefined, account: host?.account ?? null, importable: host?.login !== undefined };
  }

  /**
   * Copies the login the Provider's CLI holds on this machine into Settings: Devin's API key,
   * Codex's and Cursor's `auth.json`. Not Claude Code's: its credential is short-lived and its
   * refresh token rotates (ADR-0002), so only a fresh `setup-token` can be shared.
   */
  importHostLogin(provider: Provider): void {
    if (provider === "claude-code") throw new HttpError(409, "Claude Code's login on this machine cannot be copied; sign in instead.");
    const login = readHostLogin(provider)?.login;
    if (!login) throw new HttpError(404, `No ${label(provider)} login on this machine.`);
    this.store(provider, login);
  }

  private async boot(flow: Flow): Promise<void> {
    const recipe = flow.recipe;
    const name = label(flow.state.provider);
    this.arm(flow, URL_WAIT_MS, `${name} did not show a sign-in link in time.`);
    let proc: LoginProcess;
    try {
      proc = await this.runner.spawn(recipe, flow.state.id, flow.state.provider);
    } catch (e) {
      this.fail(flow, `Could not start ${name}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (finished(flow.state)) {
      await proc.kill();
      await proc.dispose();
      return;
    }
    flow.proc = proc;
    if (recipe.drive) proc.write(recipe.drive.input);
    proc.onData((chunk) => {
      const overflow = Math.max(0, flow.output.length + chunk.length - OUTPUT_CAP);
      flow.output = (flow.output + chunk).slice(overflow);
      flow.typedAt = Math.max(0, flow.typedAt - overflow);
      if (recipe.drive && !flow.driven && recipe.drive.done.test(stripTerminal(flow.output))) {
        flow.driven = true;
        proc.write("\x04");
        setTimeout(() => void proc.kill().catch(() => undefined), DRIVE_EXIT_WAIT_MS);
      }
      if (flow.state.status === "starting") {
        const url = loginUrl(flow.output, recipe);
        if (!url) return;
        const userCode = recipe.code === "page" ? recipe.userCode(stripTerminal(flow.output)) : null;
        if (recipe.code === "page" && !userCode) return;
        // The page's side may take as long as the flow lives.
        this.arm(flow, Math.max(1000, Date.parse(flow.state.expiresAt) - Date.now()), "The sign-in was not completed in time; start again.");
        flow.state = { ...flow.state, status: "awaiting_code", url, userCode };
      } else if (flow.state.status === "exchanging") {
        if (flow.pendingCode !== null) {
          this.typePending(flow);
          return;
        }
        const why = recipe.rejected(stripTerminal(flow.output.slice(flow.typedAt)));
        if (why) this.fail(flow, `${name} did not accept the code (${why}); start again.`);
      }
    });
    const exit = await proc.exited;
    const ok = exit === 0 || (exit === null && flow.driven);
    const file = ok ? await proc.file().catch(() => null) : null;
    await proc.dispose().catch(() => undefined);
    if (finished(flow.state)) return;
    this.disarm(flow);
    if (!ok) {
      this.fail(flow, `${name} exited${exit === null ? "" : ` (${exit})`}: ${lastLine(flow.output) || "no details"}`);
      return;
    }
    const result = recipe.result(flow.output, file);
    if (!result) {
      this.fail(flow, `${name} finished but left no login behind.`);
      return;
    }
    this.store(flow.state.provider, result.login);
    flow.output = "";
    flow.state = { ...flow.state, status: "done", account: result.account };
    this.log(`${flow.state.provider}: signed in${result.account ? ` as ${result.account}` : ""}; login stored in Settings`);
  }

  private store(provider: Provider, login: string): void {
    const recipe = this.recipes[provider];
    const secret = recipe ? recipe.secret(login) : provider === "opencode" ? { opencode: { OPENCODE_AUTH_JSON: login } } : null;
    if (!secret) throw new HttpError(409, `${label(provider)} logins cannot be stored from here.`);
    this.settings.set(applySettingsUpdate(this.settings.get(), { providerSecrets: secret }));
  }

  private fail(flow: Flow, error: string): void {
    this.disarm(flow);
    flow.state = { ...flow.state, status: "error", error: redact(error) };
    flow.output = "";
    if (flow.proc) void flow.proc.kill().catch(() => undefined);
    this.log(`${flow.state.provider} sign-in failed: ${flow.state.error}`);
  }

  private arm(flow: Flow, ms: number, message: string): void {
    this.disarm(flow);
    flow.timer = setTimeout(() => this.fail(flow, message), ms);
  }

  private disarm(flow: Flow): void {
    if (flow.timer) clearTimeout(flow.timer);
    flow.timer = null;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, f] of this.flows) if (Date.parse(f.state.expiresAt) < now) this.cancel(id);
  }
}

const finished = (s: ProviderLoginFlow): boolean => s.status === "done" || s.status === "error";

function label(provider: Provider): string {
  return { "claude-code": "the Claude Code CLI", devin: "the Devin CLI", codex: "the Codex CLI", cursor: "the Cursor CLI", pi: "pi", opencode: "OpenCode", fx: "fx", kimi: "Kimi CLI", copilot: "GitHub Copilot", vibe: "Mistral Vibe", grok: "Grok Build", gemini: "Gemini CLI", qwen: "Qwen Code" }[provider];
}

function describe(status: ProviderLoginFlow["status"]): string {
  return status === "starting" ? "still starting" : status === "exchanging" ? "already redeeming a code" : status === "done" ? "already finished" : "over; start again";
}

// --- where the CLI runs ---------------------------------------------------------------------

/**
 * The CLI installed on this machine when there is one, else a throwaway container from the
 * Provider's Sandbox image (pulled first when it is not here). Either way the CLI gets a scratch home of its own.
 */
export class HostOrSandboxRunner implements LoginRunner {
  constructor(private readonly docker: SandboxDocker) {}

  async spawn(recipe: Recipe, id: string, provider: Provider): Promise<LoginProcess> {
    const bin = recipe.bin.map(findOnPath).find((b) => b !== null);
    if (bin) return spawnHost(bin, recipe, id);
    const image = await this.docker.resolveImage(provider);
    return spawnInSandbox(this.docker, image.reference, recipe, id);
  }
}

/** Runs the CLI on a pty here, in a scratch home under the temp dir (so `~/.claude.json` and friends stay untouched). */
export function spawnHost(bin: string, recipe: Recipe, id: string): LoginProcess {
  const home = join(tmpdir(), `sessionboxer-login-${id}`);
  const dirs = {
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    // Codex refuses to start when this one is missing.
    CODEX_HOME: join(home, ".codex"),
    QWEN_HOME: join(home, ".qwen"),
  };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [path, text] of Object.entries(recipe.seed ?? {})) {
    mkdirSync(dirname(join(home, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, path), text, { mode: 0o600 });
  }
  const env: Record<string, string> = {
    ...(Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)) as Record<string, string>),
    ...recipe.env,
    TERM: "xterm-256color",
    NO_COLOR: "1",
    COLUMNS: String(TTY_COLUMNS),
    HOME: home,
    USERPROFILE: home,
    ...dirs,
  };
  // The CLIs ignore BROWSER and open the URL themselves; the Settings page does that, in the
  // browser the user is actually in, so the openers they shell out to are shadowed with no-ops.
  if (platform() !== "win32") {
    const shims = join(home, "bin");
    mkdirSync(shims, { recursive: true, mode: 0o700 });
    for (const opener of BROWSER_OPENERS) writeFileSync(join(shims, opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    env.PATH = `${shims}${delimiter}${env.PATH ?? ""}`;
  }
  const script = /\.(cmd|bat)$/i.test(bin);
  const dispose = async () => rmSync(home, { recursive: true, force: true });
  const file = async () => readFirst(recipe.files.map((f) => join(home, f)));
  if (recipe.drive) return spawnHostPiped(script ? "cmd.exe" : bin, script ? ["/c", bin, ...recipe.args] : recipe.args, { cwd: home, env }, file, dispose);
  const proc = pty.spawn(script ? "cmd.exe" : bin, script ? ["/c", bin, ...recipe.args] : recipe.args, {
    name: "xterm-256color",
    cols: TTY_COLUMNS,
    rows: 50,
    cwd: home,
    env,
  });
  const listeners: Array<(chunk: string) => void> = [];
  let backlog = "";
  proc.onData((text) => {
    if (listeners.length === 0) backlog += text;
    for (const fn of listeners) fn(text);
  });
  const exited = new Promise<number | null>((resolve) => proc.onExit(({ exitCode, signal }) => resolve(signal ? null : exitCode)));
  return {
    onData: (fn) => {
      listeners.push(fn);
      if (backlog) {
        const text = backlog;
        backlog = "";
        fn(text);
      }
    },
    write: (text) => proc.write(text),
    exited,
    kill: async () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
    file,
    dispose,
  };
}


/** Runs the CLI in a throwaway container; it prints the login file after a marker on the way out. */
export async function spawnInSandbox(docker: SandboxDocker, image: string, recipe: Recipe, id: string): Promise<LoginProcess> {
  const quote = (text: string): string => `"${text.replace(/(["$`\\])/g, "\\$1")}"`;
  const files = recipe.files.map((f) => quote(`$HOME/${f}`)).join(" ");
  const seeds = Object.entries(recipe.seed ?? {})
    .map(([path, text]) => `mkdir -p "$(dirname ${quote(`$HOME/${path}`)})" && printf '%s' ${quote(text)} > ${quote(`$HOME/${path}`)}; `)
    .join("");
  // A driven CLI (ACP over stdin, which must not be the terminal) gets its input from a pipe that closes once the login file exists.
  const run = recipe.drive ? `{ printf '%s' "$SBX_DRIVE"; until for f in ${files}; do [ -f "$f" ] && break; done; do sleep 1; done; sleep 1; } | "$@"` : `"$@"`;
  const script = `${seeds}${run} || exit $?; printf '\\n%s\\n' "$MARK"; for f in ${files}; do if [ -f "$f" ]; then cat "$f"; break; fi; done; exit 0`;
  const proc = await docker.runTty(image, ["sh", "-c", script, "login", recipe.bin[0]!, ...recipe.args], `login-${id}`, { ...recipe.env, MARK: CREDENTIALS_MARK, ...(recipe.drive ? { SBX_DRIVE: recipe.drive.input } : {}) });
  let output = "";
  proc.onData((chunk) => {
    output = (output + chunk).slice(-OUTPUT_CAP);
  });
  return {
    ...proc,
    file: async () => {
      const at = output.lastIndexOf(CREDENTIALS_MARK);
      if (at < 0) return null;
      const text = stripTerminal(output.slice(at + CREDENTIALS_MARK.length)).trim();
      return text === "" ? null : text;
    },
    dispose: async () => undefined,
  };
}

/** The CLI on PATH (plus the usual per-user bin dirs a service's PATH misses), or `null`. */
export function findOnPath(bin: string): string | null {
  const home = homedir();
  const names = platform() === "win32" ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(home, ".local", "bin"), join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"].filter((d) => d !== "");
  for (const dir of dirs) for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}

// --- reading the CLI's output ---------------------------------------------------------------

// OSC 8 hyperlinks carry the whole URL even where the terminal wrapped the visible text.
const OSC8_RE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
const URL_RE = /https:\/\/[^\s"'<>\x07\x1b]+/g;

/** The Provider's sign-in URL out of raw terminal output, `null` until it appears. */
export function loginUrl(output: string, recipe: Pick<Recipe, "isLoginUrl">): string | null {
  const candidates: string[] = [...output.matchAll(OSC8_RE)].map((m) => m[1] ?? "");
  candidates.push(...(stripTerminal(output).match(URL_RE) ?? []));
  for (const raw of candidates) {
    let url: URL;
    try {
      url = new URL(raw.replace(/[.,;:)\]]+$/, ""));
    } catch {
      continue;
    }
    if (recipe.isLoginUrl(url)) return url.toString();
  }
  return null;
}

/**
 * Terminal output as plain text: no escape sequences, every `\r` a line break. TUIs reposition
 * the cursor rather than overwrite, so a redraw becomes extra lines instead of erasing what came
 * before (an error message must not vanish under the prompt that is redrawn after it).
 */
export function stripTerminal(raw: string): string {
  return raw
    .replace(/\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*G/g, " ")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** The last line the CLI showed the user: never the login it dumped after the marker. */
function lastLine(output: string): string {
  const mark = output.indexOf(CREDENTIALS_MARK);
  const lines = stripTerminal(mark < 0 ? output : output.slice(0, mark))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/paste|visit|browser|sign in|ctrl\+click|one-time code/i.test(l) && !/https:\/\//.test(l) && !l.includes(CREDENTIALS_MARK));
  return (lines.at(-1) ?? "").slice(0, 300);
}

/** Anything token-shaped out of a message that reaches the UI or the log. */
export function redact(text: string): string {
  return text
    .replace(CLAUDE_TOKEN_RE, "sk-ant-oat01-…")
    .replace(/(key|token|secret)\s*=\s*["'][^"']*["']/gi, "$1 = […]")
    .replace(/("[^"]*(?:key|token|secret)[^"]*"\s*:\s*)"[^"]*"/gi, '$1"[…]"')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[jwt]");
}

