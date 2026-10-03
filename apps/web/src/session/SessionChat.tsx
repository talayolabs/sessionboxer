import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { PROVIDER_LABELS, type Snapshot } from "@sessionboxer/protocol";
import { api } from "../api";
import { usePendingAttachments } from "../attachments-pending";
import { Composer, type ComposerMode } from "../Composer";
import { ContextGauge } from "../Context";
import type { Draft } from "../draft";
import { formatMb } from "../format";
import { ModelSelect } from "../ModelSelect";
import { OptionSelects } from "../OptionSelect";
import { SavedMessages } from "../SavedMessages";
import { Transcript } from "../Transcript";
import { UsageBars, UsageLimitBar } from "../Usage";
import { parseUtilCommand } from "../UtilityQuickAdd";
import type { Pane, SessionViewProps } from "../SessionView";
import type { useSessionDialogs } from "./SessionDialogs";

function translationPrompt(text: string): string {
  return `translate the following text to english, only answer with the text translated to english and nothing else: '${text}'`;
}

/** Agents tend to echo the quoting of the prompt; drop quotes the original didn't have. */
function cleanTranslation(answer: string, original: string): string {
  let out = answer.trim();
  for (const q of ["'", '"', "`"]) {
    if (out.length >= 2 && out.startsWith(q) && out.endsWith(q) && !(original.startsWith(q) && original.endsWith(q))) {
      out = out.slice(1, -1);
    }
  }
  if (!out) throw new Error("The Provider returned an empty translation");
  return out;
}

export type BranchActions = {
  onRevert: (seq: number) => void;
  onSwitch: (branchId: string) => void;
};

type Props = Pick<SessionViewProps, "session" | "models" | "options" | "items" | "context" | "saved" | "focus" | "onFocused" | "mobile" | "run">
  & Pick<ReturnType<typeof useSessionDialogs>, "setForkFrom" | "setUtilQuickAdd" | "setInspecting" | "setInspectingCall">
  & {
    draft: Draft;
    showChat: boolean;
    pane: Pane;
    setPane: Dispatch<SetStateAction<Pane>>;
    togglePane: (id: Pane) => void;
    branching: boolean;
    branchActions: BranchActions;
    openE2e: (runId: string | null) => void;
    composerMode: ComposerMode;
    setComposerMode: Dispatch<SetStateAction<ComposerMode>>;
    composerHeight: number | null;
    setComposerHeight: Dispatch<SetStateAction<number | null>>;
  };

