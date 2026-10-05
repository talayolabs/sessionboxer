// The Sandbox images per Provider (ADR-0088): the resolver, the per-reference status and lazy
// pulls of `SandboxImages`, the label check and the legacy preflight. Docker is a fake: images
// are "here" when the test says so, pulls finish when the test says so.
import test from "node:test";
import assert from "node:assert/strict";

const { PROVIDERS } = await import("../packages/protocol/dist/index.js");
const { SANDBOX_IMAGE_REPO, SANDBOX_IMAGE_VERSION, sandboxBaseImage, sandboxImageFor } = await import("../apps/control-plane/dist/config.js");
const { HttpError } = await import("../apps/control-plane/dist/http-error.js");
const { SandboxImages, buildCommandFor, isLocalOnly, labelledProviders, parseImageSelector } = await import("../apps/control-plane/dist/sandbox-images.js");
const { ProviderPayloads, launcherLinks, payloadDigest, readEntries, verifyPayload } = await import("../apps/control-plane/dist/provider-payload.js");
const { flattenChanges } = await import("../apps/control-plane/dist/docker.js");
const { pack } = await import("tar-stream");

const REPO = SANDBOX_IMAGE_REPO;
const V = SANDBOX_IMAGE_VERSION;
const noLog = () => undefined;

/** A Docker with the images in `local` (labels from `labels`), where `executables` is what `command -v` finds in any image; pulls hang until `finish`/`fail`. */
function fakeDocker({ local = [], labels = {}, env = {}, executables = [], archives = {}, containers = {} } = {}) {
  const here = new Set(local);
  const pending = new Map();
  const docker = {
    pulls: [],
    probes: [],
    /** The donor containers created (never started) and whether each was removed. */
    donors: [],
    here,
    getImage(ref) {
      return {
        async inspect() {
          if (!here.has(ref)) throw Object.assign(new Error(`No such image: ${ref}`), { statusCode: 404 });
          return { Id: `sha256:${ref}`, Config: { Labels: labels[ref] ?? {}, Env: env[ref] ?? [] } };
        },
      };
    },
    /** A container by id (`containers`: id → { files: Set of paths that exist, archives: path → tar entries, puts: [] }). */
    getContainer(id) {
      const c = containers[id];
      return {
        async getArchive({ path }) {
          if (!c.archives?.[path]) throw Object.assign(new Error(`Could not find the file ${path}`), { statusCode: 404 });
          return tarOf(c.archives[path]);
        },
        async putArchive(stream, { path }) {
          c.puts.push({ path, entries: (await readEntries(stream, null)).entries });
        },
        async infoArchive({ path }) {
          if (!c.files.has(path)) throw Object.assign(new Error(`Could not find the file ${path}`), { statusCode: 404 });
          return {};
        },
      };
    },
    async pull(ref) {
      docker.pulls.push(ref);
      return { ref };
    },
    modem: {
      followProgress(stream, onFinished, onProgress) {
        pending.set(stream.ref, { onFinished, onProgress });
      },
    },
    async createContainer(opts) {
      if (opts.Labels["sessionboxer.helper"] === "payload-donor") {
        const donor = { id: `donor-${docker.donors.length + 1}`, opts, removed: false, started: false };
        docker.donors.push(donor);
        return {
          id: donor.id,
          async start() {
            donor.started = true;
          },
          async getArchive({ path }) {
            const entries = archives[opts.Image]?.[path];
            if (!entries) throw Object.assign(new Error(`Could not find the file ${path}`), { statusCode: 404 });
            return tarOf(entries);
          },
          async remove() {
            donor.removed = true;
          },
        };
      }
      docker.probes.push(opts);
      const bin = opts.Entrypoint[4];
      return { async start() {}, async wait() { return { StatusCode: executables.includes(bin) ? 0 : 1 }; }, async remove() {} };
    },
    /** A layer event of the pull of `ref`. */
    progress(ref, id, current, total) {
      pending.get(ref).onProgress({ id, status: "Downloading", progressDetail: { current, total } });
    },
    async finish(ref) {
      here.add(ref);
      pending.get(ref).onFinished(null);
      pending.delete(ref);
      await new Promise((r) => setImmediate(r));
    },
    async fail(ref, message) {
      pending.get(ref).onFinished(new Error(message));
      pending.delete(ref);
      await new Promise((r) => setImmediate(r));
    },
    pulling: () => [...pending.keys()],
  };
  return docker;
}

