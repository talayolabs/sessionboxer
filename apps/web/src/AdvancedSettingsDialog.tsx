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
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal panel advanced-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="advanced-title"
      >
        <h2 id="advanced-title" className="advanced-title">
          <span>Advanced settings</span>
          <span className="muted advanced-sub">
            for this Session; the Global settings defaults otherwise
          </span>
          <span className="spacer" />
          <button type="button" className="link" onClick={onClose}>
            Done
          </button>
        </h2>
        <div className="split-settings">
          <nav className="split-nav" aria-label="Settings sections">
            <button
              type="button"
              className={section === "session" ? "active" : ""}
              onClick={() => setSection("session")}
            >
              Session
            </button>
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className={section === s.id ? "active" : ""}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <div className="split-body">
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
          </div>
        </div>
      </div>
    </div>
  );
}
