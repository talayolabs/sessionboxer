import { useMemo } from "react";
import { type Branch, type Session } from "@sessionboxer/protocol";
import { formatTime } from "./format";

interface Node {
  branch: Branch;
  children: Node[];
}

function buildTree(branches: Branch[]): Node[] {
  const byParent = new Map<string | null, Branch[]>();
  for (const b of branches) {
    const list = byParent.get(b.parentId) ?? [];
    list.push(b);
    byParent.set(b.parentId, list);
  }
  const ids = new Set(branches.map((b) => b.id));
  const build = (parentId: string | null): Node[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => (a.forkedAtSeq ?? 0) - (b.forkedAtSeq ?? 0) || a.createdAt.localeCompare(b.createdAt))
      .map((branch) => ({ branch, children: build(branch.id) }));
  // Roots: no parent, or a parent that no longer exists.
  const roots = branches.filter((b) => b.parentId === null || !ids.has(b.parentId));
  return roots
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((branch) => ({ branch, children: build(branch.id) }));
}

/** Conversation branches of a Session as a folder-like tree; clicking a branch makes it the active one. */
export function BranchTree({
  session,
  switching,
  onSelect,
}: {
  session: Session;
  switching: boolean;
  onSelect: (branchId: string) => void;
}) {
  const tree = useMemo(() => buildTree(session.branches), [session.branches]);
  const canSwitch = session.status === "idle" && !switching;
  const why = switching
    ? "Switching branch…"
    : session.status === "running"
      ? "Wait for the Agent to finish its turn"
      : session.status !== "idle"
        ? `Session is ${session.status}; switching needs a running Sandbox`
        : undefined;
  const names = new Map(session.branches.map((b) => [b.id, b.name]));

  const render = (nodes: Node[], depth: number) =>
    nodes.map(({ branch, children }) => {
      const active = branch.id === session.activeBranchId;
      const parent = branch.parentId ? names.get(branch.parentId) : undefined;
      const origin = parent ? `Forked from ${parent} at ${formatTime(branch.createdAt)}` : "The original conversation";
      const title = active ? `${origin}; this is the current branch` : (why ?? `${origin}; click to continue from it`);
      return (
        <li key={branch.id}>
          <button
            type="button"
            className={`branch-node${active ? " active" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            disabled={!active && !canSwitch}
            title={title}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(branch.id);
            }}
          >
            <span className="branch-node-glyph">{children.length > 0 ? "\u2387" : "\u2022"}</span>
            <span className="branch-node-name">{branch.name}</span>
            {active && <span className="branch-node-current">{switching ? "switching\u2026" : "current"}</span>}
          </button>
          {children.length > 0 && <ul className="branch-tree">{render(children, depth + 1)}</ul>}
        </li>
      );
    });

  return <ul className="branch-tree">{render(tree, 0)}</ul>;
}
