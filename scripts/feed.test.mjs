// Pins `feedReducer` (apps/web/src/feed.ts), the web UI's answer to each `/api/ws` message, one test
// per message type with hand-written before/after states. The web app is Vite's, not in `tsc -b`:
// Node strips the types itself (22.18+; CI runs Node 22), the only runtime import being the protocol
// built by `tsc -b`. Expected values are written by hand, never computed from the reducer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedReducer } from "../apps/web/src/feed.ts";

const PROVIDERS = ["claude-code", "devin", "codex", "cursor", "pi", "opencode", "fx", "kimi"];
const emptyPerProvider = () => Object.fromEntries(PROVIDERS.map((p) => [p, []]));

/** A Session row with the fields the sidebar order reads; the rest is irrelevant to the reducer. */
const session = (id, createdAt, pinned = false) => ({ id, title: `Session ${id}`, status: "idle", createdAt, pinned });
const A = session("a", "2026-01-01T00:00:00.000Z");
const B = session("b", "2026-01-02T00:00:00.000Z");
const C = session("c", "2026-01-03T00:00:00.000Z");
const event = (sessionId, seq) => ({ sessionId, seq, type: "status", status: "running" });

/** The page showing Session "a" with nothing loaded yet. */
function base(overrides = {}) {
  return {
    selectedId: "a",
    snapshotsFor: null,
    sessions: [B, A],
    folders: [],
    events: [],
    saved: [],
    snapshots: [],
    e2eRuns: [],
    dialogSnapshots: null,
    snapshotting: new Set(),
    settings: null,
    windowsBase: null,
    macosBase: null,
    models: null,
    options: null,
    prs: {},
    prItems: {},
    prChecks: {},
    automations: [],
    automationRuns: {},
    prFollows: [],
    followedPrs: [],
    fprItems: {},
    fprChecks: {},
    fprEvents: {},
    fprRuns: {},
    toasts: [],
    paneRequest: null,
    terminalFocus: null,
    fsChange: null,
    ...overrides,
  };
}

test("session: a new Session enters the list in sidebar order (pinned first, then newest first)", () => {
  const pinnedOld = session("p", "2025-12-01T00:00:00.000Z", true);
  assert.deepEqual(feedReducer(base(), { type: "session", session: pinnedOld }), base({ sessions: [pinnedOld, B, A] }));
  assert.deepEqual(feedReducer(base(), { type: "session", session: C }), base({ sessions: [C, B, A] }));
});

test("session: a known Session is replaced in place and the list re-sorted", () => {
  const aPinned = { ...A, pinned: true, title: "renamed" };
  assert.deepEqual(feedReducer(base(), { type: "session", session: aPinned }), base({ sessions: [aPinned, B] }));
  const bRunning = { ...B, status: "running" };
  assert.deepEqual(feedReducer(base(), { type: "session", session: bRunning }), base({ sessions: [bRunning, A] }));
});

test("session_deleted: the Session leaves the list; its attached PRs stay in `prs` (pinned as-is)", () => {
  const before = base({ prs: { a: [{ id: "pr-1" }], b: [] } });
  const after = feedReducer(before, { type: "session_deleted", id: "a" });
  assert.deepEqual(after, base({ sessions: [B], prs: { a: [{ id: "pr-1" }], b: [] } }));
});

test("folders: the whole list is replaced", () => {
  const folders = [{ id: "f1", name: "Work", kind: "manual" }];
  assert.deepEqual(feedReducer(base({ folders: [{ id: "f0", name: "Old", kind: "manual" }] }), { type: "folders", folders }), base({ folders }));
});

test("event: appended for the selected Session only, and only past the last seq", () => {
  const before = base({ events: [event("a", 1), event("a", 2)] });
  assert.deepEqual(feedReducer(before, { type: "event", event: event("a", 3) }), base({ events: [event("a", 1), event("a", 2), event("a", 3)] }));
  assert.equal(feedReducer(before, { type: "event", event: event("a", 2) }), before, "a replayed seq changes nothing");
  assert.equal(feedReducer(before, { type: "event", event: event("b", 3) }), before, "another Session's event changes nothing");
  assert.deepEqual(feedReducer(base(), { type: "event", event: event("a", 1) }), base({ events: [event("a", 1)] }), "the first event needs no last seq");
});

test("saved_messages: replaced for the selected Session, ignored for others", () => {
  const messages = [{ id: "m1", text: "hello" }];
  assert.deepEqual(feedReducer(base(), { type: "saved_messages", sessionId: "a", messages }), base({ saved: messages }));
  const before = base();
  assert.equal(feedReducer(before, { type: "saved_messages", sessionId: "b", messages }), before);
});

