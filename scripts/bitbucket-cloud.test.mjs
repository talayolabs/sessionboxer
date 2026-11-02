// Bitbucket Cloud (bitbucket.org) through the Bitbucket Connector: host normalisation, the
// email + Atlassian API token check against `GET /2.0/user`, clone planning and the `hosts.yml`
// the Daemon writes for `bb`. Data Center cases pin that its paths are unchanged. Run after `tsc -b`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeBitbucketHost, parseBitbucketRemote, verifyBitbucketCloudToken } from "../apps/control-plane/dist/bitbucket.js";
import { planClone } from "../apps/control-plane/dist/git-clone.js";
import { BbCredentials } from "../packages/sandbox-daemon/dist/bb-credentials.js";

const cloud = { kind: "bitbucket", host: "bitbucket.org", account: "jdoe", token: "ATATT-secret", email: "jdoe@example.com" };
const dc = { kind: "bitbucket", host: "bitbucket.example.com", account: "jdoe", token: "dc-secret", email: null };

test("bitbucket.org is accepted and its aliases normalise to it; other *.bitbucket.org hosts are refused", () => {
  assert.equal(normalizeBitbucketHost("https://bitbucket.org/ws/repo"), "bitbucket.org");
  assert.equal(normalizeBitbucketHost("WWW.bitbucket.org"), "bitbucket.org");
  assert.equal(normalizeBitbucketHost("api.bitbucket.org"), "bitbucket.org");
  assert.equal(normalizeBitbucketHost("bitbucket.example.com:443"), "bitbucket.example.com");
  assert.throws(() => normalizeBitbucketHost("foo.bitbucket.org"), /not a Bitbucket host/);
});

test("verifyBitbucketCloudToken sends email:token as Basic auth to /2.0/user and returns the username", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization });
    return new Response(JSON.stringify({ username: "jdoe", display_name: "J. Doe" }), { status: 200 });
  };
  const user = await verifyBitbucketCloudToken("jdoe@example.com", "tok", fetchImpl);
  assert.deepEqual(calls, [{ url: "https://api.bitbucket.org/2.0/user", auth: `Basic ${Buffer.from("jdoe@example.com:tok").toString("base64")}` }]);
  assert.equal(user.name, "jdoe");
  assert.equal(user.displayName, "J. Doe");
});

test("verifyBitbucketCloudToken explains 401 and the 503 a wrong pair can get", async () => {
  const answer = (status) => async () => new Response("<html></html>", { status });
  await assert.rejects(verifyBitbucketCloudToken("a@b.c", "x", answer(401)), /rejected the email and API token/);
  await assert.rejects(verifyBitbucketCloudToken("a@b.c", "x", answer(503)), /wrong email or token too/);
});

test("Cloud remotes parse to workspace/repo; Data Center ones are unchanged", () => {
  for (const url of ["https://bitbucket.org/ws/repo.git", "https://jdoe@bitbucket.org/ws/repo", "git@bitbucket.org:ws/repo.git", "ssh://git@bitbucket.org/ws/repo.git"]) {
    assert.deepEqual(parseBitbucketRemote(url), { host: "bitbucket.org", project: "ws", slug: "repo" }, url);
  }
  assert.deepEqual(parseBitbucketRemote("ssh://git@bitbucket.example.com:7999/KEY/slug.git"), { host: "bitbucket.example.com", project: "KEY", slug: "slug" });
  assert.equal(parseBitbucketRemote("https://github.com/o/r.git"), null);
});

test("a Cloud clone runs over HTTPS with the Connector's email and API token for bb", () => {
  const plan = planClone("git@bitbucket.org:ws/repo.git", [cloud]);
  assert.equal(plan.url, "https://bitbucket.org/ws/repo.git");
  assert.equal(plan.account, "jdoe");
  assert.equal(plan.env.BB_HOST, "bitbucket.org");
  assert.equal(plan.env.BB_TOKEN, "ATATT-secret");
  assert.equal(plan.env.BB_EMAIL, "jdoe@example.com");
  assert.equal(plan.env.BB_GIT_USER, "x-bitbucket-api-token-auth");
});

test("without a login a Cloud HTTPS clone is anonymous and an SSH one points at Connect Bitbucket; Data Center keeps its username", () => {
  const anon = planClone("https://bitbucket.org/ws/repo.git", []);
  assert.equal(anon.url, "https://bitbucket.org/ws/repo.git");
  assert.equal(anon.env.BB_TOKEN, undefined);
  assert.throws(() => planClone("git@bitbucket.org:ws/repo.git", []), /no SSH keys.*Connect Bitbucket/);
  const plan = planClone("https://bitbucket.example.com/scm/KEY/slug.git", [dc]);
  assert.equal(plan.env.BB_GIT_USER, "jdoe");
  assert.equal(plan.env.BB_EMAIL, undefined);
});

test("hosts.yml carries the Cloud email and git user next to an unchanged Data Center block", () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-cloud-"));
  try {
    new BbCredentials(dir, () => {}).apply([dc, cloud]);
    const yaml = readFileSync(join(dir, "hosts.yml"), "utf8");
    assert.match(yaml, /bitbucket\.example\.com:\n {4}user: "?jdoe"?\n {4}git_user: "?jdoe"?\n {4}oauth_token: "?dc-secret"?\n {4}users:/);
    assert.match(yaml, /bitbucket\.org:\n {4}user: "?jdoe"?\n {4}git_user: "?x-bitbucket-api-token-auth"?\n {4}oauth_token: "?ATATT-secret"?\n {4}email: "?jdoe@example\.com"?\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
