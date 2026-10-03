#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UTILITIES_MANIFEST_PATH, UtilitiesManifest, UtilitySpec, totpCode } from "@sessionboxer/protocol";

/**
 * `sb-util` (ADR-0073): the Agent's shell door to the Session's Utilities without ever printing a
 * credential. Reads the Daemon's tmpfs files (`<tmpfs>/utilities/<name>.json`) and the manifest.
 *
 *   sb-util list                          the Utilities on for this Session
 *   sb-util env <util> -- <cmd…>          run with UTIL_<CREDENTIAL>=… (and the CLI facet's env) set
 *   sb-util curl <util> <path> [args…]    curl the HTTP facet: base URL + path, its headers, basic auth
 *   sb-util ssh <util> [cmd…]             ssh to the SSH facet (key or password, jump host)
 *   sb-util tunnel <util> L:H:P [L:H:P…]  keep local port forwards through the SSH facet open
 *   sb-util otp <util>                    the current one-time code (the `totp` credential)
 *   sb-util open <util> [path]            open the web facet in the Sandbox's browser
 *
 * <util> is a name from the manifest, or `name@environment` when the same name is on twice.
 */
const dir = process.env.SESSIONBOXER_UTILITIES_DIR ?? "/dev/shm/sessionboxer/utilities";
const workspace = process.env.SESSIONBOXER_WORKSPACE ?? "/workspace";

function fail(msg: string): never {
  process.stderr.write(`sb-util: ${msg}\n`);
  process.exit(2);
}

function manifest(): UtilitiesManifest | null {
  try {
    return UtilitiesManifest.parse(JSON.parse(readFileSync(join(workspace, UTILITIES_MANIFEST_PATH), "utf8")));
  } catch {
    return null;
  }
}

function load(ref: string): UtilitySpec {
  const file = join(dir, `${ref}.json`);
  if (!existsSync(file)) {
    const have = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
    fail(`no Utility "${ref}" is on for this Session${have.length > 0 ? ` (on: ${have.join(", ")})` : ""}; see ${UTILITIES_MANIFEST_PATH} and utilities_enable.`);
  }
  return UtilitySpec.parse(JSON.parse(readFileSync(file, "utf8")));
}

