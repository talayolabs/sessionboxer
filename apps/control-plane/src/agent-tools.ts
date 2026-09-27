import { randomBytes } from "node:crypto";
import {
  AGENT_APPROVAL_TIMEOUT_MS,
  AGENT_BRIDGE_TIMEOUT_MS,
  AgentApprovalWaitArgs,
  AgentNotifyArgs,
  AgentPrAttachArgs,
  AgentPrItemsArgs,
  AgentPrMarkAddressedArgs,
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
  type CreateScheduleRequest,
  type CreateSessionRequest,
  type ForkSessionRequest,
  type PtyInfo,
  type PtyListResult,
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
} from "@sessionboxer/protocol";
import { PUBLIC_URL } from "./config.js";
import type { Db } from "./db.js";
import type { E2eVerification } from "./e2e.js";
import type { PullRequests } from "./pull-requests.js";

/** The part of the `Scheduler` the Agent's `schedule_*` tools use. */
export interface AgentScheduler {
  list(): Schedule[];
  create(req: CreateScheduleRequest): Schedule;
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
  /** `null` until the server wires the Scheduler. */
  scheduler: () => AgentScheduler | null;
  /** The `SessionInfo` the Daemon writes to `session.json`, as of now. */
  sessionInfo: (id: string) => SessionInfo;
  /** The policy in force (`Settings.agentTools` with the Session's override). */
  policy: (id: string) => AgentToolsPolicy;
  /** Global Settings as the UI sees them (no secrets); `null` until the Control Plane wires it. */
  publicSettings: () => Promise<PublicSettings> | null;
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
  "snapshot",
  "queue_add",
  "queue_list",
  "title_set",
  "verify",
  "notify",
  "terminal_list",
  "terminal_read",
  "ui_open",
  "e2e_plan",
  "e2e_case_start",
  "e2e_case_end",
  "e2e_finish",
  "session_fork",
  "approval_wait",
  "schedule_create",
  "schedule_list",
]);

/** An approval the user has not answered yet, with what runs when they allow it. */
interface PendingApproval {
  sessionId: string;
  approval: AgentApproval;
  run: () => Promise<{ sessionId: string; title: string }>;
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
      case "ui_open":
        return this.uiOpen(id, AgentUiOpenArgs.parse(args));
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
        return this.scheduler()
          .list()
          .map((s) => ({ id: s.id, name: s.name, cron: s.cron, timezone: s.timezone, enabled: s.enabled, action: s.action, nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt }));
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

  private scheduler(): AgentScheduler {
    const s = this.deps.scheduler();
    if (!s) throw new Error("Schedules are not available yet.");
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
  private requestApproval(sessionId: string, kind: AgentApprovalKind, summary: string, run: PendingApproval["run"]): unknown {
    const id = randomBytes(6).toString("hex");
    const approval: AgentApproval = { id, kind, summary, status: "pending", expiresAt: new Date(Date.now() + AGENT_APPROVAL_TIMEOUT_MS).toISOString(), result: null, error: null };
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
      ...(stored.result ? { sessionId: stored.result.sessionId, title: stored.result.title, url: `${PUBLIC_URL}${sessionRoute(stored.result.sessionId)}` } : {}),
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
    const schedule = this.scheduler().create({
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
