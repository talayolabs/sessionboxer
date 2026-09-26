import type {
  AddRepoRequest,
  UpdateRepoRequest,
  AskResult,
  AuthDevice,
  AuthLoginRequest,
  AuthPairing,
  AuthPairRedeemRequest,
  AuthPrincipal,
  CodeOpenParams,
  CodeStartParams,
  CodeThemeParams,
  CodeServerStatus,
  CompactionDetails,
  CompactionDetailsRequest,
  ConnectorFlow,
  ContextBreakdown,
  GhCliStatus,
  ConnectorKind,
  ConnectorStartRequest,
  CreateScheduleRequest,
  CreateSessionRequest,
  Schedule,
  SchedulePreview,
  SchedulePreviewRequest,
  ScheduleRun,
  UpdateScheduleRequest,
  DeleteSnapshotsResult,
  E2eRun,
  ForkSessionRequest,
  HostDirListing,
  LlmCall,
  LlmCallBody,
  PrActionRequest,
  PrActionResult,
  PrCheckItem,
  PrItem,
  ProviderModels,
  ProviderOptions,
  PtyInfo,
  PullRequest,
  PtyListResult,
  PromptAttachment,
  PromptRequest,
  PublicSettings,
  PushStatus,
  RepoRemovalBlocked,
  SessionRepo,
  PushSubscribeRequest,
  RevertRequest,
  SavedMessage,
  Session,
  SessionBroadcast,
  SessionEvent,
  SandboxImageStatus,
  Snapshot,
  SpeechModel,
  SpeechStatus,
  SwitchBranchRequest,
  Transcription,
  SyncPlan,
  SyncRequest,
  SyncResult,
  UpdatePrRequest,
  UpdateSavedMessageRequest,
  UpdateSessionRequest,
  UsbHost,
  UiClientMessage,
  TunnelNameCheck,
  TunnelServerInfo,
  UpdateSettingsRequest,
  WindowsBaseStatus,
} from "@sessionboxer/protocol";

