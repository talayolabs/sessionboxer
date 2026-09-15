import type {
  CreateSessionRequest,
  PublicSettings,
  Session,
  SessionBroadcast,
  SessionEvent,
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
  updateSettings: (update: UpdateSettingsRequest) =>
    request<PublicSettings>("/settings", { method: "PUT", body: JSON.stringify(update) }),
  sessions: () => request<Session[]>("/sessions"),
  createSession: (req: CreateSessionRequest) =>
    request<Session>("/sessions", { method: "POST", body: JSON.stringify(req) }),
  renameSession: (id: string, title: string) =>
    request<Session>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: "DELETE" }),
  events: (id: string, after = 0) => request<SessionEvent[]>(`/sessions/${id}/events?after=${after}`),
  prompt: (id: string, text: string) =>
    request<{ ok: true }>(`/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ text }) }),
  cancel: (id: string) => request<{ ok: true }>(`/sessions/${id}/cancel`, { method: "POST" }),
  stop: (id: string) => request<Session>(`/sessions/${id}/stop`, { method: "POST" }),
  resume: (id: string) => request<Session>(`/sessions/${id}/resume`, { method: "POST" }),
};

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
