// Characterization tests (Feathers) for `Automations` — the one control-plane class that acts on a
// timer, and the only one of its size with no tests (docs/TECH-DEBT.md, fix 9). It is driven through
// its public surface (what the routes and the followed-PR side call) with a real SQLite Db and a fake
// `AutomationSessions` that records prompts, creations and stops. `tick()` is private in TypeScript
// but reachable from here, which is the cheapest seam to its clock: a due time is written to the
// row, then one tick runs. Expected values are hand-computed or observed, never recomputed from the
// code. Run after `tsc -b`.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../apps/control-plane/dist/db.js";
import { HttpError } from "../apps/control-plane/dist/http-error.js";
import { Automations, automationOfSchedule, fillPlaceholders, needsPr, parseCron, scheduleOf, scheduleRunOf } from "../apps/control-plane/dist/automations.js";
import { sessionRow } from "./fixtures.mjs";

const MINUTE = 60_000;

/** Lets the `void`ed continuations (execute, onSettled) run. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const engines = [];
after(() => {
  for (const e of engines) e.stop();
});

/** An `Automations` on an in-memory Db with every side channel captured. */
function makeAutomations() {
  const db = new Db(":memory:");
  const log = [];
  const broadcasts = [];
  const pushes = [];
  const prompted = [];
  const created = [];
  const stopped = [];
  const settledHandlers = [];
  const subscribers = [];
  const sessions = {
    /** What `promptScheduled` answers: "sent" | "queued" | "resumed". */
    promptHow: "sent",
    get(id) {
      const s = db.getSession(id);
      if (!s) throw new HttpError(404, `session ${id} not found`);
      return s;
    },
    async create(req) {
      created.push(req);
      const row = sessionRow(`new${created.length}`, { title: req.title ?? `New Session ${created.length}` });
      db.insertSession(row);
      return row;
    },
    async promptScheduled(id, text) {
      prompted.push({ id, text });
      return sessions.promptHow;
    },
    async stop(id) {
      stopped.push(id);
      return sessions.get(id);
    },
    onTurnSettled(fn) {
      settledHandlers.push(fn);
      return () => {};
    },
    subscribe(fn) {
      subscribers.push(fn);
      return () => {};
    },
  };
  const automations = new Automations({
    db,
    sessions,
    broadcast: (msg) => broadcasts.push(msg),
    push: (msg) => pushes.push(msg),
    log: (msg) => log.push(msg),
  });
  engines.push(automations);
  return {
    db,
    automations,
    sessions,
    log,
    broadcasts,
    pushes,
    prompted,
    created,
    stopped,
    addSession(id, overrides = {}) {
      const row = sessionRow(id, overrides);
      db.insertSession(row);
      return row;
    },
    /** The Session's turn settled with `outcome` (what `SessionManager.onTurnSettled` fires). */
    async settle(sessionId, outcome) {
      for (const fn of settledHandlers) fn(sessionId, outcome);
      await flush();
    },
    /** A `SessionBroadcast` as the manager would publish it. */
    async emit(msg) {
      for (const fn of subscribers) fn(msg);
      await flush();
    },
    runsOf(automationId) {
      return db.automations.listRuns(automationId);
    },
  };
}

const schedule = (cron = "0 9 * * *", extra = {}) => ({ type: "schedule", cron, timezone: "UTC", missedRun: "skip", ...extra });
const prompt = (sessionId, text = "Good morning") => ({ type: "prompt", sessionId, text });
const limits = { maxConcurrent: 2, maxRunsPerDay: 20, maxRunsPerPrPerDay: 4, debounceSeconds: 120, timeoutMinutes: 360 };
const request = (trigger, action, extra = {}) => ({ name: "Daily", enabled: true, trigger, action, limits, ...extra });

const status400 = (message) => (e) => e instanceof HttpError && e.status === 400 && e.message === message;

// --- parseCron / preview -----------------------------------------------------------------------

test("parseCron: an unknown time zone and an unreadable expression are 400s with a hint", () => {
  assert.throws(() => parseCron("0 9 * * *", "Mars/Olympus"), status400('Unknown time zone "Mars/Olympus"; use an IANA name such as Europe/Madrid.'));
  assert.throws(
    () => parseCron("0 25 * * *", "UTC"),
    (e) => e instanceof HttpError && e.status === 400 && e.message.startsWith("Cannot read the cron expression: ") && !e.message.includes("CronPattern:"),
  );
});

