import { useState } from "react";
import type {
  AgentOption,
  ModelOption,
  Provider,
  PublicSettings,
} from "@sessionboxer/protocol";
import {
  SessionSettingsForm,
  sessionSettingsSections,
  type SessionSettingsDraft,
  type SessionSettingsSection,
} from "./SessionSettingsForm";
import { Modal, Tab, TabList, TabPanel, Tabs } from "./ui";

/**
 * The rest of a new Session's settings, in a split view: section titles on the left, the one
 * section's controls on the right. Edits the same draft the New session screen submits; nothing
 * is saved until the Session is created.
 */
export function AdvancedSettingsDialog({
  provider,
  settings,
  models,
  options,
  value,
  title,
  onChange,
  onTitle,
  onClose,
}: {
  provider: Provider;
  settings: PublicSettings;
  models: ModelOption[];
  options: AgentOption[];
  value: SessionSettingsDraft;
  title: string;
  onChange: (patch: Partial<SessionSettingsDraft>) => void;
  onTitle: (title: string) => void;
  onClose: () => void;
}) {
  const sections = sessionSettingsSections(provider);
  const [section, setSection] = useState<SessionSettingsSection | "session">(
    "session",
  );
  const current =
    section === "session"
      ? null
      : (sections.find((s) => s.id === section) ?? null);
  return (
    <Modal
      className="advanced-dialog"
      titleClassName="large advanced-title"
      title={
        <>
          <span>Advanced settings</span>
          <span className="muted advanced-sub">
            for this Session; the Global settings defaults otherwise
          </span>
          <span className="spacer" />
          <button type="button" className="link" onClick={onClose}>
            Done
          </button>
        </>
      }
      onClose={onClose}
    >
      <Tabs className="split-settings" orientation="vertical" value={section} onValueChange={setSection}>
        <TabList className="split-nav" aria-label="Settings sections">
          <Tab value="session">Session</Tab>
          {sections.map((s) => (
            <Tab key={s.id} value={s.id}>
              {s.label}
            </Tab>
          ))}
        </TabList>
        <TabPanel value={section} className="split-body">
          {section === "session" ? (
            <div className="ss-form">
              <section className="ss-section">
                <h3>Session</h3>
                <label>
                  Title (optional, defaults to the first prompt)
                  <input
                    value={title}
                    onChange={(e) => onTitle(e.target.value)}
                    placeholder="e.g. Fix the flaky login test"
                  />
                </label>
                <p className="muted ss-note">
                  The other sections tune the Agent (model, instructions, MCP
                  servers), what is recorded (snapshots, verification, LLM
                  calls) and the Sandbox (Docker, CPUs, memory, git identity).
                  All optional: the defaults come from Global settings.
                </p>
              </section>
            </div>
          ) : (
            current && (
              <SessionSettingsForm
                mode="create"
                provider={provider}
                settings={settings}
                models={models}
                options={options}
                value={value}
                onChange={onChange}
                only={current.id}
              />
            )
          )}
        </TabPanel>
      </Tabs>
    </Modal>
  );
}
