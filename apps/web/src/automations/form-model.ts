import type {
  AutomationAction, AutomationTrigger, PrEventFilters, PrEventType, PublicSettings,
  Provider, RepoSpec, ReviewVerdict, ScheduleMissedPolicy, Session, SessionSettingsInput,
} from "@sessionboxer/protocol";
import type { RepoDraft } from "../Repos";
import type { SessionSettingsDraft } from "../SessionSettingsForm";

export type TriggerValues = {
  triggerType: AutomationTrigger["type"];
  cron: string;
  timezone: string;
  missedRun: ScheduleMissedPolicy;
  prFollows: string[];
  prEvents: PrEventType[];
  filters: PrEventFilters;
};

export type ActionValues = {
  actionType: AutomationAction["type"];
  sessionId: string;
  text: string;
  provider: Provider;
  repos: RepoDraft[];
  draft: SessionSettingsDraft;
  title: string;
  prompt: string;
  stopAfter: boolean;
  checkoutPrHead: boolean;
  notifyText: string;
  instructions: string;
  maxVerdict: ReviewVerdict;
  deltaOnly: boolean;
  notifyOn: "always" | "findings" | "never";
  publish: "github_attachment" | "link_only";
  commentOnSkip: boolean;
  maxMinutes: number;
};

export type SchedulePreview = { ok: true; next: string[] } | { ok: false; error: string } | null;

// The converters live with their existing TSX forms; passing them keeps this model React-free.
type ActionConverters = {
  draftsToSpecs: (repos: RepoDraft[]) => RepoSpec[];
  draftToInput: (draft: SessionSettingsDraft) => SessionSettingsInput;
};

export function buildTrigger({ triggerType, cron, timezone, missedRun, prFollows, prEvents, filters }: TriggerValues): AutomationTrigger {
  return triggerType === "schedule"
      ? { type: "schedule", cron: cron.trim(), timezone: timezone.trim(), missedRun }
      : triggerType === "pr_event"
        ? { type: "pr_event", follows: prFollows, events: prEvents, filters: cleanFilters(filters) }
        : { type: "manual" };
}

export function buildAction({
  actionType, sessionId, text, provider, repos, draft, title, prompt, stopAfter, checkoutPrHead, notifyText, instructions, maxVerdict, deltaOnly, notifyOn, publish, commentOnSkip, maxMinutes,
}: ActionValues, { draftsToSpecs, draftToInput }: ActionConverters): AutomationAction {
  switch (actionType) {
    case "prompt":
      return { type: "prompt", sessionId, text: text.trim() };
    case "new_session":
      return {
        type: "new_session",
        provider,
        repos: draft.snapshotId ? [] : draftsToSpecs(repos),
        ...(draft.snapshotId ? { snapshotId: draft.snapshotId } : {}),
        settings: draftToInput(draft),
        prompt: prompt.trim(),
        stopAfter,
        checkoutPrHead,
        ...(title.trim() ? { title: title.trim() } : {}),
      };
    case "auto_review":
      return { type: "auto_review", provider, maxVerdict, deltaOnly, notifyOn, stopAfter, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) };
    case "auto_qa":
      return { type: "auto_qa", provider, publish, commentOnSkip, maxMinutes, stopAfter, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) };
    case "attach":
      return { type: "attach" };
    case "notify":
      return { type: "notify", ...(notifyText.trim() ? { text: notifyText.trim() } : {}) };
  }
}

export function getTriggerError(
  { triggerType, prEvents, prFollows }: Pick<TriggerValues, "triggerType" | "prEvents" | "prFollows">,
  preview: SchedulePreview,
  follows: readonly unknown[],
): string | null {
  return triggerType === "schedule"
      ? preview && !preview.ok
        ? preview.error
        : null
      : triggerType === "pr_event"
        ? prEvents.length === 0
          ? "Pick at least one event."
          : follows.length === 0 && prFollows.length === 0
            ? "Follow a repository below, or your PRs on the Pull requests page."
            : null
        : null;
}

export function getActionError(
  { actionType, sessionId, text, prompt }: Pick<ActionValues, "actionType" | "sessionId" | "text" | "prompt">,
  targetSession: Session | null,
  repoError: string | null,
): string | null {
  return actionType === "prompt"
      ? sessionId !== "attached" && !targetSession
        ? "Pick a Session."
        : text.trim() === ""
          ? "Write the prompt."
          : null
      : actionType === "new_session"
        ? prompt.trim() === ""
          ? "Write the first prompt."
          : repoError
        : null;
}

export function getFormError(name: string, triggerError: string | null, actionError: string | null): string | null {
  return name.trim() === "" ? "Give the automation a name." : (triggerError ?? actionError);
}

export function clamp(raw: string, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && raw !== "" ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

/** Empty optional filters are left out rather than sent as "". */
export function cleanFilters(f: PrEventFilters): PrEventFilters {
  return {
    drafts: f.drafts,
    forks: f.forks,
    authors: f.authors,
    includeOwn: f.includeOwn,
    ...(f.authorLogins && f.authorLogins.length > 0 ? { authorLogins: f.authorLogins } : {}),
    ...(f.reviewers && f.reviewers.length > 0 ? { reviewers: f.reviewers } : {}),
    ...(f.baseRef?.trim() ? { baseRef: f.baseRef.trim() } : {}),
    ...(f.titleMatch?.trim() ? { titleMatch: f.titleMatch.trim() } : {}),
    ...(f.labels && f.labels.length > 0 ? { labels: f.labels } : {}),
  };
}

/** A stored template's settings back into the form; omitted parts follow the current defaults. */
export function draftFromInput(input: SessionSettingsInput, settings: PublicSettings, draftFromDefaults: (settings: PublicSettings) => SessionSettingsDraft): SessionSettingsDraft {
  const base = draftFromDefaults(settings);
  return {
    model: input.model ?? base.model,
    options: input.options ?? base.options,
    inspectLlm: input.inspectLlm ?? base.inspectLlm,
    mcpEnabled: input.mcpEnabled ?? base.mcpEnabled,
    utilitiesEnabled: input.utilitiesEnabled ?? base.utilitiesEnabled,
    instructions: input.instructions ?? base.instructions,
    autoSnapshot: input.autoSnapshot === undefined ? base.autoSnapshot : input.autoSnapshot,
    snapshotKeep: input.snapshotKeep === undefined ? base.snapshotKeep : input.snapshotKeep,
    e2eVerify: input.e2eVerify === undefined ? base.e2eVerify : input.e2eVerify,
    agentTools: input.agentTools === undefined ? base.agentTools : input.agentTools,
    approveCreate: input.approveCreate === undefined ? base.approveCreate : input.approveCreate,
    environment: input.sandbox?.environment ?? base.environment,
    snapshotId: base.snapshotId,
    docker: input.sandbox?.docker ?? base.docker,
    cpus: input.sandbox?.cpus === undefined ? base.cpus : input.sandbox.cpus,
    memoryGb: input.sandbox?.memoryGb === undefined ? base.memoryGb : input.sandbox.memoryGb,
    gitName: input.sandbox?.gitIdentity?.name ?? base.gitName,
    gitEmail: input.sandbox?.gitIdentity?.email ?? base.gitEmail,
  };
}