test("parseCron: the expression is read in the zone, across the DST change (Europe/Madrid, 29 Mar 2026)", () => {
  const job = parseCron("0 9 * * *", "Europe/Madrid");
  // 28 Mar is still CET (UTC+1): 09:00 local = 08:00Z. 29 Mar is CEST (UTC+2): 09:00 local = 07:00Z.
  assert.equal(job.nextRun(new Date("2026-03-27T12:00:00Z")).toISOString(), "2026-03-28T08:00:00.000Z");
  assert.equal(job.nextRun(new Date("2026-03-28T12:00:00Z")).toISOString(), "2026-03-29T07:00:00.000Z");
});

test("preview: three next runs on success, the 400 message as `error` otherwise", () => {
  const { automations } = makeAutomations();
  const ok = automations.preview("*/15 * * * *", "UTC");
  assert.equal(ok.ok, true);
  assert.equal(ok.next.length, 3);
  const minutes = ok.next.map((iso) => new Date(iso).getUTCMinutes() % 15);
  assert.deepEqual(minutes, [0, 0, 0]);
  assert.equal(new Date(ok.next[1]) - new Date(ok.next[0]), 15 * MINUTE);
  const bad = automations.preview("nope", "UTC");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^Cannot read the cron expression: .*'nope'/);
});

// --- Placeholders and the schedule aliases -----------------------------------------------------

const PR = { number: 42, title: "Fix the thing", url: "https://github.com/acme/app/pull/42", repo: "acme/app", headSha: "abc123", headRef: "fix", baseRef: "main", author: "jane" };

test("fillPlaceholders: PR fields and {event} are filled; unknown or unavailable ones stay as written", () => {
  assert.equal(fillPlaceholders("#{pr.number} {pr.title} by {pr.author} ({pr.headRef}→{pr.baseRef}) {event}", { pr: PR, eventLabel: "opened" }), "#42 Fix the thing by jane (fix→main) opened");
  assert.equal(fillPlaceholders("{pr.nope} {pr.number}", { pr: PR }), "{pr.nope} 42");
  assert.equal(fillPlaceholders("{pr.number} {event}", {}), "{pr.number} {event}");
});

test("needsPr: auto_review, auto_qa, attach and prompt-to-attached need a PR; the rest do not", () => {
  assert.equal(needsPr({ type: "attach" }), true);
  assert.equal(needsPr(prompt("attached")), true);
  assert.equal(needsPr(prompt("s1")), false);
  assert.equal(needsPr({ type: "notify" }), false);
});

test("scheduleOf: only schedule-triggered prompt/new_session automations have a schedule view; queued shows as running", () => {
  const base = { id: "a1", name: "Daily", enabled: true, nextRunAt: "2026-01-02T09:00:00.000Z", lastRunAt: null, lastStatus: "queued", runsToday: 0, createdAt: "c", updatedAt: "u", limits };
  const view = scheduleOf({ ...base, trigger: schedule(), action: prompt("s1") });
  assert.deepEqual(view, {
    id: "a1",
    name: "Daily",
    cron: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    missedPolicy: "skip",
    action: { type: "prompt", sessionId: "s1", text: "Good morning" },
    nextRunAt: "2026-01-02T09:00:00.000Z",
    lastRunAt: null,
    lastStatus: "running",
    createdAt: "c",
    updatedAt: "u",
  });
  assert.equal(scheduleOf({ ...base, trigger: { type: "pr_event", follows: [], events: ["opened"], filters: {} }, action: prompt("s1") }), null);
  assert.equal(scheduleOf({ ...base, trigger: schedule(), action: prompt("attached") }), null);
  assert.equal(scheduleOf({ ...base, trigger: schedule(), action: { type: "notify" } }), null);
});

test("scheduleRunOf: a pr_event run reads as manual, queued as running, startedAt falls back to queuedAt", () => {
  const run = { id: "r1", automationId: "a1", trigger: "pr_event", status: "queued", queuedAt: "q", startedAt: null, finishedAt: null, detail: null, error: null, sessionId: null };
  assert.deepEqual(scheduleRunOf(run), { id: "r1", scheduleId: "a1", trigger: "manual", status: "running", startedAt: "q", finishedAt: null, detail: null, error: null, sessionId: null });
});

