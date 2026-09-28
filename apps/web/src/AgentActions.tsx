import type { UiHint } from "@sessionboxer/protocol";

/** What the Agent did through the `sessionboxer` MCP (ADR-0062): a compact transcript marker. */
export interface AgentActionItem {
  kind: "agent_action";
  key: string;
  ts: string;
  tool: string;
  text: string;
  /** Where the marker leads when clicked (`prs`, `pr:<id>`, `e2e`, `terminal`, …). */
  pane: string | null;
  /** The other Session the action concerns, when any. */
  sessionId: string | null;
}

const PANE_LABELS: Record<string, string> = {
  prs: "the PRs pane",
  e2e: "the Auto QA pane",
  terminal: "the Terminal",
  desktop: "the Desktop",
  code: "the Code pane",
  context: "the Context pane",
  schedules: "the Schedules pane",
  chat: "the chat",
};

function paneLabel(pane: string): string {
  if (pane.startsWith("pr:")) return "that pull request";
  return PANE_LABELS[pane] ?? `the ${pane} pane`;
}

/** `Agent: attached PR #12 (owner/repo)`; clicking opens the pane the action concerns. */
export function AgentActionMarker({ item, onOpenPane }: { item: AgentActionItem; onOpenPane?: (pane: string) => void }) {
  const title = `The Agent called ${item.tool} through the sessionboxer MCP`;
  if (item.pane && onOpenPane) {
    const pane = item.pane;
    return (
      <button type="button" className="marker marker-agent marker-button" title={`${title}. Click to open ${paneLabel(pane)}.`} onClick={() => onOpenPane(pane)}>
        Agent: {item.text}
      </button>
    );
  }
  return (
    <div className="marker marker-agent" title={title}>
      Agent: {item.text}
    </div>
  );
}

/**
 * Whether the user is in the middle of typing: the focused element is an editable field with
 * something in it. A `ui_hint` never switches panes underneath a message being written.
 */
export function userIsTyping(): boolean {
  const el = document.activeElement;
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return (el.textContent ?? "").trim() !== "";
  if (el instanceof HTMLTextAreaElement) return el.value.trim() !== "";
  if (el instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "range", "file"].includes(el.type) && el.value.trim() !== "";
  return false;
}

/** Whether a `ui_hint` applies to the page: the same Session is on screen and nothing is being typed. */
export function uiHintApplies(hint: UiHint, selectedSessionId: string | null): boolean {
  return hint.sessionId === selectedSessionId && !userIsTyping();
}
