import type { AgentToolsPolicy } from "@sessionboxer/protocol";
import { Select } from "./ui";

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

const POLICIES: readonly AgentToolsPolicy[] = ["off", "session", "all"];

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
  return (
    <Select<AgentToolsPolicy | "default">
      value={value ?? "default"}
      disabled={disabled}
      onChange={(v) => onChange(v === "default" ? null : v)}
      aria-label="Agent tools"
      options={[
        ...(fallback !== undefined ? [{ value: "default" as const, label: `Settings default (${AGENT_TOOLS_LABELS[fallback]})`, hint: AGENT_TOOLS_HINTS[fallback] }] : []),
        ...POLICIES.map((p) => ({ value: p, label: AGENT_TOOLS_LABELS[p], hint: AGENT_TOOLS_HINTS[p] })),
      ]}
    />
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
    <Select<"default" | "on" | "off">
      value={value === null ? "default" : value ? "on" : "off"}
      disabled={disabled}
      onChange={(v) => onChange(v === "default" ? null : v === "on")}
      aria-label="Ask before the Agent creates a Session"
      options={[
        ...(fallback !== undefined ? [{ value: "default" as const, label: `Settings default (${fallback ? "ask" : "do not ask"})` }] : []),
        { value: "on", label: "Ask me (a card in the chat: Allow / Deny)" },
        { value: "off", label: "Do not ask" },
      ]}
    />
  );
}
