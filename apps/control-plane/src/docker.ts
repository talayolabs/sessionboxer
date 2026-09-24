import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import Docker from "dockerode";
import { pack } from "tar-fs";
import { pack as packStream } from "tar-stream";
import { DAEMON_PORT, NOVNC_PORT, VSCODE_THEMES_EXTENSION, vscodeThemeExtensionFiles, type DockerMode } from "@sessionboxer/protocol";
import { SANDBOX_CA_FILE } from "./ca-certs.js";
import { ROOT_DIR, SANDBOX_HOST_ALIAS, SANDBOX_IMAGE, SANDBOX_NETWORK } from "./config.js";
import { log } from "./log.js";

export const LABEL_SESSION = "sessionboxer.session";
export const LABEL_SNAPSHOT = "sessionboxer.snapshot";
export const SNAPSHOT_REPO = "sessionboxer/snapshot";
export const SYSBOX_RUNTIME = "sysbox-runc";
const LOOPBACK = "127.0.0.1";

/**
 * The Sandbox Daemon, the protocol package and the VS Code extensions as they are in this
 * checkout, copied into every Sandbox before it starts so they always match the Control
 * Plane, also for Sandboxes created from an older image or resumed or forked from a snapshot
 * that carries older copies. Their npm dependencies still come from the image (`npm run
 * build:image` when the Dockerfile or those dependencies change).
 */
interface SyncEntryBase {
  /** Directory in the Sandbox that receives the contents as a subdirectory named `name`. */
  dest: string;
  name: string;
  /** Skipped, with a log line, when `dest` is missing in the Sandbox (an image without that component). */
  optional?: boolean;
}
interface SyncDirEntry extends SyncEntryBase {
  /** Directory in this checkout whose contents go into the Sandbox. */
  host: string;
  /** File that must exist in `host` for the checkout to count as built. */
  marker: string;
  /** Files (relative to `host`) that keep the executable bit. */
  executable?: string[];
}
interface SyncFilesEntry extends SyncEntryBase {
  /** Generated contents by relative path. */
  files: () => Record<string, string>;
}
type SyncEntry = SyncDirEntry | SyncFilesEntry;
const SANDBOX_SYNC: SyncEntry[] = [
  { host: join(ROOT_DIR, "packages/protocol/dist"), marker: "index.js", dest: "/opt/sessionboxer/protocol", name: "dist" },
  {
    host: join(ROOT_DIR, "packages/sandbox-daemon/dist"),
    marker: "index.js",
    dest: "/opt/sessionboxer/sandbox-daemon",
    name: "dist",
    // the image's `sessionboxer-daemon` symlink executes dist/index.js directly
    executable: ["index.js"],
  },
  {
    host: join(ROOT_DIR, "images/sandbox/vscode-sessionboxer"),
    marker: "package.json",
    dest: "/opt/openvscode-server/extensions",
    name: "sessionboxer",
    optional: true,
  },
  { files: vscodeThemeExtensionFiles, dest: "/opt/openvscode-server/extensions", name: VSCODE_THEMES_EXTENSION, optional: true },
];

/**
 * How the Control Plane reaches a Sandbox's ports (ADR-0005): by container
 * address on the Sandbox network (`ip`, Linux and OrbStack), or through ports
 * published on the loopback interface when the Docker daemon lives in a VM
 * whose container addresses the host cannot route to (`localhost`, Docker
 * Desktop and Colima on macOS/Windows).
 */
export type SandboxReach = "ip" | "localhost";

export interface Endpoint {
  host: string;
  port: number;
}

export interface SandboxSpec {
  sessionId: string;
  env: Record<string, string>;
  cpus: number;
  memoryGb: number;
  dockerMode: DockerMode;
  /** Image to start from; the Sandbox image unless forking a Snapshot. */
  image?: string;
}

