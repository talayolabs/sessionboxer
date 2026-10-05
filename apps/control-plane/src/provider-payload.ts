import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { posix } from "node:path";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type Docker from "dockerode";
import { extract, type Header, pack } from "tar-stream";
import { PROVIDER_LABELS, type Provider, type ProviderPayload } from "@sessionboxer/protocol";
import { DATA_DIR, SANDBOX_IMAGE_VERSION, sandboxImageFor, sandboxImageOverride } from "./config.js";
import { HttpError } from "./http-error.js";
import { log as defaultLog } from "./log.js";
import { buildCommandFor, isLocalOnly, LABEL_PAYLOAD_FORMAT, LABEL_RUNTIME, labelledProviders, PAYLOAD_FORMAT, PROVIDER_EXECUTABLES, type SandboxImages } from "./sandbox-images.js";
import { isStatus } from "./vm-host.js";

/**
 * The Agent payloads of the Sandbox images (ADR-0088 §9). A Snapshot of a `<version>-<providerId>`
 * image has one Agent; a fork of it into another Provider keeps the whole filesystem and gets the
 * target Agent staged into its stopped container before the Daemon starts: the payload directory
 * is lifted out of a never-started container of the Provider's own image (the donor) with the
 * archive API, every entry checked against the payload's manifest, and put into the fork the
 * same way, with the launcher links `sessionboxer-link-providers` would make. Nothing in the
 * Snapshot runs, nothing is downloaded or installed, nothing outside the payload moves.
 */
export const PAYLOADS_DIR = "/opt/sessionboxer/providers";
export const LAUNCHERS_DIR = "/usr/local/bin";
/** `sessionboxer.helper` label value of the donor containers (swept at boot like the preflight ones). */
export const PAYLOAD_DONOR_HELPER = "payload-donor";
/** Where a launcher's `#!/usr/bin/env <interpreter>` is looked for in the fork (the image's PATH, system part). */
const SYSTEM_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
const STAGING_DIR = join(DATA_DIR, "payloads");

/** A fork into `provider` whose image lacks the Agent: where the payload comes from, resolved before anything is pulled or created. */
export interface PayloadNeed {
  provider: Provider;
  /** The Provider's own image for this release, or `SESSIONBOXER_IMAGE`. */
  donor: string;
  /** The Snapshot image's `Env`, to tell what the donor's adds. */
  imageEnv: string[];
}

/** A payload ready to stage: the donor is here and carries the Agent; `env` is what the fork container needs set beyond its image's. */
export interface PayloadPlan extends PayloadNeed {
  env: Record<string, string>;
}

/** A tar entry as the verification sees it (`head`: a file's first bytes, for the launchers' shebang). */
export interface PayloadEntry {
  name: string;
  type: NonNullable<Header["type"]>;
  mode: number;
  size: number;
  linkname: string | null;
  sha256: string;
  head: Buffer;
}

export interface PayloadManifest {
  provider: string;
  version: string;
  payloadFormat: number;
  files: string[];
}

/** What `verifyPayload` makes of a payload archive. */
export interface VerifiedPayload {
  version: string;
  digest: string;
  bytes: number;
  /** The `bin/*` launcher names. */
  launchers: string[];
  /** The interpreters the launchers' scripts name (`#!/usr/bin/env node` → `node`; an absolute shebang as is). */
  interpreters: string[];
}

export class ProviderPayloads {
  constructor(
    private readonly docker: Docker,
    private readonly images: SandboxImages,
    private readonly log: (line: string) => void = defaultLog,
  ) {}

