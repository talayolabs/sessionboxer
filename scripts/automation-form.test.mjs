// Node strips the model's TypeScript, as in feed.test.mjs; the TSX repo converter stays behind a seam.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrigger, buildAction, cleanFilters, clamp,
  getTriggerError, getActionError, getFormError,
} from "../apps/web/src/automations/form-model.ts";

const filters = { drafts: "skip", forks: "review_only", authors: "not_self", includeOwn: false };
const trigger = {
  triggerType: "schedule", cron: " 0 9 * * 1-5 ", timezone: " UTC ", missedRun: "skip",
  prFollows: [], prEvents: ["opened", "synchronize", "ready_for_review"], filters,
};
const draft = {
  model: null, options: {}, inspectLlm: true, mcpEnabled: ["mcp"], utilitiesEnabled: ["util"],
  instructions: "defaults", autoSnapshot: null, snapshotKeep: null, e2eVerify: null,
  agentTools: null, approveCreate: null, environment: "docker-linux", snapshotId: null,
  docker: false, cpus: null, memoryGb: null, gitName: "Name", gitEmail: "email@example.com",
};
const action = {
  actionType: "prompt", sessionId: "session-1", text: "  Check the build.\n",
  provider: "pi", repos: [], draft, title: "", prompt: "  First prompt.\n", stopAfter: true,
  checkoutPrHead: true, notifyText: "", instructions: "", maxVerdict: "comment",
  deltaOnly: true, notifyOn: "findings", publish: "github_attachment", commentOnSkip: false,
  maxMinutes: 10,
};
const unusedConverters = {
  draftsToSpecs() { assert.fail("this action must not convert repositories"); },
};
const draftInput = {
  model: null, options: {}, inspectLlm: true, mcpEnabled: ["mcp"], utilitiesEnabled: ["util"],
  instructions: "defaults", autoSnapshot: null, snapshotKeep: null, e2eVerify: null, agentTools: null, approveCreate: null,
  sandbox: { environment: "docker-linux", docker: false, cpus: null, memoryGb: null, gitIdentity: { name: "Name", email: "email@example.com" } },
};

test("schedule: trims cron and timezone, retains missed-run policy", () => {
  assert.deepEqual(buildTrigger(trigger), { type: "schedule", cron: "0 9 * * 1-5", timezone: "UTC", missedRun: "skip" });
});

test("PR event: retains follows/events and omits empty optional filters", () => {
  assert.deepEqual(buildTrigger({ ...trigger, triggerType: "pr_event", prFollows: ["follow-1"],
    filters: { ...filters, baseRef: " main ", titleMatch: "  ", labels: [], reviewers: ["reviewer"] } }),
  { type: "pr_event", follows: ["follow-1"], events: ["opened", "synchronize", "ready_for_review"],
    filters: { drafts: "skip", forks: "review_only", authors: "not_self", includeOwn: false, reviewers: ["reviewer"], baseRef: "main" } });
});

test("manual: ignores the other trigger fields", () => {
  assert.deepEqual(buildTrigger({ ...trigger, triggerType: "manual" }), { type: "manual" });
});

test("prompt: trims text but retains the attached-session sentinel", () => {
  assert.deepEqual(buildAction({ ...action, sessionId: "attached" }, unusedConverters),
    { type: "prompt", sessionId: "attached", text: "Check the build." });
});

test("new_session: converts repos/settings and trims optional title and prompt", () => {
  const repos = [{ key: 1, type: "git", url: "https://example.com/repo.git", ref: "main", name: "repo", path: "" }];
  const before = { ...action, actionType: "new_session", repos, title: "  Nightly  " };
  const saved = structuredClone(before);
  assert.deepEqual(buildAction(before, {
    draftsToSpecs(value) {
      assert.equal(value, repos);
      return [{ name: "repo", source: { type: "git", url: "https://example.com/repo.git", ref: "main" } }];
    },
  }), { type: "new_session", provider: "pi",
    repos: [{ name: "repo", source: { type: "git", url: "https://example.com/repo.git", ref: "main" } }],
    settings: draftInput, prompt: "First prompt.",
    stopAfter: true, checkoutPrHead: true, title: "Nightly" });
  assert.deepEqual(before, saved);
});

test("new_session snapshot: no repo conversion, no blank title, snapshot before settings in JSON", () => {
  const result = buildAction({ ...action, actionType: "new_session", draft: { ...draft, snapshotId: "snap" }, title: " " }, unusedConverters);
  assert.equal(JSON.stringify(result),
    '{"type":"new_session","provider":"pi","repos":[],"snapshotId":"snap","settings":'
    + '{"model":null,"options":{},"inspectLlm":true,"mcpEnabled":["mcp"],"utilitiesEnabled":["util"],"instructions":"defaults",'
    + '"autoSnapshot":null,"snapshotKeep":null,"e2eVerify":null,"agentTools":null,"approveCreate":null,'
    + '"sandbox":{"environment":"docker-linux","docker":false,"cpus":null,"memoryGb":null,"gitIdentity":{"name":"Name","email":"email@example.com"}}},'
    + '"prompt":"First prompt.","stopAfter":true,"checkoutPrHead":true}');
});

