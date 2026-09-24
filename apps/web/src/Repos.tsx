import { useEffect, useState } from "react";
import {
  REPO_NAME_PATTERN,
  WORKSPACE_ROOT_REPO,
  repoOriginLabel,
  repoNameFromSource,
  repoWorkAtRisk,
  type PublicSettings,
  type RepoSource,
  type RepoSpec,
  type Session,
  type SessionRepo,
} from "@sessionboxer/protocol";
import { api } from "./api";
import { FolderDialog } from "./FolderDialog";
import { SourceIcon } from "./SourceIcon";

/** One row of the repository editor before it is turned into a `RepoSpec`. */
export interface RepoDraft {
  key: number;
  type: RepoSource["type"];
  url: string;
  ref: string;
  path: string;
  name: string;
  /** GitHub login git and `gh` act as in the directory; `undefined` lets the Control Plane pick, `null` binds none. */
  account?: string | null;
}

let nextKey = 1;

export function newRepoDraft(type: RepoSource["type"] = "git"): RepoDraft {
  return { key: nextKey++, type, url: "", ref: "", path: "", name: "" };
}

/** The GitHub logins connected in Settings (every GitHub entry's account), in Settings order without repeats. */
export function githubAccounts(settings: PublicSettings | null): string[] {
  const out: string[] = [];
  for (const s of settings?.mcpServers ?? []) {
    const a = s.connector?.kind === "github" ? s.connector.account : null;
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

const AUTO_ACCOUNT = "\u0000auto";
const NO_ACCOUNT = "\u0000none";

/** Dropdown of the connected GitHub logins: *Auto* (pick per repository), each login, or none. */
function AccountSelect({
  value,
  accounts,
  disabled,
  onChange,
}: {
  value: string | null | undefined;
  accounts: string[];
  disabled?: boolean;
  onChange: (account: string | null | undefined) => void;
}) {
  const options = value && !accounts.includes(value) ? [...accounts, value] : accounts;
  return (
    <select
      aria-label="GitHub account"
      className="repo-account"
      title="GitHub login git push and gh act as inside this repository"
      value={value === undefined ? AUTO_ACCOUNT : value === null ? NO_ACCOUNT : value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === AUTO_ACCOUNT ? undefined : e.target.value === NO_ACCOUNT ? null : e.target.value)}
    >
      <option value={AUTO_ACCOUNT}>Account: auto</option>
      {options.map((a) => (
        <option key={a} value={a}>
          @{a}
        </option>
      ))}
      <option value={NO_ACCOUNT}>Active login (no binding)</option>
    </select>
  );
}

function draftSource(d: RepoDraft): RepoSource | null {
  if (d.type === "git") {
    const url = d.url.trim();
    if (url === "") return null;
    const ref = d.ref.trim();
    return ref ? { type: "git", url, ref } : { type: "git", url };
  }
  const path = d.path.trim();
  return path === "" ? null : { type: "copy", path };
}

/** The specs a list of drafts stands for; rows without a URL / path are skipped. */
export function draftsToSpecs(drafts: RepoDraft[]): RepoSpec[] {
  return drafts.flatMap((d): RepoSpec[] => {
    const source = draftSource(d);
    if (!source) return [];
    const name = d.name.trim();
    return [{ ...(name ? { name } : {}), source, ...(d.account !== undefined && source.type === "git" ? { account: d.account } : {}) }];
  });
}

/** Drafts to edit stored specs (a scheduled task's template) again. */
export function specsToDrafts(specs: RepoSpec[]): RepoDraft[] {
  return specs.map((s) => ({
    ...newRepoDraft(s.source.type),
    url: s.source.type === "git" ? s.source.url : "",
    ref: s.source.type === "git" ? (s.source.ref ?? "") : "",
    path: s.source.type === "copy" ? s.source.path : "",
    name: s.name ?? "",
    ...(s.account !== undefined ? { account: s.account } : {}),
  }));
}

/** What a draft would be called in `/workspace/<name>` (the typed name, else derived from the source). */
export function draftName(d: RepoDraft): string {
  const typed = d.name.trim();
  if (typed) return typed;
  const source = draftSource(d);
  return source ? repoNameFromSource(source) : "";
}

/** A problem with the drafts as a whole (duplicate or invalid directory names), or `null`. */
export function draftsError(drafts: RepoDraft[]): string | null {
  const seen = new Set<string>();
  for (const d of drafts) {
    const name = draftName(d);
    if (name === "") continue;
    if (!REPO_NAME_PATTERN.test(name)) return `"${name}" is not a valid directory name (letters, digits, '.', '_' and '-', not starting with a dot).`;
    const lower = name.toLowerCase();
    if (seen.has(lower)) return `Two repositories would both be at /workspace/${name}; give one another name.`;
    seen.add(lower);
  }
  return null;
}

/**
 * Editable list of repositories for a Workspace: each row a git URL (with optional branch) or a
 * host folder to copy, and the directory name it gets under `/workspace`.
 */
export function RepoEditor({
  drafts,
  onChange,
  disabled,
  compact,
  accounts = [],
}: {
  drafts: RepoDraft[];
  onChange: (drafts: RepoDraft[]) => void;
  disabled?: boolean;
  /** Without the "Add" buttons and the intro (one row being edited in a dialog). */
  compact?: boolean;
  /** Connected GitHub logins a git repository can be bound to; no dropdown when empty. */
  accounts?: string[];
}) {
  const [browsing, setBrowsing] = useState<number | null>(null);
  const patch = (key: number, p: Partial<RepoDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...p } : d)));
  const error = draftsError(drafts);
  return (
    <div className="repo-editor">
      {drafts.map((d, i) => (
        <div key={d.key} className="repo-row">
          <select
            aria-label="Kind"
            value={d.type}
            disabled={disabled}
            onChange={(e) => patch(d.key, { type: e.target.value as RepoSource["type"] })}
          >
            <option value="git">Clone a git URL</option>
            <option value="copy">Copy a host folder</option>
          </select>
          {d.type === "git" ? (
            <>
              <input
                aria-label="Repository URL"
                required={i === 0 && compact}
                value={d.url}
                disabled={disabled}
                onChange={(e) => patch(d.key, { url: e.target.value })}
                placeholder="https://github.com/org/repo.git"
                spellCheck={false}
              />
              <div className="repo-ref-account">
                <input
                  aria-label="Branch or tag"
                  className="repo-ref"
                  value={d.ref}
                  disabled={disabled}
                  onChange={(e) => patch(d.key, { ref: e.target.value })}
                  placeholder="branch (optional)"
                  spellCheck={false}
                />
                {accounts.length > 0 && <AccountSelect value={d.account} accounts={accounts} disabled={disabled} onChange={(account) => patch(d.key, { account })} />}
              </div>
            </>
          ) : (
            <div className="input-row">
              <input
                aria-label="Host folder"
                required={i === 0 && compact}
                value={d.path}
                disabled={disabled}
                onChange={(e) => patch(d.key, { path: e.target.value })}
                placeholder="/home/you/project"
                spellCheck={false}
              />
              <button type="button" disabled={disabled} onClick={() => setBrowsing(d.key)}>
                Browse…
              </button>
            </div>
          )}
          <label className="repo-name" title="Directory under /workspace">
            <span className="muted">/workspace/</span>
            <input
              aria-label="Directory name"
              value={d.name}
              disabled={disabled}
              onChange={(e) => patch(d.key, { name: e.target.value })}
              placeholder={draftName(d) || "name"}
              spellCheck={false}
            />
          </label>
          {!compact && (
            <button type="button" aria-label="Remove this repository" title="Remove" disabled={disabled} onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}>
              {"\u00d7"}
            </button>
          )}
        </div>
      ))}
      {error && <p className="warn">{error}</p>}
      {!compact && (
        <div className="row repo-add">
          <button type="button" disabled={disabled} onClick={() => onChange([...drafts, newRepoDraft("git")])}>
            + Git repository
          </button>
          <button type="button" disabled={disabled} onClick={() => onChange([...drafts, newRepoDraft("copy")])}>
            + Host folder
          </button>
          {drafts.length === 0 && <span className="muted">None: the Workspace starts empty.</span>}
        </div>
      )}
      {browsing !== null && (
        <FolderDialog
          initialPath={drafts.find((d) => d.key === browsing)?.path ?? ""}
          onSelect={(p) => {
            patch(browsing, { path: p });
            setBrowsing(null);
          }}
          onClose={() => setBrowsing(null)}
        />
      )}
    </div>
  );
}

