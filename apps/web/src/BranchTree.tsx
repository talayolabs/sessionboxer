import { useMemo } from "react";
import { branchScope, inBranchScope, type Branch, type Session } from "@sessionboxer/protocol";
import { formatTime } from "./format";

interface Node {
  branch: Branch;
  children: Node[];
}

/** A turn divider of the visible transcript. */
export interface DividerRef {
  branchId: string;
  seq: number;
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

/**
 * Where a branch shows up in the active branch's transcript: the divider it forks off from (children of the
 * visible lineage) or the divider where the active lineage left it (ancestors). `null` when it is out of sight.
 */
export function dividerFor(branches: Branch[], activeBranchId: string, branch: Branch): DividerRef | null {
  const scope = branchScope(branches, activeBranchId);
  if (branch.id === activeBranchId) {
    return branch.parentId !== null && branch.forkedAtSeq !== null ? { branchId: branch.parentId, seq: branch.forkedAtSeq } : null;
  }
  const entry = scope.find((s) => s.branchId === branch.id);
  if (entry) return { branchId: branch.id, seq: entry.uptoSeq };
  if (branch.parentId !== null && branch.forkedAtSeq !== null && inBranchScope(scope, branch.parentId, branch.forkedAtSeq)) {
    return { branchId: branch.parentId, seq: branch.forkedAtSeq };
  }
  return null;
}

/**
 * Conversation branches of a Session as a compact folder-like tree. Clicking a branch that is in sight of the
 * current chat scrolls to its divider; one that is not asks to switch the conversation to it.
 */
export function BranchTree({
  session,
  switching,
  onFocus,
  onSwitch,
}: {
  session: Session;
  switching: boolean;
  onFocus: (divider: DividerRef | null) => void;
  onSwitch: (branch: Branch) => void;
}) {
  const tree = useMemo(() => buildTree(session.branches), [session.branches]);
  const canSwitch = session.status === "idle" && !switching;
  const why = switching
    ? "Switching branch…"
    : session.status === "running"
      ? "Wait for the Agent to finish its turn before switching"
      : session.status !== "idle"
        ? `Session is ${session.status}; switching needs a running Sandbox`
        : undefined;
  const names = new Map(session.branches.map((b) => [b.id, b.name]));

  const render = (nodes: Node[], depth: number) =>
    nodes.map(({ branch, children }) => {
      const active = branch.id === session.activeBranchId;
      const divider = dividerFor(session.branches, session.activeBranchId, branch);
      const parent = branch.parentId ? names.get(branch.parentId) : undefined;
      const origin = parent ? `Forked from "${parent}" at ${formatTime(branch.createdAt)}` : "The original conversation";
      const title = active
        ? `${origin}; this is the current branch`
        : divider
          ? `${origin}; click to scroll to where it parts from the current chat`
          : (why ?? `${origin}; click to switch the conversation to it`);
      return (
        <li key={branch.id}>
          <button
            type="button"
            className={`branch-node${active ? " active" : ""}`}
            style={{ paddingLeft: 4 + depth * 12 }}
            disabled={!active && !divider && !canSwitch}
            title={title}
            onClick={(e) => {
              e.stopPropagation();
              if (active || divider) onFocus(divider);
              else onSwitch(branch);
            }}
          >
            <span className="branch-node-glyph">{active ? "\u25B8" : children.length > 0 ? "\u2387" : "\u2022"}</span>
            <span className="branch-node-name">{branch.name}</span>
          </button>
          {children.length > 0 && <ul className="branch-tree">{render(children, depth + 1)}</ul>}
        </li>
      );
    });

  return <ul className="branch-tree">{render(tree, 0)}</ul>;
}
