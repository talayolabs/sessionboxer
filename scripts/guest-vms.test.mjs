// Characterization tests (Feathers) for WindowsVms and MacosVms, the two GuestVms over a QEMU/KVM
// sidecar container, written before their shared lifecycle is pulled up into a QemuVms base class
// (docs/TECH-DEBT.md, fix 13). Each class is built with a fake VmHost and a fake dockerode that
// record every call, so the Docker call order, the volume and container names, the base record on
// disk and the user-facing refusals are what the tests observe. Expected values are the ones seen
// today (messages copied from the UI, names from the ADRs), not recomputed from the code. Run after
// `tsc -b`.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The base record lives under SESSIONBOXER_HOME; config.js reads it at import time.
const HOME = mkdtempSync(join(tmpdir(), "sbx-guest-vms-"));
process.env.SESSIONBOXER_HOME = HOME;
const { Settings } = await import("../packages/protocol/dist/index.js");
const { HttpError } = await import("../apps/control-plane/dist/http-error.js");
const { WindowsVms } = await import("../apps/control-plane/dist/windows.js");
const { MacosVms, TOOLCHAIN } = await import("../apps/control-plane/dist/macos.js");

const GB = 1024 ** 3;

/** A VmHost that answers from these fields and records what it is asked (into `calls`, shared with the fake Docker). */
function fakeHost(calls) {
  const host = {
    /** What `kvmUnavailable` answers: null (KVM works) or the reason. */
    kvm: null,
    /** Volumes that exist, by name, with the bytes they take. */
    volumes: new Map(),
    /** What `state` answers per container id. */
    states: new Map(),
    /** What a helper container prints (the AVX2 probe of the macOS VMs greps /proc/cpuinfo). */
    helperOutput: "avx2",
    async kvmUnavailable(refresh = false) {
      calls.push(["kvmUnavailable", refresh]);
      return host.kvm;
    },
    vmHostConfig(binds, ramGb) {
      return { Binds: binds, Memory: ramGb };
    },
    async ensureImage() {
      calls.push(["ensureImage"]);
    },
    async helper(script, binds) {
      calls.push(["helper", binds]);
      return host.helperOutput;
    },
    async tailLogs() {
      return [];
    },
    async start(vmId) {
      calls.push(["start", vmId]);
    },
    async stop(vmId) {
      calls.push(["stop", vmId]);
    },
    async state(vmId) {
      calls.push(["state", vmId]);
      return host.states.get(vmId) ?? "missing";
    },
    async volumeExists(name) {
      return host.volumes.has(name);
    },
    async volumeSize(name) {
      if (!host.volumes.has(name)) throw new Error(`no such volume: ${name}`);
      return host.volumes.get(name);
    },
    async removeVolume(name) {
      calls.push(["removeVolume", name]);
      host.volumes.delete(name);
    },
    async removeContainer(name) {
      calls.push(["removeContainer", name]);
    },
  };
  return host;
}

/** The three dockerode calls the classes make themselves (the rest goes through the VmHost). */
function fakeDocker(calls) {
  const docker = {
    /** Set to make `createContainer` fail (a missing image, a bad bind). */
    createContainerError: null,
    async createVolume(spec) {
      calls.push(["createVolume", spec]);
    },
    async createContainer(spec) {
      calls.push(["createContainer", spec.name]);
      if (docker.createContainerError) throw docker.createContainerError;
      return { id: `ctr-${spec.name}` };
    },
    getContainer() {
      return {
        async inspect() {
          throw Object.assign(new Error("no such container"), { statusCode: 404 });
        },
      };
    },
  };
  return docker;
}