/** `main ● +2` style summary of a repository's Git state, or `null` while unknown. */
export function repoStateLabel(repo: SessionRepo): string | null {
  const g = repo.git;
  if (!g) return null;
  if (!g.git) return "not a git repository";
  const parts: string[] = [g.branch ?? "detached HEAD"];
  if (g.dirty) parts.push("uncommitted changes");
  if (g.ahead === null) parts.push("not pushed anywhere");
  else if (g.ahead > 0) parts.push(`${g.ahead} unpushed commit${g.ahead === 1 ? "" : "s"}`);
  if (g.unpushedBranches.length > 0) parts.push(`unpushed: ${g.unpushedBranches.join(", ")}`);
  return parts.join(" \u00b7 ");
}

function repoStatusMark(repo: SessionRepo): { text: string; className: string; title: string } {
  if (repo.status === "pending") return { text: "\u2026", className: "muted", title: "Being cloned / copied" };
  if (repo.status === "error") return { text: "\u26a0", className: "warn", title: repo.error ?? "failed" };
  if (repo.git && repoWorkAtRisk(repo.git) !== null) return { text: "\u25cf", className: "warn", title: repoStateLabel(repo) ?? "" };
  return { text: "", className: "", title: repoStateLabel(repo) ?? "ready" };
}

