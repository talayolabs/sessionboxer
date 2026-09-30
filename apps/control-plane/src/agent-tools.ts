import { randomBytes } from "node:crypto";
import {
  AGENT_APPROVAL_TIMEOUT_MS,
  AGENT_BRIDGE_TIMEOUT_MS,
  AgentApprovalWaitArgs,
  AgentAutomationCreateArgs,
  AgentAutomationRunsArgs,
  AgentFollowedPrListArgs,
  AgentNotifyArgs,
  AgentPrAttachArgs,
  AgentPrFollowArgs,
  AgentPrItemsArgs,
  AgentPrMarkAddressedArgs,
  AgentPrReviewSubmitArgs,
  AgentQueueAddArgs,
  AgentScheduleCreateArgs,
  AgentSessionCreateArgs,
  AgentSessionForkArgs,
  AgentSessionGetArgs,
  AgentSessionMessageArgs,
  AgentSessionStopArgs,
  AgentSessionSummary,
  AgentSessionWaitArgs,
  AgentTerminalReadArgs,
  AgentTranscribeMediaArgs,
  AgentTitleSetArgs,
  AgentUiOpenArgs,
  AgentVerifyArgs,
  AgentWhoAmI,
  agentToolOf,
  PtyReadResult,
  repoDir,
  resolveSessionSettings,
  sessionRoute,
  type AgentApproval,
  type AgentApprovalKind,
  type AgentTool,
  type AgentToolsPolicy,
  type ContextBreakdown,
  type Automation,
  type AutomationLimits,
  type AutomationRun,
  type CreateAutomationRequest,
  type CreatePrFollowRequest,
  type CreateScheduleRequest,
  type CreateSessionRequest,
  type FollowedPr,
  type ForkSessionRequest,
  type PtyInfo,
  type PtyListResult,
  type PrFollow,
  type PublicSettings,
  type PullRequest,
  type SavedMessage,
  type Schedule,
  type Session,
  type SessionBroadcast,
  type SessionEvent,
  type SessionEventBody,
  type SessionInfo,
  type SessionStatus,
  type Settings,
  type Snapshot,
  type UiHint,
  AgentProcedureSaveArgs,
  AgentUtilitiesAddArgs,
  AgentUtilitiesEnableArgs,
  AgentUtilitiesGetArgs,
  AgentUtilitiesOpenArgs,
  AgentUtilitiesUpdateArgs,
  UTILITY_GROUPS,
  UTILITY_GROUP_LABELS,
  UTILITY_PRESETS,
  applyUtilityPreset,
  type McpKeyValue,
  type ProcedureDef,
  type PublicMcpKeyValue,
  type PublicUtilityDef,
  type UpdateSettingsRequest,
  type UtilityDef,
  type TimedTranscription,
} from "@sessionboxer/protocol";
import { PUBLIC_URL } from "./config.js";
import { resolveUtilities, toPublicUtility, utilityLabel } from "./utilities.js";
import type { Db } from "./db.js";
import type { E2eVerification } from "./e2e.js";
import type { PullRequests } from "./pull-requests.js";

/** The part of `Automations` the Agent's `automation_*` and `schedule_*` tools use. */
export interface AgentAutomations {
  list(): Automation[];
  create(req: CreateAutomationRequest): Automation;
  listRuns(id: string): AutomationRun[];
  listSchedules(): Schedule[];
  createSchedule(req: CreateScheduleRequest): Schedule;
}

/** The part of `FollowedPrs` the Agent's `pr_follow` / `pr_followed_list` tools use. */
export interface AgentFollowedPrs {
  follow(req: CreatePrFollowRequest, defaultAccount: string | null): PrFollow;
  listFollows(): PrFollow[];
  list(filter: { state?: "open" | "all"; repo?: string }): FollowedPr[];
}

/** The Auto review action's poster (`pr-reviews.ts`). */
export interface AgentPrReviews {
  submit(sessionId: string, args: AgentPrReviewSubmitArgs): Promise<{ url: string | null; verdict: string; findings: number; inline: number; note: string }>;
}

/** What the Control Plane needs to answer the `sessionboxer` MCP's tools for one Session. */
export interface AgentToolsDeps {
  db: Db;
  getSession: (id: string) => Session | null;
  listSessions: () => Session[];
  /** Global Settings (for `approveCreate` and the children cap). */
  settings: () => Settings;
  /** The last thing a Session's Agent said, capped. */
  lastReply: (id: string) => string | null;
  /** Throws when `createdBy`'s Agent may not create one more Session (its own or the global cap). */
  assertChildAllowed: (createdBy: string) => void;
  /** Creates a Session on behalf of `createdBy`'s Agent (caps checked again there). */
  createSession: (createdBy: string, req: CreateSessionRequest) => Promise<Session>;
  /** Forks `fromId` on behalf of its own Agent (`createdBy: fromId`). */
  forkSession: (fromId: string, req: ForkSessionRequest) => Promise<Session>;
  /** `from`'s Agent prompts `target` (queued when busy or asked to). */
  messageSession: (from: string, target: string, text: string, when: "now" | "queue") => Promise<"prompted" | "queued">;
  waitSession: (id: string, timeoutMs: number) => Promise<{ stillRunning: boolean; status: SessionStatus; lastReply: string | null }>;
  stopSession: (id: string) => Promise<Session>;
  /** `null` until the server wires the Automations. */
  automations: () => AgentAutomations | null;
  /** `null` until the server wires the followed pull requests. */
  followedPrs: () => AgentFollowedPrs | null;
  /** `null` until the server wires the Auto review action. */
  reviews: () => AgentPrReviews | null;
  /** The `SessionInfo` the Daemon writes to `session.json`, as of now. */
  sessionInfo: (id: string) => SessionInfo;
  /** The policy in force (`Settings.agentTools` with the Session's override). */
  policy: (id: string) => AgentToolsPolicy;
  /** Global Settings as the UI sees them (no secrets); `null` until the Control Plane wires it. */
  publicSettings: () => Promise<PublicSettings> | null;
  /** Stores a Settings change the way the Settings page does (validated, saved, pushed to live Sessions). */
  applySettings: (update: UpdateSettingsRequest) => Promise<void>;
  /** The Session's enabled Utilities, by registry id. */
  setUtilitiesEnabled: (id: string, ids: string[]) => Promise<Session>;
  prs: PullRequests;
  e2e: E2eVerification;
  snapshot: (id: string) => Promise<Snapshot>;
  enqueue: (id: string, text: string) => Promise<SavedMessage>;
  savedMessages: (id: string) => SavedMessage[];
  setTitle: (id: string, title: string) => void;
  terminalList: (id: string) => Promise<PtyListResult>;
  terminalRead: (id: string, ptyId: string, lines: number) => Promise<PtyReadResult>;
  terminalOpen: (id: string, cols: number, rows: number) => Promise<PtyInfo>;
  terminalInput: (id: string, ptyId: string, data: string) => Promise<void>;
  /** Speech to text with timestamps for a WAV in the Session's Workspace (`transcribe_media`). */
  transcribeMedia: (id: string, path: string, language: string | null) => Promise<TimedTranscription>;
  /** Panes the connected browsers show for this Session right now. */
  panesOpen: (id: string) => string[];
  /** Appends a transcript event and broadcasts it. */
  appendEvent: (id: string, body: SessionEventBody) => SessionEvent;
  broadcast: (msg: SessionBroadcast) => void;
  push: (msg: { title: string; body: string; tag: string; url: string }) => void;
  log: (msg: string) => void;
}

