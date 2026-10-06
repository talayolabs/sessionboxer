import { test } from "node:test";
import assert from "node:assert/strict";
import { detachSelectedPrs, updatePrSelection } from "../apps/web/src/pr-list-actions.ts";

const prs = [1, 2, 3].map((number) => ({ id: `pr-${number}`, owner: "org", repo: "repo", number }));

test("one toggle selects a PR; another deselects it without changing the previous state", () => {
  const empty = new Set();
  const first = updatePrSelection(empty, { type: "toggle", id: "pr-1" });
  assert.deepEqual([...empty], []);
  assert.deepEqual([...first], ["pr-1"]);
  const second = updatePrSelection(first, { type: "toggle", id: "pr-2" });
  assert.deepEqual([...second], ["pr-1", "pr-2"]);
  assert.deepEqual([...updatePrSelection(second, { type: "toggle", id: "pr-1" })], ["pr-2"]);
  assert.deepEqual([...first], ["pr-1"]);
});

test("select all and clear selection replace the set", () => {
  const selected = updatePrSelection(new Set(["stale"]), { type: "set", ids: ["pr-1", "pr-2", "pr-2"] });
  assert.deepEqual([...selected], ["pr-1", "pr-2"]);
  assert.deepEqual([...updatePrSelection(selected, { type: "set", ids: [] })], []);
});

test("refresh keeps selected IDs through reordering but never selects a newly attached PR", () => {
  const selected = new Set(["pr-1", "pr-2"]);
  assert.equal(updatePrSelection(selected, { type: "retain", ids: ["pr-3", "pr-2", "pr-1"] }), selected);
});

test("refresh prunes detached IDs, including when the list becomes empty", () => {
  const selected = new Set(["pr-1", "pr-2"]);
  assert.deepEqual([...updatePrSelection(selected, { type: "retain", ids: ["pr-2", "pr-3"] })], ["pr-2"]);
  assert.deepEqual([...updatePrSelection(selected, { type: "retain", ids: [] })], []);
  assert.deepEqual([...selected], ["pr-1", "pr-2"]);
});

test("removing a detached ID twice never selects it again", () => {
  const selected = new Set(["pr-1", "pr-2"]);
  const action = { type: "remove", id: "pr-1" };
  const next = updatePrSelection(selected, action);
  assert.deepEqual([...updatePrSelection(next, action)], ["pr-2"]);
  assert.deepEqual([...selected], ["pr-1", "pr-2"]);
});

test("detaches only the chosen PRs and clears each after its request succeeds", async () => {
  const events = [];
  let selected = new Set(["pr-1", "pr-3"]);
  await detachSelectedPrs(prs.filter((pr) => selected.has(pr.id)), async (id) => {
    events.push(`detach ${id}`);
  }, (id) => {
    events.push(`clear ${id}`);
    selected = updatePrSelection(selected, { type: "remove", id });
  });
  assert.deepEqual(events, ["detach pr-1", "clear pr-1", "detach pr-3", "clear pr-3"]);
  assert.deepEqual([...selected], []);
});

test("partial failure does not stop the batch and retains only failed PRs for retry", async () => {
  const calls = [];
  let selected = new Set(prs.map((pr) => pr.id));
  await assert.rejects(detachSelectedPrs(prs, async (id) => {
    calls.push(id);
    if (id === "pr-2") throw new Error("unavailable");
  }, (id) => { selected = updatePrSelection(selected, { type: "remove", id }); }), {
    message: "Could not detach 1 of 3 PRs. Failed PRs remain selected for retry. org/repo#2: unavailable",
  });
  assert.deepEqual(calls, ["pr-1", "pr-2", "pr-3"]);
  assert.deepEqual([...selected], ["pr-2"]);
  await detachSelectedPrs(prs.filter((pr) => selected.has(pr.id)), async (id) => { calls.push(id); },
    (id) => { selected = updatePrSelection(selected, { type: "remove", id }); });
  assert.deepEqual(calls, ["pr-1", "pr-2", "pr-3", "pr-2"]);
  assert.deepEqual([...selected], []);
});

test("all failures report the batch count and do not clear anything", async () => {
  await assert.rejects(detachSelectedPrs(prs, async () => { throw "offline"; }, () => assert.fail("must not clear")),
    /Could not detach 3 of 3 PRs.*org\/repo#1: offline; org\/repo#2: offline; org\/repo#3: offline/);
});

test("large batches run one request at a time instead of flooding the Control Plane", async () => {
  let active = 0;
  let peak = 0;
  let detached = 0;
  const many = Array.from({ length: 200 }, (_, number) => ({ ...prs[0], id: String(number), number }));
  await detachSelectedPrs(many, async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
  }, () => detached++);
  assert.equal(peak, 1);
  assert.equal(detached, 200);
});

test("large failure summaries include only the first three details", async () => {
  const many = Array.from({ length: 20 }, (_, number) => ({ ...prs[0], id: String(number), number }));
  await assert.rejects(detachSelectedPrs(many, async () => { throw new Error("offline"); }, () => {}), {
    message: "Could not detach 20 of 20 PRs. Failed PRs remain selected for retry. org/repo#0: offline; org/repo#1: offline; org/repo#2: offline; and 17 more",
  });
});

test("empty selection makes no requests", async () => {
  await detachSelectedPrs([], () => assert.fail("must not detach"), () => assert.fail("must not clear"));
});
