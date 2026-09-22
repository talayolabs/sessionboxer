import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** An engine found on this machine; `env` is what the Control Plane needs to dial it (dockerode reads `DOCKER_HOST`, else `/var/run/docker.sock`). */
export type DockerEngine = { where: string; env: { DOCKER_HOST?: string } };

const DEFAULT_SOCKET = "/var/run/docker.sock";
const WINDOWS_PIPE = "\\\\.\\pipe\\docker_engine";

function isSocket(file: string): boolean {
  try {
    return statSync(file).isSocket();
  } catch {
    return false;
  }
}

/** The usual sockets: Docker Engine, Docker Desktop, OrbStack, Colima, Rancher Desktop, rootless Docker, Podman. `null` when none exists. */
export function findDockerEngine(): DockerEngine | null {
  const env = process.env.DOCKER_HOST?.trim();
  if (env) return { where: env, env: {} };
  if (process.platform === "win32") return existsSync(WINDOWS_PIPE) ? { where: WINDOWS_PIPE, env: {} } : null;
  if (isSocket(DEFAULT_SOCKET)) return { where: DEFAULT_SOCKET, env: {} };
  const home = homedir();
  const runtime = process.env.XDG_RUNTIME_DIR;
  const candidates = [
    path.join(home, ".docker", "run", "docker.sock"),
    path.join(home, ".orbstack", "run", "docker.sock"),
    path.join(home, ".colima", "default", "docker.sock"),
    path.join(home, ".colima", "docker.sock"),
    path.join(home, ".rd", "docker.sock"),
    ...(runtime ? [path.join(runtime, "docker.sock"), path.join(runtime, "podman", "podman.sock")] : []),
    "/run/podman/podman.sock",
  ];
  const found = candidates.find(isSocket);
  return found ? { where: found, env: { DOCKER_HOST: `unix://${found}` } } : null;
}
