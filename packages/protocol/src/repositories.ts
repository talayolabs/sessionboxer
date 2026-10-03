// ---------------------------------------------------------------------------
// Repositories. The Workspace (`/workspace`) is the Session's root; every repository the
// Session works on sits in its own directory right below it (`/workspace/<name>`), also when
// there is only one. Repositories can be added and removed while the Session runs; the Agent
// finds the list in `.sessionboxer/repos.json`.
// ---------------------------------------------------------------------------

import { z } from "zod";

/** Where a repository comes from: a git clone (GitHub credentials apply) or a copy of a host folder. */
export const RepoSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("git"), url: z.string().min(1), ref: z.string().min(1).optional() }),
  z.object({ type: z.literal("copy"), path: z.string().min(1) }),
]);
export type RepoSource = z.infer<typeof RepoSource>;

/**
 * A pull request's head as the platform publishes it on the base repository: `refs/pull/{n}/head` on
 * GitHub, `refs/pull-requests/{n}/from` on Bitbucket Data Center. As a `RepoSource.ref` it is fetched
 * after the clone and checked out as the local branch `pr/{n}` (a fork's branch is not clonable).
 */
export const PR_REFSPEC = /^refs\/pull(?:-requests)?\/(\d+)\/(?:head|from)$/;
export function prRefspec(provider: "github" | "bitbucket", number: number): string {
  return provider === "github" ? `refs/pull/${number}/head` : `refs/pull-requests/${number}/from`;
}
export function isPrRefspec(ref: string): boolean {
  return PR_REFSPEC.test(ref);
}
/** The local branch a PR refspec is checked out as (`pr/12`); other refs are their own branch. */
export function prRefspecBranch(ref: string): string {
  const m = PR_REFSPEC.exec(ref);
  return m ? `pr/${m[1]}` : ref;
}

export const REPO_NAME_MAX_CHARS = 100;
export const REPO_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** Directory name under `/workspace`: one path segment, no leading dot (keeps `.sessionboxer`, `.` and `..` out of reach). */
export const RepoName = z
  .string()
  .min(1)
  .max(REPO_NAME_MAX_CHARS)
  .regex(REPO_NAME_PATTERN, "Use letters, digits, '.', '_' and '-', not starting with a dot");
export type RepoName = z.infer<typeof RepoName>;

/** A repository to put in a Session (at creation or later). */
export const RepoSpec = z.object({
  /** Directory name under `/workspace`; omitted derives one from the source (last URL segment / folder name). */
  name: RepoName.optional(),
  source: RepoSource,
  /**
   * GitHub login (of a connected GitHub entry) git and `gh` act as inside this repository's
   * directory. Omitted picks one for a github.com URL among the accounts enabled for the Session
   * (the one that can push to it, else the one that can see it); `null` binds none.
   */
  account: z.string().min(1).nullable().optional(),
});
export type RepoSpec = z.infer<typeof RepoSpec>;

/** Changes the account a repository is bound to (`null` unbinds it: git and `gh` fall back to the Session's active login). */
export const UpdateRepoRequest = z.object({ account: z.string().min(1).nullable() });
export type UpdateRepoRequest = z.infer<typeof UpdateRepoRequest>;

export const REPO_STATUSES = ["pending", "ready", "error"] as const;
export const RepoStatus = z.enum(REPO_STATUSES);
export type RepoStatus = z.infer<typeof RepoStatus>;

/** Git state of a repository directory as last seen in the Sandbox. */
export const RepoGitState = z.object({
  /** Checked-out branch; `null` for a detached HEAD or when the directory is not a git work tree. */
  branch: z.string().nullable(),
  /** `git status --porcelain` is not empty (also untracked files). */
  dirty: z.boolean(),
  /** Commits on HEAD that are not on its upstream; `null` when there is no upstream (or not git). */
  ahead: z.number().int().nonnegative().nullable(),
  /** Local branches other than the current one that have commits on no remote-tracking branch. */
  unpushedBranches: z.array(z.string()).default([]),
  git: z.boolean(),
  inspectedAt: z.string(),
});
export type RepoGitState = z.infer<typeof RepoGitState>;

/** Name of the repository record Sessions created before repositories had their own directories carry: their source sits at the Workspace root. */
export const WORKSPACE_ROOT_REPO = ".";

export const SessionRepo = z.object({
  id: z.string(),
  /** Directory under `/workspace` (`WORKSPACE_ROOT_REPO` for the pre-repositories layout). */
  name: z.string().min(1),
  source: RepoSource,
  status: RepoStatus,
  /** Why cloning/copying failed (`status === "error"`). */
  error: z.string().nullable().default(null),
  /** Last git inspection (after cloning, at every turn end, on request); `null` before the first one. */
  git: RepoGitState.nullable().default(null),
  /** GitHub login bound to the directory (`git push` and `gh` there act as it); `null` when none is. */
  account: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type SessionRepo = z.infer<typeof SessionRepo>;

/** Workspace path of a repository's directory (relative, `""` for the root record). */
export function repoDir(repo: Pick<SessionRepo, "name">): string {
  return repo.name === WORKSPACE_ROOT_REPO ? "" : repo.name;
}

/** Human-readable origin of a repository: `owner/repo@ref` for git URLs, the folder path for copies. */
export function repoOriginLabel(source: RepoSource): string {
  if (source.type === "copy") return source.path;
  const trimmed = source.url.replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = trimmed.split(/[/:]/).filter((p) => p !== "");
  const short = parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : trimmed;
  return source.ref ? `${short}@${source.ref}` : short;
}

/** Directory name a source gets when none is given: the URL's last segment (without `.git`) or the folder's name, made to fit `RepoName`. */
export function repoNameFromSource(source: RepoSource): string {
  const raw = source.type === "copy" ? source.path : source.url.replace(/\.git$/, "");
  const last = raw.replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
  const safe = last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, REPO_NAME_MAX_CHARS);
  return safe === "" ? "repo" : safe;
}

export const AddRepoRequest = RepoSpec;
export type AddRepoRequest = z.infer<typeof AddRepoRequest>;

/** `force` removes the directory even when it holds uncommitted or unpushed work. */
export const RemoveRepoRequest = z.object({ force: z.boolean().default(false) });
export type RemoveRepoRequest = z.infer<typeof RemoveRepoRequest>;

/** Body of the 409 a removal gets while the repository holds work that would be lost. */
export const RepoRemovalBlocked = z.object({
  error: z.string(),
  git: RepoGitState,
});
export type RepoRemovalBlocked = z.infer<typeof RepoRemovalBlocked>;

/** Workspace-relative path of the machine-readable repository list the Agent reads. */
export const REPOS_MANIFEST_PATH = ".sessionboxer/repos.json";

export const ReposManifestEntry = z.object({
  name: z.string(),
  /** Absolute path in the Sandbox. */
  path: z.string(),
  source: RepoSource,
  /** GitHub login `git push` and `gh` use inside this directory; `null` for the Session's active login. */
  account: z.string().nullable().default(null),
});
export type ReposManifestEntry = z.infer<typeof ReposManifestEntry>;

export const ReposManifest = z.object({
  workspace: z.string(),
  repos: z.array(ReposManifestEntry),
});
export type ReposManifest = z.infer<typeof ReposManifest>;
