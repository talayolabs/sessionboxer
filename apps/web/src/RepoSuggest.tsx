import { useEffect, useState } from "react";
import type { KnownRepo, PrProvider } from "@sessionboxer/protocol";
import { api } from "./api";

let cache: KnownRepo[] | null = null;

/** The repositories named anywhere so far (ADR-0068), most recent first; fetched once per mount, shared across inputs. */
export function useKnownRepos(): KnownRepo[] {
  const [repos, setRepos] = useState<KnownRepo[]>(cache ?? []);
  useEffect(() => {
    let live = true;
    void api.repositories().then(
      (r) => {
        cache = r;
        if (live) setRepos(r);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return repos;
}

export interface Suggestion {
  value: string;
  label?: string;
}

/** Clone URLs, labelled `owner/repo` when known. */
export function gitSuggestions(repos: KnownRepo[]): Suggestion[] {
  return repos.filter((r) => r.kind === "git").map((r) => ({ value: r.location, label: r.owner && r.repo ? `${r.owner}/${r.repo}` : undefined }));
}

/** Host folders copied into a Session before. */
export function folderSuggestions(repos: KnownRepo[]): Suggestion[] {
  return repos.filter((r) => r.kind === "copy").map((r) => ({ value: r.location }));
}

/** `owner/repo` (Bitbucket: `PROJECT/slug`) of the repositories on one provider and host, for a follow. */
export function followSuggestions(repos: KnownRepo[], provider: PrProvider, host: string): Suggestion[] {
  return repos
    .filter((r) => r.kind === "git" && r.provider === provider && r.host?.toLowerCase() === host.toLowerCase() && r.owner && r.repo)
    .map((r) => ({ value: `${r.owner}/${r.repo}` }));
}

/** A `<datalist>` an input points at with `list={id}`; empty when there is nothing to suggest (the browser then shows nothing). */
export function RepoDatalist({ id, options }: { id: string; options: Suggestion[] }) {
  return (
    <datalist id={id}>
      {options.map((o) => (
        <option key={o.value} value={o.value} label={o.label} />
      ))}
    </datalist>
  );
}
