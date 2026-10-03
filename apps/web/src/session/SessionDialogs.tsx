import { useState } from "react";
import type { LlmCall } from "@sessionboxer/protocol";
import { api } from "../api";
import { CompactionDialog } from "../CompactionDialog";
import type { Compaction } from "../context-model";
import { ForkDialog } from "../ForkDialog";
import { LlmCallDialog } from "../LlmCallDialog";
import { ReposDialog, githubAccounts } from "../Repos";
import { SessionSettingsDialog } from "../SessionSettingsDialog";
import { SyncDialog } from "../SyncDialog";
import { UsbDialog } from "../UsbDialog";
import { UtilityQuickAdd, type UtilCommand } from "../UtilityQuickAdd";
import type { SessionViewProps } from "../SessionView";

export function useSessionDialogs() {
  const [forkFrom, setForkFrom] = useState<string | null>(null);
  const [forkWithSettings, setForkWithSettings] = useState(false);
  const [forking, setForking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [utilQuickAdd, setUtilQuickAdd] = useState<UtilCommand | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [inspecting, setInspecting] = useState<{ index: number; compaction: Compaction } | null>(null);
  const [inspectingCall, setInspectingCall] = useState<LlmCall | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [reposOpen, setReposOpen] = useState(false);
  const [usbOpen, setUsbOpen] = useState(false);
  return { forkFrom, setForkFrom, forkWithSettings, setForkWithSettings, forking, setForking, settingsOpen, setSettingsOpen, utilQuickAdd, setUtilQuickAdd, settingsBusy, setSettingsBusy, inspecting, setInspecting, inspectingCall, setInspectingCall, syncOpen, setSyncOpen, reposOpen, setReposOpen, usbOpen, setUsbOpen };
}

type Props = ReturnType<typeof useSessionDialogs> & Pick<SessionViewProps,
  "session" | "sessions" | "settings" | "onSettings" | "models" | "options" | "allModels" | "allOptions" |
  "snapshots" | "saved" | "llmCalls" | "run" | "onForked"
> & { defaultForkPoint: string | undefined };

export function SessionDialogs({
  forkFrom, setForkFrom, forkWithSettings, setForkWithSettings, forking, setForking, settingsOpen, setSettingsOpen, utilQuickAdd, setUtilQuickAdd, settingsBusy, setSettingsBusy, inspecting, setInspecting, inspectingCall, setInspectingCall, syncOpen, setSyncOpen, reposOpen, setReposOpen, usbOpen, setUsbOpen,
  session, sessions, settings, onSettings, models, options, allModels, allOptions,
  snapshots, saved, llmCalls, run, onForked, defaultForkPoint,
}: Props) {
  return (
    <>
      {settingsOpen && settings && (
        <SessionSettingsDialog
          session={session}
          settings={settings}
          models={models}
          options={options}
          busy={settingsBusy}
          onPatch={(patch) => {
            setSettingsBusy(true);
            void run(() => api.updateSession(session.id, { settings: patch })).finally(() => setSettingsBusy(false));
          }}
          onFork={
            defaultForkPoint
              ? () => {
                  setSettingsOpen(false);
                  setForkWithSettings(true);
                  setForkFrom(defaultForkPoint);
                }
              : null
          }
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {utilQuickAdd && settings && <UtilityQuickAdd command={utilQuickAdd} session={session} settings={settings} onSettings={onSettings} onClose={() => setUtilQuickAdd(null)} />}
      {inspecting && <CompactionDialog session={session} compaction={inspecting.compaction} index={inspecting.index} onClose={() => setInspecting(null)} />}
      {inspectingCall && <LlmCallDialog session={session} call={inspectingCall} calls={llmCalls} onClose={() => setInspectingCall(null)} />}
      {syncOpen && <SyncDialog session={session} onClose={() => setSyncOpen(false)} />}
      {reposOpen && <ReposDialog session={session} accounts={githubAccounts(settings)} onClose={() => setReposOpen(false)} />}
      {usbOpen && <UsbDialog session={session} sessions={sessions} onClose={() => setUsbOpen(false)} />}
      {forkFrom && settings && (
        <ForkDialog
          session={session}
          settings={settings}
          models={{ ...allModels, [session.provider]: models }}
          options={{ ...allOptions, [session.provider]: options }}
          snapshots={snapshots}
          saved={saved}
          initialSnapshotId={forkFrom}
          initialSettingsOpen={forkWithSettings}
          busy={forking}
          onClose={() => {
            setForkFrom(null);
            setForkWithSettings(false);
          }}
          onSubmit={(req) => {
            setForking(true);
            void run(async () => {
              const fork = await api.forkSession(session.id, req);
              setForkFrom(null);
              setForkWithSettings(false);
              onForked(fork);
            }).finally(() => setForking(false));
          }}
        />
      )}
    </>
  );
}
