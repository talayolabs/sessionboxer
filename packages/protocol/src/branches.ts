// ---------------------------------------------------------------------------
// Branches: "revert to here" at a turn boundary keeps the conversation that
// followed as a branch and continues from that point on a new one. Branches
// share the Session's Sandbox; only the active branch talks to the Agent.
// ---------------------------------------------------------------------------

import { z } from "zod";

/** Id of the Session's original conversation. */
export const ROOT_BRANCH_ID = "root";

export const BRANCH_METHODS = ["fork", "replay"] as const;
/** How the Agent's memory was rewound: an ACP `session/fork` at the message, or a new session fed the transcript. */
export const BranchMethod = z.enum(BRANCH_METHODS);
export type BranchMethod = z.infer<typeof BranchMethod>;

export const Branch = z.object({
  id: z.string(),
  sessionId: z.string(),
  name: z.string(),
  /** `null` for the root branch. */
  parentId: z.string().nullable(),
  /** `turn_ended` event of the parent this branch continues from; `null` for the root branch. */
  forkedAtSeq: z.number().int().nullable(),
  method: BranchMethod.nullable(),
  createdAt: z.string(),
});
export type Branch = z.infer<typeof Branch>;

/** A branch's view of the transcript: its own events plus each ancestor's up to the fork point. */
export type BranchScope = Array<{ branchId: string; uptoSeq: number }>;

export function branchScope(branches: Branch[], activeBranchId: string): BranchScope {
  const scope: BranchScope = [];
  let id: string | null = activeBranchId;
  let upto = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    scope.push({ branchId: id, uptoSeq: upto });
    const branch = branches.find((b) => b.id === id);
    if (!branch || branch.parentId === null || branch.forkedAtSeq === null) break;
    upto = branch.forkedAtSeq;
    id = branch.parentId;
  }
  return scope;
}

export function inBranchScope(scope: BranchScope, branchId: string, seq: number): boolean {
  return scope.some((s) => s.branchId === branchId && seq <= s.uptoSeq);
}

export const RevertRequest = z.object({
  /** `seq` of the `turn_ended` event to continue from (the divider in the transcript). */
  seq: z.number().int().positive(),
});
export type RevertRequest = z.infer<typeof RevertRequest>;

export const SwitchBranchRequest = z.object({ branchId: z.string().min(1) });
export type SwitchBranchRequest = z.infer<typeof SwitchBranchRequest>;

/** Author/committer identity git in the Sandbox commits with; either part may be empty (git's own fallback then). */
export const GitIdentity = z.object({
  name: z.string().max(200).default(""),
  email: z.string().max(200).default(""),
});
export type GitIdentity = z.infer<typeof GitIdentity>;