export interface CommitSpec {
  snapshotId: string;
  tag: string;
  /** Env vars to blank in the image config (`docker commit` would otherwise persist the container's secrets). */
  stripEnv: string[];
}

export type ContainerState = "running" | "stopped" | "missing";

/**
 * Docker cannot read a blob of the image the container runs on (a layer, config or
 * manifest gone from the content store, typically after a disk incident or an image
 * removed underneath it). Commits of that container fail until it is rebuilt.
 */
export class MissingImageContentError extends Error {
  constructor(readonly digest: string) {
    super(`the Sandbox's image is missing ${digest.slice(0, 19)} from Docker's content store`);
  }
}

export class SandboxDocker {
  readonly docker = new Docker();
  reach: SandboxReach = "ip";

  /** Picks `reach` for this host; `SESSIONBOXER_SANDBOX_REACH=ip|localhost` overrides the detection. */
  async detectReach(): Promise<SandboxReach> {
    const forced = process.env.SESSIONBOXER_SANDBOX_REACH;
    if (forced === "ip" || forced === "localhost") return (this.reach = forced);
    if (process.platform === "linux") return (this.reach = "ip");
    const info = (await this.docker.info()) as { OperatingSystem?: string };
    return (this.reach = /orbstack/i.test(info.OperatingSystem ?? "") ? "ip" : "localhost");
  }

  async ensureNetwork(): Promise<void> {
    const existing = await this.docker.listNetworks({ filters: { name: [SANDBOX_NETWORK] } });
    if (!existing.some((n) => n.Name === SANDBOX_NETWORK)) {
      await this.docker.createNetwork({
        Name: SANDBOX_NETWORK,
        Driver: "bridge",
        Labels: { "sessionboxer.network": "true" },
      });
    }
    await this.joinNetworkFromContainer();
  }

  /**
   * When the Control Plane itself runs in a container (docker compose) it dials Sandboxes by
   * address on the Sandbox network, so it must be attached to that network too. The container
   * is found by its hostname (Docker's default: the container id).
   */
  private async joinNetworkFromContainer(): Promise<void> {
    if (!existsSync("/.dockerenv") && process.env.SESSIONBOXER_IN_CONTAINER !== "1") return;
    let self: Docker.ContainerInspectInfo;
    try {
      self = await this.docker.getContainer(hostname()).inspect();
    } catch {
      log(`running in a container but cannot find it as ${hostname()}; Sandboxes must be reachable on ${SANDBOX_NETWORK} some other way`);
      return;
    }
    if (Object.hasOwn(self.NetworkSettings.Networks ?? {}, SANDBOX_NETWORK)) return;
    await this.docker.getNetwork(SANDBOX_NETWORK).connect({ Container: self.Id });
    log(`joined the ${SANDBOX_NETWORK} network as ${self.Name.replace(/^\//, "")}`);
  }

  private pulling: Promise<void> | null = null;