test("automationOfSchedule: the legacy schedule request becomes a schedule-triggered automation with the default limits", () => {
  const req = { name: "Nightly", enabled: true, cron: "0 2 * * *", timezone: "UTC", missedPolicy: "catch_up", action: { type: "new_session", provider: "claude-code", repos: [], settings: {}, prompt: "Go", stopAfter: true } };
  assert.deepEqual(automationOfSchedule(req), {
    name: "Nightly",
    enabled: true,
    trigger: { type: "schedule", cron: "0 2 * * *", timezone: "UTC", missedRun: "catch_up" },
    action: { ...req.action, checkoutPrHead: true },
    limits,
  });
  assert.deepEqual(automationOfSchedule({ ...req, action: prompt("s1") }).action, prompt("s1"));
});

// --- create / update / delete --------------------------------------------------------------------

test("create: a schedule gets its next run, the name is trimmed, the list is broadcast", () => {
  const h = makeAutomations();
  h.addSession("s1");
  const before = Date.now();
  const a = h.automations.create(request(schedule("0 9 * * *"), prompt("s1"), { name: "  Daily  " }));
  assert.equal(a.name, "Daily");
  assert.equal(a.enabled, true);
  assert.ok(a.nextRunAt && new Date(a.nextRunAt).getTime() > before);
  assert.equal(new Date(a.nextRunAt).getUTCHours(), 9);
  assert.deepEqual(h.broadcasts.map((b) => b.type), ["automations"]);
  assert.deepEqual(h.broadcasts[0].automations.map((x) => x.id), [a.id]);
});

test("create: a disabled schedule, a PR trigger and a manual trigger have no next run", () => {
  const h = makeAutomations();
  h.addSession("s1");
  assert.equal(h.automations.create(request(schedule(), prompt("s1"), { enabled: false })).nextRunAt, null);
  assert.equal(h.automations.create(request({ type: "manual" }, prompt("s1"))).nextRunAt, null);
  assert.equal(h.automations.create(request({ type: "pr_event", follows: [], events: ["opened"], filters: {} }, { type: "notify" })).nextRunAt, null);
});

test("create: the cron is trimmed and validated with the time zone", () => {
  const h = makeAutomations();
  h.addSession("s1");
  assert.equal(h.automations.create(request(schedule(" 0 9 * * * "), prompt("s1"))).trigger.cron, "0 9 * * *");
  assert.throws(() => h.automations.create(request(schedule("0 9 * * *", { timezone: "Nowhere/City" }), prompt("s1"))), status400('Unknown time zone "Nowhere/City"; use an IANA name such as Europe/Madrid.'));
});

test("create: the action is checked against the trigger and the Sessions that exist", () => {
  const h = makeAutomations();
  h.addSession("s1");
  assert.throws(() => h.automations.create(request(schedule(), prompt("ghost"))), status400("Session ghost does not exist."));
  assert.throws(() => h.automations.create(request(schedule(), prompt("attached"))), status400('"The Session the PR is attached to" only works with a pull request trigger.'));
  assert.throws(() => h.automations.create(request(schedule(), { type: "attach" })), status400('The "attach" action needs a pull request trigger.'));
  assert.throws(
    () => h.automations.create(request({ type: "manual" }, { type: "auto_review", verdict: "comment", provider: "claude-code", settings: {}, instructions: "", stopAfter: true })),
    status400('The "auto review" action needs a pull request trigger.'),
  );
  assert.equal(h.automations.list().length, 0);
});

test("create: a PR trigger needs follows that exist (asked of the followed-PR side) and a readable title pattern", () => {
  const h = makeAutomations();
  const pr = (extra) => ({ type: "pr_event", follows: [], events: ["opened"], filters: {}, ...extra });
  assert.throws(() => h.automations.create(request(pr({ follows: ["f1"] }), { type: "notify" })), status400("Follow f1 does not exist."));
  h.automations.followExists = (id) => id === "f1";
  assert.equal(h.automations.create(request(pr({ follows: ["f1"] }), { type: "notify" })).trigger.follows[0], "f1");
  assert.throws(
    () => h.automations.create(request(pr({ filters: { titleMatch: "(" } }), { type: "notify" })),
    (e) => e instanceof HttpError && e.status === 400 && e.message.startsWith("Cannot read the title pattern: "),
  );
});

