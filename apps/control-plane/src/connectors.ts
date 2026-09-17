import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CONNECTORS,
  MCP_RESERVED_NAMES,
  type ConnectorFlow,
  type ConnectorKind,
  type ConnectorStartRequest,
  type McpServerDef,
  type Settings,
} from "@sessionboxer/protocol";
import { toPublicMcpServer } from "./config.js";
import { HttpError } from "./http-error.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
const GITHUB_USER_URL = "https://api.github.com/user";
/** Redirect logins expire like GitHub's device codes do (15 min). */
const FLOW_TTL_MS = 15 * 60_000;
const USER_AGENT = "sessionboxer";

interface SettingsStore {
  get(): Settings;
  set(next: Settings): void;
}

interface Flow extends ConnectorFlow {
  codeVerifier: string | null;
  deviceCode: string | null;
  /** Server-side polling interval (device flow), seconds. */
  interval: number;
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * OAuth logins for Connector presets (GitHub for now). Both GitHub flows end the same way: the
 * token is stored as the entry's secret `Authorization` header and the account name next to it,
 * so the Daemon sees an ordinary HTTP MCP server. GitHub has no dynamic client registration, so
 * an OAuth App is needed: the built-in one (client id only, device-code flow) or the user's own
 * from Settings (with a client secret, the redirect flow is used instead).
 */
export class Connectors {
  private readonly flows = new Map<string, Flow>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly callbackUrl: (kind: ConnectorKind) => string,
    private readonly onChanged: () => void,
    private readonly log: (msg: string) => void,
  ) {}

