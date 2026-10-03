// Characterization tests (Feathers) for the two clusters of SessionManager that share the least
// state with the rest — the saved-messages queue and the Snapshot policy — written before they
// are extracted (docs/TECH-DEBT.md, fix 7). They drive SessionManager through its public surface
// (what the routes, the Agent tools and the UI call) with a real SQLite Db, a fake SandboxDocker
// and a stubbed `prompt`, so moving the code cannot change what is observed. Expected values are
// the ones observed today, not recomputed from the code. Run after `tsc -b`.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { MACOS_NO_SNAPSHOT, ROOT_BRANCH_ID, Settings, WINDOWS_NO_SNAPSHOT } from "../packages/protocol/dist/index.js";
import { Db } from "../apps/control-plane/dist/db.js";
import { MissingImageContentError } from "../apps/control-plane/dist/docker.js";
import { HttpError } from "../apps/control-plane/dist/http-error.js";
import { SessionManager } from "../apps/control-plane/dist/sessions.js";

const MB = 1024 ** 2;

/** Lets the `void`ed continuations of a Daemon event (afterTurn, autoSnapshot, pumpQueue) run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** A SandboxDocker that records what it is asked and answers from these fields. */
function fakeDocker() {
  const docker = {
    calls: [],
    commitImpl: async (_containerId, spec) => ({ imageId: `sha256:${spec.tag}`, sizeBytes: 2 * MB }),
    diskBytes: 4096,
    snapshotImageIds: [],
    commit(containerId, spec) {
      docker.calls.push(["commit", containerId, spec]);
      return docker.commitImpl(containerId, spec);
    },
    async removeImage(ref) {
      docker.calls.push(["removeImage", ref]);
      return true;
    },
    async listSnapshotImageIds() {
      return docker.snapshotImageIds;
    },
    async diskUsage(containerId) {
      docker.calls.push(["diskUsage", containerId]);
      return docker.diskBytes;
    },
    containerState: "running",
    async state() {
      return docker.containerState;
    },
    // What `boot()` touches; nothing to do without a Docker.
    async detectReach() {
      return "host";
    },
    async ensureNetwork() {},
    async ensureImage() {},
    async watchDeaths() {},
  };
  return docker;
}

const managers = [];
after(async () => {
  for (const m of managers) await m.shutdown();
});