/** Fired on `window` when the Control Plane answers 401 to anything but a login attempt: the device cookie is gone or revoked. */
export const UNAUTHORIZED_EVENT = "sessionboxer:unauthorized";
const LOGIN_PATHS = new Set(["/auth/login", "/auth/pair/redeem"]);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body
    }
    if (res.status === 401 && !LOGIN_PATHS.has(path)) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: message }));
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  me: () => request<{ principal: AuthPrincipal | null }>("/auth/me"),
  login: (req: AuthLoginRequest) => request<AuthDevice>("/auth/login", { method: "POST", body: JSON.stringify(req) }),
  pair: () => request<AuthPairing>("/auth/pair", { method: "POST" }),
  pairRedeem: (req: AuthPairRedeemRequest) => request<AuthDevice>("/auth/pair/redeem", { method: "POST", body: JSON.stringify(req) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  devices: () => request<AuthDevice[]>("/auth/devices"),
  revokeDevice: (id: string) => request<void>(`/auth/devices/${id}`, { method: "DELETE" }),
  pushStatus: () => request<PushStatus>("/push"),
  pushSubscribe: (sub: PushSubscribeRequest) => request<PushStatus>("/push", { method: "PUT", body: JSON.stringify(sub) }),
  pushUnsubscribe: () => request<PushStatus>("/push", { method: "DELETE" }),
  pushTest: () => request<void>("/push/test", { method: "POST" }),
  accessToken: () => request<{ token: string }>("/auth/token"),
  rotateAccessToken: () => request<{ token: string }>("/auth/token/rotate", { method: "POST" }),
  settings: () => request<PublicSettings>("/settings"),
  models: () => request<ProviderModels>("/models"),
  options: () => request<ProviderOptions>("/options"),
  updateSettings: (update: UpdateSettingsRequest) =>
    request<PublicSettings>("/settings", { method: "PUT", body: JSON.stringify(update) }),
  sandboxImage: () => request<SandboxImageStatus>("/sandbox-image"),
  sandboxImagePull: () => request<SandboxImageStatus>("/sandbox-image/pull", { method: "POST" }),
  /** The shared Windows base disk of `qemu-windows` Sessions (ADR-0057). */
  windowsBase: () => request<WindowsBaseStatus>("/windows"),
  windowsInstall: () => request<WindowsBaseStatus>("/windows/install", { method: "POST" }),
  windowsCancel: () => request<WindowsBaseStatus>("/windows/cancel", { method: "POST" }),
  windowsRemove: () => request<WindowsBaseStatus>("/windows", { method: "DELETE" }),
  speechStatus: () => request<SpeechStatus>("/speech"),
  speechPrepare: () => request<SpeechStatus>("/speech/prepare", { method: "POST" }),
  speechDeleteModel: (model: SpeechModel) => request<void>(`/speech/models/${model}`, { method: "DELETE" }),
  /** `wav`: 16 kHz mono PCM. Includes first-use downloads of whisper-cli and the model, so poll `speechStatus` for progress. */
  transcribe: (wav: Blob, signal?: AbortSignal) =>
    request<Transcription>("/speech/transcribe", { method: "POST", body: wav, headers: { "content-type": "audio/wav" }, signal }),
  tunnelServer: (server?: string) =>
    request<{ server: string; info: TunnelServerInfo; name: string }>(`/tunnels/sessionboxer/server${server ? `?server=${encodeURIComponent(server)}` : ""}`),
  tunnelName: (name: string, server?: string) =>
    request<TunnelNameCheck>(`/tunnels/sessionboxer/names/${encodeURIComponent(name)}${server ? `?server=${encodeURIComponent(server)}` : ""}`),
  connectorStart: (kind: ConnectorKind, req: ConnectorStartRequest) =>
    request<ConnectorFlow>(`/connectors/${kind}/start`, { method: "POST", body: JSON.stringify(req) }),
  connectorFlow: (id: string) => request<ConnectorFlow>(`/connectors/flows/${id}`),
  connectorGh: () => request<GhCliStatus>("/connectors/github/gh"),
  connectorDisconnect: (serverId: string) =>
    request<PublicSettings>(`/connectors/servers/${serverId}/disconnect`, { method: "POST" }),
  schedules: () => request<Schedule[]>("/schedules"),
  createSchedule: (req: CreateScheduleRequest) => request<Schedule>("/schedules", { method: "POST", body: JSON.stringify(req) }),
  updateSchedule: (id: string, patch: UpdateScheduleRequest) =>
    request<Schedule>(`/schedules/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSchedule: (id: string) => request<void>(`/schedules/${id}`, { method: "DELETE" }),
  runSchedule: (id: string) => request<ScheduleRun>(`/schedules/${id}/run`, { method: "POST" }),
  scheduleRuns: (id: string) => request<ScheduleRun[]>(`/schedules/${id}/runs`),
  schedulePreview: (req: SchedulePreviewRequest) => request<SchedulePreview>("/schedules/preview", { method: "POST", body: JSON.stringify(req) }),
  sessions: () => request<Session[]>("/sessions"),
  createSession: (req: CreateSessionRequest) =>
    request<Session>("/sessions", { method: "POST", body: JSON.stringify(req) }),
  updateSession: (id: string, patch: UpdateSessionRequest) =>
    request<Session>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: "DELETE" }),
  events: (id: string, after = 0) => request<SessionEvent[]>(`/sessions/${id}/events?after=${after}`),
  prompt: (id: string, req: PromptRequest) =>
    request<{ ok: true }>(`/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify(req) }),
  /** Stores a file in the Session's Workspace for the next prompt; `onProgress` gets 0..1. */
  upload: (id: string, file: File, onProgress: (frac: number) => void, signal: AbortSignal): Promise<PromptAttachment> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/sessions/${id}/uploads?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onerror = () => reject(new Error("upload failed: network error"));
      xhr.onabort = () => reject(new DOMException("upload cancelled", "AbortError"));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText) as PromptAttachment);
          return;
        }
        let message = `${xhr.status} ${xhr.statusText}`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // non-JSON error body
        }
        if (xhr.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: message }));
        reject(new Error(message));
      };
      signal.addEventListener("abort", () => xhr.abort());
      xhr.send(file);
    }),
  ask: (id: string, text: string) => request<AskResult>(`/sessions/${id}/ask`, { method: "POST", body: JSON.stringify({ text }) }),
  contextReport: (id: string) => request<ContextBreakdown>(`/sessions/${id}/context/report`, { method: "POST" }),
  compactionDetails: (id: string, req: CompactionDetailsRequest) =>
    request<CompactionDetails>(`/sessions/${id}/context/compaction`, { method: "POST", body: JSON.stringify(req) }),
  llmCalls: (id: string) => request<{ calls: LlmCall[]; withBodies: string[] }>(`/sessions/${id}/llm-calls`),
  llmCallBody: (id: string, callId: string) => request<LlmCallBody>(`/sessions/${id}/llm-calls/${callId}`),
  cancel: (id: string) => request<{ ok: true }>(`/sessions/${id}/cancel`, { method: "POST" }),
  stop: (id: string) => request<Session>(`/sessions/${id}/stop`, { method: "POST" }),
  resume: (id: string) => request<Session>(`/sessions/${id}/resume`, { method: "POST" }),
  savedMessages: (id: string) => request<SavedMessage[]>(`/sessions/${id}/saved`),
  enqueueMessage: (id: string, text: string) =>
    request<SavedMessage>(`/sessions/${id}/saved`, { method: "POST", body: JSON.stringify({ text }) }),
  updateSavedMessage: (id: string, messageId: string, patch: UpdateSavedMessageRequest) =>
    request<SavedMessage>(`/sessions/${id}/saved/${messageId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSavedMessage: (id: string, messageId: string) => request<void>(`/sessions/${id}/saved/${messageId}`, { method: "DELETE" }),
  sendSavedMessage: (id: string, messageId: string) =>
    request<{ ok: true }>(`/sessions/${id}/saved/${messageId}/send`, { method: "POST" }),
  setQueueRunning: (id: string, running: boolean) =>
    request<Session>(`/sessions/${id}/queue`, { method: "POST", body: JSON.stringify({ running }) }),
  continueAfterLimit: (id: string) => request<Session>(`/sessions/${id}/usage/continue`, { method: "POST" }),
  setAutoContinue: (id: string, enabled: boolean) =>
    request<Session>(`/sessions/${id}/usage/auto-continue`, { method: "POST", body: JSON.stringify({ enabled }) }),
  snapshots: (id: string) => request<Snapshot[]>(`/sessions/${id}/snapshots`),
  createSnapshot: (id: string) => request<Snapshot>(`/sessions/${id}/snapshots`, { method: "POST" }),
  deleteSnapshot: (id: string, snapshotId: string) => request<void>(`/sessions/${id}/snapshots/${snapshotId}`, { method: "DELETE" }),
  deleteAllSnapshots: (id: string) => request<DeleteSnapshotsResult>(`/sessions/${id}/snapshots`, { method: "DELETE" }),
  rebuild: (id: string) => request<Session>(`/sessions/${id}/rebuild`, { method: "POST" }),
  forkSession: (id: string, req: ForkSessionRequest) =>
    request<Session>(`/sessions/${id}/fork`, { method: "POST", body: JSON.stringify(req) }),
  revert: (id: string, req: RevertRequest) =>
    request<Session>(`/sessions/${id}/revert`, { method: "POST", body: JSON.stringify(req) }),
  switchBranch: (id: string, req: SwitchBranchRequest) =>
    request<Session>(`/sessions/${id}/branch`, { method: "POST", body: JSON.stringify(req) }),
  hostDirs: (path?: string) => request<HostDirListing>(`/host/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  addRepo: (id: string, req: AddRepoRequest) => request<SessionRepo>(`/sessions/${id}/repos`, { method: "POST", body: JSON.stringify(req) }),
  updateRepo: (id: string, repoId: string, req: UpdateRepoRequest) =>
    request<SessionRepo>(`/sessions/${id}/repos/${repoId}`, { method: "PATCH", body: JSON.stringify(req) }),
  /** 409 with the repository's Git state when it holds work that is nowhere else and `force` is off. */
  removeRepo: async (id: string, repoId: string, force: boolean): Promise<{ removed: true } | { removed: false; blocked: RepoRemovalBlocked }> => {
    const res = await fetch(`/api/sessions/${id}/repos/${repoId}${force ? "?force=1" : ""}`, { method: "DELETE" });
    if (res.status === 409) return { removed: false, blocked: (await res.json()) as RepoRemovalBlocked };
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // non-JSON error body
      }
      if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: message }));
      throw new Error(message);
    }
    return { removed: true };
  },
  syncPlan: (id: string, repoId?: string) => request<SyncPlan>(`/sessions/${id}/sync${repoId ? `?repoId=${encodeURIComponent(repoId)}` : ""}`),
  syncPull: (id: string, req: SyncRequest) => request<SyncResult>(`/sessions/${id}/sync`, { method: "POST", body: JSON.stringify(req) }),
  usbHost: () => request<UsbHost>("/usb"),
  usbConnect: (id: string, deviceId: string) => request<Session>(`/sessions/${id}/usb`, { method: "POST", body: JSON.stringify({ deviceId }) }),
  usbDisconnect: (id: string) => request<Session>(`/sessions/${id}/usb`, { method: "DELETE" }),
  terminals: (id: string) => request<PtyListResult>(`/sessions/${id}/terminals`),
  openTerminal: (id: string, cols: number, rows: number) =>
    request<PtyInfo>(`/sessions/${id}/terminals`, { method: "POST", body: JSON.stringify({ cols, rows }) }),
  closeTerminal: (id: string, ptyId: string) =>
    request<void>(`/sessions/${id}/terminals/${ptyId}`, { method: "DELETE" }),
  codeStart: (id: string, params: CodeStartParams) =>
    request<CodeServerStatus>(`/sessions/${id}/code-server`, { method: "POST", body: JSON.stringify(params) }),
  codeTheme: (id: string, params: CodeThemeParams) =>
    request<{ ok: true }>(`/sessions/${id}/code-server/theme`, { method: "POST", body: JSON.stringify(params) }),
  codeStatus: (id: string) => request<CodeServerStatus>(`/sessions/${id}/code-server`),
  codeStop: (id: string) => request<CodeServerStatus>(`/sessions/${id}/code-server`, { method: "DELETE" }),
  codeOpen: (id: string, target: CodeOpenParams) =>
    request<{ ok: true }>(`/sessions/${id}/code-server/open`, { method: "POST", body: JSON.stringify(target) }),
  prs: (id: string) => request<PullRequest[]>(`/sessions/${id}/prs`),
  attachPr: (id: string, ref: string) => request<PullRequest>(`/sessions/${id}/prs`, { method: "POST", body: JSON.stringify({ ref }) }),
  prItems: (id: string, prId: string) => request<PrItem[]>(`/sessions/${id}/prs/${prId}/items`),
  prChecks: (id: string, prId: string) => request<PrCheckItem[]>(`/sessions/${id}/prs/${prId}/checks`),
  updatePr: (id: string, prId: string, req: UpdatePrRequest) =>
    request<PullRequest>(`/sessions/${id}/prs/${prId}`, { method: "PATCH", body: JSON.stringify(req) }),
  detachPr: (id: string, prId: string) => request<void>(`/sessions/${id}/prs/${prId}`, { method: "DELETE" }),
  refreshPr: (id: string, prId: string) => request<PullRequest>(`/sessions/${id}/prs/${prId}/refresh`, { method: "POST" }),
  prSeen: (id: string, prId: string) => request<void>(`/sessions/${id}/prs/${prId}/seen`, { method: "POST" }),
  prAction: (id: string, req: PrActionRequest) =>
    request<PrActionResult>(`/sessions/${id}/prs/actions`, { method: "POST", body: JSON.stringify(req) }),
  e2eRuns: (id: string) => request<E2eRun[]>(`/sessions/${id}/e2e`),
  e2eRunNow: (id: string) => request<E2eRun>(`/sessions/${id}/e2e/run`, { method: "POST" }),
};

