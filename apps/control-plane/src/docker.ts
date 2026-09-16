import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import { pack } from "tar-fs";
import { DAEMON_PORT, NOVNC_PORT, type DockerMode } from "@sessionboxer/protocol";
import { SANDBOX_HOST_ALIAS, SANDBOX_IMAGE, SANDBOX_NETWORK } from "./config.js";

export const LABEL_SESSION = "sessionboxer.session";
export const LABEL_SNAPSHOT = "sessionboxer.snapshot";
export const SNAPSHOT_REPO = "sessionboxer/snapshot";
export const SYSBOX_RUNTIME = "sysbox-runc";
const LOOPBACK = "127.0.0.1";

/**
 * The Sandbox Daemon and the protocol package as built in this checkout,
 * copied into every Sandbox before it starts so the Daemon always matches the
 * Control Plane, also for Sandboxes created from an older image or resumed
 * or forked from a snapshot that carries an older Daemon. Their npm
 * dependencies still come from the image (`npm run build:image` when the
 * Dockerfile or those dependencies change).
 */
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../packages");
const DAEMON_SYNC: { host: string; dest: string }[] = [
  { host: join(PACKAGES_DIR, "protocol/dist"), dest: "/opt/sessionboxer/protocol" },
  { host: join(PACKAGES_DIR, "sandbox-daemon/dist"), dest: "/opt/sessionboxer/sandbox-daemon" },
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
    if (existing.some((n) => n.Name === SANDBOX_NETWORK)) return;
    await this.docker.createNetwork({
      Name: SANDBOX_NETWORK,
      Driver: "bridge",
      Labels: { "sessionboxer.network": "true" },
    });
  }

  async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(SANDBOX_IMAGE).inspect();
    } catch {
      throw new Error(`sandbox image ${SANDBOX_IMAGE} not found; run \`npm run build:image\``);
    }
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

  /** Copies this checkout's Daemon build into the (stopped) Sandbox; see DAEMON_SYNC. */
  async syncDaemon(containerId: string): Promise<void> {
    for (const { host, dest } of DAEMON_SYNC) {
      if (!existsSync(join(host, "index.js"))) throw new Error(`${host} is not built; run \`npm run build\``);
      await this.putArchive(
        containerId,
        pack(host, {
          map: (header) => {
            header.name = join("dist", header.name);
            header.uid = 0;
            header.gid = 0;
            // the image's `sessionboxer-daemon` symlink executes dist/index.js directly
            header.mode = header.type === "directory" || header.name === "dist/index.js" ? 0o755 : 0o644;
            return header;
          },
        }),
        dest,
      );
    }
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
    const res = (await this.docker.getContainer(containerId).commit({
      _query: { container: containerId, repo: SNAPSHOT_REPO, tag: spec.tag, pause: true, changes },
      _body: {},
    })) as { Id: string };
    const history = (await this.docker.getImage(res.Id).history()) as Array<{ Size: number }>;
    return { imageId: res.Id, sizeBytes: history[0]?.Size ?? 0 };
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
  async exec(containerId: string, cmd: string[], workdir = "/workspace", user = "agent"): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: cmd,
      WorkingDir: workdir,
      AttachStdout: true,
      AttachStderr: true,
      User: user,
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

function isStatus(e: unknown, status: number): boolean {
  return typeof e === "object" && e !== null && (e as { statusCode?: unknown }).statusCode === status;
}