/** A SessionManager on an in-memory Db, with every side channel captured; `prompt` records calls instead of reaching a Daemon. */
function makeManager(settingsInput = {}) {
  const db = new Db(":memory:");
  const docker = fakeDocker();
  const settings = Settings.parse(settingsInput);
  const log = [];
  const broadcasts = [];
  const prompts = [];
  const vms = { diskUsage: async () => null, vmName: () => "", guestLabel: "VM", availability: async () => ({ available: false, reason: "test" }) };
  const manager = new SessionManager(db, docker, vms, vms, () => settings, (msg) => log.push(msg));
  managers.push(manager);
  manager.subscribe((msg) => broadcasts.push(msg));
  manager.prompt = async (id, req, origin) => {
    prompts.push({ id, text: req.text, origin });
  };
  let n = 0;
  return {
    manager,
    db,
    docker,
    settings,
    log,
    broadcasts,
    prompts,
    /** The Session as `createClaimed` would insert it once its Sandbox runs: idle, Claude Code, Linux Sandbox. */
    addSession(overrides = {}) {
      n++;
      const id = overrides.id ?? `s${n}`;
      const now = "2026-01-01T00:00:00.000Z";
      const { settings: settingsOverride, sandbox, usage, ...rest } = overrides;
      const session = {
        id,
        title: `Session ${id}`,
        provider: "claude-code",
        status: "idle",
        workspaceSource: { type: "empty" },
        repos: [],
        settings: {
          ...Settings.parse({}),
          ...{ model: null, options: {}, inspectLlm: false, mcpEnabled: [], utilitiesEnabled: [], instructions: "" },
          autoSnapshot: null,
          snapshotKeep: null,
          e2eVerify: null,
          agentTools: null,
          approveCreate: null,
          ...settingsOverride,
          sandbox: { environment: "docker-linux", dockerMode: "none", cpus: null, memoryGb: null, gitIdentity: { name: "", email: "" }, ...sandbox },
        },
        containerId: `ctr-${id}`,
        error: null,
        queueRunning: false,
        diskBytes: null,
        mcpPending: false,
        modelPending: false,
        optionsPending: false,
        availableOptions: [],
        inspectLlmPending: false,
        snapshotBytes: 0,
        snapshotCount: 0,
        branches: [],
        activeBranchId: ROOT_BRANCH_ID,
        usage: { windows: [], updatedAt: null, limit: null, autoContinue: false, ...usage },
        usb: null,
        createdBy: null,
        pinned: false,
        folderId: null,
        createdAt: now,
        updatedAt: now,
        ...rest,
      };
      db.insertSession(session);
      return session;
    },
    /** The Session's Daemon is reachable (what `connect` leaves behind once the socket is up). */
    connect(id) {
      manager.clients.set(id, { connected: true, close() {} });
    },
    /** A Snapshot row as `doSnapshot` writes it. */
    addSnapshot(sessionId, ordinal, reason, extra = {}) {
      const snapshot = {
        id: `snap-${sessionId}-${ordinal}`,
        sessionId,
        ordinal,
        reason,
        imageTag: `sessionboxer/snapshot:${sessionId}-${ordinal}`,
        imageId: `sha256:${sessionId}-${ordinal}`,
        eventSeq: 0,
        branchId: ROOT_BRANCH_ID,
        sizeBytes: MB,
        queuedMessages: [],
        createdAt: `2026-01-01T00:00:0${ordinal}.000Z`,
        ...extra,
      };
      db.insertSnapshot(snapshot);
      return snapshot;
    },
    /** Another Session whose Sandbox was started from `snapshotId` (keeps that Snapshot's image). */
    addFork(originId, snapshotId) {
      return this.addSession({ workspaceSource: { type: "fork", sessionId: originId, snapshotId, label: "fork" } });
    },
    /** What the Daemon sends when a turn is over, as `DaemonClient` hands it to the manager. */
    turnEnded(id, seq = 1, stopReason = "end_turn") {
      manager.onDaemonEvent(id, { epoch: "e1", seq, ts: "2026-01-01T00:01:00.000Z", body: { type: "turn_ended", stopReason } });
    },
    types() {
      return broadcasts.map((b) => b.type);
    },
    savedTexts(id) {
      return db.listSavedMessages(id).map((m) => m.text);
    },
    commits() {
      return docker.calls.filter((c) => c[0] === "commit");
    },
    removedImages() {
      return docker.calls.filter((c) => c[0] === "removeImage").map((c) => c[1]);
    },
  };
}

const rejectsHttp = async (promise, status, message) => {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof HttpError, `expected an HttpError, got ${String(e)}`);
    assert.equal(e.status, status);
    assert.equal(e.message, message);
    return true;
  });
};
const throwsHttp = (fn, status, message) => {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof HttpError, `expected an HttpError, got ${String(e)}`);
    assert.equal(e.status, status);
    assert.equal(e.message, message);
    return true;
  });
};

test("the manager builds on a fresh Db with fakes and does not touch Docker or start work on its own", () => {
  const h = makeManager();
  assert.deepEqual(h.docker.calls, []);
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.broadcasts, []);
  assert.deepEqual(h.manager.list(), []);
  throwsHttp(() => h.manager.get("nope"), 404, "session nope not found");
  throwsHttp(() => h.manager.savedMessages("nope"), 404, "session nope not found");
  throwsHttp(() => h.manager.snapshots("nope"), 404, "session nope not found");
});

// --- Queue --------------------------------------------------------------------

test("queue: a message enqueued on an idle, connected Session goes out at once and leaves the list", async () => {
  const h = makeManager();
  const { id } = h.addSession();
  h.connect(id);
  const saved = await h.manager.enqueueMessage(id, "hello");
  assert.equal(saved.position, 0);
  assert.equal(saved.text, "hello");
  assert.deepEqual(h.prompts, [{ id, text: "hello", origin: undefined }]);
  assert.deepEqual(h.savedTexts(id), []);
  assert.deepEqual(h.types(), ["saved_messages", "session", "saved_messages"]);
  assert.equal(h.broadcasts[0].messages.length, 1);
  assert.equal(h.broadcasts[1].session.queueRunning, true);
  assert.deepEqual(h.broadcasts[2].messages, []);
  // Observed: the queue stays "running" after the last message went out; the pump after
  // `turn_ended` is what turns it off once it finds the list empty.
  assert.equal(h.manager.get(id).queueRunning, true);
});