test("snapshots: the selected Session's list, the popup's list, both when they are the same Session, neither otherwise", () => {
  const snaps = [{ id: "s1", sessionId: "b" }];
  const withDialog = base({ snapshotsFor: "b" });
  assert.deepEqual(feedReducer(withDialog, { type: "snapshots", sessionId: "b", snapshots: snaps }), base({ snapshotsFor: "b", dialogSnapshots: snaps }));
  assert.deepEqual(feedReducer(withDialog, { type: "snapshots", sessionId: "a", snapshots: snaps }), base({ snapshotsFor: "b", snapshots: snaps }));
  assert.deepEqual(feedReducer(base({ snapshotsFor: "a" }), { type: "snapshots", sessionId: "a", snapshots: snaps }), base({ snapshotsFor: "a", snapshots: snaps, dialogSnapshots: snaps }));
  assert.equal(feedReducer(withDialog, { type: "snapshots", sessionId: "c", snapshots: snaps }), withDialog);
});

test("snapshotting: the Session joins the set while active and leaves it after", () => {
  const on = feedReducer(base(), { type: "snapshotting", sessionId: "b", active: true });
  assert.deepEqual(on, base({ snapshotting: new Set(["b"]) }));
  assert.deepEqual(feedReducer(on, { type: "snapshotting", sessionId: "b", active: false }), base({ snapshotting: new Set() }));
  assert.deepEqual(base().snapshotting, new Set(), "the previous set is not mutated");
});

test("snapshot_failed: nothing to remember (the hook shows the banner)", () => {
  const before = base();
  assert.equal(feedReducer(before, { type: "snapshot_failed", sessionId: "a", message: "disk full" }), before);
});

test("models: one Provider's list lands in a per-Provider map, empty for the others until they report", () => {
  const models = [{ id: "opus", label: "Opus" }];
  assert.deepEqual(feedReducer(base(), { type: "models", provider: "codex", models }), base({ models: { ...emptyPerProvider(), codex: models } }));
  const known = base({ models: { ...emptyPerProvider(), pi: [{ id: "x", label: "X" }] } });
  assert.deepEqual(feedReducer(known, { type: "models", provider: "codex", models }), base({ models: { ...emptyPerProvider(), pi: [{ id: "x", label: "X" }], codex: models } }));
});

test("options: same per-Provider map as the models", () => {
  const options = [{ id: "effort", label: "Effort", values: ["low", "high"] }];
  assert.deepEqual(feedReducer(base(), { type: "options", provider: "devin", options }), base({ options: { ...emptyPerProvider(), devin: options } }));
});

test("prs: the Session's attached Pull Requests are replaced, other Sessions' kept", () => {
  const before = base({ prs: { a: [{ id: "pr-1" }] } });
  assert.deepEqual(feedReducer(before, { type: "prs", sessionId: "b", prs: [{ id: "pr-2" }] }), base({ prs: { a: [{ id: "pr-1" }], b: [{ id: "pr-2" }] } }));
});

test("pr_items / pr_checks: only for a Pull Request whose detail was opened on the page", () => {
  const items = [{ id: "c1", body: "nit" }];
  const checks = [{ name: "ci", status: "failure" }];
  const opened = base({ prItems: { "pr-1": [] }, prChecks: { "pr-1": [] } });
  assert.deepEqual(feedReducer(opened, { type: "pr_items", sessionId: "a", prId: "pr-1", items }), base({ prItems: { "pr-1": items }, prChecks: { "pr-1": [] } }));
  assert.deepEqual(feedReducer(opened, { type: "pr_checks", sessionId: "a", prId: "pr-1", checks }), base({ prItems: { "pr-1": [] }, prChecks: { "pr-1": checks } }));
  const closed = base();
  assert.equal(feedReducer(closed, { type: "pr_items", sessionId: "a", prId: "pr-1", items }), closed);
  assert.equal(feedReducer(closed, { type: "pr_checks", sessionId: "a", prId: "pr-1", checks }), closed);
});

test("automations: the whole list is replaced", () => {
  const automations = [{ id: "au-1", name: "Nightly" }];
  assert.deepEqual(feedReducer(base(), { type: "automations", automations }), base({ automations }));
});

test("mcp_event_subscriptions: the live subscription list is replaced", () => {
  const subscriptions = [{ automationId: "au-1", state: "listening", mode: "push", error: null, lastEventAt: null, hasCursor: false }];
  assert.deepEqual(feedReducer(base(), { type: "mcp_event_subscriptions", subscriptions }), base({ mcpEventSubscriptions: subscriptions }));
});

