import { randomBytes } from "node:crypto";
import {
  PR_EVENT_LABELS,
  prRefspec,
  prUrl,
  type Automation,
  type AutomationRun,
  type BoxCredential,
  type CreatePrFollowRequest,
  type CreateSessionRequest,
  type FollowedPr,
  type PrCheckItem,
  type PrEvent,
  type PrEventFilters,
  type PrPeople,
  type PrFollow,
  type PrFollowHook,
  type PrItem,
  type PrRef,
  type PullRequest,
  type PushMessage,
  type RepoSpec,
  type Session,
  type SessionBroadcast,
  type StartPrSessionRequest,
} from "@sessionboxer/protocol";
import type { Automations, PrRunContext } from "./automations.js";
import { bitbucketHttpsCloneUrl, parseBitbucketRemote } from "./bitbucket.js";
import { bitbucketTokenTransport, fetchBbActivities, fetchBbBuilds, fetchBbDashboardPrs, fetchBbOpenPrs, fetchBbPr } from "./bitbucket-pr.js";
import type { Db } from "./db.js";
import type { FollowKey, StoredFollow, StoredFollowedPr, FollowedPrPatch } from "./followed-pr-store.js";
import {
  fetchChecks,
  fetchIssueComments,
  fetchOpenPrs,
  fetchPrMeta,
  fetchReviewComments,
  fetchReviews,
  fetchThreads,
  searchOpenPrs,
  tokenTransport,
  type GhOutcome,
  type PrListItem,
  type PrMeta,
} from "./github-pr.js";
import { PUBLIC_URL } from "./config.js";
import { HttpError } from "./http-error.js";
import { bitbucketHookHint, githubHookHint, verifyHookSignature, type HookHint } from "./pr-hooks.js";
import { itemId, type PrEtags, type PrItemInput } from "./pr-store.js";

export interface FollowedPrDeps {
  db: Db;
  /** Every Connector login with a token (GitHub and Bitbucket Data Center), read from Settings each time. */
  credentials: () => BoxCredential[];
  automations: Automations;
  sessions: {
    list(): Session[];
    get(id: string): Session | null;
    create(req: CreateSessionRequest): Promise<Session>;
  };
  /** Attaches a PR to a Session (the Session-level PR pane). */
  attach: (sessionId: string, url: string, by: PullRequest["attachedBy"]) => Promise<PullRequest>;
  broadcast: (msg: SessionBroadcast) => void;
  push: (msg: PushMessage) => void;
  log: (msg: string) => void;
}

const TICK_MS = 10_000;
/** A follow's list is read this often (search-backed lists have their own 30/min rate limit). */
const LIST_POLL_MS = 60_000;
/** …and this often while the repository's webhook is delivering (ADR-0067). */
const LIST_POLL_HOOK_MS = 5 * 60_000;
/** A delivery is not read past this. */
const HOOK_BODY_MAX = 1024 * 1024;
/** Comments and checks of a PR the list did not report changed are re-read this often anyway. */
const DETAIL_REFRESH_MS = 30 * 60_000;
/** A PR with checks still running has them re-read this often. */
const CHECKS_POLL_MS = 5 * 60_000;
/** Merged and closed PRs stay on the page this long. */
const CLOSED_KEEP_MS = 7 * 24 * 3_600_000;
/** A PR first seen more than this after it was created is not "opened" (a follow added to an old repo). */
const OPENED_WINDOW_MS = 24 * 3_600_000;
/** A run held back by `maxConcurrent` is dropped after this. */
const DEFERRED_MAX_MS = 3_600_000;
const BACKOFF_MS = 5 * 60_000;
const PURGE_EVERY_MS = 3_600_000;

interface PendingEvent {
  type: PrEvent["type"];
  headSha: string;
  actor: string | null;
  ref: string | null;
}

interface Deferred {
  automationId: string;
  prId: string;
  event: PrEvent;
  since: number;
}

/**
 * Pull requests followed without a Session (ADR-0064). Follows are polled on a timer with the
 * Connector's token, one request at a time per login; the PRs they list are read in detail
 * (comments, reviews, checks) when the list says they changed; what changed becomes events, and
 * events go to the automations whose `pr_event` trigger listens — with dedupe (one run per
 * automation, PR, event and head), a debounce on new commits, and the automation's caps.
 */
export class FollowedPrs {
  private timer: NodeJS.Timeout | null = null;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly queued = new Set<string>();
  private readonly debounces = new Map<string, { timer: NodeJS.Timeout; event: PrEvent }>();
  private readonly deferred: Deferred[] = [];
  private lastPurge = 0;