test("queue: while a turn runs the message is kept and the queue is left playing", async () => {
  const h = makeManager();
  const { id } = h.addSession({ status: "running" });
  h.connect(id);
  await h.manager.enqueueMessage(id, "later");
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.savedTexts(id), ["later"]);
  assert.equal(h.manager.get(id).queueRunning, true);
});

test("queue: an idle Session whose Daemon is not connected keeps the message for `onDaemonConnected`", async () => {
  const h = makeManager();
  const { id } = h.addSession();
  await h.manager.enqueueMessage(id, "when you are back");
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.savedTexts(id), ["when you are back"]);
  assert.equal(h.manager.get(id).queueRunning, true);
});

test("queue: a paused queue with messages stays paused unless `resumePaused`", async () => {
  const h = makeManager();
  const { id } = h.addSession({ status: "running" });
  h.connect(id);
  h.db.insertSavedMessage(id, "first");
  await h.manager.enqueueMessage(id, "second");
  assert.equal(h.manager.get(id).queueRunning, false, "paused: the user stopped it with messages in it");
  assert.deepEqual(h.savedTexts(id), ["first", "second"]);
  assert.deepEqual(h.types(), ["saved_messages"]);

  h.db.updateSession(id, { status: "idle" });
  await h.manager.enqueueMessage(id, "third", { resumePaused: true });
  assert.equal(h.manager.get(id).queueRunning, true);
  assert.deepEqual(h.prompts.map((p) => p.text), ["first"], "the oldest message goes first");
  assert.deepEqual(h.savedTexts(id), ["second", "third"]);
});

test("queue: a Session in error keeps the message without starting the queue", async () => {
  const h = makeManager();
  const { id } = h.addSession({ status: "error", error: "boom" });
  h.connect(id);
  await h.manager.enqueueMessage(id, "x");
  assert.equal(h.manager.get(id).queueRunning, false);
  assert.deepEqual(h.savedTexts(id), ["x"]);
  assert.deepEqual(h.prompts, []);
});

test("queue: setQueueRunning(true) is 409 on an empty queue and on an errored Session", async () => {
  const h = makeManager();
  const { id } = h.addSession();
  await rejectsHttp(h.manager.setQueueRunning(id, true), 409, "The queue is empty.");
  h.db.insertSavedMessage(id, "x");
  h.db.updateSession(id, { status: "error", error: "boom" });
  await rejectsHttp(h.manager.setQueueRunning(id, true), 409, "Session is in error state: boom");
  await rejectsHttp(h.manager.setQueueRunning("nope", false), 404, "session nope not found");
});

test("queue: pause then play; play pumps the first message and reports the Session as it is after", async () => {
  const h = makeManager();
  const { id } = h.addSession({ queueRunning: true });
  h.connect(id);
  h.db.insertSavedMessage(id, "a");
  h.db.insertSavedMessage(id, "b");
  const paused = await h.manager.setQueueRunning(id, false);
  assert.equal(paused.queueRunning, false);
  assert.deepEqual(h.types(), ["session"]);
  const playing = await h.manager.setQueueRunning(id, true);
  assert.equal(playing.queueRunning, true);
  assert.deepEqual(h.prompts.map((p) => p.text), ["a"]);
  assert.deepEqual(h.savedTexts(id), ["b"]);
  assert.deepEqual(h.types(), ["session", "session", "saved_messages"]);
});

test("queue: when the prompt fails the queue pauses, logs why and keeps the message", async () => {
  const h = makeManager();
  const { id } = h.addSession();
  h.connect(id);
  h.db.insertSavedMessage(id, "a");
  h.manager.prompt = async () => {
    throw new HttpError(503, "Sandbox Daemon is not connected yet; retry in a moment.");
  };
  const s = await h.manager.setQueueRunning(id, true);
  assert.equal(s.queueRunning, false);
  assert.deepEqual(h.log, [`queue ${id} paused: Sandbox Daemon is not connected yet; retry in a moment.`]);
  assert.deepEqual(h.savedTexts(id), ["a"]);
  assert.deepEqual(h.broadcasts.map((b) => [b.type, b.session?.queueRunning]), [["session", true], ["session", false]]);
});

