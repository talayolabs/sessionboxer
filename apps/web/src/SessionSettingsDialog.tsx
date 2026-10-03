import { useState } from "react";
import type { AgentOption, ModelOption, PublicSettings, Session, SessionSettingsPatch } from "@sessionboxer/protocol";
import { SessionSettingsForm, sessionSettingsSections, type SessionSettingsSection } from "./SessionSettingsForm";
import { draftFromSettings, type SessionSettingsDraft } from "./session-settings-model";
import { Modal, Tab, TabList, TabPanel, Tabs } from "./ui";

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
    ...(patch.utilitiesEnabled !== undefined ? { utilitiesEnabled: patch.utilitiesEnabled } : {}),
    ...(patch.autoSnapshot !== undefined ? { autoSnapshot: patch.autoSnapshot } : {}),
    ...(patch.snapshotKeep !== undefined ? { snapshotKeep: patch.snapshotKeep } : {}),
    ...(patch.e2eVerify !== undefined ? { e2eVerify: patch.e2eVerify } : {}),
    ...(patch.agentTools !== undefined ? { agentTools: patch.agentTools } : {}),
    ...(patch.approveCreate !== undefined ? { approveCreate: patch.approveCreate } : {}),
    ...(Object.keys(sandbox).length > 0 ? { sandbox } : {}),
  };
}

/**
 * "Session settings", from the Session header (and the phone's ⋯ sheet): every per-Session
 * setting in one place, in the same split view as Global settings and Advanced settings (section
 * titles on the left, the one section on the right). Each control saves as it changes; the Daemon
 * decides whether that is immediate, an Agent restart in place, or deferred to the end of the
 * current turn.
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
  /** Opens the Fork dialog (the way to change creation-only values); `null` when the Sandbox is not running and there is no snapshot yet. */
  onFork: (() => void) | null;
  onClose: () => void;
}) {
  const sections = sessionSettingsSections(session.provider);
  const [section, setSection] = useState<SessionSettingsSection>("environment");
  const current: SessionSettingsSection = sections.some((s) => s.id === section) ? section : "environment";
  return (
    <Modal
      className="advanced-dialog"
      titleClassName="large advanced-title"
      title={
        <>
          <span>Session settings</span>
          <span className="muted advanced-sub">
            changes save as you make them; defaults in <a href="#/settings">Global settings</a>
          </span>
          <span className="spacer" />
          <button type="button" className="link" onClick={onClose}>
            Done
          </button>
        </>
      }
      onClose={onClose}
    >
      <Tabs className="split-settings" orientation="vertical" value={current} onValueChange={setSection}>
        <TabList className="split-nav" aria-label="Settings sections">
          {sections.map((s) => (
            <Tab key={s.id} value={s.id}>
              {s.label}
            </Tab>
          ))}
        </TabList>
        <TabPanel value={current} className="split-body">
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
            only={current}
          />
        </TabPanel>
      </Tabs>
    </Modal>
  );
}
