import type { AgentPromptOrigin, SavedMessage, Session, SessionBroadcast } from "@sessionboxer/protocol";
import type { Db, SessionPatch } from "./db.js";
import { HttpError } from "./http-error.js";

/** What the queue needs from the rest of the Control Plane; no back-reference to `SessionManager`. */
export interface SessionQueueDeps {
  db: Db;
  /** The Session, or a 404 `HttpError`. */
  get: (id: string) => Session;
  /** Patches the Session and broadcasts it (`queueRunning`). */
  update: (id: string, patch: SessionPatch) => Session;
  /** Sends `text` to the Session's Agent; `origin` when another Session's Agent queued it. */
  prompt: (id: string, text: string, origin?: AgentPromptOrigin) => Promise<void>;
  /** Whether the Session's Daemon is connected right now. */
  isConnected: (id: string) => boolean;
  broadcast: (msg: SessionBroadcast) => void;
  log: (msg: string) => void;
}

/**
 * The saved-messages queue of each Session: messages the user, a scheduled task, a PR action or
 * another Agent left for the Session's Agent, sent one per turn while the queue plays
 * (`Session.queueRunning`). Extracted from `SessionManager` (docs/TECH-DEBT.md, fix 7).
 */
export class SessionQueue {
  /** Saved messages another Session's Agent queued (`session_message`), by message id: sent with that origin. */
  private readonly origins = new Map<string, { targetId: string; origin: AgentPromptOrigin }>();

  constructor(private readonly deps: SessionQueueDeps) {}

  list(id: string): SavedMessage[] {
    this.deps.get(id);
    return this.deps.db.listSavedMessages(id);
  }

  /**
   * Appends a message to the Session's queue and lets the queue play: the message goes out
   * as soon as the Agent is idle (now, after the current turn, or when a stopped Sandbox is
   * resumed). A queue the user paused with messages still in it stays paused, the new message
   * waits behind them, unless `resumePaused` (scheduled tasks, PR actions) asks otherwise.
   */
  async enqueue(id: string, text: string, opts: { resumePaused?: boolean; origin?: AgentPromptOrigin } = {}): Promise<SavedMessage> {
    const s = this.deps.get(id);
    const paused = !s.queueRunning && this.deps.db.listSavedMessages(id).length > 0;
    const saved = this.deps.db.insertSavedMessage(id, text);
    if (opts.origin) this.origins.set(saved.id, { targetId: id, origin: opts.origin });
    this.broadcastSaved(id);
    if (!s.queueRunning && (!paused || opts.resumePaused) && s.status !== "error") {
      this.deps.update(id, { queueRunning: true });
      await this.pump(id);
    }
    return saved;
  }

  updateMessage(id: string, messageId: string, patch: { text?: string; position?: number }): SavedMessage {
    this.deps.get(id);
    const saved = this.deps.db.updateSavedMessage(id, messageId, patch);
    if (!saved) throw new HttpError(404, `saved message ${messageId} not found`);
    this.broadcastSaved(id);
    return saved;
  }

  deleteMessage(id: string, messageId: string): void {
    this.deps.get(id);
    if (!this.deps.db.deleteSavedMessage(id, messageId)) throw new HttpError(404, `saved message ${messageId} not found`);
    this.broadcastSaved(id);
  }

  /** Sends a saved message now and drops it from the list. */
  async send(id: string, messageId: string): Promise<void> {
    this.deps.get(id);
    const saved = this.deps.db.getSavedMessage(id, messageId);
    if (!saved) throw new HttpError(404, `saved message ${messageId} not found`);
    await this.deps.prompt(id, saved.text);
    this.deps.db.deleteSavedMessage(id, messageId);
    this.broadcastSaved(id);
  }

  /**
   * Play/pause the queue. While playing, the first queued message is sent as soon as
   * the Agent is idle and again after every `turn_ended`, until the list is empty; a stopped
   * Sandbox plays it when resumed. Pausing lets the current turn finish.
   */
  async setRunning(id: string, running: boolean): Promise<Session> {
    const s = this.deps.get(id);
    if (running && this.deps.db.listSavedMessages(id).length === 0) throw new HttpError(409, "The queue is empty.");
    if (running && s.status === "error") throw new HttpError(409, `Session is in error state: ${s.error ?? "unknown"}`);
    if (s.queueRunning !== running) this.deps.update(id, { queueRunning: running });
    if (running) await this.pump(id);
    return this.deps.get(id);
  }

  /** Sends the next queued message if the queue is playing and the Agent is idle and reachable. */
  async pump(id: string): Promise<void> {
    const s = this.deps.db.getSession(id);
    if (!s?.queueRunning || s.status !== "idle" || s.usage.limit) return;
    const next = this.deps.db.listSavedMessages(id)[0];
    if (!next) {
      this.deps.update(id, { queueRunning: false });
      return;
    }
    // Between a resume and the Daemon's connection the Session is idle but unreachable;
    // `onDaemonConnected` pumps then.
    if (!this.deps.isConnected(id)) return;
    try {
      await this.deps.prompt(id, next.text, this.origins.get(next.id)?.origin);
    } catch (e) {
      this.deps.log(`queue ${id} paused: ${e instanceof Error ? e.message : String(e)}`);
      this.deps.update(id, { queueRunning: false });
      return;
    }
    this.origins.delete(next.id);
    this.deps.db.deleteSavedMessage(id, next.id);
    this.broadcastSaved(id);
  }

  /** Whether a message `fromId`'s Agent queued for `targetId` is still waiting to be sent. */
  hasQueuedFrom(targetId: string, fromId: string): boolean {
    return [...this.origins.values()].some((q) => q.targetId === targetId && q.origin.fromSessionId === fromId);
  }

  /** Drops what the queue remembers about a deleted Session. */
  forget(id: string): void {
    for (const [messageId, q] of this.origins) if (q.targetId === id) this.origins.delete(messageId);
  }

  private broadcastSaved(id: string): void {
    this.deps.broadcast({ type: "saved_messages", sessionId: id, messages: this.deps.db.listSavedMessages(id) });
  }
}
