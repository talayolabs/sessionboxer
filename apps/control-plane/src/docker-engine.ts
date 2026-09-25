import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Where the Docker engine is: `DOCKER_HOST` when set, else the first of the usual sockets
 * (Docker Engine, Docker Desktop, OrbStack, Colima, Rancher Desktop, rootless Docker, Podman).
 * dockerode reads `DOCKER_HOST` and falls back to /var/run/docker.sock, so a socket found
 * elsewhere is handed to it through `dockerHost`. Same probe as the desktop app's.
 */
export type DockerEngine = { where: string; dockerHost?: string };

const DEFAULT_SOCKET = "/var/run/docker.sock";
const WINDOWS_PIPE = "\\\\.\\pipe\\docker_engine";

function isSocket(file: string): boolean {
  try {
    return statSync(file).isSocket();
  } catch {
    return false;
  }
}

/** Sockets looked at when `DOCKER_HOST` is unset, in order. */
export function dockerSocketCandidates(): string[] {
  if (process.platform === "win32") return [WINDOWS_PIPE];
  const home = homedir();
  const runtime = process.env.XDG_RUNTIME_DIR;
  return [
    DEFAULT_SOCKET,
    path.join(home, ".docker", "run", "docker.sock"),
    path.join(home, ".orbstack", "run", "docker.sock"),
    path.join(home, ".colima", "default", "docker.sock"),
    path.join(home, ".colima", "docker.sock"),
    path.join(home, ".rd", "docker.sock"),
    ...(runtime ? [path.join(runtime, "docker.sock"), path.join(runtime, "podman", "podman.sock")] : []),
    "/run/podman/podman.sock",
  ];
}

export function findDockerEngine(): DockerEngine | null {
  const env = process.env.DOCKER_HOST?.trim();
  if (env) return { where: env };
  if (process.platform === "win32") return existsSync(WINDOWS_PIPE) ? { where: WINDOWS_PIPE } : null;
  const found = dockerSocketCandidates().find(isSocket);
  if (!found) return null;
  return found === DEFAULT_SOCKET ? { where: found } : { where: found, dockerHost: `unix://${found}` };
}

/** What to tell someone whose machine has no engine, for their OS. */
export function noDockerAdvice(): string[] {
  const install =
    process.platform === "darwin"
      ? ["Install OrbStack (brew install --cask orbstack) or Docker Desktop for Mac, open it once and", "wait until it says it is running, then run this command again."]
      : process.platform === "win32"
        ? ["Install Docker Desktop with the WSL 2 engine, start it, then run this command again", "(inside WSL: sessionboxer runs on Linux)."]
        : ["Install Docker Engine (curl -fsSL https://get.docker.com | sh), let your user use it", "(sudo usermod -aG docker $USER, then log out and in), then run this command again."];
  return [
    "No Docker engine was found on this machine. Sessionboxer runs each Session in a Docker container.",
    "",
    ...install,
    "",
    "How to install Docker on macOS, Windows and Linux: https://sessionboxer.talayolabs.com/#docker",
    "",
    "Looked at DOCKER_HOST (unset) and these sockets:",
    ...dockerSocketCandidates().map((p) => `  ${p}`),
    "",
    "Docker somewhere else? DOCKER_HOST=unix:///path/to/docker.sock sessionboxer serve",
  ];
}
