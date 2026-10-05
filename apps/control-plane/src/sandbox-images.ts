import type Docker from "dockerode";
import { PROVIDERS, PROVIDER_LABELS, SandboxImageSelector, type Provider, type SandboxImageInfo, type SandboxImageStatus } from "@sessionboxer/protocol";
import { SANDBOX_IMAGE_REPO, SANDBOX_IMAGE_VERSION, sandboxImageFor } from "./config.js";
import { HttpError } from "./http-error.js";
import { log as defaultLog } from "./log.js";
import { isStatus } from "./vm-host.js";

/**
 * The Sandbox images on this Docker host (ADR-0088): one per Provider plus the base one, each
 * known by its resolved reference. Nothing is pulled until a Session, a sign-in, a VM helper or
 * an explicit `POST /api/sandbox-image/pull` needs the image; the standing of every reference is
 * kept here for `GET /api/sandbox-image`, a pull in flight is shared by everything waiting for
 * that reference, and a failure stays with its reference until it is retried.
 */

/** Most Sandbox images downloading at once (each is a few GB); the rest wait their turn. */
export const MAX_CONCURRENT_PULLS = 2;

/** Labels the release workflow puts on every published image; images without them are legacy monoliths or custom images. */
export const LABEL_PROVIDERS = "io.sessionboxer.providers";
export const LABEL_PAYLOAD_FORMAT = "io.sessionboxer.payload-format";
/** The Agent payload layout this Control Plane knows (`/opt/sessionboxer/providers/<id>/manifest.json`). */
export const PAYLOAD_FORMAT = "1";

/** The executable each Provider's Agent is started by (the first word of the Daemon's `ACP_COMMANDS`): what a legacy image must have on its PATH. */
export const PROVIDER_EXECUTABLES: Record<Provider, string> = {
  "claude-code": "claude-agent-acp",
  devin: "devin",
  codex: "codex-acp",
  cursor: "cursor-agent",
  pi: "pi-acp",
  opencode: "opencode",
  fx: "fx",
  gemini: "gemini",
  kimi: "kimi",
  copilot: "copilot",
  qwen: "qwen",
  vibe: "vibe-acp",
  grok: "grok",
};

const DEV_REPO = "sessionboxer/sandbox";

function tagOf(ref: string): string | null {
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? ref.slice(colon + 1) : null;
}

/** A tag only `npm run build:image` makes here (`sessionboxer/sandbox:dev*`, a bare name, a `dev` tag): never pulled. */
export function isLocalOnly(ref: string): boolean {
  if (!ref.includes("/")) return true;
  if (ref.startsWith(`${DEV_REPO}:`)) return true;
  const tag = tagOf(ref);
  return tag === "dev" || (tag?.startsWith("dev-") ?? false);
}

/** The `npm run build:image` invocation that produces `ref` on this machine; `null` for an image that is not one of ours. */
export function buildCommandFor(ref: string): string | null {
  const tag = tagOf(ref);
  if (tag === null) return null;
  const ours = ref.startsWith(`${SANDBOX_IMAGE_REPO}:`) || ref.startsWith(`${DEV_REPO}:`);
  if (!ours) return null;
  const suffix = tag.startsWith("dev-") ? tag.slice(4) : tag.startsWith(`${SANDBOX_IMAGE_VERSION}-`) ? tag.slice(SANDBOX_IMAGE_VERSION.length + 1) : null;
  return suffix ? `npm run build:image -- --provider ${suffix}` : "npm run build:image";
}

/** `?provider=` of the image routes: a Provider id or `base`; omitted = the first Provider (what one-image Control Planes answered). */
export function parseImageSelector(raw: string | undefined): SandboxImageSelector {
  if (raw === undefined || raw === "") return PROVIDERS[0];
  const parsed = SandboxImageSelector.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `provider must be a Provider id or "base", not "${raw}"`);
  return parsed.data;
}

/** The Provider set a label names (unknown ids are dropped); `null` without the label (a legacy image: all of them, as far as its executables go). */
export function labelledProviders(labels: Record<string, string> | null | undefined): Provider[] | null {
  const value = labels?.[LABEL_PROVIDERS];
  if (value === undefined) return null;
  const known = new Set<string>(PROVIDERS);
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is Provider => known.has(p));
}

