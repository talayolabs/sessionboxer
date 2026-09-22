import { execFile } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  REPOS_MANIFEST_PATH,
  type DaemonReposInspectResult,
  type DaemonReposRemoveResult,
  type DaemonReposSetParams,
  type RepoGitState,
  ReposManifest,
  repoOriginLabel,
  repoWorkAtRisk,
} from "@sessionboxer/protocol";
import { workspaceDir } from "./workspace-sync.js";

const execFileAsync = promisify(execFile);

const GITHUB_HELPER_KEY = "credential.https://github.com.helper";
const ACCOUNT_KEY = "sessionboxer.githubAccount";

/**
 * The Workspace's repositories, one directory each under the Workspace root: keeps the
 * manifest the Agent reads (`.sessionboxer/repos.json`), reports each directory's git state
 * and removes directories, refusing to throw away work that is nowhere else.
 */
export class Repos {
  private manifest: ReposManifest | null;

  constructor(
    private readonly workspace: string,
    private readonly log: (msg: string) => void,
  ) {
    this.manifest = this.readManifest();
  }

  async set(params: DaemonReposSetParams): Promise<void> {
    const manifest: ReposManifest = {
      workspace: this.workspace,
      repos: params.repos.map((r) => ({
        name: r.name,
        path: r.name === "." ? this.workspace : join(this.workspace, r.name),
        source: r.source,
        account: r.account,
      })),
    };
    const file = join(this.workspace, REPOS_MANIFEST_PATH);
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
    this.manifest = manifest;
    for (const r of manifest.repos) await this.bindAccount(r.path, r.account);
  }

  /**
   * Makes git and `gh` act as `account` inside the repository at `abs` (or as the Sandbox's active
   * login again for `null`): its .git/config names the login and a helper that asks gh for that
   * login's token — the token itself is never written.
   */
  private async bindAccount(abs: string, account: string | null): Promise<void> {
    try {
      if ((await this.git(abs, ["rev-parse", "--show-toplevel"])).trim() !== (await fs.realpath(abs))) return;
    } catch {
      return;
    }
    const current = (await this.git(abs, ["config", "--local", "--get", ACCOUNT_KEY]).catch(() => "")).trim() || null;
    if (current === account) return;
    const unset = (key: string) => this.git(abs, ["config", "--local", "--unset-all", key]).catch(() => "");
    await unset(GITHUB_HELPER_KEY);
    await unset(ACCOUNT_KEY);
    if (account !== null) {
      await this.git(abs, ["config", "--local", ACCOUNT_KEY, account]);
      // An empty helper first drops the system-wide `gh auth git-credential` for this repository.
      await this.git(abs, ["config", "--local", "--add", GITHUB_HELPER_KEY, ""]);
      await this.git(abs, ["config", "--local", "--add", GITHUB_HELPER_KEY, `sessionboxer ${account}`]);
    }
    this.log(`${abs}: git and gh act as ${account === null ? "the active login" : `@${account}`}`);
  }

  /** The repository table that goes with the Agent's instructions; empty until the Control Plane has sent the list. */
  briefing(): string {
    const repos = this.manifest?.repos ?? [];
    if (repos.length === 0) return "";
    const rows = repos.map(
      (r) =>
        `- \`${r.path}\` — ${r.source.type === "git" ? "clone of" : "copy of"} ${repoOriginLabel(r.source)}${
          r.account ? ` (git and gh act as @${r.account} there)` : ""
        }`,
    );
    return [
      `Repositories in this Workspace (${repos.length}); the list is kept in \`${join(this.workspace, REPOS_MANIFEST_PATH)}\`:`,
      ...rows,
    ].join("\n");
  }

  private readManifest(): ReposManifest | null {
    try {
      return ReposManifest.parse(JSON.parse(readFileSync(join(this.workspace, REPOS_MANIFEST_PATH), "utf8")));
    } catch {
      return null;
    }
  }

  async inspect(dirs: string[]): Promise<DaemonReposInspectResult> {
    const states = await Promise.all(dirs.map(async (dir) => ({ dir, state: await this.gitState(dir) })));
    return { states };
  }

  async remove(dir: string, force: boolean): Promise<DaemonReposRemoveResult> {
    const abs = workspaceDir(this.workspace, dir);
    if (abs === this.workspace) throw new Error("the Workspace root cannot be removed");
    const state = await this.gitState(dir);
    if (state === null) return { removed: true };
    if (!force && repoWorkAtRisk(state) !== null) return { removed: false, git: state };
    this.log(`removing ${abs}${force ? " (forced)" : ""}`);
    await fs.rm(abs, { recursive: true, force: true });
    return { removed: true };
  }

  /** `null` when the directory does not exist; a non-git directory reports `git: false`. */
  async gitState(dir: string): Promise<RepoGitState | null> {
    const abs = workspaceDir(this.workspace, dir);
    try {
      if (!(await fs.stat(abs)).isDirectory()) return null;
    } catch {
      return null;
    }
    const inspectedAt = new Date().toISOString();
    const notGit: RepoGitState = { branch: null, dirty: false, ahead: null, unpushedBranches: [], git: false, inspectedAt };
    let top: string;
    try {
      top = (await this.git(abs, ["rev-parse", "--show-toplevel"])).trim();
    } catch {
      return notGit;
    }
    // A plain directory inside a repository (the Workspace root when repositories are nested) is not one itself.
    if ((await fs.realpath(top)) !== (await fs.realpath(abs))) return notGit;
    try {
      const [branchOut, statusOut, refs] = await Promise.all([
        this.git(abs, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
        this.git(abs, ["status", "--porcelain", "--untracked-files=normal"]),
        this.git(abs, ["for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)", "refs/heads"]),
      ]);
      const branch = branchOut.trim() || null;
      let ahead: number | null = null;
      const unpushedBranches: string[] = [];
      for (const line of refs.split("\n")) {
        if (line === "") continue;
        const [name = "", upstream = "", track = ""] = line.split("\t");
        const aheadMatch = /ahead (\d+)/.exec(track);
        const n = upstream === "" ? null : aheadMatch ? Number(aheadMatch[1]) : /gone/.test(track) ? null : 0;
        if (name === branch) ahead = n;
        // Without an upstream a branch still counts as pushed when some remote branch has its tip.
        else if (n !== null ? n > 0 : !(await this.tipOnRemote(abs, name))) unpushedBranches.push(name);
      }
      // No upstream (or detached): nothing is lost when there are no commits or a remote branch has the tip.
      if (ahead === null && (!(await this.hasCommits(abs)) || (await this.tipOnRemote(abs, "HEAD")))) ahead = 0;
      return { branch, dirty: statusOut.trim() !== "", ahead, unpushedBranches, git: true, inspectedAt };
    } catch (e) {
      this.log(`git inspection of ${abs} failed: ${String(e)}`);
      return notGit;
    }
  }

  private async hasCommits(abs: string): Promise<boolean> {
    try {
      await this.git(abs, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  private async tipOnRemote(abs: string, ref: string): Promise<boolean> {
    const out = await this.git(abs, ["branch", "-r", "--contains", ref]).catch(() => "");
    return out.trim() !== "";
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  }
}