/** The repositories of a Session, one chip each, as shown in the Session header. */
export function RepoChips({ session, onClick }: { session: Session; onClick: () => void }) {
  return (
    <button type="button" className="repo-chips" title="Repositories in this Workspace (click to add or remove)" onClick={onClick}>
      {session.repos.length === 0 && <span className="muted">no repositories</span>}
      {session.repos.map((r) => {
        const mark = repoStatusMark(r);
        return (
          <span key={r.id} className={`repo-chip repo-${r.status}`} title={`${r.name === WORKSPACE_ROOT_REPO ? "/workspace" : `/workspace/${r.name}`}\n${repoOriginLabel(r.source)}\n${mark.title}`}>
            <SourceIcon source={r.source} size={12} />
            {r.name === WORKSPACE_ROOT_REPO ? "workspace" : r.name}
            {r.git?.branch && <span className="muted repo-branch">{r.git.branch}</span>}
            {r.account && (
              <span className="muted repo-account-chip" title={`git push and gh act as @${r.account} here`}>
                {r.account}
              </span>
            )}
            {mark.text && <span className={mark.className}>{mark.text}</span>}
          </span>
        );
      })}
    </button>
  );
}

/**
 * The Session's repositories with their Git state, a remover per row (asking twice when the
 * repository holds work that is nowhere else) and a form to add one to the running Sandbox.
 */