test("create: the repositories of a New Session action are remembered as suggestions", () => {
  const h = makeAutomations();
  const action = {
    type: "new_session",
    provider: "claude-code",
    repos: [{ name: "app", source: { type: "git", url: "https://github.com/acme/app.git" } }],
    settings: {},
    prompt: "Go",
    stopAfter: true,
    checkoutPrHead: true,
  };
  h.automations.create(request(schedule(), action));
  // The store keeps the location in its canonical form: no `.git` suffix.
  assert.deepEqual(
    h.db.repos.list().map((r) => [r.kind, r.location]),
    [["git", "https://github.com/acme/app"]],
  );
});

test("update: only a timing change recomputes the next run; disabling clears it; unknown ids are 404", () => {
  const h = makeAutomations();
  h.addSession("s1");
  const a = h.automations.create(request(schedule("0 9 * * *"), prompt("s1")));
  const renamed = h.automations.update(a.id, { name: "Morning" });
  assert.equal(renamed.name, "Morning");
  assert.equal(renamed.nextRunAt, a.nextRunAt);
  const moved = h.automations.update(a.id, { trigger: schedule("0 10 * * *") });
  assert.equal(new Date(moved.nextRunAt).getUTCHours(), 10);
  assert.equal(h.automations.update(a.id, { enabled: false }).nextRunAt, null);
  assert.ok(h.automations.update(a.id, { enabled: true }).nextRunAt);
  assert.throws(() => h.automations.update("ghost", { name: "x" }), (e) => e instanceof HttpError && e.status === 404);
});

test("delete: removes the row and broadcasts; unknown ids are 404", () => {
  const h = makeAutomations();
  h.addSession("s1");
  const a = h.automations.create(request(schedule(), prompt("s1")));
  h.broadcasts.length = 0;
  h.automations.delete(a.id);
  assert.deepEqual(h.automations.list(), []);
  assert.deepEqual(h.broadcasts, [{ type: "automations", automations: [] }]);
  assert.throws(() => h.automations.delete(a.id), (e) => e instanceof HttpError && e.status === 404);
});

// --- Run now ---------------------------------------------------------------------------------------

test("runNow prompt: prompts the Session, the run stays running until the turn settles, then succeeds", async () => {
  const h = makeAutomations();
  h.automations.start();
  h.addSession("s1");
  const a = h.automations.create(request(schedule(), prompt("s1", "Good morning")));
  const run = await h.automations.runNow(a.id);
  assert.deepEqual(h.prompted, [{ id: "s1", text: "Good morning" }]);
  assert.equal(run.trigger, "manual");
  assert.equal(run.status, "running");
  assert.equal(run.sessionId, "s1");
  assert.equal(run.detail, "Prompt sent.");
  assert.deepEqual(run.result, { type: "prompt", how: "sent" });
  assert.equal(h.automations.runningCount(a.id), 1);

  await h.settle("s1", "end_turn");
  const done = h.runsOf(a.id)[0];
  assert.equal(done.status, "succeeded");
  assert.ok(done.finishedAt);
  assert.equal(h.automations.runningCount(a.id), 0);
  assert.equal(h.automations.list()[0].lastStatus, "succeeded");
  assert.deepEqual(h.pushes, []);
  assert.ok(h.broadcasts.some((b) => b.type === "automation_runs" && b.automationId === a.id));
});

test("runNow prompt: a Session busy with a turn gets the prompt queued, and the run says so", async () => {
  const h = makeAutomations();
  h.addSession("s1");
  h.sessions.promptHow = "queued";
  const a = h.automations.create(request(schedule(), prompt("s1")));
  const run = await h.automations.runNow(a.id);
  assert.equal(run.detail, "Queued behind the running turn; sent when it ends.");
  assert.deepEqual(run.result, { type: "prompt", how: "queued" });
  h.sessions.promptHow = "resumed";
  assert.equal((await h.automations.runNow(a.id)).detail, "Sandbox resumed; the prompt goes out once the Daemon is up.");
});