  constructor(private readonly deps: FollowedPrDeps) {
    const { automations } = deps;
    automations.followExists = (id) => this.deps.db.followedPrs.getFollow(id) !== null;
    automations.prHeadRepo = async (repo, number, followedPrId) => this.headRepo(repo, number, followedPrId);
    automations.runners.set("attach", { start: (automation, run, ctx) => this.attachAction(ctx) });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const d of this.debounces.values()) clearTimeout(d.timer);
    this.debounces.clear();
  }

  // --- follows -------------------------------------------------------------------------------

  listFollows(): PrFollow[] {
    return this.deps.db.followedPrs.listFollows().map(publicFollow);
  }

  /** The Connector logins a follow can be read with. */
  accounts(): Array<Pick<BoxCredential, "kind" | "host" | "account">> {
    return this.deps.credentials().map((c) => ({ kind: c.kind, host: c.host, account: c.account }));
  }

  /** Every author and requested reviewer (logins, GitHub teams as `org/slug`) seen on followed PRs, for the filter inputs. */
  people(): PrPeople {
    const authors = new Set<string>();
    const reviewers = new Set<string>();
    for (const pr of this.deps.db.followedPrs.listPrs({ state: "all" })) {
      if (pr.author) authors.add(pr.author);
      for (const r of pr.requestedReviewers) reviewers.add(r);
    }
    const sorted = (s: Set<string>): string[] => [...s].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return { authors: sorted(authors), reviewers: sorted(reviewers) };
  }

  follow(req: CreatePrFollowRequest, defaultAccount?: string | null): PrFollow {
    const key = this.followKey(req, defaultAccount ?? null);
    const store = this.deps.db.followedPrs;
    const existing = store.findFollow(key);
    if (existing) {
      if (!existing.enabled) store.setFollowEnabled(existing.id, true);
      this.broadcastFollows();
      return publicFollow(store.getFollow(existing.id)!);
    }
    const f = store.insertFollow(key);
    if (f.kind === "repo" && f.owner !== null && f.repo !== null) this.deps.db.repos.rememberRef({ provider: f.provider, host: f.host, owner: f.owner, repo: f.repo }, "follow");
    this.deps.log(`following ${describeFollow(f)}`);
    this.broadcastFollows();
    void this.enqueue(accountKey(f), `follow:${f.id}`, () => this.pollFollow(f.id));
    return publicFollow(f);
  }

  private followKey(req: CreatePrFollowRequest, defaultAccount: string | null): FollowKey {
    const creds = this.deps.credentials().filter((c) => c.kind === req.provider);
    if (creds.length === 0) {
      throw new HttpError(400, req.provider === "github" ? "Connect a GitHub account first (Settings → Connectors)." : "Connect a Bitbucket Data Center first (Settings → Connectors).");
    }
    let owner: string | null = null;
    let repo: string | null = null;
    let host = req.provider === "github" ? "github.com" : (req.host ?? "").trim().toLowerCase();
    if (req.kind === "repo") {
      const text = (req.repo ?? "").trim();
      if (text === "") throw new HttpError(400, "Say which repository: owner/repo, or its URL.");
      if (req.provider === "github") {
        const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/.exec(text);
        if (!m) throw new HttpError(400, `Cannot read "${text}" as owner/repo or a github.com URL.`);
        owner = m[1]!;
        repo = m[2]!;
      } else {
        const parsed = parseBitbucketRemote(text);
        if (parsed) {
          host = parsed.host;
          owner = parsed.project;
          repo = parsed.slug;
        } else {
          const m = /^([A-Za-z0-9_.~-]+)\/([A-Za-z0-9_.-]+)$/.exec(text);
          if (!m) throw new HttpError(400, `Cannot read "${text}" as PROJECT/slug or a Bitbucket Data Center URL.`);
          owner = m[1]!;
          repo = m[2]!;
        }
      }
    }
    if (host === "") {
      const hosts = [...new Set(creds.map((c) => c.host))];
      if (hosts.length !== 1) throw new HttpError(400, "Say which Bitbucket host the follow is on.");
      host = hosts[0]!;
    }
    const onHost = creds.filter((c) => c.host.toLowerCase() === host.toLowerCase());
    if (onHost.length === 0) throw new HttpError(400, `No Connector for ${host}.`);
    const wanted = (req.account ?? defaultAccount ?? "").trim();
    const cred = wanted === "" ? onHost[0]! : onHost.find((c) => c.account.toLowerCase() === wanted.toLowerCase());
    if (!cred) {
      if (req.account) throw new HttpError(400, `@${req.account} is not a connected ${req.provider === "github" ? "GitHub" : "Bitbucket"} login.`);
      return { provider: req.provider, host, account: onHost[0]!.account, kind: req.kind, owner, repo };
    }
    return { provider: req.provider, host, account: cred.account, kind: req.kind, owner, repo };
  }

  setFollowEnabled(id: string, enabled: boolean): PrFollow {
    const f = this.deps.db.followedPrs.setFollowEnabled(id, enabled);
    if (!f) throw new HttpError(404, `follow ${id} not found`);
    this.broadcastFollows();
    if (enabled) void this.enqueue(accountKey(f), `follow:${f.id}`, () => this.pollFollow(f.id));
    return publicFollow(f);
  }

  unfollow(id: string): void {
    const store = this.deps.db.followedPrs;
    const f = store.getFollow(id);
    if (!f) throw new HttpError(404, `follow ${id} not found`);
    if (f.webhookId) void this.deleteRegisteredHook(f).catch((e: unknown) => this.deps.log(`followed PRs: removing the webhook of ${describeFollow(f)} failed: ${e instanceof Error ? e.message : String(e)}`));
    store.deleteFollow(id);
    for (const pr of store.orphans()) store.deletePr(pr.id);
    this.deps.log(`unfollowed ${describeFollow(f)}`);
    this.broadcastFollows();
    this.broadcastPrs();
  }

  /** Reads the follow's list now (a webhook, the "Poll now" button). */
  pollFollowNow(id: string): Promise<void> {
    const f = this.deps.db.followedPrs.getFollow(id);
    if (!f) throw new HttpError(404, `follow ${id} not found`);
    this.deps.db.followedPrs.touchFollow(id);
    return this.enqueue(accountKey(f), `follow:${f.id}`, () => this.pollFollow(f.id));
  }

  // --- followed PRs --------------------------------------------------------------------------

  list(filter: { state?: "open" | "all"; repo?: string } = { state: "all" }): FollowedPr[] {
    return this.deps.db.followedPrs.listPrs(filter).map((pr) => this.toPublic(pr));
  }

  get(id: string): FollowedPr {
    return this.toPublic(this.stored(id));
  }

  items(id: string): PrItem[] {
    this.stored(id);
    return this.deps.db.followedPrs.items(id);
  }

  checks(id: string): PrCheckItem[] {
    this.stored(id);
    return this.deps.db.followedPrs.checks(id);
  }

  events(id: string): PrEvent[] {
    this.stored(id);
    return this.deps.db.followedPrs.listEvents(id);
  }

  runs(id: string): AutomationRun[] {
    this.stored(id);
    return this.deps.db.automations.listRunsForPr(id);
  }

  async refresh(id: string): Promise<FollowedPr> {
    const pr = this.stored(id);
    this.deps.db.followedPrs.updatePr(id, { needsDetail: true });
    await this.enqueue(prAccountKey(pr), `pr:${id}`, () => this.pollPr(id));
    return this.get(id);
  }

  markSeen(id: string): FollowedPr {
    this.stored(id);
    if (this.deps.db.followedPrs.markSeen(id) > 0) this.broadcastPrs();
    return this.get(id);
  }

  async attachTo(id: string, sessionId: string): Promise<PullRequest> {
    const pr = this.stored(id);
    const attached = await this.deps.attach(sessionId, pr.url, "manual");
    this.broadcastPrs();
    return attached;
  }

  /** A new Session with the PR's head checked out and the PR attached. */
  async startSession(id: string, req: StartPrSessionRequest): Promise<Session> {
    const pr = this.stored(id);
    const repo = await this.headRepo(`${pr.owner}/${pr.repo}`, pr.number, pr.id);
    const session = await this.deps.sessions.create({
      title: `PR #${pr.number}: ${pr.title}`.slice(0, 200),
      provider: req.provider,
      repos: [repo],
      workspaceSource: { type: "empty" },
      settings: req.settings,
      prompt: req.prompt?.trim() || prBrief(pr),
    });
    await this.deps.attach(session.id, pr.url, "manual").catch((e: unknown) => this.deps.log(`attach ${pr.url} to ${session.id} failed: ${String(e)}`));
    this.broadcastPrs();
    return session;
  }

  /** Runs a `pr_event` automation on this PR by hand: filters and caps apply, dedupe does not. */
  async runAutomation(id: string, automationId: string): Promise<AutomationRun> {
    const pr = this.stored(id);
    const automation = this.deps.db.automations.get(automationId);
    if (!automation) throw new HttpError(404, `automation ${automationId} not found`);
    if (automation.trigger.type !== "pr_event") throw new HttpError(400, "Only an automation with a pull request trigger runs on a PR.");
    const latest = this.deps.db.followedPrs.listEvents(id)[0];
    const event: PrEvent = latest ?? { id: "manual", followedPrId: id, type: "opened", headSha: pr.headSha, actor: null, ref: null, detectedAt: new Date().toISOString() };
    const reason = this.capReason(automation, pr);
    if (reason) return this.deps.automations.recordSkipped(automation, "manual", reason, this.context(pr, event));
    return this.deps.automations.runForPr(automation, { ...this.context(pr, event), event: { id: event.id, type: event.type, headSha: pr.headSha } });
  }

  private stored(id: string): StoredFollowedPr {
    const pr = this.deps.db.followedPrs.getPr(id);
    if (!pr) throw new HttpError(404, `followed PR ${id} not found`);
    return pr;
  }

  private toPublic(pr: StoredFollowedPr): FollowedPr {
    const { etags: _etags, retryAt: _retryAt, needsDetail: _needsDetail, lastActivityAt: _lastActivityAt, ...rest } = pr;
    const latest = new Map<string, AutomationRun>();
    for (const run of this.deps.db.automations.listRunsForPr(pr.id)) if (!latest.has(run.automationId)) latest.set(run.automationId, run);
    return {
      ...rest,
      attached: this.deps.db.prs.findAll(pr).map((p) => ({ sessionId: p.sessionId, prId: p.id })),
      runs: [...latest.values()],
    };
  }

  // --- webhooks (ADR-0067) -----------------------------------------------------------------------

  hookInfo(id: string): PrFollowHook {
    const f = this.deps.db.followedPrs.getFollow(id);
    if (!f) throw new HttpError(404, `follow ${id} not found`);
    return { webhook: f.webhook, url: f.webhookUrl, secret: f.webhookId ? null : f.webhookSecret, registeredId: f.webhookId, seenAt: f.webhookSeenAt };
  }

  /**
   * Turns the follow's webhook on: a fresh secret, the URL at `baseUrl` (a tunnel with a stable hostname;
   * the Control Plane's own URL by default), registered on GitHub for `repo` follows when the login may;
   * otherwise the URL and secret come back for the user to configure by hand.
   */
  async enableHook(id: string, baseUrl?: string): Promise<PrFollowHook> {
    const f = this.deps.db.followedPrs.getFollow(id);
    if (!f) throw new HttpError(404, `follow ${id} not found`);
    if (f.webhookId) await this.deleteRegisteredHook(f).catch(() => undefined);
    const secret = randomBytes(32).toString("hex");
    const url = `${(baseUrl ?? PUBLIC_URL).replace(/\/+$/, "")}/api/hooks/${f.provider}/${f.id}`;
    let hookId: string | null = null;
    if (f.provider === "github" && f.kind === "repo" && f.owner && f.repo) {
      const cred = this.credential(f);
      if (!cred) throw new HttpError(400, `No connected login can register a webhook on ${f.owner}/${f.repo} (Settings → Connectors).`);
      const res = await tokenTransport(cred.token).request({
        method: "POST",
        path: `repos/${f.owner}/${f.repo}/hooks`,
        headers: {},
        account: cred.account,
        body: JSON.stringify({
          name: "web",
          active: true,
          events: ["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "check_run", "check_suite"],
          config: { url, content_type: "json", secret, insecure_ssl: "0" },
        }),
      });
      if (res.status !== 201) {
        const detail = ghMessage(res.body);
        throw new HttpError(res.status === 404 || res.status === 403 ? 400 : 502, `GitHub did not create the webhook (HTTP ${res.status}${detail ? `: ${detail}` : ""}); the login needs admin on the repository (\`repo\` scope, or the Webhooks permission).`);
      }
      const parsed = JSON.parse(res.body) as { id?: number };
      hookId = parsed.id !== undefined ? String(parsed.id) : null;
    }
    this.deps.db.followedPrs.setFollowHook(f.id, { secret, url, hookId });
    this.deps.log(`followed PRs: webhook ${hookId ? "registered" : "configured (paste the URL and secret on the platform)"} for ${describeFollow(f)}`);
    this.broadcastFollows();
    return this.hookInfo(f.id);
  }

  async disableHook(id: string): Promise<PrFollowHook> {
    const f = this.deps.db.followedPrs.getFollow(id);
    if (!f) throw new HttpError(404, `follow ${id} not found`);
    if (f.webhookId) await this.deleteRegisteredHook(f);
    this.deps.db.followedPrs.setFollowHook(f.id, null);
    this.broadcastFollows();
    return this.hookInfo(f.id);
  }

  private async deleteRegisteredHook(f: StoredFollow): Promise<void> {
    if (!f.webhookId || f.provider !== "github" || !f.owner || !f.repo) return;
    const cred = this.credential(f);
    if (!cred) throw new Error("no connected login for the repository");
    const res = await tokenTransport(cred.token).request({ method: "DELETE", path: `repos/${f.owner}/${f.repo}/hooks/${f.webhookId}`, headers: {}, account: cred.account, body: null });
    if (res.status !== 204 && res.status !== 404) throw new Error(`HTTP ${res.status} deleting hook ${f.webhookId}`);
  }

  /**
   * A delivery at `POST /api/hooks/{provider}/{followId}`: verified with the follow's secret, then read
   * only for *which* PRs to poll now — the polling loop stays the source of truth, so a forged or
   * replayed delivery costs one extra poll at most. Answers `{ status, body }` for the route.
   */
  onHook(provider: "github" | "bitbucket", followId: string, h: { signature: string | undefined; event: string | undefined; length: number }, rawBody: string): { status: 202 | 401 | 404 | 413; body: Record<string, unknown> } {
    const f = this.deps.db.followedPrs.getFollow(followId);
    if (!f || f.provider !== provider || !f.webhookSecret) return { status: 404, body: { error: "unknown hook" } };
    if (h.length > HOOK_BODY_MAX || rawBody.length > HOOK_BODY_MAX) return { status: 413, body: { error: "delivery too large" } };
    if (!verifyHookSignature(f.webhookSecret, rawBody, h.signature)) return { status: 401, body: { error: "bad signature" } };
    this.deps.db.followedPrs.markHookSeen(f.id);
    if (h.event === "ping" || h.event === "diagnostics:ping") {
      this.broadcastFollows();
      return { status: 202, body: { ok: true, pong: true } };
    }
    const hint = provider === "github" ? githubHookHint(rawBody) : bitbucketHookHint(rawBody);
    const polled = this.pollFromHint(f, hint);
    return { status: 202, body: { ok: true, polled } };
  }

  /** The attached-PR poller saw checks change on a PR we also follow: read its detail now instead of on the timer. */
  pollHint(ref: PrRef): void {
    const pr = this.deps.db.followedPrs.findPr(ref);
    if (!pr || pr.follows.length === 0) return;
    this.deps.db.followedPrs.updatePr(pr.id, { needsDetail: true });
    void this.enqueue(prAccountKey(pr), `pr:${pr.id}`, () => this.pollPr(pr.id));
  }

  private pollFromHint(f: StoredFollow, hint: HookHint | null): number {
    const store = this.deps.db.followedPrs;
    const listNow = () => {
      store.touchFollow(f.id);
      void this.enqueue(accountKey(f), `follow:${f.id}`, () => this.pollFollow(f.id));
    };
    if (!hint || hint.numbers.length === 0) {
      listNow();
      return 0;
    }
    if (f.kind === "repo" && (f.owner?.toLowerCase() !== hint.owner.toLowerCase() || f.repo?.toLowerCase() !== hint.repo.toLowerCase())) return 0;
    let polled = 0;
    let missing = false;
    for (const number of hint.numbers) {
      const pr = store.findPr({ provider: f.provider, host: f.host, owner: hint.owner, repo: hint.repo, number });
      if (pr && pr.follows.includes(f.id)) {
        store.updatePr(pr.id, { needsDetail: true });
        void this.enqueue(prAccountKey(pr), `pr:${pr.id}`, () => this.pollPr(pr.id));
        polled++;
      } else missing = true;
    }
    if (missing) listNow();
    return polled;
  }

  /** The Session-level poller (every minute while the box is up) already reads this PR's checks. */
  private attachedToLiveSession(pr: StoredFollowedPr): boolean {
    return this.deps.db.prs.findAll(pr).some((p) => {
      if (!p.watch) return false;
      const s = this.deps.sessions.get(p.sessionId);
      return s !== null && (s.status === "idle" || s.status === "running");
    });
  }

  // --- polling -------------------------------------------------------------------------------

  private tick(): void {
    const store = this.deps.db.followedPrs;
    const now = Date.now();
    for (const f of store.listFollows()) {
      if (!f.enabled) continue;
      if (f.retryAt && Date.parse(f.retryAt) > now) continue;
      if (f.polledAt && now - Date.parse(f.polledAt) < (f.webhook === "healthy" ? LIST_POLL_HOOK_MS : LIST_POLL_MS)) continue;
      void this.enqueue(accountKey(f), `follow:${f.id}`, () => this.pollFollow(f.id));
    }
    for (const pr of store.listPrs()) {
      if (pr.follows.length === 0) continue;
      if (pr.retryAt && Date.parse(pr.retryAt) > now) continue;
      const age = pr.syncedAt ? now - Date.parse(pr.syncedAt) : Number.POSITIVE_INFINITY;
      const due = pr.needsDetail || age >= DETAIL_REFRESH_MS || (pr.checksPending > 0 && age >= CHECKS_POLL_MS && !this.attachedToLiveSession(pr));
      if (due) void this.enqueue(prAccountKey(pr), `pr:${pr.id}`, () => this.pollPr(pr.id));
    }
    this.retryDeferred();
    if (now - this.lastPurge >= PURGE_EVERY_MS) {
      this.lastPurge = now;
      let changed = false;
      for (const pr of store.orphans()) changed = store.deletePr(pr.id) || changed;
      changed = store.purgeClosed(new Date(now - CLOSED_KEEP_MS).toISOString()) > 0 || changed;
      if (changed) this.broadcastPrs();
    }
  }

  /** One request at a time per login (its rate limit is shared); the same job is not queued twice. */
  private enqueue(key: string, jobId: string, job: () => Promise<void>): Promise<void> {
    if (this.queued.has(jobId)) return Promise.resolve();
    this.queued.add(jobId);
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev
      .then(job)
      .catch((e: unknown) => this.deps.log(`followed PRs: ${jobId} failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.queued.delete(jobId);
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    this.queues.set(key, next);
    return next;
  }

  private credential(f: Pick<StoredFollow, "provider" | "host" | "account">): BoxCredential | null {
    return this.deps.credentials().find((c) => c.kind === f.provider && c.host.toLowerCase() === f.host.toLowerCase() && c.account.toLowerCase() === f.account.toLowerCase()) ?? null;
  }

  /** The follow of a PR whose login is still connected (the one the detail is read with). */
  credentialFor(pr: StoredFollowedPr): { follow: StoredFollow; cred: BoxCredential } | null {
    for (const id of pr.follows) {
      const follow = this.deps.db.followedPrs.getFollow(id);
      if (!follow) continue;
      const cred = this.credential(follow);
      if (cred) return { follow, cred };
    }
    return null;
  }

  private async pollFollow(id: string): Promise<void> {
    const store = this.deps.db.followedPrs;
    const f = store.getFollow(id);
    if (!f || !f.enabled) return;
    const cred = this.credential(f);
    if (!cred) {
      store.setFollowSync(id, { error: "unauthorized", detail: `@${f.account} is not a connected ${f.provider === "github" ? "GitHub" : "Bitbucket"} login any more (Settings → Connectors).` });
      this.broadcastFollows();
      return;
    }
    let r: GhOutcome<PrListItem[]>;
    if (f.provider === "github") {
      const t = tokenTransport(cred.token);
      if (f.kind === "repo") r = await fetchOpenPrs(t, f.owner!, f.repo!, f.etags.list, cred.account);
      else r = await searchOpenPrs(t, f.kind === "mine" ? "author:@me" : "review-requested:@me", cred.account);
    } else {
      const t = bitbucketTokenTransport(f.host, cred.token);
      if (f.kind === "repo") r = await fetchBbOpenPrs(t, f.host, f.owner!, f.repo!);
      else r = await fetchBbDashboardPrs(t, f.host, f.kind === "mine" ? "AUTHOR" : "REVIEWER");
    }
    if (r.status === "unchanged") {
      store.setFollowSync(id, { error: null, detail: null });
      this.broadcastFollows();
      return;
    }
    if (r.status === "error") {
      store.setFollowSync(id, { error: r.kind, detail: r.detail, retryAt: r.retryAt ?? (r.kind === "rate_limited" || r.kind === "error" ? new Date(Date.now() + BACKOFF_MS).toISOString() : null) });
      this.deps.log(`followed PRs: ${describeFollow(f)}: ${r.kind}: ${r.detail}`);
      this.broadcastFollows();
      return;
    }
    const baseline = f.polledAt === null;
    const seen = new Set<string>();
    const dispatch: Array<{ pr: StoredFollowedPr; events: PrEvent[] }> = [];
    for (const it of r.value) {
      const applied = this.applyListItem(f, it, baseline);
      seen.add(applied.pr.id);
      if (applied.events.length > 0) dispatch.push(applied);
    }
    for (const pr of store.prsOfFollow(id)) {
      if (seen.has(pr.id) || pr.state === "merged" || pr.state === "closed") continue;
      const gone = await this.vanished(f, cred, pr);
      if (gone.length > 0) dispatch.push({ pr: store.getPr(pr.id) ?? pr, events: gone });
    }
    store.setFollowSync(id, { etags: { ...f.etags, list: r.etag ?? undefined }, error: null, detail: null });
    this.broadcastFollows();
    this.broadcastPrs();
    for (const d of dispatch) this.dispatch(d.pr, d.events);
  }

  private applyListItem(f: StoredFollow, it: PrListItem, baseline: boolean): { pr: StoredFollowedPr; events: PrEvent[] } {
    const store = this.deps.db.followedPrs;
    const ref: PrRef = { provider: f.provider, host: f.host, owner: it.owner, repo: it.repo, number: it.number };
    const full = it.headRef !== null;
    const patch: FollowedPrPatch = {
      title: it.title,
      ...(it.body !== null ? { body: it.body } : {}),
      state: it.state,
      author: it.author,
      labels: it.labels,
      remoteCreatedAt: it.createdAt,
      remoteUpdatedAt: it.updatedAt,
      closedAt: it.closedAt,
      ...(full
        ? {
            headRef: it.headRef!,
            headSha: it.headSha ?? "",
            headRepo: it.headRepo ?? `${it.owner}/${it.repo}`,
            baseRef: it.baseRef ?? "",
            isFork: (it.headRepo ?? "").toLowerCase() !== `${it.owner}/${it.repo}`.toLowerCase(),
            requestedReviewers: it.requestedReviewers,
          }
        : {}),
    };
    const existing = store.findPr(ref);
    if (!existing) {
      const fresh = !baseline && (it.createdAt === null || Date.now() - Date.parse(it.createdAt) < OPENED_WINDOW_MS);
      const pr = store.insertPr({ ...ref, url: it.url }, { ...patch, needsDetail: true });
      store.link(pr.id, f.id);
      if (fresh && (it.state === "open" || it.state === "draft")) store.setPendingOpened(pr.id, true);
      return { pr, events: [] };
    }
    store.link(existing.id, f.id);
    const pending: PendingEvent[] = [];
    const headSha = it.headSha ?? existing.headSha;
    if (it.headSha && existing.headSha && it.headSha !== existing.headSha) pending.push({ type: "synchronize", headSha: it.headSha, actor: null, ref: null });
    pending.push(...stateEvents(existing.state, it.state, headSha));
    if (full) {
      for (const login of it.requestedReviewers) {
        if (!existing.requestedReviewers.includes(login)) pending.push({ type: "review_requested", headSha, actor: null, ref: login });
      }
    }
    const changed = it.updatedAt !== existing.remoteUpdatedAt || (it.headSha !== null && it.headSha !== existing.headSha) || it.state !== existing.state;
    store.updatePr(existing.id, { ...patch, ...(changed ? { needsDetail: true } : {}) });
    const events = pending.map((e) => store.insertEvent(existing.id, e)).filter((e): e is PrEvent => e !== null);
    return { pr: store.getPr(existing.id)!, events };
  }

  /** A PR the list stopped naming: merged or closed (kept, with its event), or simply out of the scope (unlinked). */
  private async vanished(f: StoredFollow, cred: BoxCredential, pr: StoredFollowedPr): Promise<PrEvent[]> {
    const store = this.deps.db.followedPrs;
    const meta = await this.readMeta(f, cred, pr);
    if (meta.status !== "ok") {
      if (meta.status === "error" && meta.kind === "not_found") {
        store.unlink(pr.id, f.id);
        if (store.getPr(pr.id)?.follows.length === 0) store.deletePr(pr.id);
      }
      return [];
    }
    const m = meta.value;
    if (m.state === "merged" || m.state === "closed") {
      const events = stateEvents(pr.state, m.state, m.headSha || pr.headSha);
      store.updatePr(pr.id, { title: m.title, state: m.state, headRef: m.headRef, headSha: m.headSha || pr.headSha, headRepo: m.headRepo, baseRef: m.baseRef, author: m.author, closedAt: m.closedAt ?? new Date().toISOString() });
      return events.map((e) => store.insertEvent(pr.id, e)).filter((e): e is PrEvent => e !== null);
    }
    store.unlink(pr.id, f.id);
    if (store.getPr(pr.id)?.follows.length === 0) store.deletePr(pr.id);
    return [];
  }

  private async readMeta(f: Pick<StoredFollow, "provider" | "host">, cred: BoxCredential, pr: StoredFollowedPr): Promise<GhOutcome<PrMeta>> {
    if (f.provider === "github") return fetchPrMeta(tokenTransport(cred.token), pr, undefined, cred.account);
    const r = await fetchBbPr(bitbucketTokenTransport(f.host, cred.token), pr);
    return r.status === "ok" ? { ...r, value: r.value.meta } : r;
  }

  private async pollPr(id: string): Promise<void> {
    const store = this.deps.db.followedPrs;
    const pr = store.getPr(id);
    if (!pr) return;
    const via = this.credentialFor(pr);
    if (!via) {
      store.setPrSync(id, { etags: pr.etags, error: "unauthorized", detail: "no connected login can read this PR (Settings → Connectors)" });
      this.broadcastPrs();
      return;
    }
    const { cred } = via;
    const pending: PendingEvent[] = [];
    const etags: PrEtags = { ...pr.etags };
    let failure: { kind: NonNullable<PullRequest["syncError"]>; detail: string; retryAt: string | null } | null = null;
    let headSha = pr.headSha;
    let itemsChanged = false;
    let checksChanged = false;
    const applyMeta = (m: PrMeta, reviewDecision?: FollowedPrPatch["reviewDecision"]): void => {
      if (pr.headSha !== "" && m.headSha !== "" && m.headSha !== pr.headSha) pending.push({ type: "synchronize", headSha: m.headSha, actor: null, ref: null });
      pending.push(...stateEvents(pr.state, m.state, m.headSha || pr.headSha));
      headSha = m.headSha || pr.headSha;
      store.updatePr(id, {
        title: m.title,
        state: m.state,
        headRef: m.headRef,
        headSha,
        headRepo: m.headRepo,
        baseRef: m.baseRef,
        author: m.author,
        closedAt: m.closedAt,
        isFork: m.headRepo.toLowerCase() !== `${pr.owner}/${pr.repo}`.toLowerCase(),
        ...(reviewDecision !== undefined ? { reviewDecision } : {}),
      });
    };
    const applyItems = (items: PrItemInput[], kinds: PrItem["kind"][]): void => {
      const fresh = store.upsertItems(id, kinds, items);
      itemsChanged = itemsChanged || fresh.length > 0;
      for (const it of fresh) {
        pending.push({ type: it.kind === "review" ? "review_submitted" : "comment", headSha, actor: it.author, ref: it.id });
      }
    };
    const applyChecks = (sha: string, checks: Parameters<typeof store.setChecks>[2]): void => {
      checksChanged = store.setChecks(id, sha, checks) || checksChanged;
      for (const c of checks) if (c.state === "failed") pending.push({ type: "check_failed", headSha: sha, actor: null, ref: c.name });
    };

    if (pr.provider === "github") {
      const t = tokenTransport(cred.token);
      const account = cred.account;
      const meta = await fetchPrMeta(t, pr, etags.pr, account);
      if (meta.status === "error") {
        store.setPrSync(id, { etags, error: meta.kind, detail: meta.detail, retryAt: meta.retryAt ?? backoff(meta.kind) });
        this.broadcastPrs();
        return;
      }
      if (meta.status === "ok") {
        etags.pr = meta.etag ?? undefined;
        applyMeta(meta.value);
      }
      const apply = (r: GhOutcome<PrItemInput[]>, key: keyof PrEtags, kind: PrItem["kind"]): void => {
        if (r.status === "error") {
          failure ??= { kind: r.kind, detail: r.detail, retryAt: r.retryAt };
          return;
        }
        if (r.status === "unchanged") return;
        etags[key] = r.etag ?? undefined;
        applyItems(r.value, [kind]);
      };
      apply(await fetchIssueComments(t, pr, etags.issueComments, account, account), "issueComments", "issue_comment");
      apply(await fetchReviewComments(t, pr, etags.reviewComments, account, account, (k, gid) => itemId(id, k, gid)), "reviewComments", "review_comment");
      apply(await fetchReviews(t, pr, etags.reviews, account, account), "reviews", "review");
      const threads = await fetchThreads(t, pr, account);
      if (threads.status === "ok") {
        store.setThreads(id, threads.value.threads);
        store.updatePr(id, { reviewDecision: threads.value.reviewDecision });
      } else if (threads.status === "error") failure ??= { kind: threads.kind, detail: threads.detail, retryAt: threads.retryAt };
      const checks = await fetchChecks(t, pr, account);
      if (checks.status === "ok") {
        if (headSha === "" && checks.value.headSha) {
          headSha = checks.value.headSha;
          store.updatePr(id, { headSha });
        }
        applyChecks(checks.value.headSha, checks.value.checks);
      } else if (checks.status === "error") failure ??= { kind: checks.kind, detail: checks.detail, retryAt: checks.retryAt };
    } else {
      const t = bitbucketTokenTransport(pr.host, cred.token);
      const info = await fetchBbPr(t, pr);
      if (info.status !== "ok") {
        if (info.status === "error") store.setPrSync(id, { etags, error: info.kind, detail: info.detail, retryAt: info.retryAt ?? backoff(info.kind) });
        this.broadcastPrs();
        return;
      }
      applyMeta(info.value.meta, info.value.reviewDecision);
      const acts = await fetchBbActivities(t, pr, cred.account, (kind, gid) => itemId(id, kind, gid));
      if (acts.status === "ok") applyItems(acts.value, ["issue_comment", "review_comment", "review"]);
      else if (acts.status === "error") failure ??= { kind: acts.kind, detail: acts.detail, retryAt: acts.retryAt };
      if (info.value.headSha) {
        const builds = await fetchBbBuilds(t, pr, info.value.headSha, info.value.targetRefId);
        if (builds.status === "ok") applyChecks(info.value.headSha, builds.value);
        else if (builds.status === "error") failure ??= { kind: builds.kind, detail: builds.detail, retryAt: builds.retryAt };
      }
    }

    const events: PrEvent[] = [];
    if (pr.pendingOpened && headSha !== "") {
      store.setPendingOpened(id, false);
      const opened = store.insertEvent(id, { type: "opened", headSha, actor: pr.author, ref: null });
      if (opened) events.push(opened);
    }
    for (const e of pending) {
      const stored = store.insertEvent(id, e);
      if (stored) events.push(stored);
    }
    store.setPrSync(id, failure ? { etags, error: failure.kind, detail: failure.detail, retryAt: failure.retryAt } : { etags, error: null, detail: null });
    if (failure) this.deps.log(`followed PRs: ${pr.owner}/${pr.repo}#${pr.number}: ${failure.kind}: ${failure.detail}`);
    this.broadcastPrs();
    if (itemsChanged) this.deps.broadcast({ type: "followed_pr_items", prId: id, items: store.items(id) });
    if (checksChanged) this.deps.broadcast({ type: "followed_pr_checks", prId: id, checks: store.checks(id) });
    if (events.length > 0) {
      this.deps.broadcast({ type: "pr_events", prId: id, events: store.listEvents(id) });
      this.dispatch(store.getPr(id) ?? pr, events);
    }
  }

  // --- events → automations ------------------------------------------------------------------

  private dispatch(pr: StoredFollowedPr, events: PrEvent[]): void {
    const automations = this.deps.db.automations.list().filter((a) => a.enabled && a.trigger.type === "pr_event");
    if (automations.length === 0) return;
    const own = this.ownLogins(pr);
    for (const a of automations) {
      if (a.trigger.type !== "pr_event") continue;
      const t = a.trigger;
      if (t.follows.length > 0 && !t.follows.some((id) => pr.follows.includes(id))) continue;
      for (const e of events) {
        if (!t.events.includes(e.type)) continue;
        const why = filterReason(t.filters, a.action.type, pr, e, own, this.agentOpened(pr));
        if (why) {
          this.deps.log(`automation ${a.name}: ${pr.owner}/${pr.repo}#${pr.number} ${e.type} skipped: ${why}`);
          continue;
        }
        if (e.type === "synchronize" && a.limits.debounceSeconds > 0) this.debounce(a, pr.id, e);
        else void this.fire(a.id, pr.id, e);
      }
    }
  }

  /** Logins the PR is followed with: their comments, reviews and pushes are "own" activity. */
  private ownLogins(pr: StoredFollowedPr): Set<string> {
    const out = new Set<string>();
    for (const id of pr.follows) {
      const f = this.deps.db.followedPrs.getFollow(id);
      if (f) out.add(f.account.toLowerCase());
    }
    return out;
  }

  private debounce(a: Automation, prId: string, event: PrEvent): void {
    const key = `${a.id}:${prId}`;
    const prev = this.debounces.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      this.debounces.delete(key);
      void this.fire(a.id, prId, event);
    }, a.limits.debounceSeconds * 1000);
    this.debounces.set(key, { timer, event });
  }

  private async fire(automationId: string, prId: string, event: PrEvent, deferredSince?: number): Promise<void> {
    const automation = this.deps.db.automations.get(automationId);
    const pr = this.deps.db.followedPrs.getPr(prId);
    if (!automation || !automation.enabled || !pr) return;
    const headSha = event.type === "synchronize" ? pr.headSha : event.headSha;
    if (this.deps.db.automations.hasRunFor(automation.id, pr.id, event.type, headSha)) return;
    const ctx = this.context(pr, event);
    if (this.deps.db.automations.listActiveRuns(automation.id).length >= automation.limits.maxConcurrent) {
      const since = deferredSince ?? Date.now();
      if (Date.now() - since >= DEFERRED_MAX_MS) {
        this.deps.automations.recordSkipped(automation, "pr_event", `${automation.limits.maxConcurrent} run${automation.limits.maxConcurrent === 1 ? "" : "s"} still going after an hour of waiting.`, ctx);
        return;
      }
      if (!this.deferred.some((d) => d.automationId === automationId && d.prId === prId && d.event.type === event.type)) this.deferred.push({ automationId, prId, event, since });
      return;
    }
    const cap = this.capReason(automation, pr);
    if (cap) {
      this.deps.automations.recordSkipped(automation, "pr_event", cap, ctx);
      return;
    }
    await this.deps.automations.runForPr(automation, { ...ctx, event: { id: event.id, type: event.type, headSha } });
  }

  private capReason(automation: Automation, pr: StoredFollowedPr): string | null {
    if (automation.runsToday >= automation.limits.maxRunsPerDay) return `Daily cap reached (${automation.limits.maxRunsPerDay} runs in 24 hours).`;
    const onPr = this.deps.db.automations.countRunsForPrToday(automation.id, pr.id);
    if (onPr >= automation.limits.maxRunsPerPrPerDay) return `Cap for this PR reached (${automation.limits.maxRunsPerPrPerDay} runs in 24 hours).`;
    return null;
  }

  private retryDeferred(): void {
    if (this.deferred.length === 0) return;
    const batch = this.deferred.splice(0);
    for (const d of batch) void this.fire(d.automationId, d.prId, d.event, d.since);
  }

  private context(pr: StoredFollowedPr, event: PrEvent): PrRunContext {
    return {
      event: { id: event.id, type: event.type, headSha: event.headSha },
      followedPrId: pr.id,
      prUrl: pr.url,
      prTitle: pr.title,
      pr: { number: pr.number, title: pr.title, url: pr.url, repo: `${pr.owner}/${pr.repo}`, headSha: pr.headSha, headRef: pr.headRef, baseRef: pr.baseRef, author: pr.author },
      eventLabel: eventLabel(event),
      attachedSessionIds: this.deps.db.prs.findAll(pr).map((p) => p.sessionId),
    };
  }

  // --- actions -------------------------------------------------------------------------------

  /** `attach`: the PR goes to every Session that has its head branch checked out from its repository. */
  private async attachAction(ctx: PrRunContext): Promise<{ skipped: string } | { done: string; sessionId?: string }> {
    const pr = ctx.followedPrId ? this.deps.db.followedPrs.getPr(ctx.followedPrId) : null;
    if (!pr) return { skipped: "No followed pull request in hand." };
    const targets = this.deps.sessions.list().filter((s) => s.repos.some((r) => r.status === "ready" && r.git?.branch === pr.headRef && sourceIs(r.source, pr)));
    if (targets.length === 0) return { skipped: `No Session has ${pr.headRef} of ${pr.headRepo} checked out.` };
    const already = new Set(this.deps.db.prs.findAll(pr).map((p) => p.sessionId));
    const fresh = targets.filter((s) => !already.has(s.id));
    if (fresh.length === 0) return { done: `Already attached to ${targets.map((s) => `“${s.title}”`).join(", ")}.`, sessionId: targets[0]!.id };
    for (const s of fresh) await this.deps.attach(s.id, pr.url, "agent");
    this.broadcastPrs();
    return { done: `Attached to ${fresh.map((s) => `“${s.title}”`).join(", ")}.`, sessionId: fresh[0]!.id };
  }

  /** The PR's head branch of its head repository, cloned with the follow's login. */
  private async headRepo(repo: string, number: number, followedPrId: string | undefined): Promise<RepoSpec> {
    const pr = followedPrId ? this.deps.db.followedPrs.getPr(followedPrId) : null;
    if (!pr) throw new Error(`${repo}#${number} is not a followed pull request; follow its repository on the Pull requests page first.`);
    if (pr.headRef === "" || pr.headRepo === "") throw new Error(`${repo}#${number}: its head is not known yet (the PR has not been read in detail).`);
    const via = this.credentialFor(pr);
    // A fork's branch is fetched as the base repository's PR ref (`refs/pull/{n}/head`, `refs/pull-requests/{n}/from`):
    // the fork may be private or gone, and the box then needs no credential for the fork.
    const ref = pr.isFork ? prRefspec(pr.provider, pr.number) : pr.headRef;
    if (pr.provider === "github") {
      const full = pr.isFork ? `${pr.owner}/${pr.repo}` : pr.headRepo;
      return { name: pr.repo, source: { type: "git", url: `https://github.com/${full}.git`, ref }, account: pr.isFork ? null : (via?.cred.account ?? null) };
    }
    const [project, slug] = pr.isFork ? [pr.owner, pr.repo] : pr.headRepo.split("/");
    return { name: pr.repo, source: { type: "git", url: bitbucketHttpsCloneUrl({ host: pr.host, project: project ?? pr.owner, slug: slug ?? pr.repo }), ref } };
  }

  /** Whether an Agent (a Session of this Control Plane) opened the PR: the `not_self` filter skips those, not the user's own hand-made PRs. */
  private agentOpened(pr: StoredFollowedPr): boolean {
    return this.deps.db.prs.findAll(pr).some((p) => p.attachedBy === "agent");
  }

  // --- broadcasts ----------------------------------------------------------------------------

  private broadcastFollows(): void {
    this.deps.broadcast({ type: "pr_follows", follows: this.listFollows() });
  }

  /** Re-sends the PR list (a run's result changed what a PR shows). */
  announce(_prId: string): void {
    this.broadcastPrs();
  }

  private broadcastPrs(): void {
    this.deps.broadcast({ type: "followed_prs", prs: this.list() });
  }
}