test("auto_review: retains verdict, delta, notifications, stop and trimmed instructions", () => {
  assert.deepEqual(buildAction({ ...action, actionType: "auto_review", instructions: "  Focus on tests. ", maxVerdict: "approve", notifyOn: "always", deltaOnly: false, stopAfter: false }, unusedConverters),
    { type: "auto_review", provider: "pi", maxVerdict: "approve", deltaOnly: false, notifyOn: "always", stopAfter: false, instructions: "Focus on tests." });
  assert.deepEqual(buildAction({ ...action, actionType: "auto_review" }, unusedConverters),
    { type: "auto_review", provider: "pi", maxVerdict: "comment", deltaOnly: true, notifyOn: "findings", stopAfter: true });
});

test("auto_qa: retains publishing, skips, limit, stop and optional instructions", () => {
  assert.deepEqual(buildAction({ ...action, actionType: "auto_qa", publish: "link_only", commentOnSkip: true, maxMinutes: 7, instructions: " Test login. " }, unusedConverters),
    { type: "auto_qa", provider: "pi", publish: "link_only", commentOnSkip: true, maxMinutes: 7, stopAfter: true, instructions: "Test login." });
  assert.deepEqual(buildAction({ ...action, actionType: "auto_qa", instructions: " " }, unusedConverters),
    { type: "auto_qa", provider: "pi", publish: "github_attachment", commentOnSkip: false, maxMinutes: 10, stopAfter: true });
});

test("attach: no action fields leak into the payload", () => {
  assert.deepEqual(buildAction({ ...action, actionType: "attach" }, unusedConverters), { type: "attach" });
});

test("notify: trims text and omits it when blank", () => {
  assert.deepEqual(buildAction({ ...action, actionType: "notify", notifyText: " {pr.title} " }, unusedConverters), { type: "notify", text: "{pr.title}" });
  assert.deepEqual(buildAction({ ...action, actionType: "notify", notifyText: " " }, unusedConverters), { type: "notify" });
});

test("triggerError: preview errors verbatim, events before follows, manual ignores preview", () => {
  assert.equal(getTriggerError(trigger, { ok: false, error: "Invalid cron expression" }, []), "Invalid cron expression");
  assert.equal(getTriggerError(trigger, null, []), null);
  assert.equal(getTriggerError(trigger, { ok: true, next: [] }, []), null);
  const pr = { ...trigger, triggerType: "pr_event" };
  assert.equal(getTriggerError({ ...pr, prEvents: [] }, null, []), "Pick at least one event.");
  assert.equal(getTriggerError(pr, null, []), "Follow a repository below, or your PRs on the Pull requests page.");
  assert.equal(getTriggerError({ ...pr, prFollows: ["new-follow"] }, null, []), null);
  assert.equal(getTriggerError(pr, null, [{ id: "follow" }]), null);
  assert.equal(getTriggerError({ ...trigger, triggerType: "manual" }, { ok: false, error: "ignored" }, []), null);
});

test("actionError: missing Session, empty prompt, first prompt, then repo error", () => {
  assert.equal(getActionError(action, null, null), "Pick a Session.");
  assert.equal(getActionError({ ...action, text: " " }, { id: "session-1" }, null), "Write the prompt.");
  assert.equal(getActionError({ ...action, sessionId: "attached" }, null, null), null);
  assert.equal(getActionError({ ...action, actionType: "new_session", prompt: " " }, null, "bad repo"), "Write the first prompt.");
  assert.equal(getActionError({ ...action, actionType: "new_session" }, null, "bad repo"), "bad repo");
  assert.equal(getActionError({ ...action, actionType: "notify" }, null, "bad repo"), null);
});

test("formError: blank name wins, then trigger error, then action error", () => {
  assert.equal(getFormError(" ", "trigger", "action"), "Give the automation a name.");
  assert.equal(getFormError("Named", "trigger", "action"), "trigger");
  assert.equal(getFormError("Named", null, "action"), "action");
  assert.equal(getFormError("Named", null, null), null);
});

test("cleanFilters: preserves list entries, trims text, drops empty optionals without mutation", () => {
  const input = { ...filters, baseRef: " release/* ", titleMatch: " fix ", authorLogins: [" alice "], reviewers: [], labels: ["needs-review"] };
  const before = structuredClone(input);
  assert.deepEqual(cleanFilters(input), { drafts: "skip", forks: "review_only", authors: "not_self", includeOwn: false,
    authorLogins: [" alice "], baseRef: "release/*", titleMatch: "fix", labels: ["needs-review"] });
  assert.deepEqual(input, before);
});

test("clamp: round and bound; empty/non-finite falls back, whitespace remains numeric zero", () => {
  assert.equal(clamp("3.6", 1, 20, 2), 4);
  assert.equal(clamp("-3", 1, 20, 2), 1);
  assert.equal(clamp("30", 1, 20, 2), 20);
  assert.equal(clamp("", 1, 20, 2), 2);
  assert.equal(clamp("NaN", 1, 20, 2), 2);
  assert.equal(clamp("Infinity", 1, 20, 2), 2);
  assert.equal(clamp(" ", 1, 20, 2), 1);
});