test("automation_runs: the automation's history is replaced; a followed PR's opened runs merge the fresh ones in, newest first", () => {
  const r1 = { id: "r1", followedPrId: "fpr-1", queuedAt: "2026-02-01T10:00:00.000Z", status: "done" };
  const r2 = { id: "r2", followedPrId: "fpr-1", queuedAt: "2026-02-01T12:00:00.000Z", status: "running" };
  const r3 = { id: "r3", followedPrId: null, queuedAt: "2026-02-01T13:00:00.000Z", status: "queued" };
  const r1Done = { ...r1, status: "failed" };
  const before = base({ automationRuns: { "au-1": [r1] }, fprRuns: { "fpr-1": [r1], "fpr-2": [] } });
  const after = feedReducer(before, { type: "automation_runs", automationId: "au-1", runs: [r1Done, r2, r3] });
  assert.deepEqual(after, base({ automationRuns: { "au-1": [r1Done, r2, r3] }, fprRuns: { "fpr-1": [r2, r1Done], "fpr-2": [] } }));
  const noFollow = base({ fprRuns: { "fpr-9": [] } });
  assert.deepEqual(feedReducer(noFollow, { type: "automation_runs", automationId: "au-1", runs: [r3] }), base({ automationRuns: { "au-1": [r3] }, fprRuns: { "fpr-9": [] } }));
});

test("pr_follows / followed_prs: whole lists replaced", () => {
  const follows = [{ id: "f1", repo: "o/r" }];
  const prs = [{ id: "fpr-1", number: 7 }];
  assert.deepEqual(feedReducer(base(), { type: "pr_follows", follows }), base({ prFollows: follows }));
  assert.deepEqual(feedReducer(base(), { type: "followed_prs", prs }), base({ followedPrs: prs }));
});

test("followed_pr_items / followed_pr_checks / pr_events: only for a followed PR opened on the page", () => {
  const items = [{ id: "c1" }];
  const checks = [{ name: "ci" }];
  const events = [{ id: "e1" }];
  const opened = base({ fprItems: { "fpr-1": [] }, fprChecks: { "fpr-1": [] }, fprEvents: { "fpr-1": [] } });
  assert.deepEqual(feedReducer(opened, { type: "followed_pr_items", prId: "fpr-1", items }), base({ fprItems: { "fpr-1": items }, fprChecks: { "fpr-1": [] }, fprEvents: { "fpr-1": [] } }));
  assert.deepEqual(feedReducer(opened, { type: "followed_pr_checks", prId: "fpr-1", checks }), base({ fprItems: { "fpr-1": [] }, fprChecks: { "fpr-1": checks }, fprEvents: { "fpr-1": [] } }));
  assert.deepEqual(feedReducer(opened, { type: "pr_events", prId: "fpr-1", events }), base({ fprItems: { "fpr-1": [] }, fprChecks: { "fpr-1": [] }, fprEvents: { "fpr-1": events } }));
  const closed = base();
  assert.equal(feedReducer(closed, { type: "followed_pr_items", prId: "fpr-1", items }), closed);
  assert.equal(feedReducer(closed, { type: "followed_pr_checks", prId: "fpr-1", checks }), closed);
  assert.equal(feedReducer(closed, { type: "pr_events", prId: "fpr-1", events }), closed);
});

test("fs_changed: the last changed file, with a fresh nonce so the same path reloads twice", () => {
  const after = feedReducer(base(), { type: "fs_changed", sessionId: "a", path: "out/index.html", exists: true });
  assert.equal(typeof after.fsChange.nonce, "number");
  const { nonce, ...rest } = after.fsChange;
  assert.deepEqual({ ...after, fsChange: rest }, base({ fsChange: { sessionId: "a", path: "out/index.html", exists: true } }));
});

test("e2e_changed: the selected Session's run is added or replaced; a case that just started asks for the e2e pane", () => {
  const run = (id, cases) => ({ id, sessionId: "a", cases });
  const fresh = run("run-1", [{ id: "c1", status: "running" }]);
  assert.deepEqual(feedReducer(base(), { type: "e2e_changed", sessionId: "a", run: fresh }), base({ e2eRuns: [fresh], paneRequest: { sessionId: "a", pane: "e2e" } }));
  const old = run("run-0", [{ id: "c0", status: "passed" }]);
  const before = base({ e2eRuns: [old, fresh] });
  const finished = run("run-1", [{ id: "c1", status: "passed" }]);
  assert.deepEqual(feedReducer(before, { type: "e2e_changed", sessionId: "a", run: finished }), base({ e2eRuns: [old, finished] }), "a case that ended asks for nothing");
  const stillRunning = run("run-1", [{ id: "c1", status: "running" }, { id: "c2", status: "pending" }]);
  assert.deepEqual(feedReducer(before, { type: "e2e_changed", sessionId: "a", run: stillRunning }), base({ e2eRuns: [old, stillRunning] }), "a case already running asks for nothing");
  const other = { ...fresh, sessionId: "b" };
  assert.equal(feedReducer(before, { type: "e2e_changed", sessionId: "b", run: other }), before);
});