test("queue: a Session under a usage limit is not pumped (the queue stays playing for later)", async () => {
  const h = makeManager();
  const { id } = h.addSession({ usage: { limit: { message: "out of credit", resetsAt: null, hitAt: "2026-01-01T00:00:00.000Z", retry: null } } });
  h.connect(id);
  h.db.insertSavedMessage(id, "a");
  const s = await h.manager.setQueueRunning(id, true);
  assert.equal(s.queueRunning, true);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.savedTexts(id), ["a"]);
});

test("queue: updateSavedMessage reorders and renumbers; unknown ids are 404", async () => {
  const h = makeManager();
  const { id } = h.addSession({ status: "running" });
  const a = h.db.insertSavedMessage(id, "a");
  h.db.insertSavedMessage(id, "b");
  const c = h.db.insertSavedMessage(id, "c");
  const moved = h.manager.updateSavedMessage(id, c.id, { position: 0 });
  assert.equal(moved.position, 0);
  assert.deepEqual(h.savedTexts(id), ["c", "a", "b"]);
  const renamed = h.manager.updateSavedMessage(id, a.id, { text: "A", position: 5 });
  assert.deepEqual([renamed.text, renamed.position], ["A", 2], "a position past the end lands last");
  assert.deepEqual(h.manager.savedMessages(id).map((m) => [m.text, m.position]), [["c", 0], ["b", 1], ["A", 2]]);
  throwsHttp(() => h.manager.updateSavedMessage(id, "nope", { text: "x" }), 404, "saved message nope not found");
  assert.deepEqual(h.types(), ["saved_messages", "saved_messages"]);
});

test("queue: deleteSavedMessage closes the gap; unknown ids are 404", () => {
  const h = makeManager();
  const { id } = h.addSession();
  const a = h.db.insertSavedMessage(id, "a");
  h.db.insertSavedMessage(id, "b");
  h.manager.deleteSavedMessage(id, a.id);
  assert.deepEqual(h.manager.savedMessages(id).map((m) => [m.text, m.position]), [["b", 0]]);
  throwsHttp(() => h.manager.deleteSavedMessage(id, a.id), 404, `saved message ${a.id} not found`);
  assert.deepEqual(h.types(), ["saved_messages"]);
});

test("queue: sendSavedMessage prompts with the text and drops the message; a failed prompt keeps it", async () => {
  const h = makeManager();
  const { id } = h.addSession();
  h.connect(id);
  h.db.insertSavedMessage(id, "a");
  const b = h.db.insertSavedMessage(id, "b");
  await h.manager.sendSavedMessage(id, b.id);
  assert.deepEqual(h.prompts, [{ id, text: "b", origin: undefined }]);
  assert.deepEqual(h.savedTexts(id), ["a"]);
  assert.deepEqual(h.types(), ["saved_messages"]);
  await rejectsHttp(h.manager.sendSavedMessage(id, b.id), 404, `saved message ${b.id} not found`);
  h.manager.prompt = async () => {
    throw new HttpError(409, "The Agent is still working on the previous prompt.");
  };
  const [a] = h.db.listSavedMessages(id);
  await rejectsHttp(h.manager.sendSavedMessage(id, a.id), 409, "The Agent is still working on the previous prompt.");
  assert.deepEqual(h.savedTexts(id), ["a"]);
});

test("queue: a message another Agent queued keeps its origin until it is sent, then the sender may message again", async () => {
  const h = makeManager();
  const from = h.addSession({ id: "from" });
  const target = h.addSession({ id: "target", status: "running" });
  h.connect(target.id);
  assert.equal(await h.manager.promptFromAgent(from.id, target.id, "ping", "queue"), "queued");
  assert.deepEqual(h.savedTexts(target.id), ["ping"]);
  await rejectsHttp(
    h.manager.promptFromAgent(from.id, target.id, "again", "queue"),
    409,
    `Your previous message to “${target.title}” is still in flight (one at a time per Session); session_wait for its reply first.`,
  );
  h.db.updateSession(target.id, { status: "idle" });
  await h.manager.setQueueRunning(target.id, true);
  assert.deepEqual(h.prompts, [{ id: target.id, text: "ping", origin: { type: "agent", fromSessionId: from.id, fromTitle: from.title, hops: 1 } }]);
  assert.deepEqual(h.savedTexts(target.id), []);
  // Observed: the queue is still playing after its last message went out, so even `when: "now"` is queued.
  assert.equal(await h.manager.promptFromAgent(from.id, target.id, "again", "now"), "queued", "no 409: the origin was dropped with the message");
  assert.deepEqual(h.savedTexts(target.id), ["again"]);
});

