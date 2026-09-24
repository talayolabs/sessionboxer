import { PROVIDER_LABELS, type Provider, type Session, type SessionEvent } from "@sessionboxer/protocol";

/**
 * Handing a Session's work to another Agent (ADR-0052): the origin's Agent, which has the whole
 * conversation in its memory, is asked in a hidden turn to write a handoff document; the fork's
 * Agent — another provider, or a fresh session of the same one — gets it as its first message on
 * the same Snapshot.
 */

const OPEN = "<handoff>";
const CLOSE = "</handoff>";
/** Room for the whole document as a first prompt; a longer one is cut at a line. */
const MAX_CHARS = 60_000;
/** A reply without the markers and shorter than this is not a handoff but a refusal or an error line ("session limit reached"). */
const MIN_UNMARKED_CHARS = 200;

/** The hidden prompt that asks the origin's Agent for the document. */
export function handoffRequestPrompt(from: Provider, to: Provider): string {
  const successor = to === from ? `a fresh ${PROVIDER_LABELS[to]} session with no memory of this conversation` : `${PROVIDER_LABELS[to]}, a different coding agent with no memory of this conversation`;
  return [
    `Your work here is being handed off to ${successor}. It gets an exact copy of this machine (files, tools, logins, running state) plus the document you write now as its very first message — nothing else. Write it so that the successor can carry on without asking anything.`,
    "",
    "Do not change any files. Look at the workspace (git status/log/diff, notes) only where your memory is not enough. Reply with the document only, between `<handoff>` and `</handoff>`, in Markdown with these sections:",
    "",
    "1. **Goal** — what the user wants, in their words where it matters, and the current task.",
    "2. **State of the work** — what is done and working, what is half-done, what is not started; where the user's requests were changed or narrowed, say so.",
    "3. **Decisions** — choices made and why (design, libraries, trade-offs, things the user rejected).",
    "4. **Open items** — remaining work, known bugs, questions waiting for the user, in priority order.",
    "5. **Files and places** — files created or changed (repo-qualified paths), branches, commits, PRs, URLs, services and ports involved.",
    "6. **How to run and test** — exact commands, credentials that are in place (never their values), how to verify the work, what has been verified already.",
    "7. **Gotchas** — environment quirks, flaky steps, anything that cost you time.",
    "",
    "Be concrete and complete rather than brief: exact names, paths, commands, error messages. Do not include secrets or token values.",
  ].join("\n");
}

/**
 * The document out of the Agent's reply: what is between the markers, or the whole reply without
 * them when it is long enough to be one. `{ refusal }` when the Agent answered with something else.
 */
export function extractHandoff(reply: string): { doc: string } | { refusal: string } {
  let text = reply;
  const open = text.indexOf(OPEN);
  const close = text.lastIndexOf(CLOSE);
  const marked = open !== -1 && close > open;
  if (marked) text = text.slice(open + OPEN.length, close);
  else text = text.replace(OPEN, "").replace(CLOSE, "");
  text = text.trim();
  if (text === "") return { refusal: "nothing" };
  if (!marked && text.length < MIN_UNMARKED_CHARS) return { refusal: text };
  if (text.length > MAX_CHARS) {
    const cut = text.lastIndexOf("\n", MAX_CHARS);
    text = `${text.slice(0, cut > MAX_CHARS / 2 ? cut : MAX_CHARS)}\n\n_(handoff cut here: it was longer than ${MAX_CHARS} characters)_`;
  }
  return { doc: text };
}

/** The fork's first message: the document with a preamble, followed by what the user asked the fork to do, if anything. */
export function handoffMessage(doc: string, origin: Session, fromProvider: Provider, toProvider: Provider, snapshotOrdinal: number, userPrompt: string | undefined): string {
  const predecessor = fromProvider === toProvider ? `a previous ${PROVIDER_LABELS[fromProvider]} session` : PROVIDER_LABELS[fromProvider];
  const parts = [
    `You are taking over the work of ${predecessor} on this machine (Session "${origin.title}", forked at snapshot ${snapshotOrdinal}). The files, tools, logins and running state are exactly as your predecessor left them; its conversation is not available to you. It wrote the following handoff for you.`,
    "",
    "---",
    "",
    doc,
    "",
    "---",
    "",
    userPrompt?.trim()
      ? `The user says:\n\n${userPrompt.trim()}`
      : "Read the handoff, check the state of the workspace against it, then carry on with the open items in order — or, if anything is unclear or contradicts what you find, ask the user before changing things.",
  ];
  return parts.join("\n");
}

/** The full text of the last Agent message of `turn` (message boundaries by `messageId`; one message when the Agent sends none). */
export function lastAgentMessage(turn: SessionEvent[]): string {
  let text = "";
  let lastId: string | null | undefined;
  for (const { body } of turn) {
    if (body.type !== "update" || body.update.sessionUpdate !== "agent_message_chunk" || body.update.content.type !== "text") continue;
    if (body.update.messageId !== lastId) {
      text = "";
      lastId = body.update.messageId;
    }
    text += body.update.content.text;
  }
  return text;
}

/** Whether the turn that starts with `first` is one of the Control Plane's hidden turns (never verified, not a user turn). */
export function isHiddenTurn(turn: SessionEvent[]): boolean {
  const first = turn[0];
  return first?.body.type === "user_prompt" && (first.body.origin === "e2e" || first.body.origin === "handoff_request");
}