  /**
   * Whether a Sandbox created from `image` for `provider` needs the Agent staged in: `null` when the
   * image carries it, going by `known` (the Providers its Snapshot recorded), else its labels, else
   * — a legacy image — the executable preflight. Throws a 409 saying what is missing when the payload
   * cannot be had: a legacy image without the Agent, another release's runtime, a donor that is not here
   * and cannot be pulled, or a `SESSIONBOXER_IMAGE` without the Agent.
   */
  async need(provider: Provider, image: string, known: Provider[] | null): Promise<PayloadNeed | null> {
    const info = await this.docker.getImage(image).inspect();
    const labels = info.Config?.Labels ?? {};
    const providers = known ?? labelledProviders(labels);
    const label = PROVIDER_LABELS[provider];
    if (providers === null) {
      if (await this.images.hasExecutable(image, info.Id, PROVIDER_EXECUTABLES[provider])) return null;
      throw new HttpError(409, `The Snapshot's image has no ${label} and carries no Sessionboxer labels, so no Agent payload matching its runtime can be chosen; fork with its own Agent, or take the Snapshot on a Sessionboxer ${SANDBOX_IMAGE_VERSION} Sandbox image.`);
    }
    if (providers.includes(provider)) return null;
    const runtime = labels[LABEL_RUNTIME];
    if (runtime === undefined) throw new HttpError(409, `The Snapshot's image names its Agents but not its runtime (no ${LABEL_RUNTIME} label), so ${label} cannot be added to the fork.`);
    if (runtime !== SANDBOX_IMAGE_VERSION) {
      throw new HttpError(
        409,
        `The Snapshot was taken on Sessionboxer ${runtime}'s Sandbox image and this Control Plane is ${SANDBOX_IMAGE_VERSION}: an Agent is only added from the same release, so ${label} cannot be added to the fork. Fork with its own Agent, or resume the origin and snapshot it again on ${SANDBOX_IMAGE_VERSION}.`,
      );
    }
    const donor = sandboxImageFor(provider);
    const status = await this.images.inspect(donor);
    if (status.state === "missing" && isLocalOnly(donor)) throw new HttpError(409, `${label} cannot be added to the fork: ${this.missing(donor)}`);
    if (status.state === "ready") await this.assertDonor(provider, donor).catch((e: unknown) => Promise.reject(new HttpError(409, e instanceof Error ? e.message : String(e))));
    return { provider, donor, imageEnv: info.Config?.Env ?? [] };
  }

  /** The donor is here (pulled if it was not) and carries the Agent for this release; what the fork container is created with follows. */
  async prepare(need: PayloadNeed): Promise<PayloadPlan> {
    try {
      await this.images.ensure(need.donor);
    } catch (e) {
      throw new Error(`${PROVIDER_LABELS[need.provider]} cannot be added to the fork: ${e instanceof Error ? e.message : String(e)}`);
    }
    const info = await this.assertDonor(need.provider, need.donor);
    const have = new Set(need.imageEnv);
    const env: Record<string, string> = {};
    for (const kv of (info.Config?.Env ?? []).filter((kv) => !have.has(kv))) {
      const at = kv.indexOf("=");
      env[kv.slice(0, at)] = kv.slice(at + 1);
    }
    return { ...need, env };
  }

  /**
   * Stages the Agent into the stopped container `containerId`: the payload directory as the donor has
   * it, then its launchers' links in `/usr/local/bin`. Refuses a payload directory already there with
   * other content, and a launcher whose interpreter the Snapshot no longer has. Returns what went in.
   */
  async inject(containerId: string, plan: PayloadPlan): Promise<ProviderPayload> {
    const started = Date.now();
    const label = PROVIDER_LABELS[plan.provider];
    const donor = await this.docker.createContainer({
      name: `sbx-payload-${plan.provider}-${Date.now().toString(36)}`,
      Image: plan.donor,
      Entrypoint: ["/bin/true"],
      Cmd: [],
      Labels: { "sessionboxer.helper": PAYLOAD_DONOR_HELPER },
      HostConfig: { NetworkMode: "none", CapDrop: ["ALL"] },
    });
    await mkdir(STAGING_DIR, { recursive: true });
    const staged = join(STAGING_DIR, `${plan.provider}-${randomBytes(6).toString("hex")}.tar`);
    try {
      const archive = await donor.getArchive({ path: `${PAYLOADS_DIR}/${plan.provider}` }).catch((e: unknown) => {
        if (isStatus(e, 404)) throw new Error(`${plan.donor} has no ${label} payload at ${PAYLOADS_DIR}/${plan.provider}; it is not a Sessionboxer ${SANDBOX_IMAGE_VERSION} Sandbox image`);
        throw e;
      });
      await pipeline(archive as Readable, createWriteStream(staged));
      const { entries, manifest } = await readEntries(createReadStream(staged), `${plan.provider}/manifest.json`);
      const payload = verifyPayload(plan.provider, entries, manifest);
      const fork = this.docker.getContainer(containerId);
      const existing = await this.existingDigest(fork, plan.provider);
      if (existing !== null && existing !== payload.digest) {
        throw new Error(`The fork already has ${PAYLOADS_DIR}/${plan.provider} with other content than ${plan.donor}'s ${label} ${payload.version} (${existing} vs ${payload.digest}); it cannot be replaced.`);
      }
      if (existing === null) {
        await fork.putArchive(directoryTar(posix.basename(PAYLOADS_DIR)), { path: posix.dirname(PAYLOADS_DIR) });
        await fork.putArchive(createReadStream(staged), { path: PAYLOADS_DIR });
      }
      await fork.putArchive(launcherLinks(plan.provider, payload.launchers), { path: LAUNCHERS_DIR });
      await this.assertInterpreters(fork, payload.interpreters, label);
      this.log(`${containerId.slice(0, 12)}: ${label} ${payload.version} added from ${plan.donor} (${(payload.bytes / 1024 ** 2).toFixed(1)} MB, ${payload.digest.slice(0, 19)}, ${payload.launchers.join(", ")}) in ${Date.now() - started} ms`);
      return { provider: plan.provider, version: payload.version, digest: payload.digest, bytes: payload.bytes, from: plan.donor };
    } finally {
      await donor.remove({ force: true }).catch((e: unknown) => this.log(`payload donor ${donor.id.slice(0, 12)} not removed: ${String(e)}`));
      await rm(staged, { force: true });
    }
  }