const tick = () => new Promise((r) => setImmediate(r));

/** A tar of `entries` (`{ name, type, content, linkname, mode }`), as the archive API streams one. */
function tarOf(entries) {
  const tar = pack();
  for (const e of entries) {
    const header = { name: e.name, type: e.type ?? "file", mode: e.mode ?? (e.type === "directory" ? 0o755 : 0o644), uid: 0, gid: 0, mtime: new Date(0), ...(e.linkname ? { linkname: e.linkname } : {}) };
    if (header.type === "file") tar.entry({ ...header, size: Buffer.byteLength(e.content ?? "") }, e.content ?? "");
    else tar.entry(header);
  }
  tar.finalize();
  return tar;
}

const CODEX_MANIFEST = { provider: "codex", version: "1.1.9", payloadFormat: 1, files: ["bin/codex-acp", "lib/index.js", "lib/dist/run.js"] };
/** The Codex payload directory as `getArchive /opt/sessionboxer/providers/codex` streams it. */
function codexPayload(manifest = CODEX_MANIFEST, extra = []) {
  return [
    { name: "codex/", type: "directory" },
    { name: "codex/manifest.json", content: JSON.stringify(manifest) },
    { name: "codex/bin/", type: "directory" },
    { name: "codex/bin/codex-acp", type: "symlink", linkname: "../lib/index.js" },
    { name: "codex/lib/", type: "directory" },
    { name: "codex/lib/index.js", content: "#!/usr/bin/env node\nrequire('./dist/run.js');\n", mode: 0o755 },
    { name: "codex/lib/dist/", type: "directory" },
    { name: "codex/lib/dist/run.js", content: "console.log('codex')" },
    ...extra,
  ];
}
const payloadEntries = async (entries) => (await readEntries(tarOf(entries), "codex/manifest.json")).entries;
const PAYLOADS = "/opt/sessionboxer/providers";
const RUNTIME = { "io.sessionboxer.payload-format": "1", "io.sessionboxer.runtime": V };
const claudeImage = `${REPO}:${V}-claude-code`;
const codexImage = `${REPO}:${V}-codex`;
const rejectsWith = (promise, status, pattern) =>
  assert.rejects(promise, (e) => {
    assert.ok(e instanceof HttpError, `expected an HttpError, got ${String(e)}`);
    assert.equal(e.status, status);
    assert.match(e.message, pattern);
    return true;
  });


test("the resolver names one image per Provider and a base one, and SESSIONBOXER_IMAGE overrides both verbatim", () => {
  const before = process.env.SESSIONBOXER_IMAGE;
  delete process.env.SESSIONBOXER_IMAGE;
  try {
    assert.equal(sandboxImageFor("codex"), `${REPO}:${V}-codex`);
    assert.equal(sandboxImageFor("claude-code"), `${REPO}:${V}-claude-code`);
    assert.equal(sandboxBaseImage(), `${REPO}:${V}-base`);
    process.env.SESSIONBOXER_IMAGE = " sessionboxer/sandbox:dev ";
    for (const p of PROVIDERS) assert.equal(sandboxImageFor(p), "sessionboxer/sandbox:dev");
    assert.equal(sandboxBaseImage(), "sessionboxer/sandbox:dev");
    process.env.SESSIONBOXER_IMAGE = "";
    assert.equal(sandboxImageFor("codex"), `${REPO}:${V}-codex`);
  } finally {
    if (before === undefined) delete process.env.SESSIONBOXER_IMAGE;
    else process.env.SESSIONBOXER_IMAGE = before;
  }
});

test("local development tags are never pulled and name their build command", () => {
  assert.equal(isLocalOnly("sessionboxer/sandbox:dev"), true);
  assert.equal(isLocalOnly("sessionboxer/sandbox:dev-codex"), true);
  assert.equal(isLocalOnly("sandbox"), true);
  assert.equal(isLocalOnly(`${REPO}:${V}-codex`), false);
  assert.equal(isLocalOnly("ghcr.io/other/image:dev"), true);
  assert.equal(isLocalOnly("ghcr.io/other/image:1.0"), false);
  assert.equal(buildCommandFor("sessionboxer/sandbox:dev"), "npm run build:image");
  assert.equal(buildCommandFor("sessionboxer/sandbox:dev-codex"), "npm run build:image -- --provider codex");
  assert.equal(buildCommandFor(`${REPO}:${V}-claude-code`), "npm run build:image -- --provider claude-code");
  assert.equal(buildCommandFor(`${REPO}:${V}-base`), "npm run build:image -- --provider base");
  assert.equal(buildCommandFor(`${REPO}:${V}`), "npm run build:image");
  assert.equal(buildCommandFor("ghcr.io/other/image:1.0"), null);
});

