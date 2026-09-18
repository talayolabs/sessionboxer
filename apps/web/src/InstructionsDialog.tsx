import { useEffect } from "react";
import { PROVIDER_LABELS, instructionsDelivery, type Provider, type Session } from "@sessionboxer/protocol";

/** How `instructions` reach the Agent of a Provider, in one sentence for the UI. */
export function deliveryNote(provider: Provider): string {
  return instructionsDelivery(provider) === "system-prompt"
    ? `${PROVIDER_LABELS[provider]} gets them appended to its system prompt (every turn, before the conversation).`
    : `${PROVIDER_LABELS[provider]} has no system-prompt hook: they are prepended to the first message of the conversation (again after a rewind that replays the transcript).`;
}

/** Read-only view of a Session's standing instructions, from the "Instructions" button in the header. */
export function InstructionsDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel instructions-dialog" role="dialog" aria-modal="true" aria-labelledby="instructions-title">
        <h2 id="instructions-title">Instructions of "{session.title}"</h2>
        <p className="muted">
          Fixed when the Session was created (on top of the Sandbox briefing). {deliveryNote(session.provider)} The default for new Sessions is
          in <a href="#/settings">Settings</a>.
        </p>
        {session.instructions.trim() === "" ? (
          <p className="empty">None: this Session's Agent only has the Sandbox briefing and the project's own instruction files.</p>
        ) : (
          <pre className="instructions-text">{session.instructions}</pre>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
