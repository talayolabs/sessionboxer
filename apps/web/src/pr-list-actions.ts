import type { PullRequest } from "@sessionboxer/protocol";

type SelectionAction =
  | { type: "toggle"; id: string }
  | { type: "remove"; id: string }
  | { type: "set"; ids: string[] }
  | { type: "retain"; ids: string[] };

export function updatePrSelection(selected: Set<string>, action: SelectionAction): Set<string> {
  if (action.type === "set") return new Set(action.ids);
  if (action.type === "retain") {
    const available = new Set(action.ids);
    const next = new Set([...selected].filter((id) => available.has(id)));
    return next.size === selected.size ? selected : next;
  }
  const next = new Set(selected);
  if (action.type === "remove" || next.has(action.id)) next.delete(action.id);
  else next.add(action.id);
  return next;
}

export async function detachSelectedPrs(
  prs: Pick<PullRequest, "id" | "owner" | "repo" | "number">[],
  detach: (id: string) => Promise<void>,
  onDetached: (id: string) => void,
): Promise<void> {
  const failures: string[] = [];
  for (const pr of prs) {
    try {
      await detach(pr.id);
    } catch (error) {
      failures.push(`${pr.owner}/${pr.repo}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    onDetached(pr.id);
  }
  if (failures.length > 0) {
    const details = failures.slice(0, 3).join("; ") + (failures.length > 3 ? `; and ${failures.length - 3} more` : "");
    throw new Error(`Could not detach ${failures.length} of ${prs.length} PRs. Failed PRs remain selected for retry. ${details}`);
  }
}