function missingLocal(ref: string): string {
  return `Sandbox image ${ref} is not on this machine; run \`${buildCommandFor(ref) ?? "npm run build:image"}\``;
}

type PullEvent = { id?: string; status?: string; progressDetail?: { current?: number; total?: number } };

export class SandboxImages {
  private readonly statuses = new Map<string, SandboxImageStatus>();
  private readonly pulls = new Map<string, Promise<void>>();
  private readonly preflights = new Map<string, Promise<boolean>>();
  private readonly listeners = new Map<string, Array<() => void>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly docker: Docker,
    private readonly log: (line: string) => void = defaultLog,
    private readonly maxConcurrentPulls = MAX_CONCURRENT_PULLS,
  ) {}

  /** What is known about `ref` without asking Docker: `checking` until something looked. */
  status(ref: string): SandboxImageStatus {
    return this.statuses.get(ref) ?? { image: ref, state: "checking", received: 0, total: 0, error: null };
  }

  /** Where `ref` stands right now: a pull in flight, else Docker is asked whether it is here. Starts nothing. */
  async inspect(ref: string): Promise<SandboxImageStatus> {
    const current = this.status(ref);
    if (current.state === "pulling") return current;
    if (await this.exists(ref)) return this.set(ref, { state: "ready", received: 0, total: 0, error: null });
    if (current.state === "error") return current;
    return this.set(ref, { state: "missing", received: 0, total: 0, error: isLocalOnly(ref) ? missingLocal(ref) : null });
  }

  /** `ref` is on this machine when this resolves: pulled once if it is not (everything asking meanwhile waits on the same pull). */
  ensure(ref: string): Promise<void> {
    let pull = this.pulls.get(ref);
    if (!pull) {
      pull = this.fetch(ref).finally(() => this.pulls.delete(ref));
      this.pulls.set(ref, pull);
    }
    return pull;
  }

  /** `POST …/pull`: starts (or joins) the pull of `ref` and answers its status once that is known; the pull runs on, a failure stays in the status. */
  async prefetch(ref: string): Promise<SandboxImageStatus> {
    if (this.pulls.has(ref)) return this.status(ref);
    const pull = this.ensure(ref).catch(() => undefined);
    await Promise.race([this.changed(ref), pull]);
    return this.status(ref);
  }

  private async fetch(ref: string): Promise<void> {
    if (await this.exists(ref)) {
      this.set(ref, { state: "ready", received: 0, total: 0, error: null });
      return;
    }
    if (isLocalOnly(ref)) {
      const error = missingLocal(ref);
      this.set(ref, { state: "missing", received: 0, total: 0, error });
      throw new Error(error);
    }
    await this.pull(ref);
  }

  /**
   * What `ref` is, for `selector`: its id and the Providers its label names. A labelled image
   * must name the Provider (a base image names none); a legacy image without labels passes once
   * the Provider's executable is found on its PATH. Throws with the reason otherwise.
   */
  async resolve(ref: string, selector: SandboxImageSelector): Promise<SandboxImageInfo> {
    const info = await this.docker.getImage(ref).inspect();
    const providers = labelledProviders(info.Config?.Labels);
    const format = info.Config?.Labels?.[LABEL_PAYLOAD_FORMAT];
    if (format !== undefined && format !== PAYLOAD_FORMAT) {
      throw new Error(`Sandbox image ${ref} has Agent payload format ${format}; this Control Plane (${SANDBOX_IMAGE_VERSION}) reads format ${PAYLOAD_FORMAT} — update Sessionboxer or use its own image`);
    }
    if (selector !== "base") {
      const label = PROVIDER_LABELS[selector];
      if (providers !== null) {
        if (providers.length === 0) throw new Error(`Sandbox image ${ref} is a base image without an Agent; ${label} Sessions need ${sandboxImageFor(selector)}`);
        if (!providers.includes(selector)) throw new Error(`Sandbox image ${ref} carries ${providers.map((p) => PROVIDER_LABELS[p]).join(", ")}, not ${label}; ${label} Sessions need ${sandboxImageFor(selector)}`);
      } else if (!(await this.hasExecutable(ref, info.Id, PROVIDER_EXECUTABLES[selector]))) {
        throw new Error(`Sandbox image ${ref} has no ${label}: \`${PROVIDER_EXECUTABLES[selector]}\` is not on its PATH`);
      }
    }
    return { reference: ref, id: info.Id, providers };
  }

  private set(ref: string, status: Omit<SandboxImageStatus, "image">): SandboxImageStatus {
    const next = { image: ref, ...status };
    this.statuses.set(ref, next);
    for (const notify of this.listeners.get(ref) ?? []) notify();
    this.listeners.delete(ref);
    return next;
  }

  /** Resolves the next time the status of `ref` is set. */
  private changed(ref: string): Promise<void> {
    return new Promise((resolve) => this.listeners.set(ref, [...(this.listeners.get(ref) ?? []), resolve]));
  }

  private async exists(ref: string): Promise<boolean> {
    try {
      await this.docker.getImage(ref).inspect();
      return true;
    } catch (e) {
      if (isStatus(e, 404)) return false;
      throw e;
    }
  }

  /** Whether `bin` is on the image's PATH, by running `command -v` in a throwaway container (once per image id and executable). */
  private hasExecutable(ref: string, imageId: string, bin: string): Promise<boolean> {
    const key = `${imageId}\0${bin}`;
    let found = this.preflights.get(key);
    if (!found) {
      found = this.probe(ref, bin).catch((e: unknown) => {
        this.preflights.delete(key);
        throw e;
      });
      this.preflights.set(key, found);
    }
    return found;
  }

  private async probe(ref: string, bin: string): Promise<boolean> {
    const container = await this.docker.createContainer({
      name: `sbx-preflight-${Date.now().toString(36)}`,
      Image: ref,
      Entrypoint: ["/bin/sh", "-c", 'command -v -- "$1"', "sh", bin],
      Cmd: [],
      Labels: { "sessionboxer.helper": "preflight" },
      HostConfig: { NetworkMode: "none", CapDrop: ["ALL"] },
    });
    try {
      await container.start();
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      return StatusCode === 0;
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  private async pull(ref: string): Promise<void> {
    this.set(ref, { state: "pulling", received: 0, total: 0, error: null });
    const fail = (message: string): Error => {
      const build = buildCommandFor(ref);
      const error = `cannot pull ${ref}: ${message}${build ? ` (or build it here: \`${build}\`)` : ""}`;
      this.log(error);
      this.set(ref, { state: "error", received: 0, total: 0, error });
      return new Error(error);
    };
    await this.acquire();
    const started = Date.now();
    try {
      this.log(`pulling ${ref} (a few GB; once per version)`);
      let stream: NodeJS.ReadableStream;
      try {
        stream = (await this.docker.pull(ref)) as NodeJS.ReadableStream;
      } catch (e) {
        throw fail(e instanceof Error ? e.message : String(e));
      }
      // Layers Docker reports as already here announce no size, so they count for nothing: what is left to transfer is the total.
      const layers = new Map<string, { current: number; total: number }>();
      let lastReport = 0;
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(
          stream,
          (err) => (err ? reject(fail(err.message)) : resolve()),
          (event: PullEvent) => {
            if (event.id && event.progressDetail?.total) layers.set(event.id, { current: event.progressDetail.current ?? 0, total: event.progressDetail.total });
            let received = 0;
            let total = 0;
            for (const l of layers.values()) {
              received += Math.min(l.current, l.total);
              total += l.total;
            }
            this.set(ref, { state: "pulling", received, total, error: null });
            if (Date.now() - lastReport < 15_000) return;
            lastReport = Date.now();
            if (total > 0) this.log(`pulling ${ref}: ${(received / 1024 / 1024).toFixed(0)} / ${(total / 1024 / 1024).toFixed(0)} MB`);
          },
        );
      });
      this.set(ref, { state: "ready", received: 0, total: 0, error: null });
      this.log(`pulled ${ref} in ${Math.round((Date.now() - started) / 1000)} s`);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrentPulls) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}