/** What differs between the two platforms, as observed: names, the record on disk, the messages the UI shows. */
const PLATFORMS = [
  {
    name: "Windows",
    baseFile: "windows-base.json",
    label: "sessionboxer.windows",
    baseVolume: "sbx-windows-base",
    installContainer: "sbx-windows-install",
    vm: (id) => `sbx-win-${id}`,
    installed: { version: "11", diskGb: 64, installedAt: "2026-01-01T00:00:00.000Z", sizeBytes: 12 * GB },
    construct: (docker, deps, host) => new WindowsVms(docker, ...deps, host),
    notInstalled: "The Windows base disk is not installed (Global settings → Environment → Windows VMs).",
    installFirst: "Install the Windows base disk first (Global settings → Environment → Windows VMs).",
    noInstall: "No Windows base install is running.",
    stillUsed: (n, then) => `${n} Windows Session${n === 1 ? " still uses" : "s still use"} the base disk; delete ${n === 1 ? "it" : "them"} ${then}.`,
    missingStatus: (sessions) => ({ state: "missing", version: null, sizeBytes: 0, startedAt: null, log: [], error: null, sessions }),
    readyStatus: (sessions) => ({ state: "ready", version: "11", sizeBytes: 12 * GB, startedAt: null, log: [], error: null, sessions }),
  },
  {
    name: "macOS",
    baseFile: "macos-base.json",
    label: "sessionboxer.macos",
    baseVolume: "sbx-macos-base",
    installContainer: "sbx-macos-install",
    vm: (id) => `sbx-mac-${id}`,
    // The TOOLCHAIN the base needs today; an older number means "reprovision".
    installed: { version: "15", diskGb: 64, installedAt: "2026-01-01T00:00:00.000Z", sizeBytes: 20 * GB, productVersion: "15.6", toolchain: TOOLCHAIN },
    construct: (docker, deps, host) => new MacosVms({ docker, reach: "ip" }, ...deps, host),
    notInstalled: "The macOS base disk is not installed (Global settings → Environment → macOS VMs).",
    installFirst: "Install the macOS base disk first (Global settings → Environment → macOS VMs).",
    noInstall: "No macOS base install is running.",
    stillUsed: (n, then) => `${n} macOS Session${n === 1 ? " still uses" : "s still use"} the base disk; delete ${n === 1 ? "it" : "them"} ${then}.`,
    missingStatus: (sessions) => ({ state: "missing", toolchain: false, reprovisioning: false, version: null, sizeBytes: 0, startedAt: null, log: [], error: null, sessions, setup: null }),
    readyStatus: (sessions) => ({ state: "ready", toolchain: true, reprovisioning: false, version: "15", sizeBytes: 20 * GB, startedAt: null, log: [], error: null, sessions, setup: null }),
  },
];

/** The class under test with every side channel captured; `base` is the record on disk when it starts (and its volume exists). */
function make(p, { base = null, sessions = 0 } = {}) {
  const file = join(HOME, p.baseFile);
  if (base) writeFileSync(file, JSON.stringify(base));
  else rmSync(file, { force: true });
  const calls = [];
  const host = fakeHost(calls);
  const docker = fakeDocker(calls);
  let settings = Settings.parse({});
  const saved = [];
  const statuses = [];
  const deps = [
    () => settings,
    (next) => {
      settings = next;
      saved.push(next);
    },
    () => sessions,
    (status) => statuses.push(status),
  ];
  const vms = p.construct(docker, deps, host);
  if (base) host.volumes.set(p.baseVolume, base.sizeBytes);
  return { vms, host, docker, calls, saved, statuses, file };
}

const rejectsWith = (promise, status, message) =>
  assert.rejects(promise, (e) => {
    assert.ok(e instanceof HttpError, `expected an HttpError, got ${e}`);
    assert.equal(e.status, status);
    assert.equal(e.message, message);
    return true;
  });

