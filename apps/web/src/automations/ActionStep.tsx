import { useState } from "react";
import { AUTOMATION_ACTION_LABELS, PROVIDERS, PROVIDER_LABELS, type AutomationAction, type Provider, type ProviderModels, type ProviderOptions, type PublicSettings, type ReviewVerdict, type Session } from "@sessionboxer/protocol";
import type { Step } from "../Automations";
import { RepoEditor, githubAccounts, specsToDrafts } from "../Repos";
import { SessionSettingsForm } from "../SessionSettingsForm";
import { draftFromDefaults, draftFromInput } from "../session-settings-model";
import { useSectionState, type SectionSetters, type Setter } from "../useSectionState";
import type { ActionValues } from "./form-model";
import { VERDICT_LABELS } from "./display";

export function useActionState(a: AutomationAction | undefined, sessions: Session[], settings: PublicSettings, forSession?: Session) {
  const promptAction = a?.type === "prompt" ? a : null;
  const newAction = a?.type === "new_session" ? a : null;
  const reviewAction = a?.type === "auto_review" ? a : null;
  const qaAction = a?.type === "auto_qa" ? a : null;
  const [initial] = useState<ActionValues>(() => ({
    actionType: a?.type ?? (forSession || sessions.length > 0 ? "prompt" : "new_session"),
    sessionId: promptAction?.sessionId ?? forSession?.id ?? sessions[0]?.id ?? "",
    text: promptAction?.text ?? "",
    provider: newAction?.provider ?? reviewAction?.provider ?? qaAction?.provider ?? "claude-code",
    repos: specsToDrafts(newAction?.repos ?? []),
    draft: newAction ? { ...draftFromInput(newAction.settings, settings), snapshotId: newAction.snapshotId ?? null } : draftFromDefaults(settings),
    title: newAction?.title ?? "",
    prompt: newAction?.prompt ?? "",
    stopAfter: newAction?.stopAfter ?? reviewAction?.stopAfter ?? qaAction?.stopAfter ?? true,
    checkoutPrHead: newAction?.checkoutPrHead ?? true,
    notifyText: a?.type === "notify" ? (a.text ?? "") : "",
    instructions: reviewAction?.instructions ?? qaAction?.instructions ?? "",
    maxVerdict: reviewAction?.maxVerdict ?? "comment",
    deltaOnly: reviewAction?.deltaOnly ?? true,
    notifyOn: reviewAction?.notifyOn ?? "findings",
    publish: qaAction?.publish ?? "github_attachment",
    commentOnSkip: qaAction?.commentOnSkip ?? false,
    maxMinutes: qaAction?.maxMinutes ?? 10,
  }));
  return useSectionState(initial);
}