test("runNow: a failed, errored or deleted Session fails its tracked run with a reason, and pushes a notification", async () => {
  const h = makeAutomations();
  h.automations.start();
  h.addSession("s1");
  const a = h.automations.create(request(schedule(), prompt("s1")));

  await h.automations.runNow(a.id);
  await h.settle("s1", "usage_limit");
  assert.equal(h.runsOf(a.id)[0].error, "The Provider's usage limit was hit; the Session offers Continue / Auto-continue.");

  await h.automations.runNow(a.id);
  await h.settle("s1", "error");
  assert.equal(h.runsOf(a.id)[0].error, "The Agent reported an error.");

  await h.automations.runNow(a.id);
  await h.settle("s1", "cancelled");
  assert.equal(h.runsOf(a.id)[0].error, 'The turn ended with "cancelled".');

  await h.automations.runNow(a.id);
  await h.emit({ type: "session", session: { ...h.sessions.get("s1"), status: "stopped" } });
  assert.equal(h.runsOf(a.id)[0].error, "The Session was stopped before the turn ended.");

  await h.automations.runNow(a.id);
  await h.emit({ type: "session", session: { ...h.sessions.get("s1"), status: "error", error: "boom" } });
  assert.equal(h.runsOf(a.id)[0].error, "boom");

  await h.automations.runNow(a.id);
  await h.emit({ type: "session_deleted", id: "s1" });
  assert.equal(h.runsOf(a.id)[0].error, "The Session was deleted.");

  assert.equal(h.runsOf(a.id).every((r) => r.status === "failed"), true);
  assert.equal(h.pushes.length, 6);
  assert.deepEqual(h.pushes[0], { title: "Automation failed: Daily", body: h.runsOf(a.id).at(-1).error, tag: `sessionboxer-automation-${a.id}`, url: `#/automations/${a.id}` });
});

test("runNow notify: pushes the automation's name with the text (or 'Run now'), and the run is over at once", async () => {
  const h = makeAutomations();
  const a = h.automations.create(request({ type: "manual" }, { type: "notify" }));
  const run = await h.automations.runNow(a.id);
  assert.equal(run.status, "succeeded");
  assert.equal(run.detail, "Notified.");
  assert.deepEqual(run.result, { type: "notify" });
  assert.deepEqual(h.pushes, [{ title: "Daily", body: "Run now", tag: `sessionboxer-automation-${a.id}`, url: `#/automations/${a.id}` }]);
  const b = h.automations.create(request({ type: "manual" }, { type: "notify", text: "Coffee" }));
  await h.automations.runNow(b.id);
  assert.equal(h.pushes[1].body, "Coffee");
});

test("runNow new_session: creates the Session from the template, tracks it, stops it afterwards when asked", async () => {
  const h = makeAutomations();
  h.automations.start();
  const action = { type: "new_session", title: "Nightly build", provider: "codex", repos: [], settings: {}, prompt: "Build it", stopAfter: true, checkoutPrHead: true };
  const a = h.automations.create(request(schedule(), action));
  const run = await h.automations.runNow(a.id);
  assert.deepEqual(h.created, [{ title: "Nightly build", provider: "codex", repos: [], workspaceSource: { type: "empty" }, settings: {}, prompt: "Build it" }]);
  assert.equal(run.status, "running");
  assert.equal(run.sessionId, "new1");
  assert.equal(run.detail, 'Session "Nightly build" started.');

  await h.settle("new1", "end_turn");
  const done = h.runsOf(a.id)[0];
  assert.equal(done.status, "succeeded");
  assert.equal(done.detail, 'Session "Nightly build" started. Sandbox stopped afterwards.');
  assert.deepEqual(h.stopped, ["new1"]);
});

test("runNow new_session: from a Snapshot the template's repos are not cloned", async () => {
  const h = makeAutomations();
  const action = { type: "new_session", provider: "claude-code", repos: [{ name: "app", source: { type: "git", url: "https://x/app.git" } }], snapshotId: "snap1", settings: {}, prompt: "Go", stopAfter: false, checkoutPrHead: true };
  const a = h.automations.create(request(schedule(), action));
  await h.automations.runNow(a.id);
  assert.deepEqual(h.created[0].repos, []);
  assert.equal(h.created[0].snapshotId, "snap1");
  assert.equal(h.created[0].title, undefined);
});

test("runNow: an action with no runner on this Control Plane fails its run with a clear message", async () => {
  const h = makeAutomations();
  h.automations.followExists = () => true;
  const a = h.automations.create(request({ type: "pr_event", follows: [], events: ["opened"], filters: {} }, { type: "auto_qa", provider: "claude-code", settings: {}, instructions: "", publish: "link_only", stopAfter: true }));
  await assert.rejects(() => h.automations.runNow(a.id), status400('"Daily" reacts to pull request events; run it from a PR on the Pull requests page.'));
  const run = await h.automations.runForPr(a, { pr: PR, event: { id: "e1", type: "opened", headSha: PR.headSha }, followedPrId: "fp1", prUrl: PR.url, prTitle: PR.title });
  assert.equal(run.status, "failed");
  assert.equal(run.error, 'The "auto qa" action is not available on this Control Plane.');
  assert.equal(run.followedPrId, "fp1");
  assert.deepEqual(run.event, { id: "e1", type: "opened", headSha: "abc123" });
});

