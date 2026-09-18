import { createContext, useContext, type ReactNode } from "react";
import type { FileRef } from "./file-links";

/** Opens a Workspace file in the Session's Code pane; null where there is no Session. */
export const OpenFile = createContext<((ref: FileRef) => void) | null>(null);

function describe(ref: FileRef): string {
  const where = ref.line === undefined ? "" : `:${ref.line}${ref.column === undefined ? "" : `:${ref.column}`}`;
  return `Open ${ref.path}${where} in Remote VS Code`;
}

/**
 * A clickable reference to a file in the Workspace. Rendered as a span (not an anchor) so it
 * can sit inside buttons such as the tool-call header; falls back to plain content when the
 * Code pane is not available.
 */
export function FileLink({ fileRef, children, className }: { fileRef: FileRef; children: ReactNode; className?: string }) {
  const open = useContext(OpenFile);
  if (!open) return <>{children}</>;
  return (
    <span
      className={className ? `file-link ${className}` : "file-link"}
      role="link"
      tabIndex={0}
      title={describe(fileRef)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open(fileRef);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        open(fileRef);
      }}
    >
      {children}
    </span>
  );
}