test("the ?provider= selector defaults to the first Provider, accepts base, rejects the rest with a 400", () => {
  assert.equal(parseImageSelector(undefined), PROVIDERS[0]);
  assert.equal(parseImageSelector(""), PROVIDERS[0]);
  assert.equal(parseImageSelector("base"), "base");
  assert.equal(parseImageSelector("claude-code"), "claude-code");
  assert.throws(() => parseImageSelector("claude"), (e) => e instanceof HttpError && e.status === 400 && /"claude"/.test(e.message));
});

test("labelledProviders reads io.sessionboxer.providers, dropping unknown ids; no label = null", () => {
  assert.deepEqual(labelledProviders({ "io.sessionboxer.providers": "codex, claude-code,unknown" }), ["codex", "claude-code"]);
  assert.deepEqual(labelledProviders({ "io.sessionboxer.providers": "" }), []);
  assert.equal(labelledProviders({}), null);
  assert.equal(labelledProviders(undefined), null);
});

test("status is kept per reference; GET-style inspect reports ready/missing and starts no pull", async () => {
  const codex = `${REPO}:${V}-codex`;
  const claude = `${REPO}:${V}-claude-code`;
  const docker = fakeDocker({ local: [codex] });
  const images = new SandboxImages(docker, noLog);
  assert.deepEqual(images.status(codex), { image: codex, state: "checking", received: 0, total: 0, error: null });
  assert.deepEqual(await images.inspect(codex), { image: codex, state: "ready", received: 0, total: 0, error: null });
  assert.deepEqual(await images.inspect(claude), { image: claude, state: "missing", received: 0, total: 0, error: null });
  const dev = "sessionboxer/sandbox:dev-pi";
  const missingDev = await images.inspect(dev);
  assert.equal(missingDev.state, "missing");
  assert.match(missingDev.error, /npm run build:image -- --provider pi/);
  assert.deepEqual(docker.pulls, []);
  assert.deepEqual(docker.probes, []);
  await assert.rejects(images.ensure(dev), /npm run build:image -- --provider pi/);
  assert.deepEqual(docker.pulls, []);
  assert.equal((await images.prefetch(codex)).state, "ready");
  assert.match((await images.prefetch(dev)).error, /npm run build:image -- --provider pi/);
  assert.deepEqual(docker.pulls, []);
});

test("prefetch starts the pull and answers `pulling` right away; the pull runs on", async () => {
  const codex = `${REPO}:${V}-codex`;
  const docker = fakeDocker();
  const images = new SandboxImages(docker, noLog);
  assert.deepEqual(await images.prefetch(codex), { image: codex, state: "pulling", received: 0, total: 0, error: null });
  assert.deepEqual(docker.pulls, [codex]);
  assert.equal((await images.prefetch(codex)).state, "pulling");
  assert.deepEqual(docker.pulls, [codex]);
  await docker.finish(codex);
  assert.equal(images.status(codex).state, "ready");
});

test("ensure pulls a missing image once, shares the pull, tracks progress per layer and leaves other references alone", async () => {
  const codex = `${REPO}:${V}-codex`;
  const claude = `${REPO}:${V}-claude-code`;
  const docker = fakeDocker({ local: [claude] });
  const images = new SandboxImages(docker, noLog);
  const first = images.ensure(codex);
  const second = images.ensure(codex);
  await tick();
  assert.deepEqual(docker.pulls, [codex]);
  assert.equal(images.status(codex).state, "pulling");
  docker.progress(codex, "a", 10, 100);
  docker.progress(codex, "b", 0, 50);
  docker.progress(codex, "a", 60, 100);
  assert.deepEqual(images.status(codex), { image: codex, state: "pulling", received: 60, total: 150, error: null });
  assert.equal((await images.inspect(codex)).state, "pulling");
  assert.equal((await images.inspect(claude)).state, "ready");
  await docker.finish(codex);
  await Promise.all([first, second]);
  assert.equal(images.status(codex).state, "ready");
  await images.ensure(codex);
  assert.deepEqual(docker.pulls, [codex]);
});