for (const p of PLATFORMS) {
  test(`${p.name}: create() clears leftovers, makes the labelled volume, builds the overlay, then the stopped VM container`, async () => {
    const h = make(p, { base: p.installed });
    const id = await h.vms.create("s1");
    assert.equal(id, `ctr-${p.vm("s1")}`);
    assert.deepEqual(h.calls, [
      ["removeContainer", p.vm("s1")],
      ["removeVolume", p.vm("s1")],
      ["createVolume", { Name: p.vm("s1"), Labels: { [p.label]: "s1" } }],
      ["helper", [`${p.baseVolume}:/base:ro`, `${p.vm("s1")}:/storage`]],
      ["createContainer", p.vm("s1")],
    ]);
  });

  test(`${p.name}: create() removes the Session's volume and rethrows when the container cannot be created`, async () => {
    const h = make(p, { base: p.installed });
    const boom = new Error("No such image");
    h.docker.createContainerError = boom;
    await assert.rejects(h.vms.create("s1"), (e) => e === boom);
    assert.deepEqual(h.calls.slice(-2), [
      ["createContainer", p.vm("s1")],
      ["removeVolume", p.vm("s1")],
    ]);
  });

  test(`${p.name}: create() refuses with 409 and touches nothing when no base is installed`, async () => {
    const h = make(p);
    await rejectsWith(h.vms.create("s1"), 409, p.notInstalled);
    assert.deepEqual(h.calls, []);
  });

  test(`${p.name}: remove() removes the VM container, then the Session's volume`, async () => {
    const h = make(p, { base: p.installed });
    await h.vms.remove("s1");
    assert.deepEqual(h.calls, [
      ["removeContainer", p.vm("s1")],
      ["removeVolume", p.vm("s1")],
    ]);
  });

  test(`${p.name}: diskUsage() is the volume's size, or null when the volume is gone`, async () => {
    const h = make(p, { base: p.installed });
    assert.equal(await h.vms.diskUsage("s1"), null);
    h.host.volumes.set(p.vm("s1"), 3 * GB);
    assert.equal(await h.vms.diskUsage("s1"), 3 * GB);
  });

  test(`${p.name}: start(), stop() and state() pass the container id through to the host`, async () => {
    const h = make(p);
    h.host.states.set("ctr-1", "running");
    await h.vms.start("ctr-1");
    await h.vms.stop("ctr-1");
    assert.equal(await h.vms.state("ctr-1"), "running");
    assert.equal(await h.vms.state("ctr-2"), "missing");
    assert.deepEqual(h.calls, [
      ["start", "ctr-1"],
      ["stop", "ctr-1"],
      ["state", "ctr-1"],
      ["state", "ctr-2"],
    ]);
  });

  test(`${p.name}: vmName() is the Session's VM container (its volume has the same name)`, () => {
    const h = make(p);
    assert.equal(h.vms.vmName("abc123"), p.vm("abc123"));
  });

  test(`${p.name}: removeBase() refuses while Sessions build on the base, counting them in the message`, async () => {
    for (const [sessions, message] of [
      [1, p.stillUsed(1, "first")],
      [2, p.stillUsed(2, "first")],
    ]) {
      const h = make(p, { base: p.installed, sessions });
      await rejectsWith(h.vms.removeBase(), 409, message);
      assert.deepEqual(h.calls, []);
      assert.ok(existsSync(h.file), "the base record stays");
    }
  });

  test(`${p.name}: removeBase() removes the install container, the base volume and the record, then reports "missing"`, async () => {
    const h = make(p, { base: p.installed });
    const status = await h.vms.removeBase();
    assert.deepEqual(h.calls, [
      ["removeContainer", p.installContainer],
      ["removeVolume", p.baseVolume],
    ]);
    assert.equal(existsSync(h.file), false);
    assert.deepEqual(status, p.missingStatus(0));
    assert.deepEqual(h.statuses, [p.missingStatus(0)]);
  });

  test(`${p.name}: status() reads the installed base from its record and counts the Sessions on it`, () => {
    const h = make(p, { base: p.installed, sessions: 3 });
    assert.deepEqual(h.vms.status(), p.readyStatus(3));
    assert.deepEqual(make(p).vms.status(), p.missingStatus(0));
  });

  test(`${p.name}: availability() is the KVM reason, then "install first", then available`, async () => {
    const noKvm = make(p, { base: p.installed });
    noKvm.host.kvm = "The Docker host has no /dev/kvm; the VMs need a Linux host with KVM.";
    assert.deepEqual(await noKvm.vms.availability(), { available: false, reason: noKvm.host.kvm });
    assert.deepEqual(await make(p).vms.availability(), { available: false, reason: p.installFirst });
    assert.deepEqual(await make(p, { base: p.installed }).vms.availability(), { available: true, reason: null });
  });

  test(`${p.name}: cancelInstall() is a 409 when nothing is installing`, async () => {
    const h = make(p);
    await rejectsWith(h.vms.cancelInstall(), 409, p.noInstall);
    assert.deepEqual(h.calls, []);
  });

  test(`${p.name}: install() refuses while Sessions build on the base, and when KVM is unavailable (probed afresh)`, async () => {
    const used = make(p, { base: p.installed, sessions: 1 });
    await rejectsWith(used.vms.install(), 409, p.stillUsed(1, "before reinstalling it"));
    assert.deepEqual(used.calls, []);
    const noKvm = make(p);
    noKvm.host.kvm = "/dev/kvm is not usable inside containers on this Docker host.";
    await rejectsWith(noKvm.vms.install(), 409, noKvm.host.kvm);
    assert.deepEqual(noKvm.calls, [["kvmUnavailable", true]]);
  });

  test(`${p.name}: init() forgets a base whose volume is gone and is quiet when no install container is left`, async () => {
    const h = make(p, { base: p.installed });
    h.host.volumes.delete(p.baseVolume);
    await h.vms.init();
    assert.equal(existsSync(h.file), false);
    assert.deepEqual(h.vms.status(), p.missingStatus(0));
    const intact = make(p, { base: p.installed });
    await intact.vms.init();
    assert.deepEqual(JSON.parse(readFileSync(intact.file, "utf8")), p.installed);
    assert.deepEqual(intact.vms.status(), p.readyStatus(0));
  });
}

