import type {
  AskResult,
  CodeServerStatus,
  ConnectorFlow,
  GhCliStatus,
  ConnectorKind,
  ConnectorStartRequest,
  CreateSessionRequest,
  DeleteSnapshotsResult,
  ForkSessionRequest,
  HostDirListing,
  ProviderModels,
  ProviderOptions,
  PtyInfo,
  PtyListResult,
  PublicSettings,
  RevertRequest,
  SavedMessage,
  Session,
  SessionBroadcast,
  SessionEvent,
  Snapshot,
  SwitchBranchRequest,
  SyncPlan,
  SyncRequest,
  SyncResult,
  UpdateSavedMessageRequest,
  UpdateSessionRequest,
  UpdateSettingsRequest,
} from "@sessionboxer/protocol";

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
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  settings: () => request<PublicSettings>("/settings"),
  models: () => request<ProviderModels>("/models"),
  options: () => request<ProviderOptions>("/options"),
  updateSettings: (update: UpdateSettingsRequest) =>
    request<PublicSettings>("/settings", { method: "PUT", body: JSON.stringify(update) }),
  connectorStart: (kind: ConnectorKind, req: ConnectorStartRequest) =>
    request<ConnectorFlow>(`/connectors/${kind}/start`, { method: "POST", body: JSON.stringify(req) }),
  connectorFlow: (id: string) => request<ConnectorFlow>(`/connectors/flows/${id}`),
  connectorGh: () => request<GhCliStatus>("/connectors/github/gh"),
  connectorDisconnect: (serverId: string) =>
    request<PublicSettings>(`/connectors/servers/${serverId}/disconnect`, { method: "POST" }),
  sessions: () => request<Session[]>("/sessions"),
  createSession: (req: CreateSessionRequest) =>
    request<Session>("/sessions", { method: "POST", body: JSON.stringify(req) }),
  updateSession: (id: string, patch: UpdateSessionRequest) =>
    request<Session>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: "DELETE" }),
  events: (id: string, after = 0) => request<SessionEvent[]>(`/sessions/${id}/events?after=${after}`),
  prompt: (id: string, text: string) =>
    request<{ ok: true }>(`/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) }),
  ask: (id: string, text: string) => request<AskResult>(`/sessions/${id}/ask`, { method: "POST", body: JSON.stringify({ text }) }),
  cancel: (id: string) => request<{ ok: true }>(`/sessions/${id}/cancel`, { method: "POST" }),
  stop: (id: string) => request<Session>(`/sessions/${id}/stop`, { method: "POST" }),
  resume: (id: string) => request<Session>(`/sessions/${id}/resume`, { method: "POST" }),
  savedMessages: (id: string) => request<SavedMessage[]>(`/sessions/${id}/saved`),
  saveMessage: (id: string, text: string) =>
    request<SavedMessage>(`/sessions/${id}/saved`, { method: "POST", body: JSON.stringify({ text }) }),
  updateSavedMessage: (id: string, messageId: string, patch: UpdateSavedMessageRequest) =>
    request<SavedMessage>(`/sessions/${id}/saved/${messageId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSavedMessage: (id: string, messageId: string) => request<void>(`/sessions/${id}/saved/${messageId}`, { method: "DELETE" }),
  sendSavedMessage: (id: string, messageId: string) =>
    request<{ ok: true }>(`/sessions/${id}/saved/${messageId}/send`, { method: "POST" }),
  setQueueRunning: (id: string, running: boolean) =>
    request<Session>(`/sessions/${id}/queue`, { method: "POST", body: JSON.stringify({ running }) }),
  snapshots: (id: string) => request<Snapshot[]>(`/sessions/${id}/snapshots`),
  createSnapshot: (id: string) => request<Snapshot>(`/sessions/${id}/snapshots`, { method: "POST" }),
  deleteSnapshot: (id: string, snapshotId: string) => request<void>(`/sessions/${id}/snapshots/${snapshotId}`, { method: "DELETE" }),
  deleteAllSnapshots: (id: string) => request<DeleteSnapshotsResult>(`/sessions/${id}/snapshots`, { method: "DELETE" }),
  forkSession: (id: string, req: ForkSessionRequest) =>
    request<Session>(`/sessions/${id}/fork`, { method: "POST", body: JSON.stringify(req) }),
  revert: (id: string, req: RevertRequest) =>
    request<Session>(`/sessions/${id}/revert`, { method: "POST", body: JSON.stringify(req) }),
  switchBranch: (id: string, req: SwitchBranchRequest) =>
    request<Session>(`/sessions/${id}/branch`, { method: "POST", body: JSON.stringify(req) }),
  hostDirs: (path?: string) => request<HostDirListing>(`/host/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  syncPlan: (id: string) => request<SyncPlan>(`/sessions/${id}/sync`),
  syncPull: (id: string, req: SyncRequest) => request<SyncResult>(`/sessions/${id}/sync`, { method: "POST", body: JSON.stringify(req) }),
  terminals: (id: string) => request<PtyListResult>(`/sessions/${id}/terminals`),
  openTerminal: (id: string, cols: number, rows: number) =>
    request<PtyInfo>(`/sessions/${id}/terminals`, { method: "POST", body: JSON.stringify({ cols, rows }) }),
  closeTerminal: (id: string, ptyId: string) =>
    request<void>(`/sessions/${id}/terminals/${ptyId}`, { method: "DELETE" }),
  codeStart: (id: string) => request<CodeServerStatus>(`/sessions/${id}/code-server`, { method: "POST" }),
  codeStatus: (id: string) => request<CodeServerStatus>(`/sessions/${id}/code-server`),
  codeStop: (id: string) => request<CodeServerStatus>(`/sessions/${id}/code-server`, { method: "DELETE" }),
};

/** Same-origin URL of a Session's VS Code (the Code pane's iframe), proxied by the Control Plane. */
export function codeUrl(sessionId: string): string {
  return `/api/sessions/${sessionId}/code/`;
}

export function terminalSocketUrl(sessionId: string, ptyId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/sessions/${sessionId}/terminals/${ptyId}/ws`;
}

/** Subscribes to Control Plane pushes; reconnects with a fixed 1s backoff. */
export function subscribe(onMessage: (msg: SessionBroadcast) => void, onReconnect: () => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hadConnection = false;

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/ws`);
    ws.onopen = () => {
      if (hadConnection) onReconnect();
      hadConnection = true;
    };
    ws.onmessage = (evt) => onMessage(JSON.parse(String(evt.data)) as SessionBroadcast);
    ws.onclose = () => {
      if (!closed) timer = setTimeout(connect, 1000);
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
