#!/usr/bin/env node
// `npm run build:image [-- --provider <providerId>|base|all]`: builds the Sandbox image, handing
// the Dockerfile the CA certificates this machine trusts beyond the public ones (Cloudflare WARP, a
// corporate proxy…) as the `extra-ca` build secret, plus whatever is pasted under Settings → TLS
// certificates. Without them every download in the build fails with "self-signed certificate in
// certificate chain" on a machine whose proxy re-signs TLS. Other arguments are passed to `docker build`.
//
// Without --provider the image has every Provider's Agent and gets the name the Control Plane of
// this checkout looks for, ghcr.io/talayolabs/sessionboxer-sandbox:<version> (so it is used instead
// of the published one), plus sessionboxer/sandbox:dev. `--provider <id>` builds the Dockerfile
// target of that one Provider (ADR-0088) as <repo>:<version>-<id> plus sessionboxer/sandbox:dev-<id>;
// `base` (no Agent) and `all` likewise, with their suffix; none of them touches the plain tags.
// `SESSIONBOXER_IMAGE`, when set, is one more tag, exactly as written.
//
// Plain Node (no dependencies) so it runs before anything is compiled: the Provider ids come from
// the protocol source (scripts/sandbox-image-targets.mjs); the CA detection mirrors
// apps/control-plane/src/ca-certs.ts.
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { ROOT, imageTarget, parseArgs } from "./sandbox-image-targets.mjs";

const DATA_DIR = process.env.SESSIONBOXER_HOME ?? path.join(homedir(), ".sessionboxer");
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g;

function fingerprint(pem) {
  try {
    return new X509Certificate(pem).fingerprint256;
  } catch {
    return null;
  }
}

function subjectOf(pem) {
  try {
    return new X509Certificate(pem).subject.replace(/\n/g, ", ");
  } catch {
    return "(unreadable certificate)";
  }
}

function settings() {
  try {
    const cfg = JSON.parse(readFileSync(path.join(DATA_DIR, "config.json"), "utf8"));
    return {
      trustHostCaCerts: cfg.trustHostCaCerts !== false,
      extraCaCerts: typeof cfg.extraCaCerts === "string" ? cfg.extraCaCerts : "",
    };
  } catch {
    return { trustHostCaCerts: true, extraCaCerts: "" };
  }
}

function extraCaCerts() {
  const { trustHostCaCerts, extraCaCerts: pasted } = settings();
  const pems = [];
  if (trustHostCaCerts) {
    try {
      const bundled = new Set(tls.getCACertificates("bundled").map(fingerprint));
      for (const pem of [...tls.getCACertificates("system"), ...tls.getCACertificates("extra")]) {
        if (!bundled.has(fingerprint(pem))) pems.push(pem);
      }
    } catch {
      // Node without tls.getCACertificates(): only the pasted certificates.
    }
  }
  pems.push(...(pasted.match(PEM_BLOCK) ?? []));
  const seen = new Set();
  return pems
    .map((pem) => pem.trim())
    .filter((pem) => {
      const fp = fingerprint(pem);
      if (fp === null || seen.has(fp)) return false;
      seen.add(fp);
      return true;
    });
}

let selection;
try {
  const parsed = parseArgs(process.argv.slice(2));
  selection = imageTarget(parsed.provider, JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
  selection.forwarded = parsed.forwarded;
} catch (err) {
  console.error(`build:image: ${err.message}`);
  process.exit(2);
}

const certs = extraCaCerts();
const bundle = certs.length === 0 ? "" : `${certs.join("\n")}\n`;
mkdirSync(DATA_DIR, { recursive: true });
const bundleFile = path.join(DATA_DIR, "build-extra-ca.crt");
writeFileSync(bundleFile, bundle, { mode: 0o600 });
const digest = bundle === "" ? "" : createHash("sha256").update(bundle).digest("hex").slice(0, 16);

if (certs.length > 0) {
  console.log(`build:image: trusting ${certs.length} extra CA certificate${certs.length === 1 ? "" : "s"} during the build:`);
  for (const pem of certs) console.log(`  - ${subjectOf(pem)}`);
} else {
  console.log("build:image: no CA certificates beyond the public ones on this machine");
}

const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const override = process.env.SESSIONBOXER_IMAGE?.trim();
const tags = override ? [...selection.tags, override] : selection.tags;
console.log(`build:image: building target ${selection.target} as ${tags.join(", ")}`);

const args = [
  "build",
  "-f",
  "images/sandbox/Dockerfile",
  "--target",
  selection.target,
  ...tags.flatMap((tag) => ["-t", tag]),
  "--secret",
  `id=extra-ca,src=${bundleFile}`,
  "--build-arg",
  `EXTRA_CA_FINGERPRINT=${digest}`,
  "--build-arg",
  `SESSIONBOXER_VERSION=${version}`,
  ...selection.forwarded,
  ".",
];
const res = spawnSync("docker", args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, DOCKER_BUILDKIT: "1" } });
if (res.error) {
  console.error(`build:image: could not run docker: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