test("at most N references download at once; a failure stays with its reference until retried", async () => {
  const a = `${REPO}:${V}-codex`;
  const b = `${REPO}:${V}-claude-code`;
  const docker = fakeDocker();
  const images = new SandboxImages(docker, noLog, 1);
  const pullA = images.ensure(a);
  const pullB = images.ensure(b);
  await tick();
  assert.deepEqual(docker.pulls, [a]);
  assert.equal(images.status(b).state, "pulling");
  const rejected = assert.rejects(pullA, /cannot pull .*-codex: registry down.*npm run build:image -- --provider codex/);
  await docker.fail(a, "registry down");
  await rejected;
  assert.equal(images.status(a).state, "error");
  await tick();
  assert.deepEqual(docker.pulls, [a, b]);
  assert.equal((await images.inspect(a)).state, "error");
  await docker.finish(b);
  await pullB;
  assert.equal(images.status(b).state, "ready");
  assert.equal(images.status(a).state, "error");
  const retry = images.ensure(a);
  await tick();
  assert.deepEqual(docker.pulls, [a, b, a]);
  await docker.finish(a);
  await retry;
  assert.equal(images.status(a).state, "ready");
});

test("resolve trusts the labels: the named Provider passes, another fails clearly, a base image cannot run an Agent", async () => {
  const codex = `${REPO}:${V}-codex`;
  const base = `${REPO}:${V}-base`;
  const future = `${REPO}:9.0.0-codex`;
  const docker = fakeDocker({
    local: [codex, base, future],
    labels: {
      [codex]: { "io.sessionboxer.providers": "codex", "io.sessionboxer.payload-format": "1" },
      [base]: { "io.sessionboxer.providers": "" },
      [future]: { "io.sessionboxer.providers": "codex", "io.sessionboxer.payload-format": "2" },
    },
  });
  const images = new SandboxImages(docker, noLog);
  assert.deepEqual(await images.resolve(codex, "codex"), { reference: codex, id: `sha256:${codex}`, providers: ["codex"], runtime: null, payloads: [] });
  await assert.rejects(images.resolve(future, "codex"), /payload format 2; this Control Plane .* reads format 1/);
  await assert.rejects(images.resolve(codex, "claude-code"), /carries Codex, not Claude Code; Claude Code Sessions need .*-claude-code/);
  await assert.rejects(images.resolve(base, "codex"), /base image without an Agent; Codex Sessions need .*-codex/);
  const before = process.env.SESSIONBOXER_IMAGE;
  try {
    process.env.SESSIONBOXER_IMAGE = codex;
    await assert.rejects(images.resolve(codex, "claude-code"), /carries Codex, not Claude Code; SESSIONBOXER_IMAGE must name an image that carries Claude Code \(or be unset\)/);
  } finally {
    if (before === undefined) delete process.env.SESSIONBOXER_IMAGE;
    else process.env.SESSIONBOXER_IMAGE = before;
  }
  assert.deepEqual(await images.resolve(base, "base"), { reference: base, id: `sha256:${base}`, providers: [], runtime: null, payloads: [] });
  assert.deepEqual(await images.resolve(codex, "base"), { reference: codex, id: `sha256:${codex}`, providers: ["codex"], runtime: null, payloads: [] });
  assert.deepEqual(docker.probes, []);
});

test("a legacy image without labels counts as all Providers once the Agent's executable is found, probed once per image", async () => {
  const dev = "sessionboxer/sandbox:dev";
  const docker = fakeDocker({ local: [dev], executables: ["codex-acp", "claude-agent-acp"] });
  const images = new SandboxImages(docker, noLog);
  assert.deepEqual(await images.resolve(dev, "codex"), { reference: dev, id: `sha256:${dev}`, providers: null, runtime: null, payloads: [] });
  assert.deepEqual(await images.resolve(dev, "codex"), { reference: dev, id: `sha256:${dev}`, providers: null, runtime: null, payloads: [] });
  assert.equal(docker.probes.length, 1);
  assert.equal(docker.probes[0].Image, dev);
  assert.deepEqual(docker.probes[0].Entrypoint.slice(-1), ["codex-acp"]);
  assert.equal(docker.probes[0].HostConfig.NetworkMode, "none");
  await images.resolve(dev, "claude-code");
  assert.equal(docker.probes.length, 2);
  await assert.rejects(images.resolve(dev, "gemini"), /has no Gemini CLI: `gemini` is not on its PATH/);
  await images.resolve(dev, "base");
  assert.equal(docker.probes.length, 3);
});

