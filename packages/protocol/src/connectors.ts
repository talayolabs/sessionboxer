// ---------------------------------------------------------------------------
// Connector login flows (Control Plane `/api/connectors/...`)
// ---------------------------------------------------------------------------

import { z } from "zod";
import { MCP_NAME_PATTERN, ConnectorKind, PublicMcpServerDef } from "./mcp.js";

/**
 * How a Connector login mints its token:
 * - `gh`: GitHub CLI's own device login (GitHub's first-party app, so organization OAuth-App
 *   restrictions don't apply); `gh` is downloaded if the machine lacks it.
 * - `gh-existing`: reuse a login `gh` already has on this machine (`account` picks which).
 * - `app`: the Sessionboxer OAuth App (or the one from Settings); organizations may block it.
 * - `token`: Bitbucket Data Center: an HTTP access token the user created on `host` and pasted;
 *   verified against the host's REST API, which also tells whose it is.
 */
export const ConnectorVia = z.enum(["gh", "gh-existing", "app", "token"]);
export type ConnectorVia = z.infer<typeof ConnectorVia>;

/** Starts a login for a registry entry; a missing/unknown `serverId` creates the entry from the preset. */
export const ConnectorStartRequest = z.object({
  serverId: z.string().nullable().default(null),
  name: z.string().regex(MCP_NAME_PATTERN, "letters, digits, `_` and `-` only"),
  via: ConnectorVia.default("gh"),
  /** `gh-existing`: the `gh` account whose token to reuse. */
  account: z.string().nullable().default(null),
  /** `token`: the pasted token (GitHub personal access token, or Bitbucket HTTP access token with the host `bitbucket.example.com` or its URL). */
  host: z.string().max(500).nullable().default(null),
  token: z.string().max(4000).nullable().default(null),
});
export type ConnectorStartRequest = z.infer<typeof ConnectorStartRequest>;

/** What the GitHub CLI on this machine offers to Connector logins. */
export const GhCliStatus = z.object({
  /** `gh` found on PATH or already downloaded by Sessionboxer. */
  available: z.boolean(),
  version: z.string().nullable(),
  /** Accounts `gh` is logged in to on this machine (reusable with `via: "gh-existing"`). */
  logins: z.array(z.string()),
});
export type GhCliStatus = z.infer<typeof GhCliStatus>;

export const ConnectorFlow = z.object({
  id: z.string(),
  kind: ConnectorKind,
  serverId: z.string(),
  via: ConnectorVia,
  /** `redirect`: open `url` and come back; `device`: enter `userCode` at `verificationUri`. */
  mode: z.enum(["redirect", "device"]),
  url: z.string().nullable(),
  userCode: z.string().nullable(),
  verificationUri: z.string().nullable(),
  expiresAt: z.string(),
  status: z.enum(["pending", "done", "error"]),
  error: z.string().nullable(),
  /** The registry entry being connected, as stored (token hidden like any secret header). */
  server: PublicMcpServerDef,
});
export type ConnectorFlow = z.infer<typeof ConnectorFlow>;
