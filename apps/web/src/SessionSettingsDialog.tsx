import { useEffect } from "react";
import type { AgentOption, ModelOption, PublicSettings, Session, SessionSettingsPatch } from "@sessionboxer/protocol";
import { SessionSettingsForm, draftFromSettings, type SessionSettingsDraft } from "./SessionSettingsForm";

/** The live form's edits as a `PATCH /api/sessions/:id` body; creation-only fields never reach here (the form shows them read-only). */
function toPatch(patch: Partial<SessionSettingsDraft>): SessionSettingsPatch {
  const sandbox = {
    ...(patch.cpus !== undefined ? { cpus: patch.cpus } : {}),
    ...(patch.memoryGb !== undefined ? { memoryGb: patch.memoryGb } : {}),
  };
  return {
    ...(patch.model !== undefined && patch.model !== null ? { model: patch.model } : {}),
    ...(patch.options !== undefined ? { options: patch.options } : {}),
    ...(patch.inspectLlm !== undefined ? { inspectLlm: patch.inspectLlm } : {}),
    ...(patch.mcpEnabled !== undefined ? { mcpEnabled: patch.mcpEnabled } : {}),
    ...(patch.autoSnapshot !== undefined ? { autoSnapshot: patch.autoSnapshot } : {}),
    ...(patch.snapshotKeep !== undefined ? { snapshotKeep: patch.snapshotKeep } : {}),
    ...(Object.keys(sandbox).length > 0 ? { sandbox } : {}),
  };
}

/**
 * "Session settings", from the Session header (and the phone's ⋯ sheet): every per-Session
 * setting in one place. Each control saves as it changes; the Daemon decides whether that is
 * immediate, an Agent restart in place, or deferred to the end of the current turn.
 */
export function SessionSettingsDialog({
  session,
  settings,
  models,
  options,
  busy,
  onPatch,
  onFork,
  onClose,
}: {
  session: Session;
  settings: PublicSettings;
  models: ModelOption[];
  options: AgentOption[];
  busy: boolean;
  onPatch: (patch: SessionSettingsPatch) => void;
  /** Opens the Fork dialog (the way to change creation-only values); `null` when there is no snapshot yet. */
  onFork: (() => void) | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel session-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="session-settings-title">
        <h2 id="session-settings-title">Settings of "{session.title}"</h2>
        <p className="muted">
          Changes save as you make them. Global defaults live in <a href="#/settings">Settings</a>.
        </p>
        <SessionSettingsForm
          mode="live"
          provider={session.provider}
          session={session}
          settings={settings}
          models={models}
          options={options}
          value={draftFromSettings(session.settings)}
          onChange={(patch) => {
            const body = toPatch(patch);
            if (Object.keys(body).length > 0) onPatch(body);
          }}
          disabled={busy}
          onFork={onFork ?? undefined}
        />
        <div className="actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
