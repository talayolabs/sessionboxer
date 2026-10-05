// The Sandbox images per Provider (ADR-0088): the resolver, the per-reference status and lazy
// pulls of `SandboxImages`, the label check and the legacy preflight. Docker is a fake: images
// are "here" when the test says so, pulls finish when the test says so.
import test from "node:test";
import assert from "node:assert/strict";

const { PROVIDERS } = await import("../packages/protocol/dist/index.js");
const { SANDBOX_IMAGE_REPO, SANDBOX_IMAGE_VERSION, sandboxBaseImage, sandboxImageFor } = await import("../apps/control-plane/dist/config.js");
const { HttpError } = await import("../apps/control-plane/dist/http-error.js");
const { SandboxImages, buildCommandFor, isLocalOnly, labelledProviders, parseImageSelector } = await import("../apps/control-plane/dist/sandbox-images.js");

const REPO = SANDBOX_IMAGE_REPO;
const V = SANDBOX_IMAGE_VERSION;
const noLog = () => undefined;

/** A Docker with the images in `local` (labels from `labels`), where `executables` is what `command -v` finds in any image; pulls hang until `finish`/`fail`. */
function fakeDocker({ local = [], labels = {}, executables = [] } = {}) {
  const here = new Set(local);
  const pending = new Map();
  const docker = {
    pulls: [],
    probes: [],
    here,
    getImage(ref) {
      return {
        async inspect() {
          if (!here.has(ref)) throw Object.assign(new Error(`No such image: ${ref}`), { statusCode: 404 });
          return { Id: `sha256:${ref}`, Config: { Labels: labels[ref] ?? {} } };
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
  assert.deepEqual(await images.resolve(codex, "codex"), { reference: codex, id: `sha256:${codex}`, providers: ["codex"] });
  await assert.rejects(images.resolve(future, "codex"), /payload format 2; this Control Plane .* reads format 1/);
  await assert.rejects(images.resolve(codex, "claude-code"), /carries Codex, not Claude Code; Claude Code Sessions need .*-claude-code/);
  await assert.rejects(images.resolve(base, "codex"), /base image without an Agent; Codex Sessions need .*-codex/);
  assert.deepEqual(await images.resolve(base, "base"), { reference: base, id: `sha256:${base}`, providers: [] });
  assert.deepEqual(await images.resolve(codex, "base"), { reference: codex, id: `sha256:${codex}`, providers: ["codex"] });
  assert.deepEqual(docker.probes, []);
});

test("a legacy image without labels counts as all Providers once the Agent's executable is found, probed once per image", async () => {
  const dev = "sessionboxer/sandbox:dev";
  const docker = fakeDocker({ local: [dev], executables: ["codex-acp", "claude-agent-acp"] });
  const images = new SandboxImages(docker, noLog);
  assert.deepEqual(await images.resolve(dev, "codex"), { reference: dev, id: `sha256:${dev}`, providers: null });
  assert.deepEqual(await images.resolve(dev, "codex"), { reference: dev, id: `sha256:${dev}`, providers: null });
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