test("queue: after a completed turn the next message is sent, and an empty list stops the queue", async () => {
  const h = makeManager();
  const { id } = h.addSession({ status: "running", queueRunning: true });
  h.connect(id);
  h.db.insertSavedMessage(id, "next");
  h.turnEnded(id, 1);
  await settle();
  assert.deepEqual(h.prompts.map((p) => p.text), ["next"]);
  assert.equal(h.manager.get(id).queueRunning, true);
  h.db.updateSession(id, { status: "running" });
  h.turnEnded(id, 2);
  await settle();
  assert.equal(h.manager.get(id).queueRunning, false, "nothing left: the queue turns itself off");
  assert.deepEqual(h.prompts.length, 1);
});

test("queue: a cancelled turn pauses a playing queue", async () => {
  const h = makeManager();
  const { id } = h.addSession({ status: "running", queueRunning: true });
  h.connect(id);
  h.db.insertSavedMessage(id, "next");
  h.turnEnded(id, 1, "cancelled");
  await settle();
  assert.deepEqual(h.prompts, []);
  assert.equal(h.manager.get(id).queueRunning, false);
  assert.deepEqual(h.log, [`queue ${id} paused after turn_ended`]);
});

// --- Snapshots ----------------------------------------------------------------

test("snapshot: commits the Sandbox with the Provider's secrets stripped and records what was in the Session", async () => {
  const h = makeManager();
  const { id } = h.addSession();
  h.db.appendEvent(id, { type: "user_prompt", text: "hi" });
  h.db.appendEvent(id, { type: "turn_ended", stopReason: "end_turn" });
  h.db.insertSavedMessage(id, "queued one");
  const snapshot = await h.manager.snapshot(id, "manual");
  assert.deepEqual(h.commits(), [["commit", `ctr-${id}`, { snapshotId: snapshot.id, tag: `${id}-1`, stripEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] }]]);
  assert.match(snapshot.id, /^[0-9a-f]{12}$/);
  assert.equal(snapshot.sessionId, id);
  assert.equal(snapshot.ordinal, 1);
  assert.equal(snapshot.reason, "manual");
  assert.equal(snapshot.imageTag, `sessionboxer/snapshot:${id}-1`);
  assert.equal(snapshot.imageId, `sha256:${id}-1`);
  assert.equal(snapshot.eventSeq, 2, "the last event of the Session when no `eventSeq` is given");
  assert.equal(snapshot.branchId, ROOT_BRANCH_ID);
  assert.equal(snapshot.sizeBytes, 2 * MB);
  assert.deepEqual(snapshot.queuedMessages, ["queued one"]);
  assert.deepEqual(h.manager.snapshots(id), [snapshot]);
  assert.match(h.log[0], new RegExp(`^snapshot ${id}#1 2\\.0 MB in \\d+ ms$`));
  assert.deepEqual(h.types(), ["snapshotting", "snapshots", "session", "session", "snapshotting"]);
  assert.deepEqual([h.broadcasts[0].active, h.broadcasts[4].active], [true, false]);
  assert.equal(h.broadcasts[3].session.diskBytes, 4096, "the Sandbox's disk usage is re-measured after every Snapshot");

  const second = await h.manager.snapshot(id, "agent", 1);
  assert.deepEqual([second.ordinal, second.eventSeq, second.imageTag], [2, 1, `sessionboxer/snapshot:${id}-2`]);
});