  /** The donor's labels say it carries `provider` for this release (a legacy donor: its executable is found); the image's inspection. */
  private async assertDonor(provider: Provider, donor: string): Promise<Docker.ImageInspectInfo> {
    const info = await this.docker.getImage(donor).inspect();
    const labels = info.Config?.Labels ?? {};
    const label = PROVIDER_LABELS[provider];
    const name = sandboxImageOverride() === donor ? `SESSIONBOXER_IMAGE=${donor}` : donor;
    const providers = labelledProviders(labels);
    const format = labels[LABEL_PAYLOAD_FORMAT];
    if (format !== undefined && format !== PAYLOAD_FORMAT) throw new Error(`${name} has Agent payload format ${format}; this Control Plane reads format ${PAYLOAD_FORMAT}`);
    if (providers === null) {
      if (!(await this.images.hasExecutable(donor, info.Id, PROVIDER_EXECUTABLES[provider]))) throw new Error(`${name} has no ${label}: \`${PROVIDER_EXECUTABLES[provider]}\` is not on its PATH`);
      return info;
    }
    if (!providers.includes(provider)) {
      const carries = providers.length === 0 ? "no Agent" : providers.map((p) => PROVIDER_LABELS[p]).join(", ");
      throw new Error(`${name} carries ${carries}, not ${label}; ${label} forks need an image with it${sandboxImageOverride() === donor ? ` (or no SESSIONBOXER_IMAGE, to use ${sandboxImageFor(provider)})` : ""}`);
    }
    const runtime = labels[LABEL_RUNTIME];
    if (runtime !== SANDBOX_IMAGE_VERSION) throw new Error(`${name} is Sessionboxer ${runtime ?? "?"}'s image; this Control Plane is ${SANDBOX_IMAGE_VERSION} and adds an Agent from its own release only`);
    return info;
  }

  private missing(donor: string): string {
    return `its Sandbox image ${donor} is not on this machine; pull it, or build it with \`${buildCommandFor(donor) ?? "npm run build:image"}\``;
  }

  /** The digest of `${PAYLOADS_DIR}/${provider}` as the fork has it, `null` when it has none. */
  private async existingDigest(fork: Docker.Container, provider: Provider): Promise<string | null> {
    let archive: NodeJS.ReadableStream;
    try {
      archive = await fork.getArchive({ path: `${PAYLOADS_DIR}/${provider}` });
    } catch (e) {
      if (isStatus(e, 404)) return null;
      throw e;
    }
    const { entries } = await readEntries(archive as Readable, null);
    return payloadDigest(entries);
  }

