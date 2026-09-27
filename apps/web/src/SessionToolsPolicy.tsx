import type { AgentToolsPolicy } from "@sessionboxer/protocol";

export const AGENT_TOOLS_LABELS: Record<AgentToolsPolicy, string> = {
  off: "Off",
  session: "This Session only",
  all: "All Sessions",
};

export const AGENT_TOOLS_HINTS: Record<AgentToolsPolicy, string> = {
  off: "The Agent gets no sessionboxer MCP: it cannot see or act on Sessionboxer.",
  session: "The Agent knows who it is (whoami, docs) and acts on this Session only: PRs, Snapshots, the queue, the title, verification, terminals, panes.",
  all: "In addition, the Agent lists, creates, forks, messages and stops other Sessions and schedules prompts (children are marked; creation asks you unless turned off).",
};

/**
 * What the `sessionboxer` MCP lets the Agent do (ADR-0062), for the global Settings (`value` is the
 * policy) and the Session settings form (`value === null` follows the global `fallback`).
 */
export function AgentToolsSelect({
  value,
  fallback,
  disabled,
  onChange,
}: {
  value: AgentToolsPolicy | null;
  /** The global policy, shown as the "Settings default" choice; omit in the global form. */
  fallback?: AgentToolsPolicy;
  disabled?: boolean;
  onChange: (value: AgentToolsPolicy | null) => void;
}) {
  const effective = value ?? fallback ?? "session";
  return (
    <>
      <select value={value ?? "default"} disabled={disabled} onChange={(e) => onChange(e.target.value === "default" ? null : (e.target.value as AgentToolsPolicy))}>
        {fallback !== undefined && <option value="default">Settings default ({AGENT_TOOLS_LABELS[fallback]})</option>}
        <option value="off">{AGENT_TOOLS_LABELS.off}</option>
        <option value="session">{AGENT_TOOLS_LABELS.session}</option>
        <option value="all">{AGENT_TOOLS_LABELS.all}</option>
      </select>
      <p className="muted ss-note">{AGENT_TOOLS_HINTS[effective]}</p>
    </>
  );
}

/** The "ask before the Agent creates a Session" switch, in the same two forms. */
export function ApproveCreateSelect({
  value,
  fallback,
  disabled,
  onChange,
}: {
  value: boolean | null;
  fallback?: boolean;
  disabled?: boolean;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <select
      value={value === null ? "default" : value ? "on" : "off"}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "default" ? null : e.target.value === "on")}
    >
      {fallback !== undefined && <option value="default">Settings default ({fallback ? "ask" : "do not ask"})</option>}
      <option value="on">Ask me (a card in the chat: Allow / Deny)</option>
      <option value="off">Do not ask</option>
    </select>
  );
}
