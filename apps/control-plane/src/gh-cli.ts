import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar-stream";
import { DATA_DIR } from "./config.js";

/**
 * GitHub CLI release used when the machine has no `gh`. Pinned so the download is
 * reproducible and its checksum comes from the same release; `SESSIONBOXER_GH_VERSION` overrides.
 */
export const GH_VERSION = process.env.SESSIONBOXER_GH_VERSION ?? "2.101.0";
const GH_RELEASES = "https://github.com/cli/cli/releases/download";
export const GH_BIN_DIR = join(DATA_DIR, "bin");
/** Logins run with their own config dir so they never touch or switch the user's `gh` accounts. */
const GH_PRIVATE_CONFIG_DIR = join(DATA_DIR, "gh");
/** Beyond gh's defaults (`repo`, `read:org`, `gist`): PR workflows and the account lookup. */
const GH_EXTRA_SCOPES = "workflow,read:user,user:email";
const CODE_RE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const URL_RE = /(https:\/\/\S+\/login\/device\S*)/;

export interface GhCli {
  path: string;
  version: string | null;
}

export interface GhDeviceLogin {
  /** Resolves once gh prints the code (or rejects if it exits first). */
  code: Promise<{ userCode: string; verificationUri: string }>;
  /** Resolves with the token and account once the user authorized; rejects on failure/cancel. */
  token: Promise<{ token: string; account: string }>;
  cancel(): void;
}

/** `gh` from PATH, or the copy Sessionboxer downloaded earlier; `null` when neither exists. */
export async function findGh(): Promise<GhCli | null> {
  const names = platform() === "win32" ? ["gh.exe", "gh"] : ["gh"];
  const dirs = [GH_BIN_DIR, ...(process.env.PATH ?? "").split(delimiter).filter((d) => d !== "")];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      const version = await ghVersion(candidate);
      if (version !== null) return { path: candidate, version };
    }
  }
  return null;
}

