import { useEffect, useId, useState } from "react";
import type { ConnectorKind, PrFollow } from "@sessionboxer/protocol";
import { api } from "./api";
import { RepoDatalist, followSuggestions, useKnownRepos } from "./RepoSuggest";

export interface FollowAccount {
  kind: ConnectorKind;
  host: string;
  account: string;
}

export function accountKey(a: FollowAccount): string {
  return `${a.kind}|${a.host}|${a.account}`;
}

/** The connected logins a follow can read with; `null` while loading, `[]` when none (or the request failed). */
export function useFollowAccounts(): FollowAccount[] | null {
  const [accounts, setAccounts] = useState<FollowAccount[] | null>(null);
  useEffect(() => {
    void api.prAccounts().then(setAccounts, () => setAccounts([]));
  }, []);
  return accounts;
}

/**
 * One row that follows every open PR of a repository: the login to read with (when there is more
 * than one), the repository with the ones already in use suggested, and a Follow button. Used by
 * the Automations form so a pull request trigger does not send you to the Pull requests page first.
 */
export function FollowRepoInline({ onFollowed, disabled }: { onFollowed: (follow: PrFollow) => void; disabled?: boolean }) {
  const accounts = useFollowAccounts();
  const known = useKnownRepos();
  const listId = useId();
  const [account, setAccount] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (accounts && accounts.length > 0 && account === "") setAccount(accountKey(accounts[0]!));
  }, [accounts, account]);
  const picked = accounts?.find((a) => accountKey(a) === account) ?? null;
  const submit = () => {
    if (!picked || busy || repo.trim() === "") return;
    setBusy(true);
    setError(null);
    api
      .createPrFollow({ provider: picked.kind, host: picked.host, account: picked.account, kind: "repo", repo: repo.trim() })
      .then((f) => {
        setRepo("");
        onFollowed(f);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  if (accounts === null) return <p className="muted small-text">Loading logins…</p>;
  if (accounts.length === 0) return <p className="warn small-text">No GitHub or Bitbucket account is connected: add one under Global settings → MCP &amp; connectors to follow a repository.</p>;
  return (
    <div className="follow-inline">
      <div className="input-row">
        {accounts.length > 1 && (
          <select aria-label="Read with" value={account} disabled={disabled || busy} onChange={(e) => setAccount(e.target.value)}>
            {accounts.map((a) => (
              <option key={accountKey(a)} value={accountKey(a)}>
                @{a.account} · {a.kind === "github" ? "GitHub" : a.host}
              </option>
            ))}
          </select>
        )}
        <input
          aria-label="Repository to follow"
          placeholder={picked?.kind === "bitbucket" ? "PROJECT/slug, or the repository's URL" : "owner/repo, or the repository's URL"}
          value={repo}
          disabled={disabled || busy}
          list={listId}
          spellCheck={false}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        {picked && <RepoDatalist id={listId} options={followSuggestions(known, picked.kind, picked.host)} />}
        <button type="button" disabled={disabled || busy || !picked || repo.trim() === ""} onClick={submit}>
          {busy ? "Following…" : "Follow"}
        </button>
      </div>
      {error && <p className="warn small-text">{error}</p>}
    </div>
  );
}
