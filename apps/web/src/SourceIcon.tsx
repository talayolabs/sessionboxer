import { repoOriginLabel, type RepoSource, type Session, type WorkspaceSource } from "@sessionboxer/protocol";

/** Where a Session's Workspace came from, as a small mark next to the Provider's. */
export function sourceTitle(source: WorkspaceSource | RepoSource): string {
  switch (source.type) {
    case "git":
      return `Cloned from ${source.url}${source.ref ? ` (${source.ref})` : ""}`;
    case "copy":
      return `Copy of ${source.path}`;
    case "fork":
      return `Forked from ${source.label}`;
    case "empty":
      return "Empty workspace";
  }
}

/** Folder for a copied host directory, git's branch mark for a clone, a fork sign for a snapshot fork; nothing for empty. */
export function SourceIcon({ source, size = 16 }: { source: WorkspaceSource | RepoSource; size?: number }) {
  const label = sourceTitle(source);
  switch (source.type) {
    case "copy":
      return (
        <svg className="source-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <path
            d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6a1.5 1.5 0 0 1 1.1.5L11.8 7h7.7A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M3 10h18" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case "git":
      return (
        <svg className="source-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" transform="rotate(45 12 12)" fill="#f05133" />
          <g fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round">
            <path d="M9.5 15.5V8" />
            <path d="M9.5 12c2.6 0 4.6-1 5.2-3.2" />
          </g>
          <g fill="#fff">
            <circle cx="9.5" cy="7" r="1.5" />
            <circle cx="9.5" cy="16.5" r="1.5" />
            <circle cx="15" cy="7.8" r="1.5" />
          </g>
        </svg>
      );
    case "fork":
      return (
        <svg className="source-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
          <title>{label}</title>
          <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 6.5v2.5a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V6.5" />
            <path d="M12 12v5.5" />
          </g>
          <g fill="currentColor">
            <circle cx="7" cy="5" r="2" />
            <circle cx="17" cy="5" r="2" />
            <circle cx="12" cy="19" r="2" />
          </g>
        </svg>
      );
    case "empty":
      return null;
  }
}

/** One line for a Session's Workspace: its repositories (names), else where it came from (fork / empty / an old root clone). */
export function sessionSourceLabel(session: Session): string {
  const repos = session.repos;
  if (repos.length === 1 && repos[0]) return repos[0].name === "." ? repoOriginLabel(repos[0].source) : repos[0].name;
  if (repos.length > 1) return repos.map((r) => r.name).join(", ");
  const source = session.workspaceSource;
  return source.type === "fork" ? `fork of ${source.label}` : source.type === "empty" ? "empty workspace" : repoOriginLabel(source);
}

/** Tooltip for `sessionSourceLabel`: every repository with its origin. */
export function sessionSourceTitle(session: Session): string {
  if (session.repos.length === 0) return sourceTitle(session.workspaceSource);
  return session.repos.map((r) => `${r.name === "." ? "/workspace" : `/workspace/${r.name}`}: ${sourceTitle(r.source)}`).join("\n");
}

/** The Session's mark: one repository's icon, a stack for several, the fork / empty mark otherwise. */
export function SessionSourceIcon({ session, size = 16 }: { session: Session; size?: number }) {
  const repos = session.repos;
  if (repos.length === 1 && repos[0]) return <SourceIcon source={repos[0].source} size={size} />;
  if (repos.length === 0) return <SourceIcon source={session.workspaceSource} size={size} />;
  const label = `${repos.length} repositories\n${sessionSourceTitle(session)}`;
  return (
    <svg className="source-icon" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={label}>
      <title>{label}</title>
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
        <path d="M4 9.5A1.5 1.5 0 0 1 5.5 8h3.6a1.5 1.5 0 0 1 1.1.5L11.3 10h7.2A1.5 1.5 0 0 1 20 11.5v7A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5z" />
        <path d="M7 5h10" strokeLinecap="round" />
      </g>
    </svg>
  );
}