/** `findGh()`, downloading the pinned release into `~/.sessionboxer/bin` when needed. */
export async function ensureGh(log: (msg: string) => void): Promise<GhCli> {
  const found = await findGh();
  if (found) return found;
  const asset = releaseAsset();
  log(`gh not found; downloading GitHub CLI ${GH_VERSION} (${asset.name})`);
  mkdirSync(GH_BIN_DIR, { recursive: true, mode: 0o700 });
  const archive = join(GH_BIN_DIR, asset.name);
  const stage = join(GH_BIN_DIR, `.gh-${GH_VERSION}`);
  rmSync(stage, { recursive: true, force: true });
  try {
    const [data, sums] = await Promise.all([download(`${GH_RELEASES}/v${GH_VERSION}/${asset.name}`), download(`${GH_RELEASES}/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt`)]);
    const expected = sums
      .toString("utf8")
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .find((parts) => parts[1] === asset.name)?.[0];
    if (!expected) throw new Error(`no checksum listed for ${asset.name}`);
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expected) throw new Error(`checksum mismatch for ${asset.name}`);
    mkdirSync(stage, { recursive: true });
    const target = join(GH_BIN_DIR, asset.binary);
    if (asset.name.endsWith(".tar.gz")) {
      // Linux: unpacked in-process, no tar/gzip needed on the machine.
      const staged = join(stage, asset.binary);
      await untarFile(data, `bin/${asset.binary}`, staged);
      renameSync(staged, target);
    } else {
      // macOS and Windows ship .zip; both bundle bsdtar, which extracts zip files.
      writeFileSync(archive, data);
      await run("tar", ["-xf", archive, "-C", stage], process.env);
      // The macOS zip wraps everything in `gh_<version>_<platform>/`; the Windows zip does not.
      const extracted = [join(stage, `gh_${GH_VERSION}_${asset.platform}`, "bin", asset.binary), join(stage, "bin", asset.binary)].find((p) => existsSync(p));
      if (!extracted) throw new Error(`archive did not contain bin/${asset.binary}`);
      renameSync(extracted, target);
    }
    if (platform() !== "win32") chmodSync(target, 0o755);
    const version = await ghVersion(target);
    if (version === null) throw new Error("the downloaded gh does not run on this machine");
    log(`GitHub CLI ${version} installed at ${target}`);
    return { path: target, version };
  } finally {
    rmSync(archive, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Writes the entry whose path ends with `suffix` out of a .tar.gz to `dest`. */
async function untarFile(targz: Buffer, suffix: string, dest: string): Promise<void> {
  let found = false;
  const tar = extract();
  tar.on("entry", (header, stream, next) => {
    if (header.type === "file" && header.name.endsWith(`/${suffix}`) && !found) {
      found = true;
      const chunks: Buffer[] = [];
      stream.on("data", (c) => chunks.push(Buffer.from(c as Uint8Array)));
      stream.on("end", () => {
        writeFileSync(dest, Buffer.concat(chunks));
        next();
      });
    } else {
      stream.on("end", next);
      stream.resume();
    }
  });
  await pipeline(Readable.from([targz]), createGunzip(), tar);
  if (!found) throw new Error(`archive did not contain ${suffix}`);
}

/** Accounts the user's own `gh` (default config) is logged in to on github.com. */
export async function hostLogins(gh: GhCli): Promise<string[]> {
  const { stdout, stderr } = await run(gh.path, ["auth", "status", "--hostname", "github.com"], hostEnv(), { allowFailure: true });
  const logins: string[] = [];
  for (const m of `${stdout}\n${stderr}`.matchAll(/Logged in to github\.com account (\S+)/g)) {
    const login = m[1] ?? "";
    if (login !== "" && !logins.includes(login)) logins.push(login);
  }
  return logins;
}

/**
 * The token the user's own `gh` holds for `account`. An account logged in through `GH_TOKEN`
 * rather than `hosts.yml` is not addressable with `--user`, so the active token is read then.
 */
export async function hostToken(gh: GhCli, account: string): Promise<string> {
  const byUser = await run(gh.path, ["auth", "token", "--hostname", "github.com", "--user", account], hostEnv(), { allowFailure: true });
  let token = byUser.stdout.trim();
  if (token === "") {
    const status = await run(gh.path, ["auth", "status", "--hostname", "github.com", "--active"], hostEnv(), { allowFailure: true });
    const active = /Logged in to github\.com account (\S+)/.exec(`${status.stdout}\n${status.stderr}`)?.[1];
    if (active === account) token = (await run(gh.path, ["auth", "token", "--hostname", "github.com"], hostEnv(), { allowFailure: true })).stdout.trim();
  }
  if (token === "") throw new Error(`gh has no token for @${account}: ${byUser.stderr.trim() || "not logged in"}`);
  return token;
}

/**
 * Runs `gh auth login --web` against Sessionboxer's private gh config: gh prints the one-time
 * code and polls GitHub itself; when it finishes we read the token out and log that account out
 * of the private config again, so `config.json` stays the only place the token lives.
 */
export function deviceLogin(gh: GhCli, log: (msg: string) => void): GhDeviceLogin {
  mkdirSync(GH_PRIVATE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const env = privateEnv();
  const child = spawn(
    gh.path,
    ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key", "--scopes", GH_EXTRA_SCOPES],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const code = deferred<{ userCode: string; verificationUri: string }>();
  const onData = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    const userCode = CODE_RE.exec(output)?.[1];
    const verificationUri = URL_RE.exec(output)?.[1];
    if (userCode && verificationUri) code.resolve({ userCode: userCode.toUpperCase(), verificationUri });
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
  child.on("error", (e) => code.reject(e));
  const token = (async () => {
    const exit = await exited;
    if (exit !== 0) {
      const reason = summarizeGhFailure(output);
      code.reject(new Error(reason));
      throw new Error(reason);
    }
    const account = (await run(gh.path, ["api", "user", "--jq", ".login"], env)).stdout.trim();
    const value = (await run(gh.path, ["auth", "token", "--hostname", "github.com"], env)).stdout.trim();
    if (account === "" || value === "") throw new Error("gh finished but left no token behind.");
    try {
      await run(gh.path, ["auth", "logout", "--hostname", "github.com", "--user", account], env);
    } catch (e) {
      log(`gh: could not clear the private login for @${account}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { token: value, account };
  })();
  token.catch(() => undefined);
  return { code: code.promise, token, cancel: () => killTree(child) };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The user's own gh config (their accounts), non-interactive. */
function hostEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
}

function privateEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...hostEnv(), GH_CONFIG_DIR: GH_PRIVATE_CONFIG_DIR, GH_BROWSER: "" };
  // `gh` would use these instead of the login it just made.
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  return env;
}

function summarizeGhFailure(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/copy your one-time code|Open this URL|clipboard/i.test(l));
  const last = lines.at(-1) ?? "";
  if (/expired/i.test(last)) return "The code expired before it was entered; start again.";
  if (/access_denied|denied/i.test(last)) return "You cancelled the authorization on GitHub.";
  return last === "" ? "gh exited without logging in." : `gh: ${last}`;
}

function releaseAsset(): { name: string; platform: string; binary: string } {
  const os = platform();
  const cpu = arch();
  const archName = cpu === "x64" ? "amd64" : cpu === "arm64" ? "arm64" : null;
  if (archName === null) throw new Error(`GitHub CLI has no release for ${os}/${cpu}; install gh yourself.`);
  if (os === "linux") return { name: `gh_${GH_VERSION}_linux_${archName}.tar.gz`, platform: `linux_${archName}`, binary: "gh" };
  if (os === "darwin") return { name: `gh_${GH_VERSION}_macOS_${archName}.zip`, platform: `macOS_${archName}`, binary: "gh" };
  if (os === "win32") return { name: `gh_${GH_VERSION}_windows_${archName}.zip`, platform: `windows_${archName}`, binary: "gh.exe" };
  throw new Error(`GitHub CLI has no release for ${os}/${cpu}; install gh yourself.`);
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "sessionboxer" } });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function ghVersion(path: string): Promise<string | null> {
  try {
    const { stdout } = await run(path, ["--version"], hostEnv(), { timeoutMs: 10_000 });
    return /gh version (\S+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const timer = opts.timeoutMs ? setTimeout(() => killTree(child), opts.timeoutMs) : null;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0 || opts.allowFailure) resolve({ stdout, stderr, code });
      else reject(new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
}