// --- Agent payloads for cross-Provider forks (ADR-0088 §9) ---------------------------------------

test("need: nothing to stage when the Snapshot recorded the Agent, its labels name it, or a legacy image has the executable", async () => {
  const snap = "sessionboxer/snapshot:s1-1";
  const legacy = "sessionboxer/snapshot:old-1";
  const docker = fakeDocker({ local: [snap, legacy, codexImage], labels: { [snap]: { ...RUNTIME, "io.sessionboxer.providers": "claude-code" }, [codexImage]: { ...RUNTIME, "io.sessionboxer.providers": "codex" } }, executables: ["codex-acp"] });
  const payloads = new ProviderPayloads(docker, new SandboxImages(docker, noLog), noLog);
  assert.equal(await payloads.need("claude-code", snap, null), null, "the label names it");
  assert.equal(await payloads.need("codex", snap, ["claude-code", "codex"]), null, "the Snapshot's record wins over the label");
  assert.equal(await payloads.need("codex", legacy, null), null, "a legacy image: the preflight finds the executable");
  assert.equal(docker.probes.length, 1);
  await rejectsWith(payloads.need("gemini", legacy, null), 409, /has no Gemini CLI and carries no Sessionboxer labels/);
  assert.deepEqual(await payloads.need("codex", snap, null), { provider: "codex", donor: codexImage, imageEnv: [] });
  assert.deepEqual(await payloads.need("codex", snap, ["claude-code"]), { provider: "codex", donor: codexImage, imageEnv: [] }, "a base-labelled or single-Agent Snapshot needs the donor");
});