test("snapshot: Snapshots of one Session are serialized; the next starts when the previous settles, even if it failed", async () => {
  const h = makeManager();
  const { id } = h.addSession();
  const other = h.addSession();
  const pending = [];
  h.docker.commitImpl = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const first = h.manager.snapshot(id, "manual");
  const second = h.manager.snapshot(id, "manual");
  const elsewhere = h.manager.snapshot(other.id, "manual");
  await settle();
  assert.equal(h.commits().length, 2, "one per Session is in flight");
  assert.deepEqual(h.commits().map((c) => c[1]), [`ctr-${id}`, `ctr-${other.id}`]);
  pending[0].reject(new Error("docker is down"));
  await assert.rejects(first, { message: "docker is down" });
  await settle();
  assert.equal(h.commits().length, 3, "the second Snapshot of the Session started after the first failed");
  assert.equal(h.commits()[2][2].tag, `${id}-1`, "the failed Snapshot's ordinal was never used");
  pending[2].resolve({ imageId: "sha256:two", sizeBytes: MB });
  pending[1].resolve({ imageId: "sha256:other", sizeBytes: MB });
  assert.equal((await second).imageId, "sha256:two");
  assert.equal((await elsewhere).imageId, "sha256:other");
});

test("snapshot: refused unless the Sandbox runs; the message names the Session's status", async () => {
  const h = makeManager();
  const stopped = h.addSession({ status: "stopped" });
  await rejectsHttp(h.manager.snapshot(stopped.id, "manual"), 409, "Session is stopped; Snapshots need a running Sandbox.");
  const creating = h.addSession({ status: "creating", containerId: null });
  await rejectsHttp(h.manager.snapshot(creating.id, "manual"), 409, "Session is creating; Snapshots need a running Sandbox.");
  // Observed: an idle Session without a container is refused with the same wording, which blames the status.
  const noContainer = h.addSession({ containerId: null });
  await rejectsHttp(h.manager.snapshot(noContainer.id, "manual"), 409, "Session is idle; Snapshots need a running Sandbox.");
  await rejectsHttp(h.manager.snapshot("nope", "manual"), 404, "session nope not found");
  assert.deepEqual(h.commits(), []);
  assert.deepEqual(h.types(), [], "refusals before the commit do not announce a Snapshot");
});

test("snapshot: VM Sessions cannot be snapshotted", async () => {
  const h = makeManager();
  const windows = h.addSession({ sandbox: { environment: "qemu-windows" } });
  await rejectsHttp(h.manager.snapshot(windows.id, "manual"), 409, WINDOWS_NO_SNAPSHOT);
  assert.equal(WINDOWS_NO_SNAPSHOT, "Snapshots, forks and rebuilds are not available for Windows Sessions yet: the VM disk is outside the Sandbox's image.");
  const macos = h.addSession({ sandbox: { environment: "qemu-macos" } });
  await rejectsHttp(h.manager.snapshot(macos.id, "manual"), 409, MACOS_NO_SNAPSHOT);
  assert.equal(MACOS_NO_SNAPSHOT, "Snapshots, forks and rebuilds are not available for macOS Sessions yet: the VM disk is outside the Sandbox's image.");
});

test("snapshot: a Sandbox whose image lost content is told to rebuild; other commit failures pass through", async () => {
  const h = makeManager();
  const { id } = h.addSession();
  h.docker.commitImpl = async () => {
    throw new MissingImageContentError("sha256:abcdef0123456789abcdef");
  };
  await rejectsHttp(
    h.manager.snapshot(id, "manual"),
    409,
    "This Sandbox needs a rebuild before it can be snapshotted again (Snapshots \u2192 Rebuild Sandbox): the Sandbox's image is missing sha256:abcdef012345 from Docker's content store.",
  );
  assert.deepEqual(h.types(), ["snapshotting", "snapshotting"]);
  assert.deepEqual(h.manager.snapshots(id), []);
  h.docker.commitImpl = async () => {
    throw new Error("docker is down");
  };
  await assert.rejects(h.manager.snapshot(id, "manual"), (e) => e instanceof Error && !(e instanceof HttpError) && e.message === "docker is down");
});