// --- helpers ---------------------------------------------------------------------------------

function publicFollow(f: StoredFollow): PrFollow {
  const { etags: _etags, webhookSecret: _secret, webhookId: _hookId, webhookUrl: _url, ...rest } = f;
  return rest;
}

function ghMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    return parsed.message ?? null;
  } catch {
    return null;
  }
}

export function describeFollow(f: Pick<PrFollow, "provider" | "host" | "account" | "kind" | "owner" | "repo">): string {
  const where = f.provider === "github" ? "" : ` on ${f.host}`;
  if (f.kind === "repo") return `${f.owner}/${f.repo}${where} (as @${f.account})`;
  return `${f.kind === "mine" ? "PRs opened by" : "reviews requested from"} @${f.account}${where}`;
}

function accountKey(f: Pick<PrFollow, "provider" | "host" | "account">): string {
  return `${f.provider}:${f.host.toLowerCase()}:${f.account.toLowerCase()}`;
}

function prAccountKey(pr: StoredFollowedPr): string {
  return `${pr.provider}:${pr.host.toLowerCase()}`;
}

function backoff(kind: NonNullable<PullRequest["syncError"]>): string | null {
  return kind === "rate_limited" || kind === "error" ? new Date(Date.now() + BACKOFF_MS).toISOString() : null;
}