/** Tools every policy but `off` allows: self-knowledge and this Session. Anything else needs `all`. */
const SESSION_TOOLS: ReadonlySet<AgentTool> = new Set<AgentTool>([
  "whoami",
  "docs",
  "settings_get",
  "pr_attach",
  "pr_list",
  "pr_items",
  "pr_mark_addressed",
  "pr_review_submit",
  "snapshot",
  "queue_add",
  "queue_list",
  "title_set",
  "verify",
  "notify",
  "terminal_list",
  "terminal_read",
  "transcribe_media",
  "ui_open",
  "e2e_plan",
  "e2e_case_start",
  "e2e_case_end",
  "e2e_finish",
  "session_fork",
  "approval_wait",
  "schedule_create",
  "schedule_list",
  "automation_create",
  "automation_list",
  "automation_runs",
  "utilities_list",
  "utilities_get",
  "utilities_open",
  "utilities_add",
  "utilities_update",
  "utilities_enable",
  "procedure_save",
]);

/** An approval the user has not answered yet, with what runs when they allow it. */
interface PendingApproval {
  sessionId: string;
  approval: AgentApproval;
  run: () => Promise<{ sessionId: string | null; title: string }>;
  timer: NodeJS.Timeout;
  waiters: Set<() => void>;
}

/** `session_wait` / `approval_wait` return before the Daemon's bridge gives up on the request. */
const WAIT_MARGIN_MS = 2000;

/** Keys of `PublicSettings` the Agent never sees, whatever their value (nothing secret-shaped leaves the Control Plane). */
const SECRET_SHAPED = /secret|token|password|passwd|apikey|api_key|credential|auth|vapid|login|cookie|private|sshkey|identityfile/i;

const ITEM_BODY_MAX = 2000;
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 40;
/** How long `ui_open` waits for a new Terminal's shell to print its prompt before typing the command. */
const TERMINAL_PROMPT_TIMEOUT_MS = 8_000;

/**
 * The `sessionboxer` MCP's tools, answered for the Session whose Daemon asked (ADR-0062). The Session
 * id comes from the WebSocket the request arrived on, never from the request. Every tool checks the
 * policy in force; every action leaves an `agent_action` marker in the transcript.
 */
export class AgentTools {
  private readonly approvals = new Map<string, PendingApproval>();

  constructor(private readonly deps: AgentToolsDeps) {}

  /** Whether `method` is one of the MCP's tools (`_sessionboxer/agent/<tool>`). */
  static toolOf(method: string): AgentTool | null {
    return agentToolOf(method);
  }

  async handle(id: string, tool: AgentTool, args: unknown): Promise<unknown> {
    const policy = this.deps.policy(id);
    if (policy === "off") throw new Error("The sessionboxer tools are off for this Session (Settings → Agent tools).");
    if (!SESSION_TOOLS.has(tool) && policy !== "all") {
      throw new Error(`${tool} works on other Sessions; this Session's policy is "${policy}" (only this Session). The user can allow it in Settings → Agent tools → all Sessions.`);
    }
    switch (tool) {
      case "whoami":
        return this.whoami(id);
      case "settings_get":
        return this.settingsGet();
      case "pr_attach":
        return this.prAttach(id, AgentPrAttachArgs.parse(args));
      case "pr_list":
        return this.prs(id).map(summarizePr);
      case "pr_items":
        return this.prItems(id, AgentPrItemsArgs.parse(args));
      case "pr_mark_addressed":
        return this.prMarkAddressed(id, AgentPrMarkAddressedArgs.parse(args));
      case "snapshot":
        return this.snapshot(id);
      case "queue_add":
        return this.queueAdd(id, AgentQueueAddArgs.parse(args));
      case "queue_list":
        return this.deps.savedMessages(id).map((m) => ({ id: m.id, position: m.position, text: m.text, createdAt: m.createdAt }));
      case "title_set":
        return this.titleSet(id, AgentTitleSetArgs.parse(args));
      case "verify":
        return this.verify(id, AgentVerifyArgs.parse(args));
      case "notify":
        return this.notify(id, AgentNotifyArgs.parse(args));
      case "terminal_list":
        return (await this.deps.terminalList(id)).terminals.map((t) => ({ id: t.id, createdAt: t.createdAt, exitCode: t.exitCode }));
      case "terminal_read": {
        const p = AgentTerminalReadArgs.parse(args);
        return this.deps.terminalRead(id, p.id, p.lines);
      }
      case "transcribe_media": {
        const p = AgentTranscribeMediaArgs.parse(args);
        const t = await this.deps.transcribeMedia(id, p.path, p.language ?? null);
        return { language: t.language, seconds: t.seconds, model: t.model, text: t.text, segments: t.segments };
      }
      case "ui_open":
        return this.uiOpen(id, AgentUiOpenArgs.parse(args));
      case "utilities_list":
        return this.utilitiesList(id);
      case "utilities_get":
        return this.utilitiesGet(id, AgentUtilitiesGetArgs.parse(args));
      case "utilities_open":
        return this.utilitiesOpen(id, AgentUtilitiesOpenArgs.parse(args));
      case "utilities_add":
        return this.utilitiesAdd(id, AgentUtilitiesAddArgs.parse(args));
      case "utilities_update":
        return this.utilitiesUpdate(id, AgentUtilitiesUpdateArgs.parse(args));
      case "utilities_enable":
        return this.utilitiesEnable(id, AgentUtilitiesEnableArgs.parse(args));
      case "procedure_save":
        return this.procedureSave(id, AgentProcedureSaveArgs.parse(args));
      case "sessions_list":
        return this.deps.listSessions().map((s) => this.summarize(id, s));
      case "session_get": {
        const target = this.other(id, AgentSessionGetArgs.parse(args).id);
        return { ...this.summarize(id, target), lastReply: this.deps.lastReply(target.id), error: target.error };
      }
      case "session_create":
        return this.sessionCreate(id, AgentSessionCreateArgs.parse(args));
      case "session_fork":
        return this.sessionFork(id, AgentSessionForkArgs.parse(args));
      case "session_message":
        return this.sessionMessage(id, AgentSessionMessageArgs.parse(args));
      case "session_wait":
        return this.sessionWait(id, AgentSessionWaitArgs.parse(args));
      case "session_stop":
        return this.sessionStop(id, AgentSessionStopArgs.parse(args));
      case "approval_wait":
        return this.approvalWait(id, AgentApprovalWaitArgs.parse(args));
      case "schedule_create":
        return this.scheduleCreate(id, policy, AgentScheduleCreateArgs.parse(args));
      case "schedule_list":
        return this.automations()
          .listSchedules()
          .map((s) => ({
            id: s.id,
            name: s.name,
            cron: s.cron,
            timezone: s.timezone,
            enabled: s.enabled,
            action: s.action,
            nextRunAt: s.nextRunAt,
            lastRunAt: s.lastRunAt,
          }));
      case "automation_create":
        return this.automationCreate(id, policy, AgentAutomationCreateArgs.parse(args));
      case "pr_follow":
        return this.prFollow(id, AgentPrFollowArgs.parse(args));
      case "pr_review_submit": {
        const r = this.deps.reviews();
        if (!r) throw new Error("Automatic reviews are not available on this Control Plane.");
        const posted = await r.submit(id, AgentPrReviewSubmitArgs.parse(args));
        this.mark(id, tool, `review posted: ${posted.findings} finding${posted.findings === 1 ? "" : "s"}, ${posted.verdict.replace("_", " ")}${posted.url ? ` → ${posted.url}` : ""}`, "prs");
        return posted;
      }
      case "pr_followed_list": {
        const p = AgentFollowedPrListArgs.parse(args);
        return {
          follows: this.followedPrs().listFollows(),
          prs: this.followedPrs()
            .list(p)
            .map((pr) => ({
              id: pr.id,
              repo: `${pr.owner}/${pr.repo}`,
              number: pr.number,
              url: pr.url,
              title: pr.title,
              state: pr.state,
              author: pr.author,
              headRef: pr.headRef,
              headSha: pr.headSha,
              baseRef: pr.baseRef,
              isFork: pr.isFork,
              reviewDecision: pr.reviewDecision,
              checks: { failed: pr.checksFailed, pending: pr.checksPending, passed: pr.checksPassed },
              updatedAt: pr.remoteUpdatedAt,
              attachedTo: pr.attached.map((a) => a.sessionId),
              lastRuns: pr.runs.map((r) => ({ automationId: r.automationId, status: r.status, finishedAt: r.finishedAt })),
            })),
        };
      }
      case "automation_list":
        return this.automations()
          .list()
          .map((a) => ({
            id: a.id,
            name: a.name,
            enabled: a.enabled,
            trigger: a.trigger,
            action: a.action,
            limits: a.limits,
            nextRunAt: a.nextRunAt,
            lastRunAt: a.lastRunAt,
            lastStatus: a.lastStatus,
            runsToday: a.runsToday,
          }));
      case "automation_runs": {
        const p = AgentAutomationRunsArgs.parse(args);
        return this.automations()
          .listRuns(p.id)
          .slice(0, 50)
          .map((r) => ({
            id: r.id,
            trigger: r.trigger,
            status: r.status,
            event: r.event,
            prUrl: r.prUrl,
            sessionId: r.sessionId,
            queuedAt: r.queuedAt,
            finishedAt: r.finishedAt,
            detail: r.detail,
            error: r.error,
            result: r.result,
          }));
      }
      case "docs":
      case "e2e_plan":
      case "e2e_case_start":
      case "e2e_case_end":
      case "e2e_finish":
        // `docs` is answered in the Sandbox; the `e2e_*` tools travel as their own methods (`DAEMON_METHODS.e2e*`).
        throw new Error(`${tool} is not answered by the Control Plane`);
    }
  }