test("pr_activity: one toast with a line per Pull Request, keeping at most the four previous toasts", () => {
  const prs = [
    { prId: "pr-1", url: "https://github.com/o/r/pull/12", title: "Fix login", number: 12, count: 2, authors: ["ana", "bo"], changesRequested: false, failedChecks: [] },
    { prId: "pr-2", url: "https://github.com/o/r/pull/13", title: "Docs", number: 13, count: 0, authors: [], changesRequested: false, failedChecks: ["lint"] },
  ];
  const toast = (id) => ({ id, sessionId: "x", sessionTitle: "old", lines: [] });
  const before = base({ toasts: [toast(1), toast(2), toast(3), toast(4), toast(5)] });
  const after = feedReducer(before, { type: "pr_activity", sessionId: "a", sessionTitle: "Login fix", prs });
  const added = after.toasts[after.toasts.length - 1];
  assert.equal(typeof added.id, "number");
  assert.deepEqual(after.toasts.slice(0, -1), [toast(2), toast(3), toast(4), toast(5)]);
  assert.deepEqual(
    { ...added, id: undefined },
    { id: undefined, sessionId: "a", sessionTitle: "Login fix", lines: [{ prId: "pr-1", text: "#12 Fix login: 2 new items from @ana, @bo" }, { prId: "pr-2", text: "#13 Docs: check failed: lint" }] },
  );
  assert.deepEqual({ ...after, toasts: [] }, base(), "nothing else changes");
});

test("pr_merged: one toast line naming the merge method", () => {
  const pr = { prId: "pr-1", url: "https://github.com/o/r/pull/12", title: "Fix login", number: 12, method: "squash" };
  const after = feedReducer(base(), { type: "pr_merged", sessionId: "a", sessionTitle: "Login fix", pr });
  assert.equal(after.toasts.length, 1);
  assert.deepEqual({ ...after.toasts[0], id: undefined }, { id: undefined, sessionId: "a", sessionTitle: "Login fix", lines: [{ prId: "pr-1", text: "#12 Fix login: merged (squash)" }] });
});

test("remote: patched into the settings once they are loaded, dropped before", () => {
  const remote = { status: "up", url: "https://x.example" };
  const before = base();
  assert.equal(feedReducer(before, { type: "remote", remote }), before);
  const loaded = base({ settings: { remote: { status: "down" }, mcpServers: [] } });
  assert.deepEqual(feedReducer(loaded, { type: "remote", remote }), base({ settings: { remote, mcpServers: [] } }));
});

test("ui_hint: a pane request for the Session on screen, plus the Terminal to focus when one is named", () => {
  const before = base({ terminalFocus: { sessionId: "a", focus: { ptyId: "old", nonce: 1 } } });
  const plain = feedReducer(before, { type: "ui_hint", hint: { sessionId: "a", pane: "browser", terminalId: null } });
  assert.deepEqual(plain, base({ paneRequest: { sessionId: "a", pane: "browser" }, terminalFocus: { sessionId: "a", focus: { ptyId: "old", nonce: 1 } } }));
  const term = feedReducer(before, { type: "ui_hint", hint: { sessionId: "a", pane: "terminal", terminalId: "pty-7" } });
  assert.equal(typeof term.terminalFocus.focus.nonce, "number");
  assert.deepEqual({ ...term, terminalFocus: { ...term.terminalFocus, focus: { ...term.terminalFocus.focus, nonce: 0 } } }, base({ paneRequest: { sessionId: "a", pane: "terminal" }, terminalFocus: { sessionId: "a", focus: { ptyId: "pty-7", nonce: 0 } } }));
  assert.equal(feedReducer(before, { type: "ui_hint", hint: { sessionId: "b", pane: "browser", terminalId: null } }), before, "another Session's hint never steals the pane");
});

test("windows_base / macos_base: the base disk status is remembered (the hook refetches the settings)", () => {
  const status = { state: "ready", progress: null };
  assert.deepEqual(feedReducer(base(), { type: "windows_base", status }), base({ windowsBase: status }));
  assert.deepEqual(feedReducer(base(), { type: "macos_base", status }), base({ macosBase: status }));
});

test("pong: nothing", () => {
  const before = base();
  assert.equal(feedReducer(before, { type: "pong" }), before);
});

test("the state passed in is never mutated", () => {
  const before = base({ events: [event("a", 1)], prs: { a: [] }, toasts: [] });
  const snapshot = structuredClone(before);
  feedReducer(before, { type: "event", event: event("a", 2) });
  feedReducer(before, { type: "prs", sessionId: "a", prs: [{ id: "pr-1" }] });
  feedReducer(before, { type: "session", session: C });
  feedReducer(before, { type: "snapshotting", sessionId: "a", active: true });
  assert.deepEqual(before, snapshot);
});