export function ActionStep({
  actionType, sessionId, text, provider, repos, draft, title, prompt, stopAfter, checkoutPrHead, notifyText, instructions, maxVerdict, deltaOnly, notifyOn, publish, commentOnSkip, maxMinutes,
  setActionType, setSessionId, setText, setProvider, setRepos, setDraft, setTitle, setPrompt, setStopAfter, setCheckoutPrHead, setNotifyText, setInstructions, setMaxVerdict, setDeltaOnly, setNotifyOn, setPublish, setCommentOnSkip, setMaxMinutes,
  forSession, sessions, settings, models, options, busy, isPr, showLimits, actionError, setStep,
}: ActionValues & SectionSetters<ActionValues> & {
  forSession?: Session;
  sessions: Session[];
  settings: PublicSettings;
  models: ProviderModels;
  options: ProviderOptions;
  busy: boolean;
  isPr: boolean;
  showLimits: boolean;
  actionError: string | null;
  setStep: Setter<Step>;
}) {
  const actionChoices: AutomationAction["type"][] = isPr ? ["auto_review", "auto_qa", "prompt", "new_session", "attach", "notify"] : ["prompt", "new_session", "notify"];
  return (
    <section className="automation-step">
      <h3>
        <span className="automation-step-n">2</span> Do
      </h3>
      {!forSession && (
        <fieldset className="choice">
          <legend>Action</legend>
          {actionChoices.map((type) => (
            <label key={type} className="check">
              <input type="radio" name="action" checked={actionType === type} onChange={() => setActionType(type)} />
              {AUTOMATION_ACTION_LABELS[type]}
            </label>
          ))}
        </fieldset>
      )}
      {actionType === "prompt" && (
        <>
          {!forSession && (
            <label>
              Session
              <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                {isPr && <option value="attached">The Session the PR is attached to</option>}
                {sessions.length === 0 && !isPr && <option value="">No Sessions yet</option>}
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} ({PROVIDER_LABELS[s.provider]}, {s.status})
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="field-hint">
            Sent right away when the Session is idle, queued behind the running turn otherwise; a stopped Session is resumed first. The Session keeps its transcript and
            snapshots.{isPr && <> Placeholders: <code>{"{pr.url}"}</code>, <code>{"{pr.number}"}</code>, <code>{"{pr.title}"}</code>, <code>{"{pr.repo}"}</code>, <code>{"{pr.headSha}"}</code>, <code>{"{event}"}</code>.</>}
          </p>
          <label>
            Prompt
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={isPr ? "PR {pr.url} was {event}: address the new comments and failing checks." : undefined} />
          </label>
        </>
      )}
      {(actionType === "new_session" || actionType === "auto_review" || actionType === "auto_qa") && (
        <label>
          Provider
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as Provider);
              setDraft((d) => ({ ...d, model: null, options: {}, inspectLlm: true }));
            }}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
      )}
      {actionType === "new_session" && (
        <>
          {isPr && (
            <label className="check">
              <input type="checkbox" checked={checkoutPrHead} onChange={(e) => setCheckoutPrHead(e.target.checked)} />
              {draft.snapshotId
                ? "Open the prompt with fetching the PR head into the snapshot's repository (nothing is cloned)"
                : "Clone the PR's repository at the PR head as the first repository"}
            </label>
          )}
          {draft.snapshotId ? (
            <p className="field-hint">The repositories come with the snapshot picked under Environment; each run starts a fresh Sandbox from that image.</p>
          ) : (
            <fieldset className="choice">
              <legend>
                {isPr && checkoutPrHead ? "Other repositories" : "Repositories"} (each goes to <code>/workspace/&lt;name&gt;</code>; cloned fresh on every run)
              </legend>
              <RepoEditor drafts={repos} onChange={setRepos} disabled={busy} accounts={githubAccounts(settings)} />
            </fieldset>
          )}
          <SessionSettingsForm
            mode="create"
            provider={provider}
            settings={settings}
            models={models[provider]}
            options={options[provider]}
            value={draft}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
            disabled={busy}
          />
          <label>
            Session title (optional; defaults to the first prompt{isPr && "; placeholders work"})
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isPr ? "PR #{pr.number}: {pr.title}" : undefined} />
          </label>
          <label>
            First prompt
            <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={isPr ? "Pull request {pr.url} ({event}). …" : undefined} />
          </label>
        </>
      )}
      {actionType === "auto_review" && (
        <>
          <p className="field-hint">
            A new Session clones the repository at the PR head, reviews the diff (the PR's text is data, not instructions) and hands its findings to the Control Plane, which posts one review
            comment on the PR under your connector account with a link back here.
          </p>
          <div className="row">
            <label>
              Verdict
              <select value={maxVerdict} onChange={(e) => setMaxVerdict(e.target.value as ReviewVerdict)}>
                {(Object.keys(VERDICT_LABELS) as ReviewVerdict[]).map((v) => (
                  <option key={v} value={v}>
                    {VERDICT_LABELS[v]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Notify me
              <select value={notifyOn} onChange={(e) => setNotifyOn(e.target.value as typeof notifyOn)}>
                <option value="findings">When there are findings</option>
                <option value="always">After every review</option>
                <option value="never">Never</option>
              </select>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={deltaOnly} onChange={(e) => setDeltaOnly(e.target.checked)} />
            On new commits, review only what changed since the last review
          </label>
          <label>
            Instructions for the reviewer (optional: conventions, what to ignore)
            <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </label>
        </>
      )}
      {actionType === "auto_qa" && (
        <>
          <p className="field-hint">
            A new Session clones the repository at the PR head, plans 2–5 cases from the PR's title, description and diff, runs them on its desktop and records a video; the result is posted
            on the PR with a link back here.
          </p>
          <div className="row">
            <label>
              Publish the video
              <select value={publish} onChange={(e) => setPublish(e.target.value as typeof publish)}>
                <option value="github_attachment">Attached to the PR comment (GitHub)</option>
                <option value="link_only">Link to Sessionboxer only</option>
              </select>
            </label>
            <label>
              Time limit (minutes)
              <input type="number" min={1} max={30} value={maxMinutes} onChange={(e) => setMaxMinutes(Math.max(1, Math.min(30, Number(e.target.value) || 10)))} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={commentOnSkip} onChange={(e) => setCommentOnSkip(e.target.checked)} />
            Comment on the PR even when nothing is testable on a desktop
          </label>
          <label>
            Instructions for QA (optional: how to start the app, test accounts)
            <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </label>
        </>
      )}
      {(actionType === "new_session" || actionType === "auto_review" || actionType === "auto_qa") && (
        <label className="check">
          <input type="checkbox" checked={stopAfter} onChange={(e) => setStopAfter(e.target.checked)} />
          Stop the Session when the turn ends (the transcript and snapshots stay; resume it any time)
        </label>
      )}
      {actionType === "attach" && <p className="field-hint">When a followed PR's head branch was pushed from one of your Sessions, the PR appears in that Session's PRs pane without pasting its URL.</p>}
      {actionType === "notify" && (
        <label>
          Text (optional; placeholders work)
          <input value={notifyText} onChange={(e) => setNotifyText(e.target.value)} placeholder={isPr ? "{pr.title} was {event}" : "Time for the morning triage"} />
        </label>
      )}
      {!showLimits && (
        <div className="actions">
          <button type="button" className="primary" disabled={actionError !== null} onClick={() => setStep("limits")}>
            Next: limits
          </button>
        </div>
      )}
    </section>
  );
}