  private session(id: string): Session {
    const s = this.deps.getSession(id);
    if (!s) throw new Error(`session ${id} not found`);
    return s;
  }

  private mark(id: string, tool: AgentTool, text: string, pane?: string, sessionId?: string): void {
    this.deps.appendEvent(id, { type: "agent_action", tool, text, ...(pane ? { pane } : {}), ...(sessionId ? { sessionId } : {}) });
  }

  /** Another Session by id (a prefix of at least 6 characters does), or the caller itself. */
  private other(id: string, ref: string): Session {
    const exact = this.deps.getSession(ref);
    if (exact) return exact;
    const hits = ref.length >= 6 ? this.deps.listSessions().filter((s) => s.id.startsWith(ref)) : [];
    if (hits.length === 1) return hits[0]!;
    if (ref === "self" || ref === "me") return this.session(id);
    throw new Error(`No Session ${ref}; sessions_list shows the ids.`);
  }

  private summarize(selfId: string, s: Session): AgentSessionSummary {
    const parent = s.createdBy ? this.deps.getSession(s.createdBy.sessionId) : null;
    return AgentSessionSummary.parse({
      id: s.id,
      title: s.title,
      url: `${PUBLIC_URL}${sessionRoute(s.id)}`,
      status: s.status,
      provider: s.provider,
      environment: s.settings.sandbox.environment,
      repos: s.repos.map((r) => r.name),
      createdAt: s.createdAt,
      createdBy: s.createdBy ? { sessionId: s.createdBy.sessionId, title: parent?.title ?? s.createdBy.sessionId } : null,
      forkedFrom: this.forkOriginOf(s),
      self: s.id === selfId,
      mine: s.createdBy?.sessionId === selfId,
      queueLength: this.deps.savedMessages(s.id).length,
    });
  }

  private forkOriginOf(s: Session): { sessionId: string; title: string } | null {
    for (const ev of this.deps.db.listEvents(s.id)) {
      if (ev.body.type === "forked") return { sessionId: ev.body.fromSessionId, title: ev.body.fromTitle };
      if (ev.body.type === "user_prompt") break;
    }
    return null;
  }

  private followedPrs(): AgentFollowedPrs {
    const f = this.deps.followedPrs();
    if (!f) throw new Error("Followed pull requests are not available on this Control Plane.");
    return f;
  }

