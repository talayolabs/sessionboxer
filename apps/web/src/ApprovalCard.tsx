import { useState } from "react";
import type { AgentApproval } from "@sessionboxer/protocol";
import { api } from "./api";
import { useClock } from "./time";

function inMinutes(iso: string, now: number): string {
  const left = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  return left <= 0 ? "any moment now" : `in ${left} min`;
}

/**
 * "Claude wants to create a Session 'X' — Allow / Deny" (ADR-0062). While pending the card takes
 * the answer; settled (allowed, denied, or expired after ten unattended minutes) it says so and
 * links the Session created. The state comes from the latest `agent_approval` event of the id.
 */
export function ApprovalCard({ sessionId, approval, agent }: { sessionId: string; approval: AgentApproval; agent: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useClock();
  const answer = async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.answerApproval(sessionId, approval.id, allow);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const what = `${agent} wants to ${approval.summary}`;
  return (
    <div className={`approval approval-${approval.status}`} data-approval-id={approval.id}>
      <div className="approval-text">
        <strong>{what}</strong>
        {approval.status === "pending" && (
          <span className="muted"> — unanswered, it is denied {inMinutes(approval.expiresAt, now)}</span>
        )}
        {approval.status === "allowed" && approval.result && (
          <span>
            {" "}
            — allowed: <a href={`#/sessions/${approval.result.sessionId}`}>{approval.result.title}</a>
          </span>
        )}
        {approval.status === "allowed" && approval.error && <span className="approval-error"> — allowed, but it failed: {approval.error}</span>}
        {approval.status === "denied" && <span className="muted"> — denied</span>}
        {approval.status === "expired" && <span className="muted"> — not answered in time, denied</span>}
      </div>
      {approval.status === "pending" && (
        <div className="approval-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void answer(true)}>
            Allow
          </button>
          <button type="button" disabled={busy} onClick={() => void answer(false)}>
            Deny
          </button>
        </div>
      )}
      {error && <div className="approval-error">{error}</div>}
    </div>
  );
}