  /** Every interpreter the launchers name is in the fork (its system PATH), so they can start at all. */
  private async assertInterpreters(fork: Docker.Container, interpreters: string[], label: string): Promise<void> {
    for (const interpreter of interpreters) {
      const candidates = interpreter.startsWith("/") ? [interpreter] : SYSTEM_PATH.map((dir) => `${dir}/${interpreter}`);
      let found = false;
      for (const path of candidates) {
        try {
          await fork.infoArchive({ path });
          found = true;
          break;
        } catch (e) {
          if (!isStatus(e, 404)) throw e;
        }
      }
      if (!found) throw new Error(`${label}'s launcher needs \`${interpreter}\`, which the Snapshot no longer has; it cannot run there.`);
    }
  }
}

/** Reads a tar stream into entries (hashing each), keeping the contents of the entry named `manifestName`. */
export async function readEntries(tar: Readable, manifestName: string | null): Promise<{ entries: PayloadEntry[]; manifest: string | null }> {
  const entries: PayloadEntry[] = [];
  let manifest: string | null = null;
  const extractor = extract();
  extractor.on("entry", (header, stream, next) => {
    const hash = createHash("sha256");
    const head: Buffer[] = [];
    const keep = header.name === manifestName;
    const chunks: Buffer[] = [];
    stream.on("data", (data) => {
      const chunk = data as Buffer;
      hash.update(chunk);
      if (head.length === 0) head.push(chunk.subarray(0, 256));
      if (keep) chunks.push(chunk);
    });
    stream.on("end", () => {
      if (keep) manifest = Buffer.concat(chunks).toString("utf8");
      entries.push({
        name: header.name,
        type: header.type ?? "file",
        mode: header.mode ?? 0,
        size: header.size ?? 0,
        linkname: header.linkname ?? null,
        sha256: hash.digest("hex"),
        head: head[0] ?? Buffer.alloc(0),
      });
      next();
    });
    stream.resume();
  });
  await pipeline(tar, extractor);
  return { entries, manifest };
}

/**
 * The archive of `${PAYLOADS_DIR}/${provider}` is exactly the payload its manifest describes: every
 * file and symlink is listed (and every listed one is there), names stay under `<provider>/`, no
 * symlink points out of the payload, a hard link (how the archive repeats a file it already holds)
 * names a file of the payload, nothing else (devices, fifos) is in it. Throws otherwise.
 */
export function verifyPayload(provider: Provider, entries: PayloadEntry[], manifestText: string | null): VerifiedPayload {
  const root = `${provider}/`;
  const where = `the ${PROVIDER_LABELS[provider]} payload`;
  if (manifestText === null) throw new Error(`${where} has no manifest.json`);
  const manifest = parseManifest(manifestText, where);
  if (manifest.provider !== provider) throw new Error(`${where}'s manifest is for ${manifest.provider}`);
  const expected = new Set([...manifest.files, "manifest.json"]);
  const seen = new Set<string>();
  const byPath = new Map<string, PayloadEntry>();
  for (const entry of entries) {
    const rel = relativeTo(root, entry.name, where);
    if (entry.type === "directory") continue;
    if (entry.type !== "file" && entry.type !== "symlink" && entry.type !== "link") throw new Error(`${where} has a ${entry.type} entry, ${rel}, which a payload cannot contain`);
    if (!expected.has(rel)) throw new Error(`${where} has ${rel}, which its manifest does not list`);
    if (entry.type === "link") {
      const target = relativeTo(root, entry.linkname ?? "", where);
      if (byPath.get(target)?.type !== "file") throw new Error(`${where}'s ${rel} is a hard link to ${entry.linkname ?? ""}, which is not a file of the payload`);
    }
    if (entry.type === "symlink") {
      const target = entry.linkname ?? "";
      if (target.startsWith("/")) throw new Error(`${where}'s ${rel} is a symlink to an absolute path (${target})`);
      const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
      if (resolved === ".." || resolved.startsWith("../")) throw new Error(`${where}'s ${rel} is a symlink out of the payload (${target})`);
    }
    seen.add(rel);
    byPath.set(rel, entry);
  }
  const missing = [...expected].filter((f) => !seen.has(f));
  if (missing.length > 0) throw new Error(`${where} is missing ${missing.length} file(s) its manifest lists: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`);
  const launchers = manifest.files.filter((f) => /^bin\/[^/]+$/.test(f)).map((f) => f.slice(4));
  const interpreters = new Set<string>();
  for (const launcher of launchers) {
    const interpreter = interpreterOf(resolveWithin(byPath, root, `bin/${launcher}`));
    if (interpreter) interpreters.add(interpreter);
  }
  return {
    version: manifest.version,
    digest: payloadDigest(entries),
    bytes: entries.reduce((sum, e) => sum + (e.type === "file" ? e.size : 0), 0),
    launchers,
    interpreters: [...interpreters],
  };
}