test("need: another release's runtime, a missing local donor and a SESSIONBOXER_IMAGE without the Agent are refused with the reason", async () => {
  const old = "sessionboxer/snapshot:s1-1";
  const unlabelledRuntime = "sessionboxer/snapshot:s1-2";
  const snap = "sessionboxer/snapshot:s1-3";
  const docker = fakeDocker({
    local: [old, unlabelledRuntime, snap, "sessionboxer/sandbox:dev"],
    labels: {
      [old]: { ...RUNTIME, "io.sessionboxer.runtime": "1.4.0", "io.sessionboxer.providers": "claude-code" },
      [unlabelledRuntime]: { "io.sessionboxer.providers": "claude-code" },
      [snap]: { ...RUNTIME, "io.sessionboxer.providers": "" },
      "sessionboxer/sandbox:dev": { ...RUNTIME, "io.sessionboxer.providers": "claude-code" },
    },
  });
  const payloads = new ProviderPayloads(docker, new SandboxImages(docker, noLog), noLog);
  await rejectsWith(payloads.need("codex", old, null), 409, new RegExp(`taken on Sessionboxer 1.4.0's Sandbox image and this Control Plane is ${V}.*Codex cannot be added`));
  await rejectsWith(payloads.need("codex", unlabelledRuntime, null), 409, /names its Agents but not its runtime/);
  const before = process.env.SESSIONBOXER_IMAGE;
  try {
    process.env.SESSIONBOXER_IMAGE = "sessionboxer/sandbox:dev-codex";
    await rejectsWith(payloads.need("codex", snap, null), 409, /Codex cannot be added to the fork: its Sandbox image sessionboxer\/sandbox:dev-codex is not on this machine; pull it, or build it with `npm run build:image -- --provider codex`/);
    process.env.SESSIONBOXER_IMAGE = "sessionboxer/sandbox:dev";
    await rejectsWith(payloads.need("codex", snap, null), 409, /SESSIONBOXER_IMAGE=sessionboxer\/sandbox:dev carries Claude Code, not Codex; Codex forks need an image with it \(or no SESSIONBOXER_IMAGE/);
    delete process.env.SESSIONBOXER_IMAGE;
    assert.deepEqual(await payloads.need("codex", snap, null), { provider: "codex", donor: codexImage, imageEnv: [] }, "a pullable donor that is not here yet is left to prepare()");
  } finally {
    if (before === undefined) delete process.env.SESSIONBOXER_IMAGE;
    else process.env.SESSIONBOXER_IMAGE = before;
  }
});

test("prepare: pulls the donor once, checks it is this release's image with the Agent, and finds the variables it sets beyond the Snapshot's", async () => {
  const docker = fakeDocker({ labels: { [codexImage]: { ...RUNTIME, "io.sessionboxer.providers": "codex" } }, env: { [codexImage]: ["PATH=/usr/local/bin:/usr/bin", "CODEX_HOME=/opt/sessionboxer/providers/codex/home"] } });
  const payloads = new ProviderPayloads(docker, new SandboxImages(docker, noLog), noLog);
  const need = { provider: "codex", donor: codexImage, imageEnv: ["PATH=/usr/local/bin:/usr/bin"] };
  const preparing = payloads.prepare(need);
  await tick();
  assert.deepEqual(docker.pulls, [codexImage]);
  await docker.finish(codexImage);
  assert.deepEqual(await preparing, { ...need, env: { CODEX_HOME: "/opt/sessionboxer/providers/codex/home" } });

  const stale = fakeDocker({ local: [codexImage], labels: { [codexImage]: { ...RUNTIME, "io.sessionboxer.runtime": "1.9.0", "io.sessionboxer.providers": "codex" } } });
  await assert.rejects(new ProviderPayloads(stale, new SandboxImages(stale, noLog), noLog).prepare(need), new RegExp(`is Sessionboxer 1.9.0's image; this Control Plane is ${V}`));
  const offline = fakeDocker();
  const failing = assert.rejects(new ProviderPayloads(offline, new SandboxImages(offline, noLog), noLog).prepare(need), /Codex cannot be added to the fork: cannot pull .*no route to host \(or build it here: `npm run build:image -- --provider codex`\)/);
  await tick();
  await offline.fail(codexImage, "dial tcp: no route to host");
  await failing;
});

test("inject: lifts the payload out of a never-started donor, checks it against its manifest, puts it and the launcher links into the stopped fork, removes the donor", async () => {
  const fork = { files: new Set(["/usr/bin/node"]), archives: {}, puts: [] };
  const docker = fakeDocker({ local: [codexImage], labels: { [codexImage]: { ...RUNTIME, "io.sessionboxer.providers": "codex" } }, archives: { [codexImage]: { [`${PAYLOADS}/codex`]: codexPayload() } }, containers: { fork } });
  const payloads = new ProviderPayloads(docker, new SandboxImages(docker, noLog), noLog);
  const plan = { provider: "codex", donor: codexImage, imageEnv: [], env: {} };
  const result = await payloads.inject("fork", plan);
  assert.deepEqual([docker.donors.length, docker.donors[0].started, docker.donors[0].removed], [1, false, true]);
  assert.equal(docker.donors[0].opts.HostConfig.NetworkMode, "none");
  assert.deepEqual(docker.donors[0].opts.Labels, { "sessionboxer.helper": "payload-donor" });
  assert.deepEqual(result, { provider: "codex", version: "1.1.9", digest: payloadDigest(await payloadEntries(codexPayload())), bytes: Buffer.byteLength(JSON.stringify(CODEX_MANIFEST)) + Buffer.byteLength("#!/usr/bin/env node\nrequire('./dist/run.js');\n") + Buffer.byteLength("console.log('codex')"), from: codexImage });
  assert.match(result.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(fork.puts.map((p) => p.path), ["/opt/sessionboxer", PAYLOADS, "/usr/local/bin"]);
  assert.deepEqual(fork.puts[0].entries.map((e) => [e.name, e.type]), [["providers/", "directory"]]);
  assert.deepEqual(fork.puts[1].entries.map((e) => e.name), codexPayload().map((e) => e.name));
  assert.deepEqual(fork.puts[2].entries.map((e) => [e.name, e.type, e.linkname]), [["codex-acp", "symlink", `${PAYLOADS}/codex/bin/codex-acp`]]);
});

test("inject: the same payload already in the fork only gets its links; other content there is a collision; a missing interpreter and a donor without the payload are refused — the donor goes every time", async () => {
  const same = { files: new Set(["/usr/bin/node"]), archives: { [`${PAYLOADS}/codex`]: codexPayload() }, puts: [] };
  const other = { files: new Set(["/usr/bin/node"]), archives: { [`${PAYLOADS}/codex`]: codexPayload(CODEX_MANIFEST, [{ name: "codex/lib/extra.js", content: "x" }]) }, puts: [] };
  const noNode = { files: new Set(), archives: {}, puts: [] };
  const docker = fakeDocker({
    local: [codexImage, claudeImage],
    labels: { [codexImage]: { ...RUNTIME, "io.sessionboxer.providers": "codex" } },
    archives: { [codexImage]: { [`${PAYLOADS}/codex`]: codexPayload() } },
    containers: { same, other, noNode },
  });
  const payloads = new ProviderPayloads(docker, new SandboxImages(docker, noLog), noLog);
  const plan = { provider: "codex", donor: codexImage, imageEnv: [], env: {} };
  await payloads.inject("same", plan);
  assert.deepEqual(same.puts.map((p) => p.path), ["/usr/local/bin"]);
  await assert.rejects(payloads.inject("other", plan), /already has \/opt\/sessionboxer\/providers\/codex with other content than .*Codex 1.1.9 \(sha256:[0-9a-f]+ vs sha256:[0-9a-f]+\); it cannot be replaced/);
  assert.deepEqual(other.puts, []);
  await assert.rejects(payloads.inject("noNode", plan), /Codex's launcher needs `node`, which the Snapshot no longer has/);
  await assert.rejects(payloads.inject("same", { ...plan, donor: claudeImage }), /has no Codex payload at \/opt\/sessionboxer\/providers\/codex; it is not a Sessionboxer .* Sandbox image/);
  assert.equal(docker.donors.length, 4);
  assert.ok(docker.donors.every((d) => d.removed && !d.started));
});

test("verifyPayload: every entry is in the manifest and every listed file is there; nothing absolute, no `..`, no symlink out of the payload, hard links only to its files", async () => {
  const ok = verifyPayload("codex", await payloadEntries(codexPayload()), JSON.stringify(CODEX_MANIFEST));
  assert.deepEqual([ok.version, ok.launchers, ok.interpreters], ["1.1.9", ["codex-acp"], ["node"]]);
  const verify = async (entries) => {
    const read = await readEntries(tarOf(entries), "codex/manifest.json");
    return verifyPayload("codex", read.entries, read.manifest);
  };
  await assert.rejects(verify(codexPayload().filter((e) => e.name !== "codex/manifest.json")), /has no manifest.json/);
  await assert.rejects(verify(codexPayload({ ...CODEX_MANIFEST, provider: "gemini" })), /manifest is for gemini/);
  await assert.rejects(verify(codexPayload({ ...CODEX_MANIFEST, payloadFormat: 2 })), /payload format 2; this Control Plane reads format 1/);
  await assert.rejects(verify(codexPayload(CODEX_MANIFEST, [{ name: "codex/lib/extra.js", content: "x" }])), /has lib\/extra.js, which its manifest does not list/);
  await assert.rejects(verify(codexPayload({ ...CODEX_MANIFEST, files: [...CODEX_MANIFEST.files, "lib/gone.js", "lib/also.js"] })), /is missing 2 file\(s\) its manifest lists: lib\/gone.js, lib\/also.js/);
  await assert.rejects(verify(codexPayload({ ...CODEX_MANIFEST, files: [...CODEX_MANIFEST.files, "bin/sh"] }, [{ name: "codex/bin/sh", type: "symlink", linkname: "/bin/sh" }])), /bin\/sh is a symlink to an absolute path \(\/bin\/sh\)/);
  await assert.rejects(verify(codexPayload({ ...CODEX_MANIFEST, files: [...CODEX_MANIFEST.files, "bin/node"] }, [{ name: "codex/bin/node", type: "symlink", linkname: "../../../usr/bin/node" }])), /bin\/node is a symlink out of the payload/);
  const twin = await verify(codexPayload({ ...CODEX_MANIFEST, files: [...CODEX_MANIFEST.files, "bin/twin", "lib/twin.js"] }, [{ name: "codex/lib/twin.js", type: "link", linkname: "codex/lib/index.js" }, { name: "codex/bin/twin", type: "symlink", linkname: "../lib/twin.js" }]));
  assert.deepEqual([twin.launchers, twin.interpreters], [["codex-acp", "twin"], ["node"]], "a hard link (the archive's way of repeating a file) is a file of the payload, interpreter and all");
  await assert.rejects(verify(codexPayload({ ...CODEX_MANIFEST, files: [...CODEX_MANIFEST.files, "lib/twin.js"] }, [{ name: "codex/lib/twin.js", type: "link", linkname: "codex/lib/nowhere.js" }])), /lib\/twin.js is a hard link to codex\/lib\/nowhere.js, which is not a file of the payload/);
  await assert.rejects(verify(codexPayload({ ...CODEX_MANIFEST, files: [...CODEX_MANIFEST.files, "lib/twin.js"] }, [{ name: "codex/lib/twin.js", type: "link", linkname: "etc/passwd" }])), /entry outside codex\/: etc\/passwd/);
  await assert.rejects(verify(codexPayload({ ...CODEX_MANIFEST, files: [...CODEX_MANIFEST.files, "dev/null"] }, [{ name: "codex/dev/null", type: "character-device" }])), /has a character-device entry, dev\/null, which a payload cannot contain/);
  await assert.rejects(verify([...codexPayload(), { name: "codex/../etc/passwd", content: "x" }]), /entry outside the payload: codex\/..\/etc\/passwd/);
  await assert.rejects(verify([...codexPayload(), { name: "gemini/x", content: "x" }]), /entry outside codex\/: gemini\/x/);
  const links = (await readEntries(launcherLinks("codex", ["codex", "codex-acp"]), null)).entries;
  assert.deepEqual(links.map((e) => [e.name, e.type, e.linkname]), [["codex", "symlink", `${PAYLOADS}/codex/bin/codex`], ["codex-acp", "symlink", `${PAYLOADS}/codex/bin/codex-acp`]]);
});

test("payloadDigest: the same wherever the payload sits and whatever the entry order; content, modes and link targets count", async () => {
  const a = await payloadEntries(codexPayload());
  const b = await payloadEntries([...codexPayload()].reverse());
  assert.equal(payloadDigest(a), payloadDigest(b));
  const changed = await payloadEntries(codexPayload(CODEX_MANIFEST).map((e) => (e.name === "codex/lib/dist/run.js" ? { ...e, content: "console.log('other')" } : e)));
  assert.notEqual(payloadDigest(a), payloadDigest(changed));
  const relinked = await payloadEntries(codexPayload().map((e) => (e.name === "codex/bin/codex-acp" ? { ...e, linkname: "../lib/dist/run.js" } : e)));
  assert.notEqual(payloadDigest(a), payloadDigest(relinked));
});

test("flattenChanges: a flatten re-applies the io.sessionboxer.* labels, with the Sandbox's Agents as the providers label, and keeps only the image's own environment", () => {
  const config = {
    Env: ["PATH=/usr/local/bin", "SESSIONBOXER_SESSION_ID=s1", "CLAUDE_CODE_OAUTH_TOKEN=secret", "HOME=/home/agent"],
    Labels: { "io.sessionboxer.providers": "codex", "io.sessionboxer.runtime": V, "io.sessionboxer.payload-format": "1", "org.opencontainers.image.version": V, "sessionboxer.session": "s1" },
    User: "agent",
    WorkingDir: "/workspace",
    Entrypoint: ["/entry"],
    Cmd: null,
  };
  assert.deepEqual(flattenChanges(config, { snapshotId: "snap1", tag: "s1-2", stripEnv: ["CLAUDE_CODE_OAUTH_TOKEN"], keepEnv: ["SESSIONBOXER_SESSION_ID"], providers: ["codex", "claude-code"] }), [
    "LABEL sessionboxer.snapshot=snap1",
    `LABEL io.sessionboxer.runtime="${V}"`,
    'LABEL io.sessionboxer.payload-format="1"',
    'LABEL io.sessionboxer.providers="codex,claude-code"',
    "ENV PATH=/usr/local/bin",
    "ENV HOME=/home/agent",
    "USER agent",
    "WORKDIR /workspace",
    'ENTRYPOINT ["/entry"]',
  ]);
  assert.deepEqual(flattenChanges(config, { snapshotId: "snap1", tag: "s1-2", stripEnv: [], keepEnv: [], providers: null }).filter((c) => c.includes("providers")), ['LABEL io.sessionboxer.providers="codex"'], "a legacy or unchanged Sandbox keeps the image's label");
});