test("recordSkipped: a run that did not happen is kept with its reason", () => {
  const h = makeAutomations();
  const a = h.automations.create(request({ type: "manual" }, { type: "notify" }));
  const run = h.automations.recordSkipped(a, "pr_event", "Already ran at this head.");
  assert.equal(run.status, "skipped");
  assert.equal(run.detail, "Already ran at this head.");
  assert.ok(run.finishedAt);
});

// --- The tick ----------------------------------------------------------------------------------------

/** The last minute boundary at or before `now`, minus `minutes`. */
function minutesAgo(minutes, now = Date.now()) {
  return new Date(Math.floor(now / MINUTE) * MINUTE - minutes * MINUTE);
}

test("tick: a schedule whose time has come runs once, and its next run moves on", async () => {
  const h = makeAutomations();
  h.addSession("s1");
  const a = h.automations.create(request(schedule("* * * * *"), prompt("s1")));
  const due = minutesAgo(1);
  h.db.automations.update(a.id, { nextRunAt: due.toISOString() });
  await h.automations.tick();
  await flush();
  const runs = h.runsOf(a.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, "cron");
  assert.deepEqual(h.prompted, [{ id: "s1", text: "Good morning" }]);
  const next = new Date(h.automations.get(a.id).nextRunAt);
  assert.ok(next.getTime() > Date.now() && next.getTime() <= Date.now() + MINUTE);
  await h.automations.tick();
  assert.equal(h.runsOf(a.id).length, 1);
});

test("tick: a run missed by more than the grace is skipped or caught up by the missed policy, counting the occurrences", async () => {
  const h = makeAutomations();
  h.addSession("s1");
  const skip = h.automations.create(request(schedule("* * * * *", { missedRun: "skip" }), prompt("s1")));
  const catchUp = h.automations.create(request(schedule("* * * * *", { missedRun: "catch_up" }), prompt("s1"), { name: "Catch" }));
  const due = minutesAgo(10);
  h.db.automations.update(skip.id, { nextRunAt: due.toISOString() });
  h.db.automations.update(catchUp.id, { nextRunAt: due.toISOString() });
  await h.automations.tick();
  await flush();

  const skipped = h.runsOf(skip.id)[0];
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.trigger, "cron");
  assert.match(skipped.detail, /^Skipped: the run due \d{1,2} \w{3} \d{4}, \d{2}:\d{2} \(UTC\) and 10 more while the Control Plane was not running\.$/);

  const caught = h.runsOf(catchUp.id)[0];
  assert.equal(caught.status, "running");
  assert.equal(caught.trigger, "catch_up");
  assert.match(caught.detail, /^Catching up: the run due .* \(UTC\) and 10 more\. Prompt sent\.$/);
  assert.equal(h.prompted.length, 1);
  assert.ok(h.log.some((l) => l.endsWith("skipped 11 missed run(s)")));
});

test("tick: disabled or unscheduled automations are left alone; a schedule without a next run gets one", async () => {
  const h = makeAutomations();
  h.addSession("s1");
  const off = h.automations.create(request(schedule("* * * * *"), prompt("s1"), { enabled: false }));
  const manual = h.automations.create(request({ type: "manual" }, prompt("s1")));
  const blank = h.automations.create(request(schedule("* * * * *"), prompt("s1")));
  h.db.automations.update(blank.id, { nextRunAt: null });
  await h.automations.tick();
  await flush();
  assert.deepEqual(h.prompted, []);
  assert.equal(h.automations.get(off.id).nextRunAt, null);
  assert.equal(h.automations.get(manual.id).nextRunAt, null);
  assert.ok(h.automations.get(blank.id).nextRunAt);
});

test("start: runs left running by a previous Control Plane are failed, since nobody can follow them any more", () => {
  const h = makeAutomations();
  const a = h.automations.create(request({ type: "manual" }, { type: "notify" }));
  h.db.automations.insertRun(a.id, "manual", "running");
  h.automations.start();
  const run = h.runsOf(a.id)[0];
  assert.equal(run.status, "failed");
  assert.equal(run.error, "The Control Plane restarted while the run was in progress.");
});
