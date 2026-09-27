import {
  AgentNotifyArgs,
  AgentPrAttachArgs,
  AgentPrItemsArgs,
  AgentPrMarkAddressedArgs,
  AgentQueueAddArgs,
  AgentTerminalReadArgs,
  AgentTitleSetArgs,
  AgentUiOpenArgs,
  AgentVerifyArgs,
  AgentWhoAmI,
  agentToolOf,
  PtyReadResult,
  repoDir,
  sessionRoute,
  type AgentTool,
  type AgentToolsPolicy,
  type ContextBreakdown,
  type PtyInfo,
  type PtyListResult,
  type PublicSettings,
  type PullRequest,
  type SavedMessage,
  type Session,
  type SessionBroadcast,
  type SessionEvent,
  type SessionEventBody,
  type SessionInfo,
  type Snapshot,
  type UiHint,
} from "@sessionboxer/protocol";
import type { Db } from "./db.js";
import type { E2eVerification } from "./e2e.js";
import type { PullRequests } from "./pull-requests.js";

/** What the Control Plane needs to answer the `sessionboxer` MCP's tools for one Session. */
export interface AgentToolsDeps {
  db: Db;
  getSession: (id: string) => Session | null;
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
]);

/** Keys of `PublicSettings` the Agent never sees, whatever their value (nothing secret-shaped leaves the Control Plane). */
const SECRET_SHAPED = /secret|token|password|passwd|apikey|api_key|credential|auth|vapid|login|cookie|private|sshkey|identityfile/i;

const ITEM_BODY_MAX = 2000;
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 40;

/**
 * The `sessionboxer` MCP's tools, answered for the Session whose Daemon asked (ADR-0062). The Session
 * id comes from the WebSocket the request arrived on, never from the request. Every tool checks the
 * policy in force; every action leaves an `agent_action` marker in the transcript.
 */
export class AgentTools {
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

  private mark(id: string, tool: AgentTool, text: string, pane?: string): void {
    this.deps.appendEvent(id, { type: "agent_action", tool, text, ...(pane ? { pane } : {}) });
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

  private async uiOpen(id: string, p: { pane: UiHint["pane"]; terminal?: { command: string } }): Promise<unknown> {
    let terminalId: string | null = null;
    if (p.pane === "terminal" && p.terminal) {
      const pty = await this.deps.terminalOpen(id, TERMINAL_COLS, TERMINAL_ROWS);
      terminalId = pty.id;
      await this.deps.terminalInput(id, pty.id, `${p.terminal.command}\n`);
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