/** Same-origin URL of a Session's VS Code (the Code pane's iframe), proxied by the Control Plane. */
export function codeUrl(sessionId: string): string {
  return `/api/sessions/${sessionId}/code/`;
}

export function terminalSocketUrl(sessionId: string, ptyId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/sessions/${sessionId}/terminals/${ptyId}/ws`;
}

/** Quiet this long on the push socket, send a ping; no answer within `PROBE_TIMEOUT_MS` means the socket is dead. */
const HEARTBEAT_MS = 20_000;
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Subscribes to Control Plane pushes; reconnects with a 1s backoff that grows to 15s while the
 * handshake keeps failing. Tells the Control Plane whether the page is on screen, so Web Pushes
 * go to the devices that are not watching.
 *
 * A socket the browser still reports open can be dead underneath (the tab was in the background,
 * the laptop slept, the network changed): nothing arrives and no `close` fires. The page pings the
 * Control Plane when the socket has been quiet for a while and as soon as it comes back on screen or
 * online; a missing pong drops the socket and reconnects, and every reconnection refetches what was
 * missed through `onReconnect`.
 */
export function subscribe(onMessage: (msg: SessionBroadcast) => void, onReconnect: () => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let probe: ReturnType<typeof setTimeout> | null = null;
  let hadConnection = false;
  let failures = 0;
  let lastSeen = 0;

  const send = (msg: UiClientMessage) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const reportVisibility = () => send({ type: "visibility", visible: document.visibilityState === "visible" });

  const clearProbe = () => {
    if (probe) clearTimeout(probe);
    probe = null;
  };

  /** Abandons the current socket (no `close` event awaited: a dead one may never deliver it) and reconnects. */
  const drop = () => {
    clearProbe();
    if (timer) clearTimeout(timer);
    timer = null;
    const old = ws;
    ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      old.close();
    }
    connect();
  };

  const ping = () => {
    if (probe || ws?.readyState !== WebSocket.OPEN) return;
    const sentAt = Date.now();
    send({ type: "ping" });
    probe = setTimeout(() => {
      probe = null;
      if (lastSeen < sentAt) drop();
    }, PROBE_TIMEOUT_MS);
  };

  const heartbeat = setInterval(() => {
    if (Date.now() - lastSeen >= HEARTBEAT_MS) ping();
  }, HEARTBEAT_MS / 4);

  /** Back on screen or online: check the socket right away instead of waiting for the next heartbeat or backoff. */
  const check = () => {
    if (closed) return;
    if (ws?.readyState === WebSocket.OPEN) ping();
    else if (ws?.readyState !== WebSocket.CONNECTING) drop();
  };
  const onVisibility = () => {
    reportVisibility();
    if (document.visibilityState === "visible") check();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", check);

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let opened = false;
    const socket = new WebSocket(`${proto}//${location.host}/api/ws`);
    ws = socket;
    socket.onopen = () => {
      opened = true;
      failures = 0;
      lastSeen = Date.now();
      reportVisibility();
      if (hadConnection) onReconnect();
      hadConnection = true;
    };
    socket.onmessage = (evt) => {
      lastSeen = Date.now();
      const msg = JSON.parse(String(evt.data)) as SessionBroadcast;
      if (msg.type === "pong") return;
      onMessage(msg);
    };
    socket.onclose = () => {
      if (closed) return;
      clearProbe();
      // A handshake the Control Plane refused looks like any other failure from here; ask it whether we are still logged in.
      if (!opened) {
        failures++;
        api.me().then(
          ({ principal }) => {
            if (!principal) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: "Login required." }));
          },
          () => undefined,
        );
      }
      timer = setTimeout(connect, Math.min(1000 * 2 ** Math.min(failures, 4), 15_000));
    };
    socket.onerror = () => socket.close();
  };
  connect();

  return () => {
    closed = true;
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", check);
    clearInterval(heartbeat);
    clearProbe();
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