export function ReposDialog({ session, accounts, onClose }: { session: Session; accounts: string[]; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<RepoDraft[]>([]);

  const rebind = async (repo: SessionRepo, account: string | null | undefined) => {
    if (account === undefined) return;
    setBusy(repo.id);
    setError(null);
    try {
      await api.updateRepo(session.id, repo.id, { account });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && busy === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const isLive = session.status === "idle" || session.status === "running";
  const legacyRoot = session.repos.some((r) => r.name === WORKSPACE_ROOT_REPO);
  const draft = adding[0];
  const spec = draft ? draftsToSpecs([draft])[0] : undefined;
  const addError = draftsError([...adding, ...session.repos.map((r): RepoDraft => ({ key: -1, type: r.source.type, url: "", ref: "", path: "", name: r.name }))]);

  const remove = async (repo: SessionRepo) => {
    if (!confirm(`Remove ${repo.name} from this Session? /workspace/${repo.name} is deleted in the Sandbox${repo.source.type === "copy" ? "; your folder on this machine is not touched" : ""}.`)) return;
    setBusy(repo.id);
    setError(null);
    try {
      const first = await api.removeRepo(session.id, repo.id, false);
      if (!first.removed) {
        if (!confirm(`${first.blocked.error}\n\nRemove anyway and lose it?`)) return;
        const second = await api.removeRepo(session.id, repo.id, true);
        if (!second.removed) setError(second.blocked.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!spec) return;
    setBusy("add");
    setError(null);
    try {
      await api.addRepo(session.id, spec);
      setAdding([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && busy === null && onClose()}>
      <div className="modal panel repos-dialog" role="dialog" aria-modal="true" aria-labelledby="repos-title">
        <h2 id="repos-title">Repositories of "{session.title}"</h2>
        <p className="muted">
          Each repository is a directory under <code>/workspace</code> in the Sandbox; the Agent finds the list in{" "}
          <code>/workspace/.sessionboxer/repos.json</code> and is told when it changes. Git state is read when the Sandbox connects
          and after every turn.
        </p>
        {error && (
          <div className="banner banner-error dialog-banner" role="alert" onClick={() => setError(null)} title="Dismiss">
            {error}
          </div>
        )}
        <ul className="repo-list" aria-busy={busy !== null}>
          {session.repos.length === 0 && <li className="empty">No repositories: the Workspace is empty.</li>}
          {session.repos.map((r) => {
            const mark = repoStatusMark(r);
            const state = repoStateLabel(r);
            return (
              <li key={r.id} className={`repo-${r.status}`}>
                <SourceIcon source={r.source} size={14} />
                <span className="repo-name-cell">
                  <strong>{r.name === WORKSPACE_ROOT_REPO ? "/workspace" : r.name}</strong>
                  <span className="muted repo-origin" title={r.source.type === "copy" ? r.source.path : r.source.url}>
                    {r.source.type === "git" ? "clone of" : "copy of"} {repoOriginLabel(r.source)}
                  </span>
                </span>
                <span className={`repo-state ${mark.className}`} title={mark.title}>
                  {r.status === "pending" ? "cloning / copying\u2026" : r.status === "error" ? (r.error ?? "failed") : (state ?? "ready")}
                </span>
                {r.source.type === "git" && (accounts.length > 0 || r.account) && (
                  <select
                    aria-label={`GitHub account for ${r.name}`}
                    className="repo-account"
                    title="GitHub login git push and gh act as inside this repository"
                    value={r.account ?? NO_ACCOUNT}
                    disabled={busy !== null}
                    onChange={(e) => void rebind(r, e.target.value === NO_ACCOUNT ? null : e.target.value)}
                  >
                    {(r.account && !accounts.includes(r.account) ? [...accounts, r.account] : accounts).map((a) => (
                      <option key={a} value={a}>
                        @{a}
                      </option>
                    ))}
                    <option value={NO_ACCOUNT}>Active login (no binding)</option>
                  </select>
                )}
                {r.name !== WORKSPACE_ROOT_REPO && (
                  <button
                    type="button"
                    className="danger"
                    disabled={busy !== null || (r.status !== "error" && !isLive)}
                    title={r.status !== "error" && !isLive ? "Removing needs a running Sandbox (Resume first)" : `Delete /workspace/${r.name} from the Sandbox`}
                    onClick={() => void remove(r)}
                  >
                    {busy === r.id ? "Removing\u2026" : "Remove"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {legacyRoot ? (
          <p className="muted">
            This Session's repository is <code>/workspace</code> itself (started before repositories had their own directories), so
            others cannot be added next to it; start a new Session to work with several.
          </p>
        ) : adding.length === 0 ? (
          <div className="row repo-add">
            <button type="button" disabled={!isLive || busy !== null} title={isLive ? undefined : "Adding needs a running Sandbox (Resume first)"} onClick={() => setAdding([newRepoDraft("git")])}>
              + Git repository
            </button>
            <button type="button" disabled={!isLive || busy !== null} title={isLive ? undefined : "Adding needs a running Sandbox (Resume first)"} onClick={() => setAdding([newRepoDraft("copy")])}>
              + Host folder
            </button>
          </div>
        ) : (
          <form
            className="repo-add-form"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <RepoEditor drafts={adding} onChange={setAdding} disabled={busy !== null} compact accounts={accounts} />
            {addError && adding.length > 0 && draftName(adding[0]!) !== "" && <p className="warn">{addError}</p>}
            <div className="actions">
              <button type="button" disabled={busy !== null} onClick={() => setAdding([])}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy !== null || !spec || addError !== null}>
                {busy === "add" ? "Adding\u2026" : `Add to /workspace/${draft ? draftName(draft) || "\u2026" : ""}`}
              </button>
            </div>
          </form>
        )}
        <div className="actions">
          <span className="spacer" />
          <button type="button" disabled={busy !== null} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