  private prFollow(id: string, p: AgentPrFollowArgs): unknown {
    const provider = p.provider ?? (p.repo && /bitbucket|\/scm\/|\/projects\//i.test(p.repo) && !/github\.com/i.test(p.repo) ? "bitbucket" : "github");
    const follow = this.followedPrs().follow(
      { provider, kind: p.kind, ...(p.repo ? { repo: p.repo } : {}), ...(p.account ? { account: p.account } : {}), ...(p.host ? { host: p.host } : {}) },
      null,
    );
    const what = follow.kind === "repo" ? `${follow.owner}/${follow.repo}` : follow.kind === "mine" ? `PRs opened by @${follow.account}` : `reviews requested from @${follow.account}`;
    this.mark(id, "pr_follow", `followed ${what}`, "prs");
    return follow;
  }

  private automations(): AgentAutomations {
    const s = this.deps.automations();
    if (!s) throw new Error("Automations are not available yet.");
    return s;
  }

  // --- Sessions (Stage 2, ADR-0062) -------------------------------------------

  private async sessionCreate(id: string, p: AgentSessionCreateArgs): Promise<unknown> {
    const self = this.session(id);
    this.deps.assertChildAllowed(id);
    const title = p.title?.trim() || excerpt(p.first_prompt, 80);
    const req: CreateSessionRequest = {
      title,
      provider: p.provider ?? self.provider,
      repos: p.repos,
      workspaceSource: { type: "empty" },
      settings: {},
      prompt: p.first_prompt,
    };
    const run = async () => {
      const child = await this.deps.createSession(id, req);
      this.mark(id, "session_create", `created Session “${child.title}”`, undefined, child.id);
      return { sessionId: child.id, title: child.title };
    };
    if (resolveSessionSettings(self.settings, this.deps.settings()).approveCreate) {
      return this.requestApproval(id, "session_create", `create a Session “${title}”`, run);
    }
    const created = await run();
    return { pending: false, ...created, url: `${PUBLIC_URL}${sessionRoute(created.sessionId)}` };
  }

  private async sessionFork(id: string, p: AgentSessionForkArgs): Promise<unknown> {
    this.session(id);
    this.deps.assertChildAllowed(id);
    if (p.conversation === "handoff" && !p.document) throw new Error("session_fork with conversation: handoff needs the document you hand off (goal, state of the work, decisions, open items, files, how to run it).");
    const snap = await this.deps.snapshot(id);
    const req: ForkSessionRequest = {
      snapshotId: snap.id,
      conversation: p.conversation,
      ...(p.provider ? { provider: p.provider } : {}),
      ...(p.title ? { title: p.title.trim() } : {}),
      settings: {},
      ...(p.first_prompt ? { prompt: p.first_prompt } : {}),
      savedMessages: [],
      ...(p.document ? { document: p.document } : {}),
    };
    const fork = await this.deps.forkSession(id, req);
    this.mark(id, "session_fork", `forked this Session at Snapshot ${snap.ordinal} into “${fork.title}” (${p.conversation})`, undefined, fork.id);
    return { pending: false, sessionId: fork.id, title: fork.title, url: `${PUBLIC_URL}${sessionRoute(fork.id)}`, snapshotOrdinal: snap.ordinal };
  }

  private async sessionMessage(id: string, p: AgentSessionMessageArgs): Promise<unknown> {
    const target = this.other(id, p.id);
    const delivery = await this.deps.messageSession(id, target.id, p.text, p.when);
    this.mark(id, "session_message", `${delivery === "queued" ? "queued a message for" : "sent a message to"} “${target.title}”: ${excerpt(p.text)}`, undefined, target.id);
    return { sessionId: target.id, title: target.title, delivery };
  }

  private async sessionWait(id: string, p: AgentSessionWaitArgs): Promise<unknown> {
    const target = this.other(id, p.id);
    if (target.id === id) throw new Error("session_wait waits for another Session; this one is you.");
    const timeoutMs = Math.min(p.timeout_s * 1000, AGENT_BRIDGE_TIMEOUT_MS - WAIT_MARGIN_MS);
    const r = await this.deps.waitSession(target.id, timeoutMs);
    return { sessionId: target.id, title: target.title, still_running: r.stillRunning, status: r.status, lastReply: r.lastReply };
  }

  private async sessionStop(id: string, p: AgentSessionStopArgs): Promise<unknown> {
    const target = this.other(id, p.id);
    if (target.id === id) throw new Error("A Session does not stop itself; end your turn instead.");
    if (target.createdBy?.sessionId !== id) throw new Error(`“${target.title}” was not created by this Session's Agent; only the user stops it.`);
    const stopped = await this.deps.stopSession(target.id);
    this.mark(id, "session_stop", `stopped Session “${target.title}”`, undefined, target.id);
    return { sessionId: stopped.id, title: stopped.title, status: stopped.status };
  }

  // --- Approvals ---------------------------------------------------------------

  /**
   * Puts a card in the chat and answers `{ pending: true, id }`; `settleApproval` (the card's
   * buttons) runs the action, the timeout denies it. Every state is an `agent_approval` event.
   */
  private requestApproval(sessionId: string, kind: AgentApprovalKind, summary: string, run: PendingApproval["run"], details: AgentApproval["details"] = []): unknown {
    const id = randomBytes(6).toString("hex");
    const approval: AgentApproval = { id, kind, summary, status: "pending", expiresAt: new Date(Date.now() + AGENT_APPROVAL_TIMEOUT_MS).toISOString(), details, result: null, error: null };
    const timer = setTimeout(() => void this.finishApproval(id, "expired"), AGENT_APPROVAL_TIMEOUT_MS);
    this.approvals.set(id, { sessionId, approval, run, timer, waiters: new Set() });
    this.deps.appendEvent(sessionId, { type: "agent_approval", approval });
    const s = this.session(sessionId);
    this.deps.push({ title: s.title, body: `The Agent wants to ${summary} — allow or deny in the chat.`, tag: `sessionboxer-approval-${id}`, url: sessionRoute(sessionId) });
    return { pending: true, id, summary, expiresAt: approval.expiresAt, hint: "approval_wait(id) blocks until the user allows or denies (or your turn can end; the result is in the chat)." };
  }

  /** The user answered the card. Unknown ids are stale (the Control Plane restarted, or it was settled already). */
  async settleApproval(sessionId: string, approvalId: string, allow: boolean): Promise<AgentApproval> {
    const pending = this.approvals.get(approvalId);
    if (!pending || pending.sessionId !== sessionId) {
      const stored = this.storedApproval(sessionId, approvalId);
      if (!stored) throw new Error(`approval ${approvalId} not found`);
      if (stored.status !== "pending") return stored;
      const expired: AgentApproval = { ...stored, status: "expired" };
      this.deps.appendEvent(sessionId, { type: "agent_approval", approval: expired });
      return expired;
    }
    return this.finishApproval(approvalId, allow ? "allowed" : "denied");
  }

  private async finishApproval(id: string, status: "allowed" | "denied" | "expired"): Promise<AgentApproval> {
    const pending = this.approvals.get(id);
    if (!pending) throw new Error(`approval ${id} not found`);
    this.approvals.delete(id);
    clearTimeout(pending.timer);
    let approval: AgentApproval = { ...pending.approval, status };
    if (status === "allowed") {
      try {
        approval = { ...approval, result: await pending.run() };
      } catch (e) {
        approval = { ...approval, error: e instanceof Error ? e.message : String(e) };
      }
    }
    if (this.deps.getSession(pending.sessionId)) this.deps.appendEvent(pending.sessionId, { type: "agent_approval", approval });
    for (const w of pending.waiters) w();
    return approval;
  }

  /** The latest `agent_approval` event of `approvalId` in the Session's transcript. */
  private storedApproval(sessionId: string, approvalId: string): AgentApproval | null {
    const events = this.deps.db.listEvents(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const body = events[i]!.body;
      if (body.type === "agent_approval" && body.approval.id === approvalId) return body.approval;
    }
    return null;
  }

  private async approvalWait(id: string, p: AgentApprovalWaitArgs): Promise<unknown> {
    const pending = this.approvals.get(p.id);
    if (pending && pending.sessionId === id) {
      const timeoutMs = Math.min(p.timeout_s * 1000, AGENT_BRIDGE_TIMEOUT_MS - WAIT_MARGIN_MS);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          pending.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        pending.waiters.add(done);
      });
    }
    const stored = this.storedApproval(id, p.id);
    if (!stored) throw new Error(`No approval ${p.id} in this Session.`);
    return {
      id: stored.id,
      status: stored.status,
      pending: stored.status === "pending",
      ...(stored.result ? { ...(stored.result.sessionId ? { sessionId: stored.result.sessionId, url: `${PUBLIC_URL}${sessionRoute(stored.result.sessionId)}` } : {}), title: stored.result.title } : {}),
      ...(stored.error ? { error: stored.error } : {}),
    };
  }

  // --- Schedules -----------------------------------------------------------------

  private scheduleCreate(id: string, policy: AgentToolsPolicy, p: AgentScheduleCreateArgs): unknown {
    const self = this.session(id);
    const action: CreateScheduleRequest["action"] =
      p.action.type === "prompt"
        ? { type: "prompt", sessionId: p.action.sessionId ? this.other(id, p.action.sessionId).id : id, text: p.action.text }
        : { type: "new_session", title: p.action.title, provider: p.action.provider ?? self.provider, repos: p.action.repos, settings: {}, prompt: p.action.prompt, stopAfter: p.action.stopAfter };
    const otherSession = action.type === "new_session" || action.sessionId !== id;
    if (otherSession && policy !== "all") {
      throw new Error(`Scheduling ${action.type === "new_session" ? "new Sessions" : "prompts to other Sessions"} needs the "all Sessions" policy; this Session's is "${policy}" (schedule a prompt to yourself instead).`);
    }
    const schedule = this.automations().createSchedule({
      name: p.name,
      cron: p.cron,
      timezone: p.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      enabled: true,
      missedPolicy: "skip",
      action,
    });
    this.mark(id, "schedule_create", `scheduled “${schedule.name}” (${schedule.cron}${action.type === "prompt" && action.sessionId !== id ? `, prompts “${this.other(id, action.sessionId).title}”` : action.type === "new_session" ? ", a new Session each time" : ""})`, "schedules");
    return { id: schedule.id, name: schedule.name, cron: schedule.cron, timezone: schedule.timezone, nextRunAt: schedule.nextRunAt };
  }

  private automationCreate(id: string, policy: AgentToolsPolicy, p: AgentAutomationCreateArgs): unknown {
    const self = this.session(id);
    const a = p.action;
    const action: CreateAutomationRequest["action"] =
      a.type === "prompt"
        ? { type: "prompt", sessionId: a.sessionId === undefined ? id : a.sessionId === "attached" ? "attached" : this.other(id, a.sessionId).id, text: a.text }
        : a.type === "new_session"
          ? { ...a, provider: a.provider ?? self.provider }
          : a;
    const startsSessions = action.type === "new_session" || action.type === "auto_review" || action.type === "auto_qa" || (action.type === "prompt" && action.sessionId !== id);
    if (startsSessions && policy !== "all") {
      throw new Error(`An automation that ${action.type === "prompt" ? "prompts other Sessions" : "starts Sessions"} needs the "all Sessions" policy; this Session's is "${policy}" (a prompt to yourself, attach or notify do not).`);
    }
    const limits: AutomationLimits = { maxConcurrent: 2, maxRunsPerDay: 20, maxRunsPerPrPerDay: 4, debounceSeconds: 120, timeoutMinutes: 360, ...p.limits };
    const automation = this.automations().create({ name: p.name, enabled: p.enabled, trigger: p.trigger, action, limits });
    const trigger =
      automation.trigger.type === "schedule" ? automation.trigger.cron : automation.trigger.type === "pr_event" ? `on PR ${automation.trigger.events.join(", ")}` : "manual";
    this.mark(id, "automation_create", `created the automation “${automation.name}” (${trigger} → ${action.type.replace("_", " ")})`, "automations");
    return { id: automation.id, name: automation.name, enabled: automation.enabled, trigger: automation.trigger, action: automation.action, nextRunAt: automation.nextRunAt };
  }

  private async whoami(id: string): Promise<AgentWhoAmI> {
    const s = this.session(id);
    const info = this.deps.sessionInfo(id);
    const context = lastContext(this.deps.db.listEvents(id));
    const terminals = await this.deps.terminalList(id).then((r) => r.terminals, () => [] as PtyInfo[]);
    const run = this.deps.db.activeE2eRun(id) ?? this.deps.db.listE2eRuns(id)[0] ?? null;
    return AgentWhoAmI.parse({
      ...info,
      status: s.status,
      usage: s.usage,
      context,
      queueLength: this.deps.savedMessages(id).length,
      panes: this.deps.panesOpen(id),
      terminals: terminals.map((t) => ({ id: t.id, createdAt: t.createdAt, exitCode: t.exitCode })),
      prs: this.prs(id).map(summarizePr),
      verification: run ? { id: run.id, status: run.status, brief: run.brief } : null,
      repos: s.repos.map((r) => ({ name: r.name, path: repoDir(r) === "" ? "/workspace" : `/workspace/${repoDir(r)}` })),
    });
  }

  private async settingsGet(): Promise<unknown> {
    const load = this.deps.publicSettings();
    if (!load) throw new Error("Settings are not available yet.");
    return scrub(await load);
  }

  private prs(id: string): PullRequest[] {
    return this.deps.prs.list(id);
  }

  /** `#12`, `12`, a PR id, or a URL → the attached PR. */
  private resolvePr(id: string, ref: string): PullRequest {
    const list = this.prs(id);
    const trimmed = ref.trim();
    const byId = list.find((p) => p.id === trimmed);
    if (byId) return byId;
    const n = /^#?(\d+)$/.exec(trimmed);
    if (n) {
      const number = Number(n[1]);
      const hits = list.filter((p) => p.number === number);
      if (hits.length === 1) return hits[0]!;
      if (hits.length > 1) throw new Error(`Several attached PRs are number ${number} (${hits.map((p) => `${p.owner}/${p.repo}`).join(", ")}); give the id or the URL.`);
    }
    const byUrl = list.find((p) => p.url === trimmed || `${p.owner}/${p.repo}#${p.number}` === trimmed);
    if (byUrl) return byUrl;
    throw new Error(`No attached PR matches ${ref}; pr_list shows the attached ones, pr_attach adds one.`);
  }

  private async prAttach(id: string, p: { ref: string }): Promise<unknown> {
    const pr = await this.deps.prs.attach(id, p.ref, "agent");
    this.mark(id, "pr_attach", `attached PR #${pr.number} (${pr.owner}/${pr.repo})`, `pr:${pr.id}`);
    return summarizePr(pr);
  }

  private prItems(id: string, p: { pr: string }): unknown {
    const pr = this.resolvePr(id, p.pr);
    const items = this.deps.prs.items(id, pr.id).map((i) => ({
      id: i.id,
      kind: i.kind,
      author: i.author,
      self: i.self,
      body: i.body.length > ITEM_BODY_MAX ? `${i.body.slice(0, ITEM_BODY_MAX)}…` : i.body,
      path: i.path,
      line: i.line,
      resolved: i.resolved,
      outdated: i.outdated,
      reviewState: i.reviewState,
      createdAt: i.createdAt,
      address: i.address,
      url: i.htmlUrl,
    }));
    const checks = this.deps.prs.checks(id, pr.id).map((c) => ({ id: c.id, name: c.name, state: c.state, url: c.url, address: c.address }));
    return { pr: summarizePr(pr), items, checks };
  }

  private prMarkAddressed(id: string, p: { pr: string; items: string[] }): unknown {
    const pr = this.resolvePr(id, p.pr);
    const result = this.deps.prs.markAddressed(id, pr.id, p.items);
    const n = result.items + result.checks;
    if (n > 0) this.mark(id, "pr_mark_addressed", `marked ${n} item${n === 1 ? "" : "s"} of PR #${pr.number} addressed`, `pr:${pr.id}`);
    return result;
  }

  private async snapshot(id: string): Promise<unknown> {
    const snap = await this.deps.snapshot(id);
    this.mark(id, "snapshot", `took Snapshot ${snap.ordinal}`);
    return { id: snap.id, ordinal: snap.ordinal, sizeBytes: snap.sizeBytes, createdAt: snap.createdAt };
  }

  private async queueAdd(id: string, p: { text: string }): Promise<unknown> {
    const m = await this.deps.enqueue(id, p.text);
    this.mark(id, "queue_add", `queued a message (${excerpt(p.text)})`);
    return { id: m.id, position: m.position };
  }

  private titleSet(id: string, p: { title: string }): unknown {
    const title = p.title.trim();
    const s = this.session(id);
    if (title === s.title) return { title };
    this.deps.setTitle(id, title);
    this.mark(id, "title_set", `renamed the Session to “${title}”`);
    return { title };
  }

  private verify(id: string, p: { brief: string; cases?: Array<{ title: string; steps: string; expected: string }> }): unknown {
    this.session(id);
    const run = this.deps.e2e.openByAgent(id, this.deps.db.lastEventSeq(id), p.brief, p.cases);
    this.mark(id, "verify", `opened verification run ${run.id}: ${excerpt(p.brief)}`, "e2e");
    return { id: run.id, status: run.status, cases: run.cases.map((c) => ({ index: c.index, title: c.title, status: c.status })) };
  }

  private notify(id: string, p: { text: string }): unknown {
    const s = this.session(id);
    this.deps.push({ title: s.title, body: p.text, tag: `sessionboxer-agent-${id}`, url: sessionRoute(id) });
    this.mark(id, "notify", `notified you: ${excerpt(p.text)}`);
    return { ok: true };
  }

  /**
   * A shell that gets its first line before it has drawn its prompt garbles it (PowerShell over ssh in a
   * Windows VM answers with a `>>` continuation prompt); type only once it has written something.
   */
  private async waitForPrompt(id: string, ptyId: string): Promise<void> {
    const deadline = Date.now() + TERMINAL_PROMPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const read = await this.deps.terminalRead(id, ptyId, 5);
      if (read.text.trim() !== "" || read.exitCode !== null) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // --- Utilities (ADR-0073) -------------------------------------------------------------------

  /** The catalogue as the Agent sees it: no credential values, which are on for this Session, the presets. */
  private utilitiesList(id: string): unknown {
    const s = this.session(id);
    const settings = this.deps.settings();
    const enabled = new Set(s.settings.utilitiesEnabled);
    const resolved = resolveUtilities(settings, s.settings.utilitiesEnabled, []);
    const production = new Set(settings.utilityEnvironments.filter((e) => e.production).map((e) => e.name));
    return {
      environments: settings.utilityEnvironments.map((e) => ({ name: e.name, production: e.production })),
      groups: UTILITY_GROUPS.map((g) => ({ name: g, label: UTILITY_GROUP_LABELS[g] })),
      utilities: settings.utilities.map((u) => ({
        name: u.name,
        label: utilityLabel(u),
        group: u.group,
        environment: u.environment,
        production: production.has(u.environment),
        readOnly: u.readOnly,
        enabled: enabled.has(u.id),
        preset: u.preset,
        facets: facetsOf(u),
        credentials: u.credentials.filter((c) => c.value !== "").map((c) => c.name),
        mcp: resolved.specs.find((r) => r.name === u.name && r.environment === u.environment)?.mcp ?? null,
        notes: excerpt(u.notes, 200),
      })),
      presets: Object.entries(UTILITY_PRESETS).map(([name, p]) => ({ name, label: p.label, group: p.group, credentials: p.credentials, url: p.urlHint })),
      manifest: ".sessionboxer/utilities.json",
      hint: "utilities_get gives one in full (notes, facets, MCP server name); utilities_enable switches them on for this Session; utilities_add registers a new one (the user allows it in the chat).",
    };
  }

  /** One Utility by `name` (and Environment when the name is in several); every facet, credential names only. */
  private utility(id: string, name: string, environment?: string): UtilityDef {
    const settings = this.deps.settings();
    const ref = name.trim();
    const [n, envInName] = ref.includes("@") ? (ref.split("@", 2) as [string, string]) : [ref, undefined];
    const env = environment?.trim() || envInName;
    const hits = settings.utilities.filter((u) => u.name === n && (env === undefined || u.environment === env));
    if (hits.length === 1) return hits[0]!;
    if (hits.length === 0) throw new Error(`No Utility "${ref}"${env ? ` in ${env}` : ""}; utilities_list shows them.`);
    // Several Environments: the ones on for this Session first, then it is ambiguous.
    const on = new Set(this.session(id).settings.utilitiesEnabled);
    const enabled = hits.filter((u) => on.has(u.id));
    if (enabled.length === 1) return enabled[0]!;
    throw new Error(`"${n}" exists in ${hits.map((u) => u.environment).join(", ")}; pass environment (or name@environment).`);
  }

  private utilitiesGet(id: string, p: AgentUtilitiesGetArgs): unknown {
    const s = this.session(id);
    const u = this.utility(id, p.name, p.environment);
    const settings = this.deps.settings();
    const resolved = resolveUtilities(settings, s.settings.utilitiesEnabled, []);
    const pub = toPublicUtility(u);
    const names = (list: PublicMcpKeyValue[]) => list.map((kv) => ({ name: kv.name, set: kv.value === null || kv.value !== "", secret: kv.secret }));
    return {
      name: u.name,
      label: utilityLabel(u),
      group: u.group,
      environment: u.environment,
      production: settings.utilityEnvironments.find((e) => e.name === u.environment)?.production ?? false,
      readOnly: u.readOnly,
      enabled: s.settings.utilitiesEnabled.includes(u.id),
      preset: u.preset,
      notes: u.notes,
      credentials: names(pub.credentials),
      otp: u.credentials.some((c) => c.name === "totp" && c.value !== ""),
      mcp: pub.mcp ? { ...pub.mcp, env: names(pub.mcp.env), headers: names(pub.mcp.headers), server: resolved.specs.find((r) => r.name === u.name && r.environment === u.environment)?.mcp ?? null } : null,
      web: u.web,
      http: pub.http ? { baseUrl: pub.http.baseUrl, headers: names(pub.http.headers) } : null,
      ssh: u.ssh,
      cli: pub.cli ? { install: pub.cli.install, env: names(pub.cli.env) } : null,
      usage: [
        "Credentials: `${util:" + u.name + ".<credential>}` in the desktop `type` tool; `sb-util env " + u.name + " -- <cmd>` puts them in the environment (UTIL_<NAME>).",
        ...(u.http ? [`HTTP: sb-util curl ${u.name} <path> [curl args]`] : []),
        ...(u.ssh ? [`SSH: sb-util ssh ${u.name} [cmd]; sb-util tunnel ${u.name} <local>:<host>:<port>`] : []),
        ...(u.web ? [`Web: sb-util open ${u.name} (or utilities_open) shows it in the Desktop; log in with the placeholders.`] : []),
      ],
    };
  }

  /** Opens the web facet in the Sandbox's browser (a Terminal runs `sb-util open`) and shows the user the Desktop. */
  private async utilitiesOpen(id: string, p: AgentUtilitiesOpenArgs): Promise<unknown> {
    const s = this.session(id);
    const u = this.utility(id, p.name, p.environment);
    if (!s.settings.utilitiesEnabled.includes(u.id)) throw new Error(`"${u.name}" is not on for this Session; utilities_enable first.`);
    if (!u.web || u.web.url === "") throw new Error(`"${u.name}" has no web facet.`);
    const path = p.path?.trim() ?? "";
    const pty = await this.deps.terminalOpen(id, TERMINAL_COLS, TERMINAL_ROWS);
    await this.waitForPrompt(id, pty.id);
    await this.deps.terminalInput(id, pty.id, `sb-util open ${u.name}@${u.environment}${path ? ` ${shellQuote(path)}` : ""} && exit\r`);
    this.deps.broadcast({ type: "ui_hint", hint: { sessionId: id, pane: "desktop", terminalId: null } });
    this.mark(id, "utilities_open", `opened ${utilityLabel(u)} (${u.environment}) in the browser`, "desktop");
    return { url: u.web.url, login: u.web.login, hint: "The page is in the Desktop; take a screenshot. Sign in by typing `${util:" + u.name + ".user}` / `${util:" + u.name + ".password}` (and `.otp`) with the desktop `type` tool." };
  }

  /** Registers a Utility once the user allows the card; the credentials never reach the transcript (the card shows names and masks). */
  private utilitiesAdd(id: string, p: AgentUtilitiesAddArgs): unknown {
    const s = this.session(id);
    const settings = this.deps.settings();
    const preset = p.preset ? UTILITY_PRESETS[p.preset] : undefined;
    if (p.preset && !preset) throw new Error(`No preset "${p.preset}"; utilities_list names them.`);
    const environment = p.environment?.trim() || settings.utilityEnvironments.find((e) => !e.production)?.name || settings.utilityEnvironments[0]?.name;
    if (!environment) throw new Error("No Environment exists; the user adds them in Settings → Utilities.");
    if (!settings.utilityEnvironments.some((e) => e.name === environment)) throw new Error(`No Environment "${environment}"; the ones there are: ${settings.utilityEnvironments.map((e) => e.name).join(", ")}.`);
    if (settings.utilities.some((u) => u.name === p.name && u.environment === environment)) throw new Error(`"${p.name}" already exists in ${environment}; utilities_update changes it.`);
    const url = p.web?.url?.trim() ?? p.http?.baseUrl?.trim() ?? "";
    const fromPreset = preset ? applyUtilityPreset(preset, url) : { web: null, http: null, cli: null, mcp: null };
    const secretNames = new Set(["password", "pass", "token", "totp", "secret", "ssh_key", "key", "uri", "api_key", "apikey"]);
    const creds: McpKeyValue[] = p.credentials.map((c) => ({ name: c.name, value: c.value, secret: secretNames.has(c.name.toLowerCase()) || /pass|secret|token|key/i.test(c.name) }));
    const kv = (list: Array<{ name: string; value: string }>): McpKeyValue[] => list.map((c) => ({ name: c.name, value: c.value, secret: /pass|secret|token|key|auth/i.test(c.name) }));
    const def: UtilityDef = {
      id: randomBytes(6).toString("hex"),
      name: p.name,
      label: p.label?.trim() || preset?.label || "",
      group: p.group ?? preset?.group ?? "observability",
      environment,
      preset: p.preset ?? null,
      credentials: creds,
      readOnly: p.readOnly ?? true,
      notes: p.notes?.trim() || preset?.notes || "",
      enabledByDefault: true,
      web: p.web ? { url: p.web.url?.trim() ?? fromPreset.web?.url ?? "", login: p.web.login ?? fromPreset.web?.login ?? "form" } : fromPreset.web,
      http: p.http ? { baseUrl: p.http.baseUrl.trim(), headers: kv(p.http.headers) } : fromPreset.http,
      ssh: p.ssh ? { host: p.ssh.host ?? "", port: p.ssh.port ?? 22, user: p.ssh.user ?? "", jump: p.ssh.jump ?? "" } : null,
      cli: p.cli ? { install: p.cli.install, env: kv(p.cli.env) } : fromPreset.cli,
      mcp: p.mcp
        ? { transport: p.mcp.transport ?? "stdio", command: p.mcp.command ?? "", args: p.mcp.args ?? [], env: p.mcp.env ?? [], url: p.mcp.url ?? "", headers: p.mcp.headers ?? [] }
        : fromPreset.mcp,
    };
    const details = utilityDetails(def, settings.utilityEnvironments.find((e) => e.name === environment)?.production ?? false);
    const run = async () => {
      const current = this.deps.settings();
      await this.deps.applySettings({ utilities: [...current.utilities.map(toPublicUtility), publicWithValues(def)] });
      if (p.enable) await this.deps.setUtilitiesEnabled(id, [...this.session(id).settings.utilitiesEnabled, def.id]);
      this.mark(id, "utilities_add", `registered the Utility ${utilityLabel(def)} (${environment})${p.enable ? " and switched it on" : ""}`);
      return { sessionId: null, title: `${utilityLabel(def)} (${environment})` };
    };
    return this.requestApproval(id, "utility_add", `register the Utility “${utilityLabel(def)}” in ${environment}${p.enable ? " and use it in this Session" : ""}`, run, details);
  }

  /** Changes a Utility once the user allows the card; credentials given replace the stored ones of the same name. */
  private utilitiesUpdate(id: string, p: AgentUtilitiesUpdateArgs): unknown {
    this.session(id);
    const settings = this.deps.settings();
    const before = this.utility(id, p.name, p.environment);
    const kv = (list: Array<{ name: string; value: string }> | undefined, prev: McpKeyValue[]): McpKeyValue[] =>
      list === undefined ? prev : list.map((c) => ({ name: c.name, value: c.value, secret: prev.find((x) => x.name === c.name)?.secret ?? /pass|secret|token|key|auth/i.test(c.name) }));
    const creds = [...before.credentials.filter((c) => !p.credentials.some((n) => n.name === c.name)), ...p.credentials.map((c) => ({ name: c.name, value: c.value, secret: before.credentials.find((x) => x.name === c.name)?.secret ?? /pass|secret|token|key|uri/i.test(c.name) }))];
    const preset = p.preset ? UTILITY_PRESETS[p.preset] : undefined;
    if (p.preset && !preset) throw new Error(`No preset "${p.preset}"; utilities_list names them.`);
    const def: UtilityDef = {
      ...before,
      ...(p.label !== undefined ? { label: p.label.trim() } : {}),
      ...(p.group !== undefined ? { group: p.group } : {}),
      ...(p.preset !== undefined ? { preset: p.preset } : {}),
      ...(p.readOnly !== undefined ? { readOnly: p.readOnly } : {}),
      ...(p.notes !== undefined ? { notes: p.notes.trim() } : {}),
      credentials: creds,
      web: p.web ? { url: p.web.url?.trim() ?? before.web?.url ?? "", login: p.web.login ?? before.web?.login ?? "form" } : before.web,
      http: p.http ? { baseUrl: p.http.baseUrl.trim(), headers: kv(p.http.headers, before.http?.headers ?? []) } : before.http,
      ssh: p.ssh ? { host: p.ssh.host ?? before.ssh?.host ?? "", port: p.ssh.port ?? before.ssh?.port ?? 22, user: p.ssh.user ?? before.ssh?.user ?? "", jump: p.ssh.jump ?? before.ssh?.jump ?? "" } : before.ssh,
      cli: p.cli ? { install: p.cli.install, env: kv(p.cli.env, before.cli?.env ?? []) } : before.cli,
      mcp: p.mcp
        ? {
            transport: p.mcp.transport ?? before.mcp?.transport ?? "stdio",
            command: p.mcp.command ?? before.mcp?.command ?? "",
            args: p.mcp.args ?? before.mcp?.args ?? [],
            env: p.mcp.env ?? before.mcp?.env ?? [],
            url: p.mcp.url ?? before.mcp?.url ?? "",
            headers: p.mcp.headers ?? before.mcp?.headers ?? [],
          }
        : before.mcp,
    };
    const details = utilityDetails(def, settings.utilityEnvironments.find((e) => e.name === def.environment)?.production ?? false, new Set(p.credentials.map((c) => c.name)));
    const run = async () => {
      const current = this.deps.settings();
      if (!current.utilities.some((u) => u.id === def.id)) throw new Error(`"${before.name}" was deleted meanwhile.`);
      await this.deps.applySettings({ utilities: current.utilities.map((u) => (u.id === def.id ? publicWithValues(def) : toPublicUtility(u))) });
      this.mark(id, "utilities_update", `changed the Utility ${utilityLabel(def)} (${def.environment})`);
      return { sessionId: null, title: `${utilityLabel(def)} (${def.environment})` };
    };
    return this.requestApproval(id, "utility_update", `change the Utility “${utilityLabel(def)}” in ${def.environment}`, run, details);
  }

  /** Switches Utilities on or off for this Session: by name (`name`, `name@env`), an Environment or a group switches all of it. Switching on asks the user. */
  private async utilitiesEnable(id: string, p: AgentUtilitiesEnableArgs): Promise<unknown> {
    const s = this.session(id);
    const settings = this.deps.settings();
    const targets = new Set<string>();
    for (const raw of p.names) {
      const ref = raw.trim();
      if (settings.utilityEnvironments.some((e) => e.name === ref)) {
        settings.utilities.filter((u) => u.environment === ref).forEach((u) => targets.add(u.id));
        continue;
      }
      if ((UTILITY_GROUPS as readonly string[]).includes(ref)) {
        settings.utilities.filter((u) => u.group === ref).forEach((u) => targets.add(u.id));
        continue;
      }
      const [n, env] = ref.includes("@") ? (ref.split("@", 2) as [string, string]) : [ref, undefined];
      const hits = settings.utilities.filter((u) => u.name === n && (env === undefined || u.environment === env));
      if (hits.length === 0) throw new Error(`No Utility, Environment or group "${ref}"; utilities_list shows them.`);
      hits.forEach((u) => targets.add(u.id));
    }
    const current = new Set(s.settings.utilitiesEnabled);
    const next = p.enabled ? [...new Set([...current, ...targets])] : [...current].filter((x) => !targets.has(x));
    const changed = settings.utilities.filter((u) => targets.has(u.id) && current.has(u.id) !== p.enabled);
    if (changed.length === 0) return { changed: [], enabled: this.enabledNames(id) };
    const list = changed.map((u) => `${utilityLabel(u)} (${u.environment})`).join(", ");
    if (!p.enabled) {
      await this.deps.setUtilitiesEnabled(id, next);
      this.mark(id, "utilities_enable", `switched off ${list}`);
      return { changed: changed.map((u) => `${u.name}@${u.environment}`), enabled: this.enabledNames(id) };
    }
    const production = new Set(settings.utilityEnvironments.filter((e) => e.production).map((e) => e.name));
    const run = async () => {
      await this.deps.setUtilitiesEnabled(id, next);
      this.mark(id, "utilities_enable", `switched on ${list}`);
      return { sessionId: null, title: list };
    };
    return this.requestApproval(
      id,
      "utility_enable",
      `use ${list} in this Session${changed.some((u) => production.has(u.environment)) ? " (production)" : ""}`,
      run,
      changed.map((u) => ({ name: `${u.name}@${u.environment}`, value: `${UTILITY_GROUP_LABELS[u.group]}${u.readOnly ? " · read-only" : ""}${production.has(u.environment) ? " · production" : ""}`, secret: false })),
    );
  }

  private enabledNames(id: string): string[] {
    const on = new Set(this.session(id).settings.utilitiesEnabled);
    return this.deps.settings().utilities.filter((u) => on.has(u.id)).map((u) => `${u.name}@${u.environment}`);
  }

  /** Proposes a procedure (a skill about investigating something with the Utilities); stored once the user allows it, a skill in every Session it applies to. */
  private procedureSave(id: string, p: AgentProcedureSaveArgs): unknown {
    this.session(id);
    const settings = this.deps.settings();
    const existing = settings.procedures.find((x) => x.name === p.name);
    const def: ProcedureDef = { id: existing?.id ?? randomBytes(6).toString("hex"), name: p.name, description: p.description.trim(), body: p.body.trim(), utilities: p.utilities, environments: p.environments, source: "agent", enabled: true };
    const details = [
      { name: "name", value: def.name, secret: false },
      { name: "description", value: def.description, secret: false },
      ...(def.utilities.length > 0 ? [{ name: "utilities", value: def.utilities.join(", "), secret: false }] : []),
      ...(def.environments.length > 0 ? [{ name: "environments", value: def.environments.join(", "), secret: false }] : []),
      { name: "body", value: def.body, secret: false },
    ];
    const run = async () => {
      const current = this.deps.settings();
      const others = current.procedures.filter((x) => x.name !== def.name);
      await this.deps.applySettings({ procedures: [...others, def] });
      this.mark(id, "procedure_save", `${existing ? "updated" : "saved"} the procedure ${def.name}`);
      return { sessionId: null, title: def.name };
    };
    return this.requestApproval(id, "procedure_save", `${existing ? "update" : "save"} the procedure “${def.name}” (${excerpt(def.description, 80)})`, run, details);
  }

  private async uiOpen(id: string, p: { pane: UiHint["pane"]; terminal?: { command: string } }): Promise<unknown> {
    let terminalId: string | null = null;
    if (p.pane === "terminal" && p.terminal) {
      const pty = await this.deps.terminalOpen(id, TERMINAL_COLS, TERMINAL_ROWS);
      terminalId = pty.id;
      await this.waitForPrompt(id, pty.id);
      await this.deps.terminalInput(id, pty.id, `${p.terminal.command}\r`);
    }
    this.deps.broadcast({ type: "ui_hint", hint: { sessionId: id, pane: p.pane, terminalId } });
    this.mark(id, "ui_open", terminalId ? `opened a Terminal running ${excerpt(p.terminal!.command, 80)}` : `opened the ${p.pane} pane`, p.pane);
    return { pane: p.pane, terminalId, shown: this.deps.panesOpen(id).length > 0 };
  }
}