test("snapshot: automatic Snapshots are pruned to `snapshotKeep`, oldest first, never one a fork started from", async () => {
  const h = makeManager({ snapshotKeep: 2 });
  const { id } = h.addSession();
  for (const ordinal of [1, 2, 3, 4]) h.addSnapshot(id, ordinal, "turn");
  h.addSnapshot(id, 5, "manual");
  h.addFork(id, `snap-${id}-2`);
  const fresh = await h.manager.snapshot(id, "turn");
  assert.equal(fresh.ordinal, 6);
  assert.deepEqual(h.removedImages(), [`sha256:${id}-1`, `sha256:${id}-3`]);
  assert.deepEqual(h.manager.snapshots(id).map((s) => s.ordinal), [2, 4, 5, 6]);
  assert.equal(h.broadcasts.filter((b) => b.type === "snapshots")[0].snapshots.length, 4, "the list is broadcast after the prune");
});

test("snapshot: a manual Snapshot prunes the automatic ones too; the Session's `snapshotKeep` wins over the global one", async () => {
  const h = makeManager({ snapshotKeep: 1 });
  const loose = h.addSession({ settings: { snapshotKeep: 10 } });
  for (const ordinal of [1, 2, 3]) h.addSnapshot(loose.id, ordinal, "turn");
  await h.manager.snapshot(loose.id, "manual");
  assert.deepEqual(h.removedImages(), []);
  assert.deepEqual(h.manager.snapshots(loose.id).map((s) => s.ordinal), [1, 2, 3, 4]);

  const strict = h.addSession({ settings: { snapshotKeep: 1 } });
  for (const ordinal of [1, 2, 3]) h.addSnapshot(strict.id, ordinal, "turn");
  await h.manager.snapshot(strict.id, "manual");
  assert.deepEqual(h.removedImages(), [`sha256:${strict.id}-1`, `sha256:${strict.id}-2`]);
  assert.deepEqual(h.manager.snapshots(strict.id).map((s) => [s.ordinal, s.reason]), [[3, "turn"], [4, "manual"]]);
});

test("snapshot: `snapshotKeep: 0` prunes nothing", async () => {
  // Observed: zero is "keep everything", not "keep none".
  const h = makeManager({ snapshotKeep: 0 });
  const { id } = h.addSession();
  for (const ordinal of [1, 2, 3]) h.addSnapshot(id, ordinal, "turn");
  await h.manager.snapshot(id, "turn");
  assert.deepEqual(h.removedImages(), []);
  assert.equal(h.manager.snapshots(id).length, 4);
});

test("deleteSnapshot: removes the image and the row; refuses a fork's origin and the Sandbox's base image; 404 otherwise", async () => {
  const h = makeManager();
  const { id } = h.addSession();
  const origin = h.addSnapshot(id, 1, "turn");
  const oldBase = h.addSnapshot(id, 2, "rebuild");
  const base = h.addSnapshot(id, 3, "rebuild");
  const plain = h.addSnapshot(id, 4, "manual");
  h.addFork(id, origin.id);
  await rejectsHttp(h.manager.deleteSnapshot(id, "nope"), 404, "snapshot nope not found");
  await rejectsHttp(h.manager.deleteSnapshot(id, origin.id), 409, "Snapshot 1 is the origin of 1 Session(s); delete them first.");
  await rejectsHttp(h.manager.deleteSnapshot(id, base.id), 409, "Snapshot 3 is the image the Sandbox runs on.");
  assert.deepEqual(h.removedImages(), []);
  await h.manager.deleteSnapshot(id, plain.id);
  // Observed: only the newest `rebuild` Snapshot counts as the base; an older one can go.
  await h.manager.deleteSnapshot(id, oldBase.id);
  assert.deepEqual(h.removedImages(), [plain.imageId, oldBase.imageId]);
  assert.deepEqual(h.manager.snapshots(id).map((s) => s.ordinal), [1, 3]);
  assert.deepEqual(h.types(), ["snapshots", "session", "snapshots", "session"]);
  await rejectsHttp(h.manager.deleteSnapshot("nope", plain.id), 404, "session nope not found");
});

test("deleteAllSnapshots: counts what went and what had to stay", async () => {
  const h = makeManager();
  const { id } = h.addSession();
  const origin = h.addSnapshot(id, 1, "turn");
  h.addSnapshot(id, 2, "rebuild");
  h.addSnapshot(id, 3, "rebuild");
  h.addSnapshot(id, 4, "manual");
  h.addSnapshot(id, 5, "turn");
  h.addFork(id, origin.id);
  assert.deepEqual(await h.manager.deleteAllSnapshots(id), { deleted: 3, kept: 2 });
  assert.deepEqual(h.removedImages(), [`sha256:${id}-2`, `sha256:${id}-4`, `sha256:${id}-5`]);
  assert.deepEqual(h.manager.snapshots(id).map((s) => s.ordinal), [1, 3]);
  assert.deepEqual(h.types(), ["snapshots", "session"]);
  assert.deepEqual(await h.manager.deleteAllSnapshots(id), { deleted: 0, kept: 2 });
  await rejectsHttp(h.manager.deleteAllSnapshots("nope"), 404, "session nope not found");
});

