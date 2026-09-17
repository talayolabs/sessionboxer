import { existsSync } from "node:fs";

/**
 * The Control Plane installs the host's extra CA certificates (corporate proxy, Cloudflare
 * WARP…) at this path and links them into the system store; OpenSSL-based tools pick them up
 * from there, while Node (the Agents and most MCP servers), Python's `requests` and uv-managed
 * Pythons only look at their own bundles unless told otherwise.
 */
const EXTRA_CA_FILE = "/usr/local/share/ca-certificates/sessionboxer-extra.crt";
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/** Environment for child processes so they trust the installed extra CAs (empty when none). */
export function caEnv(): Record<string, string> {
  if (!existsSync(EXTRA_CA_FILE)) return {};
  return {
    NODE_EXTRA_CA_CERTS: EXTRA_CA_FILE,
    SSL_CERT_FILE: SYSTEM_BUNDLE,
    REQUESTS_CA_BUNDLE: SYSTEM_BUNDLE,
  };
}