function summarizePr(p: PullRequest): AgentWhoAmI["prs"][number] & { url: string; number: number; owner: string; repo: string; headRef: string } {
  return {
    id: p.id,
    ref: `${p.owner}/${p.repo}#${p.number}`,
    number: p.number,
    owner: p.owner,
    repo: p.repo,
    url: p.url,
    title: p.title,
    state: p.state,
    headRef: p.headRef,
    checks: p.checksFailed + p.checksPending + p.checksPassed,
    comments: p.openThreads,
    unseen: p.unread,
  };
}

function lastContext(events: SessionEvent[]): AgentWhoAmI["context"] {
  for (let i = events.length - 1; i >= 0; i--) {
    const body = events[i]!.body;
    if (body.type !== "context_breakdown") continue;
    const b: ContextBreakdown = body.breakdown;
    if (b.totalTokens === null || b.maxTokens === null) return null;
    return { usedTokens: Math.max(0, Math.round(b.totalTokens)), maxTokens: Math.max(0, Math.round(b.maxTokens)), percent: b.percent ?? (b.maxTokens > 0 ? (100 * b.totalTokens) / b.maxTokens : 0) };
  }
  return null;
}

function excerpt(text: string, max = 60): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Drops every secret-shaped key, at any depth. */
export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_SHAPED.test(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

/** The facets a Utility has, by name. */
function facetsOf(u: UtilityDef): string[] {
  return [
    ...(u.mcp ? ["mcp"] : []),
    ...(u.web && u.web.url !== "" ? ["web"] : []),
    ...(u.http && u.http.baseUrl !== "" ? ["http"] : []),
    ...(u.ssh && u.ssh.host !== "" ? ["ssh"] : []),
    ...(u.cli ? ["cli"] : []),
  ];
}

const MASK = "••••••••";

/** The approval card's form for a Utility: every field the Agent proposes, secret values masked. */
function utilityDetails(u: UtilityDef, production: boolean, changedCredentials?: Set<string>): AgentApproval["details"] {
  const out: AgentApproval["details"] = [
    { name: "name", value: u.name, secret: false },
    ...(u.label ? [{ name: "label", value: u.label, secret: false }] : []),
    { name: "group", value: UTILITY_GROUP_LABELS[u.group], secret: false },
    { name: "environment", value: `${u.environment}${production ? " (production)" : ""}`, secret: false },
    ...(u.preset ? [{ name: "preset", value: u.preset, secret: false }] : []),
    { name: "access", value: u.readOnly ? "read-only" : "read and write", secret: false },
  ];
  for (const c of u.credentials) {
    if (changedCredentials && !changedCredentials.has(c.name)) continue;
    out.push({ name: `credential ${c.name}`, value: c.secret ? MASK : c.value, secret: c.secret });
  }
  if (u.web && u.web.url) out.push({ name: "web", value: `${u.web.url} (${u.web.login} login)`, secret: false });
  if (u.http && u.http.baseUrl) out.push({ name: "http", value: `${u.http.baseUrl}${u.http.headers.length > 0 ? ` · headers ${u.http.headers.map((h) => h.name).join(", ")}` : ""}`, secret: false });
  if (u.ssh && u.ssh.host) out.push({ name: "ssh", value: `${u.ssh.user ? `${u.ssh.user}@` : ""}${u.ssh.host}:${u.ssh.port}${u.ssh.jump ? ` via ${u.ssh.jump}` : ""}`, secret: false });
  if (u.cli) out.push({ name: "cli", value: `${u.cli.install || "(no install step)"}${u.cli.env.length > 0 ? ` · env ${u.cli.env.map((h) => h.name).join(", ")}` : ""}`, secret: false });
  if (u.mcp) out.push({ name: "mcp", value: u.mcp.transport === "stdio" ? `${u.mcp.command} ${u.mcp.args.join(" ")}`.trim() : `${u.mcp.transport} ${u.mcp.url}`, secret: false });
  if (u.notes) out.push({ name: "notes", value: excerpt(u.notes, 300), secret: false });
  return out;
}

/** A definition as the Settings update takes it, with the values to store (the merge keeps `null`s, stores strings). */
function publicWithValues(u: UtilityDef): PublicUtilityDef {
  return u;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
