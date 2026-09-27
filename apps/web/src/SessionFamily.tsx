import type { Session } from "@sessionboxer/protocol";

/**
 * Sidebar line under a Session created by another Session's Agent ("child of <title>") or under
 * a Session whose Agent created others (its children, ADR-0062). Nothing for the rest.
 */
export function SessionFamily({ session, sessions, onOpen }: { session: Session; sessions: Session[]; onOpen: (id: string) => void }) {
  const parent = session.createdBy ? sessions.find((s) => s.id === session.createdBy?.sessionId) : undefined;
  const children = sessions.filter((s) => s.createdBy?.sessionId === session.id);
  if (!session.createdBy && children.length === 0) return null;
  const link = (s: Session) => (
    <a
      key={s.id}
      href={`#/sessions/${s.id}`}
      className="session-family-link"
      title={`${s.title} (${s.status})`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen(s.id);
      }}
    >
      {s.title}
    </a>
  );
  return (
    <div className="session-family">
      {session.createdBy && (
        <span title="This Session was created by the Agent of another Session through the sessionboxer MCP">
          child of {parent ? link(parent) : <span className="muted">a deleted Session</span>}
        </span>
      )}
      {children.length > 0 && (
        <span title="Sessions this Session's Agent created through the sessionboxer MCP">
          {children.length === 1 ? "child: " : `${children.length} children: `}
          {children.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              {link(c)}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