test("boot: collects the Snapshot images no Session's row references, and only those", async () => {
  const h = makeManager();
  const { id } = h.addSession();
  const known = h.addSnapshot(id, 1, "manual");
  h.docker.snapshotImageIds = [known.imageId, "sha256:0123456789abcdef0123456789abcdef", "sha256:fedcba9876543210"];
  h.docker.containerState = "stopped"; // so boot() does not try to reach a Daemon
  await h.manager.boot();
  await settle();
  assert.deepEqual(h.removedImages(), ["sha256:0123456789abcdef0123456789abcdef", "sha256:fedcba9876543210"]);
  assert.deepEqual(h.log, ["sandbox reach: host", "removed orphan snapshot image 0123456789ab", "removed orphan snapshot image fedcba987654"]);
  assert.deepEqual(h.manager.snapshots(id), [known]);
  assert.equal(h.manager.get(id).status, "stopped");
});

test("autoSnapshot: a completed turn is snapshotted before the queue plays on", async () => {
  const h = makeManager({ autoSnapshot: true });
  const { id } = h.addSession({ status: "running", queueRunning: true });
  h.connect(id);
  h.db.insertSavedMessage(id, "next");
  let promptedAfterCommit = null;
  h.manager.prompt = async () => {
    promptedAfterCommit = h.commits().length === 1;
  };
  h.turnEnded(id, 7);
  await settle();
  const [snapshot] = h.manager.snapshots(id);
  assert.deepEqual([snapshot.reason, snapshot.eventSeq, snapshot.ordinal], ["turn", 1, 1], "`eventSeq` is the stored event's seq, not the Daemon's");
  assert.equal(promptedAfterCommit, true);
  assert.deepEqual(h.types().filter((t) => t !== "event"), ["session", "snapshotting", "snapshots", "session", "session", "snapshotting", "saved_messages"]);
});

test("autoSnapshot: off by default, on for a Session that asks for it, and never for one that is not idle or runs in a VM", async () => {
  const h = makeManager();
  const off = h.addSession({ status: "running" });
  h.turnEnded(off.id);
  const on = h.addSession({ status: "running", settings: { autoSnapshot: true } });
  h.turnEnded(on.id);
  const stopped = h.addSession({ status: "stopped", settings: { autoSnapshot: true } });
  h.turnEnded(stopped.id);
  const windows = h.addSession({ status: "running", settings: { autoSnapshot: true }, sandbox: { environment: "qemu-windows" } });
  h.turnEnded(windows.id);
  await settle();
  assert.deepEqual(h.commits().map((c) => c[1]), [`ctr-${on.id}`]);
  assert.deepEqual(h.broadcasts.filter((b) => b.type === "snapshot_failed"), []);
  assert.equal(h.manager.get(windows.id).status, "idle");
  assert.equal(h.manager.get(stopped.id).status, "stopped");
});

test("autoSnapshot: a failed automatic Snapshot is logged and announced, and the turn still settles", async () => {
  const h = makeManager({ autoSnapshot: true });
  const { id } = h.addSession({ status: "running" });
  h.docker.commitImpl = async () => {
    throw new Error("docker is down");
  };
  const settled = [];
  h.manager.onTurnSettled((sessionId, outcome) => settled.push([sessionId, outcome]));
  h.turnEnded(id);
  await settle();
  assert.deepEqual(h.log, [`auto snapshot ${id} failed: docker is down`]);
  assert.deepEqual(
    h.broadcasts.filter((b) => b.type === "snapshot_failed"),
    [{ type: "snapshot_failed", sessionId: id, message: "Automatic snapshot failed. docker is down" }],
  );
  assert.deepEqual(settled, [[id, "end_turn"]]);
  assert.deepEqual(h.manager.snapshots(id), []);
});
