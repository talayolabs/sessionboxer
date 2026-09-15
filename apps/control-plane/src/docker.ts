import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { DAEMON_PORT } from "@sessionboxer/protocol";
import { SANDBOX_IMAGE, SANDBOX_NETWORK } from "./config.js";

export const LABEL_SESSION = "sessionboxer.session";

export interface SandboxSpec {
  sessionId: string;
  env: Record<string, string>;
  cpus: number;
  memoryGb: number;
}

export type ContainerState = "running" | "stopped" | "missing";

export class SandboxDocker {
  readonly docker = new Docker();

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

  async create(spec: SandboxSpec): Promise<string> {
    const container = await this.docker.createContainer({
      name: `sbx-${spec.sessionId}`,
      Image: SANDBOX_IMAGE,
      Hostname: `sbx-${spec.sessionId.slice(0, 12)}`,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: { [LABEL_SESSION]: spec.sessionId },
      ExposedPorts: { [`${DAEMON_PORT}/tcp`]: {}, "6080/tcp": {} },
      HostConfig: {
        NanoCpus: Math.round(spec.cpus * 1e9),
        Memory: Math.round(spec.memoryGb * 1024 ** 3),
        ShmSize: 1024 ** 3,
        NetworkMode: SANDBOX_NETWORK,
        // Sandboxes publish no host ports (ADR-0005).
        PortBindings: {},
        PublishAllPorts: false,
        RestartPolicy: { Name: "no" },
      },
    });
    return container.id;
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

  async address(containerId: string): Promise<string> {
    const info = await this.docker.getContainer(containerId).inspect();
    const net = info.NetworkSettings.Networks[SANDBOX_NETWORK];
    if (!net?.IPAddress) throw new Error(`container ${containerId} has no address on ${SANDBOX_NETWORK}`);
    return net.IPAddress;
  }

  /** Runs a command in the Sandbox as the agent user; rejects on non-zero exit. */
  async exec(containerId: string, cmd: string[], workdir = "/workspace"): Promise<string> {
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: cmd,
      WorkingDir: workdir,
      AttachStdout: true,
      AttachStderr: true,
      User: "agent",
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

  /** Emits container ids whose Sandbox died on its own (not via a stop we requested). */
  async watchDeaths(onDie: (containerId: string, sessionId: string, exitCode: string) => void): Promise<void> {
    const stream = await this.docker.getEvents({
      filters: { type: ["container"], event: ["die"], label: [LABEL_SESSION] },
    });
    stream.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as {
            id: string;
            Actor: { Attributes: Record<string, string> };
          };
          const sessionId = ev.Actor.Attributes[LABEL_SESSION];
          if (sessionId) onDie(ev.id, sessionId, ev.Actor.Attributes.exitCode ?? "?");
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
