import type { Dispatch, SetStateAction } from "react";
import type { PullRequest } from "@sessionboxer/protocol";
import { api } from "../api";
import { CodePane, type CodeTarget } from "../Code";
import { ContextPane } from "../Context";
import { Desktop } from "../Desktop";
import { E2ePane } from "../E2e";
import { AppPane } from "../HtmlArtifact";
import { PrPane, PrsPane } from "../PullRequests";
import { TerminalPane } from "../Terminal";
import type { Pane, SessionViewProps } from "../SessionView";
import type { useSessionDialogs } from "./SessionDialogs";

type Props = Pick<SessionViewProps, "session" | "context" | "llmCalls" | "settings" | "prs" |
  "prItems" | "prChecks" | "e2eRuns" | "schedulesPane" | "terminalFocus" | "fsChange" | "run">
  & Pick<ReturnType<typeof useSessionDialogs>, "setInspectingCall">
  & {
    shown: Pane;
    setPane: Dispatch<SetStateAction<Pane>>;
    codeTarget: CodeTarget | null;
    appTarget: string | null;
    openPr: PullRequest | null;
    e2eEnabled: boolean;
    e2eFocus: string | null;
    setE2eVerify: (value: boolean | null) => void;
    appendToComposer: (text: string) => void;
  };

export function SessionPane({
  session, context, llmCalls, settings, prs, prItems, prChecks, e2eRuns, schedulesPane,
  terminalFocus, fsChange, run, setInspectingCall, shown, setPane, codeTarget, appTarget,
  openPr, e2eEnabled, e2eFocus, setE2eVerify, appendToComposer,
}: Props) {
  return (
    <>
      {shown === "desktop" && <Desktop session={session} />}
      {shown === "code" && <CodePane session={session} target={codeTarget} />}
      {shown === "app" && <AppPane session={session} path={appTarget} change={fsChange} />}
      {shown === "terminal" && <TerminalPane session={session} focus={terminalFocus} />}
      {shown === "context" && <ContextPane session={session} context={context} llmCalls={llmCalls} onInspectLlmCall={setInspectingCall} run={run} />}
      {shown === "prs" && <PrsPane session={session} prs={prs} run={run} onOpen={(id) => setPane(`pr:${id}`)} />}
      {shown === "schedules" && <div className="pane schedules-pane">{schedulesPane}</div>}
      {shown === "e2e" && (
        <E2ePane
          session={session}
          runs={e2eRuns}
          enabled={e2eEnabled}
          globalEnabled={settings?.e2eVerify ?? false}
          focusRunId={e2eFocus}
          onToggle={setE2eVerify}
          onRunNow={() => void run(() => api.e2eRunNow(session.id))}
        />
      )}
      {openPr && (
        <PrPane
          session={session}
          pr={openPr}
          items={prItems[openPr.id] ?? null}
          checks={prChecks[openPr.id] ?? null}
          run={run}
          onPromptText={appendToComposer}
          onBack={() => setPane("prs")}
        />
      )}
    </>
  );
}
