import { promises as fs, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DaemonUtilitiesSetParams,
  UTILITIES_MANIFEST_PATH,
  procedureSkillMarkdown,
  type UtilitiesManifest,
  type UtilitySpec,
} from "@sessionboxer/protocol";

/** The VM the Agent runs in (Windows/macOS Sessions): the manifest and the skills have to be there too. */
export interface UtilitiesMirror {
  /** The manifest's path as the Agent sees it. */
  readonly manifestPath: string;
  /** The skills directory in the VM (`<home>/.claude/skills`). */
  readonly skillsDir: string;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * The Session's Utilities in the Sandbox (ADR-0073). From what the Control Plane sends
 * (`utilities/set`) this writes three things: each Utility's credentials to
 * `<tmpfs>/utilities/<name>.json` (0600, on tmpfs so Snapshots never carry them; `sb-util` and the
 * computer-use MCP's `${util:…}` placeholders read them), the secret-free manifest
 * `.sessionboxer/utilities.json` in the Workspace (what the Agent reads to know what it has), and
 * the procedures as skills in `~/.claude/skills/<name>/SKILL.md`. Skills materialised earlier and
 * gone from the set are removed (a list of ours is kept next to the credentials).
 */
export class UtilitiesFiles {
  private manifest: UtilitiesManifest | null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: string,
    private readonly skillsDir: string,
    private readonly tmpfsDir: string,
    private readonly log: (msg: string) => void,
    private readonly onChanged: (names: string[]) => void,
    private readonly mirror?: UtilitiesMirror,
  ) {
    this.manifest = this.read();
  }

  get current(): UtilitiesManifest | null {
    return this.manifest;
  }

  get manifestPath(): string {
    return this.mirror?.manifestPath ?? join(this.workspace, UTILITIES_MANIFEST_PATH);
  }

  async set(params: DaemonUtilitiesSetParams): Promise<void> {
    const p = DaemonUtilitiesSetParams.parse(params);
    const before = this.manifest;
    await this.writeCredentials(p.utilities);
    const procedures = await this.writeSkills(p.procedures);
    const manifest: UtilitiesManifest = {
      environments: p.environments,
      utilities: p.utilities.map(({ credentials, http, cli, ...u }) => ({
        ...u,
        credentials: credentials.map((c) => c.name),
        otp: credentials.some((c) => c.name === "totp"),
        http: http ? { baseUrl: http.baseUrl, headers: http.headers.map((h) => h.name) } : null,
        cli: cli ? { install: cli.install, env: cli.env.map((e) => e.name) } : null,
      })),
      available: p.available,
      procedures,
    };
    const content = JSON.stringify(manifest, null, 2) + "\n";
    const file = join(this.workspace, UTILITIES_MANIFEST_PATH);
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    this.manifest = manifest;
    if (this.mirror) {
      const mirror = this.mirror;
      this.chain = this.chain
        .then(async () => {
          await mirror.write(mirror.manifestPath, content);
          for (const proc of p.procedures) await mirror.write(`${mirror.skillsDir}/${proc.name}/SKILL.md`, procedureSkillMarkdown(proc));
        })
        .catch((e: unknown) => this.log(`could not write the Utilities manifest in the VM: ${String(e)}`));
    }
    const names = manifest.utilities.map((u) => this.qualified(u, manifest));
    if (before && JSON.stringify(before.utilities.map((u) => this.qualified(u, before))) === JSON.stringify(names)) return;
    if (before || names.length > 0) this.onChanged(names);
  }

  /** `name` or `name (environment)` when the same name is on in two Environments. */
  private qualified(u: { name: string; environment: string }, m: UtilitiesManifest): string {
    return m.utilities.filter((o) => o.name === u.name).length > 1 ? `${u.name} (${u.environment})` : u.name;
  }

  /** The briefing paragraph; empty while no Utility is registered. */
  briefing(): string {
    const m = this.manifest;
    if (!m || (m.utilities.length === 0 && m.available.length === 0)) return "";
    const on = m.utilities.map((u) => `${u.name} (${u.environment}${u.readOnly ? ", read-only" : ""}${u.production ? ", production" : ""})`);
    const lines = [
      `Utilities are the external systems you may investigate with — observability (dashboards, logs, traces) and the applications`,
      `under test — registered by the user with their credentials, grouped by target Environment. What this Session has is in`,
      `\`${this.manifestPath}\` (${UTILITIES_MANIFEST_PATH} in the Workspace; read it before reaching for one): ${on.length === 0 ? "none is on right now" : on.join(", ")}` +
        (m.available.length > 0 ? `; off but available: ${m.available.map((u) => `${u.name} (${u.environment})`).join(", ")} — \`utilities_enable\` asks the user to switch them on.` : "."),
      "You never see credential values: in the desktop `type` tool write `${util:<name>.<credential>}` (and `${util:<name>.otp}` for a",
      "one-time code) and the real value is typed; in a shell `sb-util env <name> -- <command>` runs with them in the environment,",
      "`sb-util curl <name> <path>` calls the HTTP API with its headers, `sb-util ssh <name> [cmd]` / `sb-util tunnel <name> L:H:P`",
      "reach the SSH facet, `sb-util otp <name>` prints the code, `sb-util open <name>` opens the web UI in the browser. A Utility's",
      "MCP facet is an ordinary MCP server of this Session with the name the manifest gives (`mcp`). Read-only Utilities are for",
      "looking, not changing; in a production Environment change nothing without the user's explicit go-ahead in this conversation.",
      "`utilities_list` / `utilities_get` (`sessionboxer` MCP) give the catalogue with notes and presets; `utilities_add` /",
      "`utilities_update` register or change one (the user allows it in a card; if they paste credentials in the chat, register them",
      "right away and suggest the `/util` composer command next time so they stay out of the transcript). Procedures — skills that",
      `say how to investigate something with these Utilities — are in the skills directory${m.procedures.length > 0 ? ` (${m.procedures.join(", ")})` : ""}; \`procedure_save\` proposes a new one.`,
    ];
    return lines.join("\n");
  }

  private async writeCredentials(utilities: UtilitySpec[]): Promise<void> {
    const dir = join(this.tmpfsDir, "utilities");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const keep = new Set<string>();
    for (const u of utilities) {
      // Two Environments of the same name: the plain file is the first (the manifest order), the other is `name@env`.
      const file = keep.has(`${u.name}.json`) ? `${u.name}@${u.environment}.json` : `${u.name}.json`;
      keep.add(file);
      await fs.writeFile(join(dir, `${file}.tmp`), JSON.stringify(u, null, 2) + "\n", { mode: 0o600 });
      await fs.rename(join(dir, `${file}.tmp`), join(dir, file));
    }
    for (const f of await fs.readdir(dir)) if (!keep.has(f)) await fs.rm(join(dir, f), { force: true });
  }

  /** Writes the procedures as skills, removes ours that are gone; names of the ones in place. */
  private async writeSkills(procedures: DaemonUtilitiesSetParams["procedures"]): Promise<string[]> {
    const marker = join(this.tmpfsDir, "procedures.json");
    let ours: string[] = [];
    try {
      ours = JSON.parse(await fs.readFile(marker, "utf8")) as string[];
    } catch {
      ours = [];
    }
    const written: string[] = [];
    for (const p of procedures) {
      const dir = join(this.skillsDir, p.name);
      if (!ours.includes(p.name) && (await exists(dir))) {
        this.log(`procedure "${p.name}" clashes with a skill already in ${this.skillsDir}; not materialised`);
        continue;
      }
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, "SKILL.md"), procedureSkillMarkdown(p));
      written.push(p.name);
    }
    for (const name of ours) {
      if (written.includes(name)) continue;
      await fs.rm(join(this.skillsDir, name), { recursive: true, force: true });
      if (this.mirror) {
        const mirror = this.mirror;
        this.chain = this.chain.then(() => mirror.remove(`${mirror.skillsDir}/${name}`)).catch(() => undefined);
      }
    }
    await fs.mkdir(dirname(marker), { recursive: true });
    await fs.writeFile(marker, JSON.stringify(written) + "\n");
    return written;
  }

  private read(): UtilitiesManifest | null {
    try {
      return JSON.parse(readFileSync(join(this.workspace, UTILITIES_MANIFEST_PATH), "utf8")) as UtilitiesManifest;
    } catch {
      return null;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