function stateEvents(from: PullRequest["state"], to: PullRequest["state"], headSha: string): PendingEvent[] {
  if (from === to) return [];
  const e = (type: PrEvent["type"]): PendingEvent => ({ type, headSha, actor: null, ref: null });
  if (to === "merged") return [e("merged")];
  if (to === "closed") return [e("closed")];
  if (from === "merged" || from === "closed") return [e("reopened")];
  if (from === "draft" && to === "open") return [e("ready_for_review")];
  if (from === "open" && to === "draft") return [e("converted_to_draft")];
  return [];
}

function eventLabel(e: PrEvent): string {
  const base = PR_EVENT_LABELS[e.type];
  if (e.type === "check_failed" && e.ref) return `${base}: ${e.ref}`;
  if (e.type === "review_requested" && e.ref) return `${base}: @${e.ref}`;
  if (e.actor && (e.type === "comment" || e.type === "review_submitted")) return `${base} by @${e.actor}`;
  return base;
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

const normLogin = (s: string): string => s.trim().replace(/^@/, "").toLowerCase();

/** `org/slug` matches that team, a bare `slug` that team of any org, a login itself; all case-insensitive. */
function sameReviewer(wanted: string, actual: string): boolean {
  const w = normLogin(wanted);
  const a = normLogin(actual);
  return w === a || (a.includes("/") && !w.includes("/") && a.endsWith(`/${w}`));
}

function loginList(list: string[]): string {
  return list.map((l) => `@${normLogin(l)}`).join(", ");
}

/** Why the trigger's filters keep an event from firing, or `null` to fire. */
export function filterReason(filters: PrEventFilters, action: Automation["action"]["type"], pr: StoredFollowedPr, e: PrEvent, own: Set<string>, agentOpened = false): string | null {
  if (pr.state === "draft" && filters.drafts === "skip" && e.type !== "converted_to_draft") return "the PR is a draft";
  if (pr.isFork) {
    if (filters.forks === "skip") return "the PR comes from a fork";
    if (filters.forks === "review_only" && action !== "auto_review" && action !== "notify") return "the PR comes from a fork (only reviews and notifications run on forks)";
  }
  const selfAuthored = own.has(pr.author.toLowerCase());
  if (filters.authors === "not_self" && selfAuthored && agentOpened) return `@${pr.author} (the follow's own login) opened it from a Session`;
  if (filters.authors === "self_only" && !selfAuthored) return `@${pr.author} is not the follow's own login`;
  if (filters.authorLogins && filters.authorLogins.length > 0 && !filters.authorLogins.some((l) => normLogin(l) === normLogin(pr.author))) {
    return `@${pr.author} is not among the authors ${loginList(filters.authorLogins)}`;
  }
  const wantedReviewers = filters.reviewers ?? [];
  if (wantedReviewers.length > 0) {
    const asked = e.type === "review_requested" && e.ref ? [e.ref] : pr.requestedReviewers;
    if (!asked.some((r) => wantedReviewers.some((w) => sameReviewer(w, r)))) {
      return e.type === "review_requested" && e.ref ? `the review was asked of @${e.ref}, not of ${loginList(wantedReviewers)}` : `none of ${loginList(wantedReviewers)} is asked to review it`;
    }
  }
  if (!filters.includeOwn && e.actor && own.has(e.actor.toLowerCase())) return `@${e.actor} (the follow's own login) caused it`;
  if (filters.baseRef && !globToRegExp(filters.baseRef).test(pr.baseRef)) return `the base branch ${pr.baseRef} does not match ${filters.baseRef}`;
  if (filters.titleMatch) {
    try {
      if (!new RegExp(filters.titleMatch).test(pr.title)) return `the title does not match /${filters.titleMatch}/`;
    } catch {
      return "the title pattern cannot be read";
    }
  }
  if (filters.labels && filters.labels.length > 0 && !filters.labels.some((l) => pr.labels.includes(l))) return `none of the labels ${filters.labels.join(", ")} is on it`;
  return null;
}

/** The Session's repository is the PR's base or head repository. */
function sourceIs(source: Session["repos"][number]["source"], pr: StoredFollowedPr): boolean {
  if (source.type !== "git") return false;
  const url = source.url.toLowerCase();
  const names = [`${pr.owner}/${pr.repo}`, pr.headRepo].filter((n) => n !== "").map((n) => n.toLowerCase());
  if (pr.provider === "bitbucket") {
    const parsed = parseBitbucketRemote(source.url);
    return parsed !== null && parsed.host === pr.host.toLowerCase() && names.includes(`${parsed.project}/${parsed.slug}`.toLowerCase());
  }
  return names.some((n) => url.includes(`github.com/${n}.git`) || url.endsWith(`github.com/${n}`) || url.includes(`github.com:${n}.git`) || url.endsWith(`github.com:${n}`));
}

/** The first prompt of a Session started from a PR by hand, when the user gave none. */
function prBrief(pr: StoredFollowedPr): string {
  return [
    `You are in a checkout of the pull request ${prUrl(pr)} (#${pr.number}, "${pr.title}" by @${pr.author}; branch ${pr.headRef} into ${pr.baseRef}).`,
    "Read the PR's description and its diff against the base branch, then wait for my instructions.",
  ].join("\n");
}