  /** The Sandbox image is present, pulling it once when it is not (a pull in flight is awaited). */
  async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(SANDBOX_IMAGE).inspect();
      return;
    } catch {
      /* not local */
    }
    if (!SANDBOX_IMAGE.includes("/") || SANDBOX_IMAGE.endsWith(":dev")) {
      throw new Error(`sandbox image ${SANDBOX_IMAGE} not found; run \`npm run build:image\``);
    }
    this.pulling ??= this.pull().finally(() => {
      this.pulling = null;
    });
    await this.pulling;
  }

  private async pull(): Promise<void> {
    log(`pulling ${SANDBOX_IMAGE} (a few GB; once per version, or \`npm run build:image\` builds it here)`);
    const started = Date.now();
    let stream: NodeJS.ReadableStream;
    try {
      stream = (await this.docker.pull(SANDBOX_IMAGE)) as NodeJS.ReadableStream;
    } catch (e) {
      throw new Error(`cannot pull ${SANDBOX_IMAGE}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const layers = new Map<string, { current: number; total: number }>();
    let lastReport = 0;
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(new Error(`cannot pull ${SANDBOX_IMAGE}: ${err.message}`)) : resolve()),
        (event: { id?: string; status?: string; progressDetail?: { current?: number; total?: number } }) => {
          if (event.id && event.progressDetail?.total) {
            layers.set(event.id, { current: event.progressDetail.current ?? 0, total: event.progressDetail.total });
          }
          if (Date.now() - lastReport < 15_000) return;
          lastReport = Date.now();
          let current = 0;
          let total = 0;
          for (const l of layers.values()) {
            current += Math.min(l.current, l.total);
            total += l.total;
          }
          if (total > 0) log(`pulling ${SANDBOX_IMAGE}: ${(current / 1024 / 1024).toFixed(0)} / ${(total / 1024 / 1024).toFixed(0)} MB`);
        },
      );
    });
    log(`pulled ${SANDBOX_IMAGE} in ${Math.round((Date.now() - started) / 1000)} s`);
  }

  /** Whether the host Docker daemon has the Sysbox runtime registered (ADR-0008). */
  async hasSysbox(): Promise<boolean> {
    const info = (await this.docker.info()) as { Runtimes?: Record<string, unknown> };
    return Object.hasOwn(info.Runtimes ?? {}, SYSBOX_RUNTIME);
  }

  async create(spec: SandboxSpec): Promise<string> {
    const ports = [DAEMON_PORT, NOVNC_PORT].map((p) => `${p}/tcp`);
    const container = await this.docker.createContainer({
      name: `sbx-${spec.sessionId}`,
      Image: spec.image ?? SANDBOX_IMAGE,
      Hostname: `sbx-${spec.sessionId.slice(0, 12)}`,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: { [LABEL_SESSION]: spec.sessionId },
      ExposedPorts: Object.fromEntries(ports.map((p) => [p, {}])),
      // The nested daemon's storage must not sit on the Sandbox's own overlayfs;
      // Sysbox mounts /var/lib/docker itself, `--privileged` gets an anonymous
      // volume (removed with the container).
      ...(spec.dockerMode === "privileged" ? { Volumes: { "/var/lib/docker": {} } } : {}),
      HostConfig: {
        NanoCpus: Math.round(spec.cpus * 1e9),
        Memory: Math.round(spec.memoryGb * 1024 ** 3),
        ShmSize: 1024 ** 3,
        NetworkMode: SANDBOX_NETWORK,
        // The host machine by name, for MCP servers (and anything else) running on it.
        ExtraHosts: [`${SANDBOX_HOST_ALIAS}:host-gateway`],
        // Sandboxes publish no host ports (ADR-0005), except on loopback with
        // an ephemeral host port each when the container address is unreachable.
        PortBindings:
          this.reach === "localhost"
            ? Object.fromEntries(ports.map((p) => [p, [{ HostIp: LOOPBACK, HostPort: "" }]]))
            : {},
        PublishAllPorts: false,
        RestartPolicy: { Name: "no" },
        ...(spec.dockerMode === "sysbox" ? { Runtime: SYSBOX_RUNTIME } : {}),
        ...(spec.dockerMode === "privileged" ? { Privileged: true } : {}),
      },
    });
    return container.id;
  }

  /** Copies this checkout's Daemon build (and the other SANDBOX_SYNC parts) into the (stopped) Sandbox; returns what was skipped. */
  async syncDaemon(containerId: string): Promise<string[]> {
    const skipped: string[] = [];
    for (const entry of SANDBOX_SYNC) {
      if ("host" in entry && !existsSync(join(entry.host, entry.marker))) throw new Error(`${entry.host} is not built; run \`npm run build\``);
      const archive = "host" in entry ? packDir(entry) : packFiles(entry);
      if (entry.optional && !(await this.pathExists(containerId, entry.dest))) {
        archive.destroy();
        skipped.push(`${entry.dest}/${entry.name} (no ${entry.dest} in this Sandbox's image)`);
        continue;
      }
      await this.putArchive(containerId, archive, entry.dest);
    }
    return skipped;
  }

  /** Whether `path` exists in the (possibly stopped) container. */
  private async pathExists(containerId: string, path: string): Promise<boolean> {
    try {
      await this.docker.getContainer(containerId).infoArchive({ path });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stages the extra CA bundle in the (stopped) Sandbox; `activateCaCerts` links it into the
   * system store once the Sandbox runs. An empty bundle stages nothing (removal happens there too).
   */
  async stageCaCerts(containerId: string, pem: string): Promise<void> {
    if (pem === "") return;
    const tar = packStream();
    tar.entry({ name: basename(SANDBOX_CA_FILE), mode: 0o644, uid: 0, gid: 0, mtime: new Date() }, pem);
    tar.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of tar) chunks.push(chunk as Buffer);
    await this.putArchive(containerId, Readable.from([Buffer.concat(chunks)]), dirname(SANDBOX_CA_FILE));
  }

  /** Runs `update-ca-certificates` in the running Sandbox, dropping a stale bundle when `pem` is empty. */
  async activateCaCerts(containerId: string, pem: string): Promise<void> {
    const script =
      pem === ""
        ? `[ ! -e "$0" ] || { rm -f "$0" "/etc/ssl/certs/$(basename "$0" .crt).pem" && update-ca-certificates >/dev/null; }`
        : `update-ca-certificates >/dev/null`;
    await this.exec(containerId, ["sh", "-c", script, SANDBOX_CA_FILE], "/", "root");
  }

  async start(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).start();
  }

  async stop(containerId: string, timeoutSeconds = 10): Promise<void> {
    try {
      await this.docker.getContainer(containerId).stop({ t: timeoutSeconds });
    } catch (e) {
      if (!isStatus(e, 304)) throw e; // 304: already stopped
    }
  }

  async rename(containerId: string, name: string): Promise<void> {
    await this.docker.getContainer(containerId).rename({ name });
  }

  async remove(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).remove({ force: true, v: true });
    } catch (e) {
      if (!isStatus(e, 404)) throw e;
    }
  }

  async state(containerId: string): Promise<ContainerState> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return info.State.Running ? "running" : "stopped";
    } catch (e) {
      if (isStatus(e, 404)) return "missing";
      throw e;
    }
  }

  /** Bytes in the container's writable layer (what the Sandbox adds on top of its image). */
  async diskUsage(containerId: string): Promise<number | null> {
    try {
      // `size=1` is a documented query param the dockerode typings do not know about.
      const info = (await this.docker
        .getContainer(containerId)
        .inspect({ size: true } as Docker.ContainerInspectOptions)) as { SizeRw?: number };
      return info.SizeRw ?? null;
    } catch (e) {
      if (isStatus(e, 404)) return null;
      throw e;
    }
  }

  /**
   * `docker commit`: freezes the container's filesystem into an image tagged
   * `sessionboxer/snapshot:<tag>`. The container is paused for the duration.
   * Returns the image id and the size of the committed layer.
   */
  async commit(containerId: string, spec: CommitSpec): Promise<{ imageId: string; sizeBytes: number }> {
    const changes = [`LABEL ${LABEL_SNAPSHOT}=${spec.snapshotId}`, ...spec.stripEnv.map((k) => `ENV ${k}=`)];
    let res: { Id: string };
    try {
      res = (await this.docker.getContainer(containerId).commit({
        _query: { container: containerId, repo: SNAPSHOT_REPO, tag: spec.tag, pause: true, changes },
        _body: {},
      })) as { Id: string };
    } catch (e) {
      const digest = missingContentDigest(e);
      if (digest) throw new MissingImageContentError(digest);
      throw e;
    }
    return { imageId: res.Id, sizeBytes: await this.topLayerSize(res.Id) };
  }

  /**
   * `docker export | docker import`: a single-layer image of the (stopped) container's
   * whole filesystem, tagged like a Snapshot, that depends on nothing from the image the
   * container was created from — the way out when that image lost content. `keepEnv` are
   * the variables the container was created with; only the image's own stay in the config.
   */
  async flatten(containerId: string, spec: CommitSpec & { keepEnv: string[] }): Promise<{ imageId: string; sizeBytes: number }> {
    const container = this.docker.getContainer(containerId);
    const { Config: config } = await container.inspect();
    const skip = new Set([...spec.stripEnv, ...spec.keepEnv]);
    const changes = [
      `LABEL ${LABEL_SNAPSHOT}=${spec.snapshotId}`,
      ...config.Env.filter((kv) => !skip.has(kv.slice(0, kv.indexOf("=")))).map(envChange),
      ...(config.User ? [`USER ${config.User}`] : []),
      ...(config.WorkingDir ? [`WORKDIR ${config.WorkingDir}`] : []),
      ...(config.Entrypoint ? [`ENTRYPOINT ${JSON.stringify(config.Entrypoint)}`] : []),
      ...(config.Cmd ? [`CMD ${JSON.stringify(config.Cmd)}`] : []),
    ];
    const tar = await container.export();
    const progress = await this.docker.importImage(tar, { repo: SNAPSHOT_REPO, tag: spec.tag, changes });
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(progress, (err: Error | null) => (err ? reject(err) : resolve()));
    });
    const { Id } = await this.docker.getImage(`${SNAPSHOT_REPO}:${spec.tag}`).inspect();
    return { imageId: Id, sizeBytes: await this.topLayerSize(Id) };
  }

  private async topLayerSize(imageId: string): Promise<number> {
    const history = (await this.docker.getImage(imageId).history()) as Array<{ Size: number }>;
    return history[0]?.Size ?? 0;
  }

  async imageExists(ref: string): Promise<boolean> {
    try {
      await this.docker.getImage(ref).inspect();
      return true;
    } catch (e) {
      if (isStatus(e, 404)) return false;
      throw e;
    }
  }

  /** Removes an image; `false` if it is still in use (a container was created from it) or already gone. */
  async removeImage(ref: string): Promise<boolean> {
    try {
      await this.docker.getImage(ref).remove();
      return true;
    } catch (e) {
      if (isStatus(e, 404) || isStatus(e, 409)) return false;
      throw e;
    }
  }

  /** Ids of every Snapshot image on this host, whether or not the database still knows them. */
  async listSnapshotImageIds(): Promise<string[]> {
    const images = await this.docker.listImages({ filters: { label: [LABEL_SNAPSHOT] } });
    return images.map((i) => i.Id);
  }

  /** Where the Control Plane can dial `containerPort` of a running Sandbox. */
  async endpoint(containerId: string, containerPort: number): Promise<Endpoint> {
    const info = await this.docker.getContainer(containerId).inspect();
    if (this.reach === "localhost") {
      const binding = info.NetworkSettings.Ports[`${containerPort}/tcp`]?.[0];
      const port = Number(binding?.HostPort);
      if (!port) throw new Error(`container ${containerId} has no published host port for ${containerPort}/tcp`);
      return { host: LOOPBACK, port };
    }
    const net = info.NetworkSettings.Networks[SANDBOX_NETWORK];
    if (!net?.IPAddress) throw new Error(`container ${containerId} has no address on ${SANDBOX_NETWORK}`);
    return { host: net.IPAddress, port: containerPort };
  }

  /** Runs a command in the Sandbox (as the agent user by default); rejects on non-zero exit. */
  async exec(
    containerId: string,
    cmd: string[],
    workdir = "/workspace",
    user = "agent",
    env: Record<string, string> = {},
  ): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: cmd,
      WorkingDir: workdir,
      AttachStdout: true,
      AttachStderr: true,
      User: user,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    const out = new PassThrough();
    out.on("data", (c: Buffer) => chunks.push(c));
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.demuxStream(stream, out, out);
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    const inspect = await exec.inspect();
    const output = Buffer.concat(chunks).toString("utf8");
    if (inspect.ExitCode !== 0) {
      throw new Error(`\`${cmd.join(" ")}\` exited ${inspect.ExitCode}: ${output.trim().slice(-2000)}`);
    }
    return output;
  }

  /** Extracts a tar stream into `dest` inside the Sandbox (ownership as recorded in the tar). */
  async putArchive(containerId: string, tar: Readable, dest: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    const failed = new Promise<never>((_, reject) => tar.once("error", reject));
    await Promise.race([container.putArchive(tar, { path: dest }), failed]);
  }

  /**
   * Emits container ids whose Sandbox died on its own (not via a stop we requested).
   * The Docker event stream is re-opened if it ends or fails (e.g. a daemon restart).
   */
  async watchDeaths(
    onDie: (containerId: string, sessionId: string, exitCode: string) => void,
    onLost: (error: string) => void,
  ): Promise<void> {
    const stream = await this.docker.getEvents({
      filters: { type: ["container"], event: ["die"], label: [LABEL_SESSION] },
    });
    let lost = false;
    const reopen = (why: string): void => {
      if (lost) return;
      lost = true;
      onLost(why);
      const retry = (): void => {
        this.watchDeaths(onDie, onLost).catch((e: unknown) => {
          onLost(String(e));
          setTimeout(retry, 5000);
        });
      };
      setTimeout(retry, 5000);
    };
    stream.once("error", (e: Error) => reopen(e.message));
    stream.once("end", () => reopen("stream ended"));
    stream.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as {
            Actor: { ID: string; Attributes: Record<string, string> };
          };
          const sessionId = ev.Actor.Attributes[LABEL_SESSION];
          if (sessionId) onDie(ev.Actor.ID, sessionId, ev.Actor.Attributes.exitCode ?? "?");
        } catch {
          // ignore partial lines
        }
      }
    });
  }
}