export function SessionChat({
  session, models, options, items, context, saved, focus, onFocused, mobile, run,
  setForkFrom, setUtilQuickAdd, setInspecting, setInspectingCall, draft, showChat, pane, setPane,
  togglePane, branching, branchActions, openE2e, composerMode, setComposerMode, composerHeight, setComposerHeight,
}: Props) {
  const [modelBusy, setModelBusy] = useState(false);
  const [usageBusy, setUsageBusy] = useState(false);
  const [zen, setZen] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const canPrompt = session.status === "idle" || session.status === "running";
  const attachError = useCallback((message: string) => void run(() => Promise.reject(new Error(message))), [run]);
  const attachments = usePendingAttachments(session.id, canPrompt, attachError);
  const send = () => {
    const text = draft.get();
    const t = text.trim();
    const files = attachments.attachments;
    if (!canPrompt || (!t && files.length === 0)) return;
    if (attachments.items.length !== files.length) return;
    // `/util …` registers a Utility from the composer without the credentials ever entering the transcript (ADR-0073).
    const util = parseUtilCommand(t);
    draft.set("");
    if (util) {
      setUtilQuickAdd(util);
      return;
    }
    void run(async () => {
      try {
        await api.prompt(session.id, files.length > 0 ? { text: t, attachments: files } : { text: t });
      } catch (e) {
        draft.set((cur) => (cur.trim() === "" ? text : cur));
        throw e;
      }
      attachments.clear();
    });
  };
  const enqueue = () => {
    const t = draft.get().trim();
    if (!t) return;
    draft.set("");
    void run(() => api.enqueueMessage(session.id, t));
  };
  const translateToEnglish = useCallback(
    async (selected: string) => cleanTranslation((await api.ask(session.id, translationPrompt(selected))).text, selected),
    [session.id],
  );

  const changeModel = (model: string | null) => {
    if (!model || model === session.settings.model) return;
    setModelBusy(true);
    void run(() => api.updateSession(session.id, { settings: { model } })).finally(() => setModelBusy(false));
  };
  const showModelSelect = models.length > 0 || session.settings.model !== null;
  const changeOption = (id: string, value: string | null) => {
    if (!value || value === session.settings.options[id]) return;
    setModelBusy(true);
    void run(() => api.updateSession(session.id, { settings: { options: { [id]: value } } })).finally(() => setModelBusy(false));
  };
  const snapshotActions = {
    onFork: (s: Snapshot) => setForkFrom(s.id),
    onDelete: (s: Snapshot) => {
      if (confirm(`Delete snapshot #${s.ordinal} (${formatMb(s.sizeBytes)})?`)) void run(() => api.deleteSnapshot(session.id, s.id));
    },
  };

  return (
    <div className="chat" ref={chatRef} hidden={!showChat}>
      <Transcript
        key={session.id}
        items={items}
        actions={snapshotActions}
        branchActions={branchActions}
        branches={session.branches}
        activeBranchId={session.activeBranchId}
        canBranch={session.status === "idle"}
        branchBusy={branching}
        running={session.status === "running"}
        focus={focus}
        onFocused={onFocused}
        onInspectCompaction={(index, compaction) => setInspecting({ index, compaction })}
        onInspectLlmCall={setInspectingCall}
        onOpenE2e={openE2e}
        onOpenPane={(p) => (p === "e2e" ? openE2e(null) : setPane(p as Pane))}
        agent={{ sessionId: session.id, label: PROVIDER_LABELS[session.provider], draft }}
      />
      <Composer
        draft={draft}
        onSend={send}
        onEnqueue={enqueue}
        running={session.status === "running"}
        onStop={() => void run(() => api.cancel(session.id))}
        above={
          <>
            <SavedMessages
              messages={saved}
              queueRunning={session.queueRunning}
              canSend={canPrompt}
              onLoad={(m) => draft.set(m.text)}
              onSend={(m) => void run(() => api.sendSavedMessage(session.id, m.id))}
              onDelete={(m) => void run(() => api.deleteSavedMessage(session.id, m.id))}
              onMove={(m, position) => void run(() => api.updateSavedMessage(session.id, m.id, { position }))}
              onQueueToggle={(running) => void run(() => api.setQueueRunning(session.id, running))}
            />
            <UsageLimitBar
              usage={session.usage}
              provider={session.provider}
              canContinue={session.status === "idle"}
              busy={usageBusy}
              onContinue={() => {
                setUsageBusy(true);
                void run(() => api.continueAfterLimit(session.id)).finally(() => setUsageBusy(false));
              }}
              onAutoContinue={(enabled) => {
                setUsageBusy(true);
                void run(() => api.setAutoContinue(session.id, enabled)).finally(() => setUsageBusy(false));
              }}
            />
            <UsageBars usage={session.usage} provider={session.provider} />
            <ContextGauge context={context} active={pane === "context"} onOpen={() => togglePane("context")} />
          </>
        }
        footerStart={
          <>
            {showModelSelect && (
              <ModelSelect compact models={models} value={session.settings.model} onChange={changeModel} disabled={modelBusy} pending={session.modelPending} />
            )}
            <OptionSelects compact options={options} values={session.settings.options} onChange={changeOption} disabled={modelBusy} pending={session.optionsPending} />
          </>
        }
        disabled={!canPrompt}
        placeholder={
          session.status === "idle"
            ? "The Agent is done and waiting for you\u2026"
            : session.status === "running"
              ? "The Agent is working; a message sent now reaches it after this turn\u2026"
              : `Session is ${session.status}`
        }
        mode={composerMode}
        onModeChange={setComposerMode}
        zen={zen}
        onZenChange={setZen}
        heightFrac={mobile ? null : composerHeight}
        onHeightFracChange={setComposerHeight}
        chatRef={chatRef}
        onTranslate={translateToEnglish}
        attachments={attachments}
      />
    </div>
  );
}
