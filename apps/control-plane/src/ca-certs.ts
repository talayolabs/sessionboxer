import { X509Certificate } from "node:crypto";
import tls from "node:tls";
import type { Settings } from "@sessionboxer/protocol";

/**
 * CA certificates a Sandbox should trust on top of the public ones: what this machine
 * trusts beyond Node's bundled Mozilla list (a corporate proxy's CA, Cloudflare WARP,
 * mitmproxy…), plus whatever the user pasted in Settings. Sandboxes otherwise fail TLS
 * to any host whose traffic the machine's proxy re-signs.
 */

/** Where the bundle is installed in a Sandbox; `update-ca-certificates` links it into the system store. */
export const SANDBOX_CA_FILE = "/usr/local/share/ca-certificates/sessionboxer-extra.crt";

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g;

export interface HostCaCert {
  subject: string;
  pem: string;
}

/** Certificates in the system trust store that are not in Node's bundled list, de-duplicated. */
export function hostExtraCaCerts(): HostCaCert[] {
  let system: string[];
  let bundled: string[];
  let extra: string[];
  try {
    system = tls.getCACertificates("system");
    bundled = tls.getCACertificates("bundled");
    extra = tls.getCACertificates("extra");
  } catch {
    return [];
  }
  const publicFingerprints = new Set(bundled.map(fingerprint).filter((f) => f !== null));
  const seen = new Set<string>();
  const out: HostCaCert[] = [];
  for (const pem of [...system, ...extra]) {
    const fp = fingerprint(pem);
    if (fp === null || publicFingerprints.has(fp) || seen.has(fp)) continue;
    seen.add(fp);
    out.push({ subject: subjectOf(pem), pem: pem.trim() });
  }
  return out;
}

/** Parses pasted PEM: every certificate block, validated; throws with the first bad block. */
export function parseExtraCaCerts(text: string): string[] {
  const blocks = text.match(PEM_BLOCK) ?? [];
  if (blocks.length === 0 && text.trim() !== "") {
    throw new Error("Extra CA certificates: no `-----BEGIN CERTIFICATE-----` block found (PEM expected).");
  }
  return blocks.map((b, i) => {
    try {
      new X509Certificate(b);
    } catch {
      throw new Error(`Extra CA certificates: certificate ${i + 1} is not a valid X.509 certificate.`);
    }
    return b.trim();
  });
}

/** The PEM bundle to install in a Sandbox; empty when there is nothing beyond the public CAs. */
export function sandboxCaBundle(settings: Settings): string {
  const pems = [
    ...(settings.trustHostCaCerts ? hostExtraCaCerts().map((c) => c.pem) : []),
    ...(settings.extraCaCerts.match(PEM_BLOCK) ?? []).map((b) => b.trim()),
  ];
  const seen = new Set<string>();
  const unique = pems.filter((pem) => {
    const fp = fingerprint(pem);
    if (fp === null || seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });
  return unique.length === 0 ? "" : `${unique.join("\n")}\n`;
}

export function countCerts(pem: string): number {
  return pem.match(PEM_BLOCK)?.length ?? 0;
}

function fingerprint(pem: string): string | null {
  try {
    return new X509Certificate(pem).fingerprint256;
  } catch {
    return null;
  }
}

function subjectOf(pem: string): string {
  try {
    const subject = new X509Certificate(pem).subject;
    return subject.split("\n").find((l) => l.startsWith("CN=")) ?? subject.split("\n")[0] ?? "(unknown)";
  } catch {
    return "(unreadable certificate)";
  }
}