/** Dockerfile `ENV` for one `KEY=value` entry of a container config. */
function envChange(kv: string): string {
  const at = kv.indexOf("=");
  const value = kv.slice(at + 1);
  return `ENV ${kv.slice(0, at)}=${/^[\w./:@-]*$/.test(value) ? value : JSON.stringify(value)}`;
}

/** The digest Docker reported missing from its content store in a 404 from commit/create, or `null`. */
function missingContentDigest(e: unknown): string | null {
  if (!isStatus(e, 404) || !(e instanceof Error) || !/not found/.test(e.message)) return null;
  // "content digest sha256:…: not found" (unknown to the metadata) or "blob sha256:… expected at …: blob not found" (file gone).
  return /(?:content digest|blob) (sha256:[0-9a-f]{64})/.exec(e.message)?.[1] ?? null;
}

function isStatus(e: unknown, status: number): boolean {
  return typeof e === "object" && e !== null && (e as { statusCode?: unknown }).statusCode === status;
}

function packDir(entry: SyncDirEntry): Readable {
  const executable = new Set((entry.executable ?? []).map((f) => join(entry.name, f)));
  return pack(entry.host, {
    map: (header) => {
      header.name = join(entry.name, header.name);
      header.uid = 0;
      header.gid = 0;
      header.mode = header.type === "directory" || executable.has(header.name) ? 0o755 : 0o644;
      return header;
    },
  });
}

function packFiles(entry: SyncFilesEntry): Readable {
  const tar = packStream();
  const mtime = new Date();
  for (const [path, content] of Object.entries(entry.files())) {
    tar.entry({ name: join(entry.name, path), mode: 0o644, uid: 0, gid: 0, mtime }, content);
  }
  tar.finalize();
  return Readable.from(tar);
}