/** `sha256:…` over the entries' names, types, modes, link targets and contents, in name order: the same wherever the payload sits. */
export function payloadDigest(entries: PayloadEntry[]): string {
  const hash = createHash("sha256");
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update(`${e.type} ${e.name.replace(/\/$/, "")} ${e.mode.toString(8)} ${e.linkname ?? ""} ${e.type === "file" ? e.sha256 : ""}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function parseManifest(text: string, where: string): PayloadManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${where}'s manifest.json is not JSON`);
  }
  const m = parsed as Partial<PayloadManifest> | null;
  if (!m || typeof m.provider !== "string" || typeof m.version !== "string" || !Array.isArray(m.files) || !m.files.every((f) => typeof f === "string")) {
    throw new Error(`${where}'s manifest.json lacks provider, version or files`);
  }
  if (String(m.payloadFormat) !== PAYLOAD_FORMAT) throw new Error(`${where} has payload format ${String(m.payloadFormat)}; this Control Plane reads format ${PAYLOAD_FORMAT}`);
  return m as PayloadManifest;
}

/** `name` without `root`, checked to be a plain path under it (no absolute names, no `..`). */
function relativeTo(root: string, name: string, where: string): string {
  if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\0")) throw new Error(`${where} has an entry outside the payload: ${name}`);
  if (name !== root.slice(0, -1) && !name.startsWith(root)) throw new Error(`${where} has an entry outside ${root}: ${name}`);
  return name.slice(root.length).replace(/\/$/, "");
}

/** The file `rel` names, following symlinks and hard links inside the payload (a few hops); `undefined` when it leads nowhere. */
function resolveWithin(byPath: Map<string, PayloadEntry>, root: string, rel: string): PayloadEntry | undefined {
  let path = rel;
  for (let hop = 0; hop < 8; hop++) {
    const entry = byPath.get(path);
    if (!entry || entry.type === "file") return entry;
    const target = entry.linkname ?? "";
    path = entry.type === "link" ? target.slice(root.length) : posix.normalize(posix.join(posix.dirname(path), target));
  }
  return undefined;
}

/** What a script's shebang names (`node` for `#!/usr/bin/env node`, the path for `#!/bin/sh`); `null` for a binary or no shebang. */
function interpreterOf(entry: PayloadEntry | undefined): string | null {
  if (!entry) return null;
  const head = entry.head.toString("latin1");
  if (!head.startsWith("#!")) return null;
  const words = (head.slice(2).split("\n")[0] ?? "").trim().split(/\s+/);
  if (words[0] === "/usr/bin/env") return words[1] && !words[1].startsWith("-") ? words[1] : "/usr/bin/env";
  return words[0] || null;
}

/** A tar with one directory entry, to make `dir` exist under its parent (a base image has no payload directory yet). */
function directoryTar(dir: string): Readable {
  const tar = pack();
  tar.entry({ name: `${dir}/`, type: "directory", mode: 0o755, uid: 0, gid: 0, mtime: new Date() });
  tar.finalize();
  return Readable.from(tar);
}

/** The `/usr/local/bin/<launcher>` symlinks `sessionboxer-link-providers` makes for a payload, as a tar for `LAUNCHERS_DIR`. */
export function launcherLinks(provider: Provider, launchers: string[]): Readable {
  const tar = pack();
  const mtime = new Date();
  for (const name of launchers) {
    tar.entry({ name, type: "symlink", linkname: `${PAYLOADS_DIR}/${provider}/bin/${name}`, mode: 0o777, uid: 0, gid: 0, mtime });
  }
  tar.finalize();
  return Readable.from(tar);
}
