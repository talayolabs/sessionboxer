import { findPrUrls, type PrRef, type SessionEvent } from "@sessionboxer/protocol";

/** A tool call that opens a pull request: `gh pr create`, `bb pr create`, a `create_pull_request` MCP tool. */
const PR_CREATION = /\bpr\s+create\b|\bpr[_-]create\b|create[_\s-]?pull[_\s-]?requests?\b|pull[_\s-]?requests?[_\s-]?create\b/i;

/**
 * The pull request URLs a turn produced (ADR-0027, `attached_by: agent`): the ones the Agent wrote
 * in its replies, and the ones a PR-creating tool call printed. URLs the Agent only read on the
 * way — `gh pr list`, a changelog, an issue page, its own thoughts — are not its PRs: one such
 * listing used to attach every PR of a repository to the Session.
 */
export function prUrlsProducedIn(turnEvents: SessionEvent[]): (PrRef & { url: string })[] {
  const said: string[] = [];
  const calls = new Map<string, { input: string[]; all: string[] }>();
  for (const { body } of turnEvents) {
    if (body.type !== "update") continue;
    const u = body.update;
    if (u.sessionUpdate === "agent_message_chunk") collectStrings(u.content, said);
    else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      const call = calls.get(u.toolCallId) ?? { input: [], all: [] };
      collectStrings({ title: u.title, rawInput: u.rawInput }, call.input);
      collectStrings(u, call.all);
      calls.set(u.toolCallId, call);
    }
  }
  const produced = [...calls.values()].filter((c) => c.input.some((s) => PR_CREATION.test(s))).flatMap((c) => c.all);
  return findPrUrls([...said, ...produced].join("\n"));
}

function collectStrings(v: unknown, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out, depth + 1);
}