  /** Starts a login; creates the registry entry from the preset when `serverId` is unknown. */
  async start(kind: ConnectorKind, req: ConnectorStartRequest): Promise<ConnectorFlow> {
    const server = this.ensureServer(kind, req);
    const { clientId, clientSecret } = this.credentials(kind);
    this.prune();
    for (const [id, f] of this.flows) if (f.serverId === server.id && f.status === "pending") this.flows.delete(id);
    const base = {
      id: randomUUID(),
      kind,
      serverId: server.id,
      status: "pending" as const,
      error: null,
      server: toPublicMcpServer(server),
      clientId,
      clientSecret,
      interval: 5,
      deviceCode: null,
      codeVerifier: null,
    };
    let flow: Flow;
    if (clientSecret !== "") {
      const codeVerifier = randomBytes(32).toString("base64url");
      const url = new URL(GITHUB_AUTHORIZE_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", this.callbackUrl(kind));
      url.searchParams.set("scope", CONNECTORS[kind].scopes.join(" "));
      url.searchParams.set("state", base.id);
      url.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
      url.searchParams.set("code_challenge_method", "S256");
      flow = {
        ...base,
        mode: "redirect",
        url: url.toString(),
        userCode: null,
        verificationUri: null,
        expiresAt: new Date(Date.now() + FLOW_TTL_MS).toISOString(),
        codeVerifier,
      };
    } else {
      const res = await postForm(GITHUB_DEVICE_URL, { client_id: clientId, scope: CONNECTORS[kind].scopes.join(" ") });
      const body = (await res.json()) as {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        expires_in?: number;
        interval?: number;
        error?: string;
        error_description?: string;
      };
      if (!res.ok || !body.device_code || !body.user_code || !body.verification_uri) {
        throw new HttpError(
          502,
          `GitHub refused to start the device login (${body.error ?? res.status}): ${
            body.error_description ?? "check the OAuth App client id and that Device Flow is enabled on it"
          }`,
        );
      }
      flow = {
        ...base,
        mode: "device",
        url: null,
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        expiresAt: new Date(Date.now() + (body.expires_in ?? 900) * 1000).toISOString(),
        interval: body.interval ?? 5,
        deviceCode: body.device_code,
      };
      void this.pollDevice(flow);
    }
    this.flows.set(flow.id, flow);
    this.log(`connector ${kind} login started (${flow.mode}) for "${server.name}"`);
    return publicFlow(flow);
  }

  get(flowId: string): ConnectorFlow {
    const flow = this.flows.get(flowId);
    if (!flow) throw new HttpError(404, "Unknown or expired login.");
    if (flow.status === "pending" && Date.parse(flow.expiresAt) < Date.now()) fail(flow, "The login expired; start again.");
    return publicFlow(flow);
  }

  /** Redirect-flow landing (`?code=&state=`); returns a message for the browser tab. */
  async callback(kind: ConnectorKind, query: Record<string, string | undefined>): Promise<{ ok: boolean; message: string }> {
    const flow = query.state ? this.flows.get(query.state) : undefined;
    if (!flow || flow.kind !== kind || flow.mode !== "redirect") return { ok: false, message: "Unknown or expired login; start it again from Settings." };
    if (flow.status !== "pending") return { ok: flow.status === "done", message: flow.status === "done" ? "Already connected." : (flow.error ?? "Login failed.") };
    if (query.error) {
      fail(flow, query.error_description ?? query.error);
      return { ok: false, message: flow.error ?? "Login failed." };
    }
    if (!query.code) {
      fail(flow, "GitHub returned no code.");
      return { ok: false, message: flow.error ?? "Login failed." };
    }
    try {
      const res = await postForm(GITHUB_TOKEN_URL, {
        client_id: flow.clientId,
        client_secret: flow.clientSecret,
        code: query.code,
        redirect_uri: this.callbackUrl(kind),
        code_verifier: flow.codeVerifier ?? "",
      });
      await this.finish(flow, (await res.json()) as TokenResponse);
      return { ok: true, message: `Connected as ${flow.server.connector?.account ?? "?"}.` };
    } catch (e) {
      fail(flow, e instanceof Error ? e.message : String(e));
      return { ok: false, message: flow.error ?? "Login failed." };
    }
  }

  /** Forgets the token (the entry stays, so it can be connected to another account). */
  disconnect(serverId: string): McpServerDef {
    const settings = this.settings.get();
    const server = settings.mcpServers.find((s) => s.id === serverId);
    if (!server?.connector) throw new HttpError(404, "Not a Connector entry.");
    const header = CONNECTORS[server.connector.kind].tokenHeader;
    const next: McpServerDef = {
      ...server,
      headers: server.headers.map((h) => (h.name === header ? { ...h, value: "" } : h)),
      connector: { ...server.connector, account: null, connectedAt: null, expiresAt: null },
    };
    this.settings.set({ ...settings, mcpServers: settings.mcpServers.map((s) => (s.id === serverId ? next : s)) });
    this.onChanged();
    return next;
  }

  private credentials(kind: ConnectorKind): { clientId: string; clientSecret: string } {
    const conf = this.settings.get().connectors[kind];
    return { clientId: conf.clientId || CONNECTORS[kind].defaultClientId, clientSecret: conf.clientSecret };
  }

  private ensureServer(kind: ConnectorKind, req: ConnectorStartRequest): McpServerDef {
    const settings = this.settings.get();
    const existing = req.serverId ? settings.mcpServers.find((s) => s.id === req.serverId) : undefined;
    if (existing) {
      if (existing.connector?.kind !== kind) throw new HttpError(400, `MCP server "${existing.name}" is not a ${CONNECTORS[kind].label} entry.`);
      return existing;
    }
    const name = req.name;
    if ((MCP_RESERVED_NAMES as readonly string[]).includes(name)) throw new HttpError(400, `MCP server name "${name}" is reserved.`);
    if (settings.mcpServers.some((s) => s.name === name)) throw new HttpError(400, `An MCP server named "${name}" already exists; pick another name.`);
    const preset = CONNECTORS[kind];
    const server: McpServerDef = {
      id: req.serverId ?? randomUUID(),
      name,
      transport: "http",
      command: "",
      args: [],
      env: [],
      url: preset.url,
      headers: [{ name: preset.tokenHeader, value: "", secret: true }],
      enabledByDefault: true,
      connector: { kind, account: null, connectedAt: null, expiresAt: null },
    };
    this.settings.set({ ...settings, mcpServers: [...settings.mcpServers, server] });
    this.onChanged();
    return server;
  }

  private async pollDevice(flow: Flow): Promise<void> {
    let interval = flow.interval;
    while (flow.status === "pending") {
      await sleep(interval * 1000);
      if (flow.status !== "pending") return;
      if (Date.parse(flow.expiresAt) < Date.now()) return fail(flow, "The code expired before it was entered; start again.");
      let body: TokenResponse;
      try {
        const res = await postForm(GITHUB_TOKEN_URL, {
          client_id: flow.clientId,
          device_code: flow.deviceCode ?? "",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
        body = (await res.json()) as TokenResponse;
      } catch (e) {
        this.log(`connector ${flow.kind} poll failed: ${String(e)}`);
        continue;
      }
      if (body.error === "authorization_pending") continue;
      if (body.error === "slow_down") {
        interval += 5;
        continue;
      }
      try {
        await this.finish(flow, body);
      } catch (e) {
        fail(flow, e instanceof Error ? e.message : String(e));
      }
      return;
    }
  }

  private async finish(flow: Flow, token: TokenResponse): Promise<void> {
    if (!token.access_token) {
      throw new Error(
        token.error === "access_denied"
          ? "You cancelled the authorization on GitHub."
          : token.error === "expired_token"
            ? "The code expired before it was entered; start again."
            : `${token.error ?? "GitHub returned no token"}${token.error_description ? `: ${token.error_description}` : ""}`,
      );
    }
    const userRes = await fetch(GITHUB_USER_URL, {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": USER_AGENT },
    });
    if (!userRes.ok) throw new Error(`GitHub rejected the new token (${userRes.status}).`);
    const user = (await userRes.json()) as { login?: string };
    const account = user.login ?? "?";
    const settings = this.settings.get();
    const server = settings.mcpServers.find((s) => s.id === flow.serverId);
    if (!server?.connector) throw new Error("The MCP server entry was deleted meanwhile.");
    const header = CONNECTORS[flow.kind].tokenHeader;
    const value = `Bearer ${token.access_token}`;
    const headers = server.headers.some((h) => h.name === header)
      ? server.headers.map((h) => (h.name === header ? { ...h, value, secret: true } : h))
      : [...server.headers, { name: header, value, secret: true }];
    const next: McpServerDef = {
      ...server,
      headers,
      connector: {
        ...server.connector,
        account,
        connectedAt: new Date().toISOString(),
        expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
      },
    };
    this.settings.set({ ...settings, mcpServers: settings.mcpServers.map((s) => (s.id === server.id ? next : s)) });
    flow.status = "done";
    flow.server = toPublicMcpServer(next);
    this.log(`connector ${flow.kind}: "${server.name}" connected as ${account}${next.connector?.expiresAt ? " (expiring token)" : ""}`);
    this.onChanged();
  }

  private prune(): void {
    const cutoff = Date.now() - FLOW_TTL_MS;
    for (const [id, f] of this.flows) if (Date.parse(f.expiresAt) < cutoff) this.flows.delete(id);
  }
}

function fail(flow: Flow, message: string): void {
  if (flow.status !== "pending") return;
  flow.status = "error";
  flow.error = message;
}

function publicFlow(flow: Flow): ConnectorFlow {
  const { codeVerifier: _v, deviceCode: _d, interval: _i, clientId: _c, clientSecret: _s, ...pub } = flow;
  return pub;
}

async function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: new URLSearchParams(fields).toString(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