const macos = PLATFORMS[1];

test("macOS: availability() also needs AVX2 on the host, probed with a helper container", async () => {
  const h = make(macos, { base: macos.installed });
  h.host.helperOutput = "none";
  assert.deepEqual(await h.vms.availability(), { available: false, reason: "The host CPU has no AVX2, which macOS needs." });
  assert.deepEqual(h.calls, [["kvmUnavailable", false], ["helper", []]]);
});

test("macOS: a base without the current toolchain is ready but not available until reprovisioned", async () => {
  const h = make(macos, { base: { ...macos.installed, toolchain: 1 } });
  assert.deepEqual(await h.vms.availability(), {
    available: false,
    reason: "The macOS base disk has no agent toolchain yet; reprovision it (Global settings → Environment → macOS VMs).",
  });
  assert.equal(h.vms.status().state, "ready");
  assert.equal(h.vms.status().toolchain, false);
});

test("macOS: a half-installed base (no installedAt) is an error status that create() refuses and removeBase() deletes", async () => {
  const partial = { version: "15", diskGb: 64, installedAt: null, sizeBytes: 0, productVersion: null };
  const h = make(macos, { base: partial });
  assert.deepEqual(h.vms.status(), {
    state: "error",
    toolchain: false,
    reprovisioning: false,
    version: "15",
    sizeBytes: 0,
    startedAt: null,
    log: [],
    error: "An earlier install stopped before macOS was set up. Install again to continue with the disk as it is, or delete it.",
    sessions: 0,
    setup: null,
  });
  await rejectsWith(h.vms.create("s1"), 409, macos.notInstalled);
  await h.vms.removeBase();
  assert.equal(existsSync(h.file), false);
});