const cred = (u: UtilitySpec, name: string): string | undefined => u.credentials.find((c) => c.name === name)?.value;
const envName = (name: string) => `UTIL_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;

function credentialEnv(u: UtilitySpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const c of u.credentials) env[envName(c.name)] = c.value;
  for (const kv of u.cli?.env ?? []) env[kv.name] = kv.value;
  env.UTIL_NAME = u.name;
  env.UTIL_ENVIRONMENT = u.environment;
  if (u.http) env.UTIL_BASE_URL = u.http.baseUrl;
  if (u.web) env.UTIL_URL = u.web.url;
  return env;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): never {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  process.exit(r.status ?? 1);
}

/** The private key of an SSH facet as a file (0600, on tmpfs next to the credentials). */
function keyFile(u: UtilitySpec, ref: string): string | null {
  const key = cred(u, "ssh_key");
  if (!key) return null;
  const file = join(dir, `${ref}.key`);
  writeFileSync(file, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function sshArgs(u: UtilitySpec, ref: string): { cmd: string; args: string[] } {
  if (!u.ssh) fail(`"${ref}" has no SSH facet.`);
  const args = ["-o", "StrictHostKeyChecking=accept-new", "-p", String(u.ssh.port)];
  if (u.ssh.jump) args.push("-J", u.ssh.jump);
  const key = keyFile(u, ref);
  if (key) args.push("-i", key, "-o", "IdentitiesOnly=yes");
  const user = u.ssh.user || cred(u, "user") || "";
  const target = user ? `${user}@${u.ssh.host}` : u.ssh.host;
  const password = cred(u, "password");
  if (!key && password) return { cmd: "sshpass", args: ["-e", "ssh", ...args, target] };
  return { cmd: "ssh", args: [...args, target] };
}

const [command, ref, ...rest] = process.argv.slice(2);
switch (command) {
  case "list": {
    const m = manifest();
    if (!m || m.utilities.length === 0) {
      process.stdout.write("No Utility is on for this Session.\n");
      if (m && m.available.length > 0) process.stdout.write(`Available (off): ${m.available.map((u) => `${u.name}@${u.environment}`).join(", ")} — utilities_enable switches them on.\n`);
      break;
    }
    for (const u of m.utilities) {
      const facets = [u.mcp ? `mcp:${u.mcp}` : null, u.web ? "web" : null, u.http ? "http" : null, u.ssh ? "ssh" : null, u.cli ? "cli" : null].filter((f) => f !== null);
      process.stdout.write(`${u.name}@${u.environment}\t${u.group}\t${u.readOnly ? "read-only" : "read-write"}${u.production ? "\tPRODUCTION" : ""}\t${facets.join(",")}\tcredentials: ${u.credentials.join(",") || "-"}\n`);
    }
    break;
  }
  case "env": {
    if (!ref) fail("usage: sb-util env <util> -- <command…>");
    const u = load(ref);
    const sep = rest.indexOf("--");
    const cmd = sep >= 0 ? rest.slice(sep + 1) : rest;
    if (cmd.length === 0) {
      for (const c of u.credentials) process.stdout.write(`${envName(c.name)}\n`);
      for (const kv of u.cli?.env ?? []) process.stdout.write(`${kv.name}\n`);
      break;
    }
    run(cmd[0]!, cmd.slice(1), credentialEnv(u));
  }
  // eslint-disable-next-line no-fallthrough
  case "curl": {
    if (!ref) fail("usage: sb-util curl <util> <path> [curl args…]");
    const u = load(ref);
    if (!u.http) fail(`"${ref}" has no HTTP facet.`);
    const path = rest[0] ?? "/";
    const url = /^https?:\/\//.test(path) ? path : `${u.http.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    const args = ["-sS"];
    for (const h of u.http.headers) args.push("-H", `${h.name}: ${h.value}`);
    const user = cred(u, "user");
    const password = cred(u, "password");
    const token = cred(u, "token");
    const hasAuth = u.http.headers.some((h) => /^authorization$/i.test(h.name));
    if (!hasAuth && user && password) args.push("-u", `${user}:${password}`);
    else if (!hasAuth && token && !u.http.headers.some((h) => /key|token/i.test(h.name))) args.push("-H", `Authorization: Bearer ${token}`);
    run("curl", [...args, ...rest.slice(1), url], {});
  }
  // eslint-disable-next-line no-fallthrough
  case "ssh": {
    if (!ref) fail("usage: sb-util ssh <util> [command…]");
    const u = load(ref);
    const { cmd, args } = sshArgs(u, ref);
    run(cmd, [...args, ...rest], cmd === "sshpass" ? { SSHPASS: cred(u, "password") } : {});
  }
  // eslint-disable-next-line no-fallthrough
  case "tunnel": {
    if (!ref || rest.length === 0) fail("usage: sb-util tunnel <util> <local>:<host>:<port> […]");
    const u = load(ref);
    const { cmd, args } = sshArgs(u, ref);
    const forwards = rest.flatMap((f) => ["-L", f]);
    process.stderr.write(`sb-util: forwarding ${rest.join(", ")} through ${u.ssh?.host}; Ctrl-C ends it.\n`);
    run(cmd, [...args, "-N", ...forwards], cmd === "sshpass" ? { SSHPASS: cred(u, "password") } : {});
  }
  // eslint-disable-next-line no-fallthrough
  case "otp": {
    if (!ref) fail("usage: sb-util otp <util>");
    const u = load(ref);
    const secret = cred(u, "totp");
    if (!secret) fail(`"${ref}" has no totp credential.`);
    void totpCode(secret).then((code) => process.stdout.write(`${code}\n`));
    break;
  }
  case "open": {
    if (!ref) fail("usage: sb-util open <util> [path]");
    const u = load(ref);
    if (!u.web) fail(`"${ref}" has no web facet.`);
    const path = rest[0] ?? "";
    const url = path === "" ? u.web.url : /^https?:\/\//.test(path) ? path : `${u.web.url.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    const r = spawnSync("xdg-open", [url], { stdio: "ignore", env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":1" } });
    if (r.error || r.status !== 0) fail(`could not open the browser: ${r.error?.message ?? `xdg-open exited ${r.status}`}`);
    process.stdout.write(`Opened ${url} in the Desktop's browser${u.web.login === "form" ? `; sign in there by typing \${util:${u.name}.user} / \${util:${u.name}.password}${cred(u, "totp") ? " and ${util:" + u.name + ".otp}" : ""} with the desktop type tool` : ""}.\n`);
    break;
  }
  default:
    process.stdout.write(
      [
        "sb-util — the Session's Utilities from the shell (credentials never printed).",
        "  sb-util list",
        "  sb-util env <util> -- <command…>      UTIL_<CREDENTIAL>=… in the environment",
        "  sb-util curl <util> <path> [args…]    the HTTP facet, headers and auth added",
        "  sb-util ssh <util> [command…]         the SSH facet (key / password, jump host)",
        "  sb-util tunnel <util> L:H:P […]       port forwards through the SSH facet",
        "  sb-util otp <util>                    current one-time code",
        "  sb-util open <util> [path]            the web facet in the Desktop's browser",
        "<util> is a name from .sessionboxer/utilities.json (name@environment when on twice).",
      ].join("\n") + "\n",
    );
    process.exit(command === undefined || command === "help" || command === "--help" ? 0 : 2);
}
