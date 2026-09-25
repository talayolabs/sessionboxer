import { useEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  PROVIDERS,
  type ForkConversation,
  type ForkSessionRequest,
  type Provider,
  type ProviderModels,
  type ProviderOptions,
  type PublicSettings,
  type SavedMessage,
  type Session,
  type Snapshot,
} from "@sessionboxer/protocol";
import { formatMb, formatTime } from "./format";
import { providerCredentialNoun, providerTokenSet } from "./providers";
import { SessionSettingsForm, draftFromSettings, draftToInput, type SessionSettingsDraft } from "./SessionSettingsForm";
import { Modal } from "./ui";

const PREVIEW_CHARS = 120;

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS)}\u2026` : oneLine;
}

/** Why the origin's Agent cannot write a handoff right now; `null` when it can. */
function handoffBlocker(session: Session): string | null {
  switch (session.status) {
    case "idle":
      return null;
    case "running":
      return "once the Agent has finished its turn";
    case "stopped":
      return "the Session is stopped: resume it first, its Agent has to write the handoff";
    case "error":
      return "the Session is in error: its Agent cannot write the handoff";
    default:
      return "once the Sandbox is up";
  }
}

/**
 * "Fork from a snapshot": pick the Snapshot (fork point), the fork's Agent (the origin's or another
 * one), what happens to the conversation (continued by the same Agent, started anew, or started
 * from a handoff the origin's Agent writes now), what the fork's first message is (one of the
 * queued messages at that point, the current queue, a new prompt, or nothing) and whether the
 * rest of the queue is copied over. The fork starts with the origin's settings; "Settings" opens
 * them for changes, including the creation-only ones (Docker, instructions, git identity). The
 * origin Session and its queue are never modified (a handoff costs it one hidden turn).
 */
export function ForkDialog({
  session,
  settings,
  models,
  options,
  snapshots,
  saved,
  initialSnapshotId,
  initialSettingsOpen = false,
  onSubmit,
  onClose,
  busy,
}: {
  session: Session;
  settings: PublicSettings;
  /** Per Provider: what the fork's Agent can be asked for. */
  models: ProviderModels;
  options: ProviderOptions;
  snapshots: Snapshot[];
  /** The origin's current saved messages, offered next to the ones stored with the Snapshot. */
  saved: SavedMessage[];
  initialSnapshotId: string;
  /** Start with the settings section expanded ("Fork with different settings"). */
  initialSettingsOpen?: boolean;
  onSubmit: (req: ForkSessionRequest) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [snapshotId, setSnapshotId] = useState(initialSnapshotId);
  const [provider, setProvider] = useState<Provider>(session.provider);
  const [conversation, setConversation] = useState<ForkConversation>("continue");
  const [title, setTitle] = useState("");
  const [first, setFirst] = useState<"none" | "custom" | `q${number}`>("none");
  const [custom, setCustom] = useState("");
  const [copyRest, setCopyRest] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const [draft, setDraft] = useState<SessionSettingsDraft>(() => draftFromSettings(session.settings));
  const [draftChanged, setDraftChanged] = useState(false);

  const snapshot = snapshots.find((s) => s.id === snapshotId) ?? snapshots[snapshots.length - 1];
  // Messages queued when the Snapshot was taken, then whatever is queued now that wasn't already there.
  const candidates = snapshot
    ? [...snapshot.queuedMessages, ...saved.map((m) => m.text).filter((t) => !snapshot.queuedMessages.includes(t))]
    : saved.map((m) => m.text);
  const snapshotCount = snapshot?.queuedMessages.length ?? 0;

  useEffect(() => {
    if (first.startsWith("q") && Number(first.slice(1)) >= candidates.length) setFirst("none");
  }, [first, candidates.length]);

  if (!snapshot) return null;

  const sameAgent = provider === session.provider;
  const originLabel = PROVIDER_LABELS[session.provider];
  const forkLabel = PROVIDER_LABELS[provider];
  const blocker = handoffBlocker(session);

  // Another Agent cannot load this one's memory: a new conversation or a handoff.
  const pickProvider = (p: Provider) => {
    setProvider(p);
    if (p !== session.provider && conversation === "continue") setConversation(blocker ? "new" : "handoff");
    // Model and options belong to a Provider; the origin's come back with it, another starts from its defaults.
    const base = draftFromSettings(session.settings);
    setDraft((d) =>
      p === session.provider
        ? { ...d, model: base.model, options: base.options, inspectLlm: base.inspectLlm }
        : { ...d, model: null, options: {}, inspectLlm: p === "claude-code" },
    );
  };

  const pickedIndex = first.startsWith("q") ? Number(first.slice(1)) : -1;
  const prompt = first === "custom" ? custom.trim() : pickedIndex >= 0 ? candidates[pickedIndex] : "";
  const others = candidates.filter((_, i) => i !== pickedIndex);
  const rest = copyRest ? others : [];
  const defaultTitle = `${session.title} (${sameAgent ? "fork" : `${forkLabel}, fork`} ${snapshot.ordinal})`;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      snapshotId: snapshot.id,
      conversation,
      ...(sameAgent ? {} : { provider }),
      ...(title.trim() ? { title: title.trim() } : {}),
      settings: draftChanged ? draftToInput(draft) : {},
      ...(prompt ? { prompt } : {}),
      savedMessages: rest,
    });
  };

  return (
    <Modal title={`Fork "${session.title}"`} onClose={onClose} onSubmit={submit}>
      <p className="muted">
        A new Session with its own Sandbox started from the snapshot image: same files and installed tools, with the same
        Agent or another one, with or without the conversation up to that point. The original Session, its Sandbox and its
        queue are left as they are.
      </p>
      <label>
        Fork point
        <select value={snapshot.id} onChange={(e) => setSnapshotId(e.target.value)}>
          {[...snapshots].reverse().map((s) => (
            <option key={s.id} value={s.id}>
              #{s.ordinal}
              {s.reason === "manual" ? " (manual)" : ""} {"\u00b7"} {formatTime(s.createdAt)} {"\u00b7"} {formatMb(s.sizeBytes)}
              {s.queuedMessages.length > 0 ? ` \u00b7 ${s.queuedMessages.length} queued` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Agent
        <select value={provider} onChange={(e) => pickProvider(e.target.value as Provider)} disabled={busy}>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
              {p === session.provider ? " (the origin's)" : ""}
            </option>
          ))}
        </select>
      </label>
      {!providerTokenSet(settings, provider) && (
        <p className="field-hint warn">
          No {forkLabel} {providerCredentialNoun(provider)} configured: add it in <a href="#/settings/providers">Global settings → Provider logins</a> first, or
          pick an Agent you are logged in to.
        </p>
      )}
      <fieldset className="choice">
        <legend>Conversation</legend>
        <label className="check" title={sameAgent ? undefined : `${forkLabel} cannot load ${originLabel}'s memory; start a new conversation or hand off.`}>
          <input
            type="radio"
            name="conversation"
            checked={conversation === "continue"}
            disabled={!sameAgent}
            onChange={() => setConversation("continue")}
          />
          <span className={`choice-text${sameAgent ? "" : " muted"}`}>
            Continue it{" "}
            <span className="muted">
              {sameAgent
                ? "— the chat up to the snapshot is kept, the Agent remembers it"
                : `— only for ${originLabel}: an Agent's memory cannot be loaded into another`}
            </span>
          </span>
        </label>
        <label className="check">
          <input type="radio" name="conversation" checked={conversation === "new"} onChange={() => setConversation("new")} />
          <span className="choice-text">
            Start a new one <span className="muted">— empty chat, {forkLabel} starts fresh on the same files</span>
          </span>
        </label>
        <label className="check" title={blocker ? `The handoff can be written ${blocker}.` : undefined}>
          <input
            type="radio"
            name="conversation"
            checked={conversation === "handoff"}
            disabled={blocker !== null}
            onChange={() => setConversation("handoff")}
          />
          <span className={`choice-text${blocker ? " muted" : ""}`}>
            Hand off{" "}
            <span className="muted">
              — {originLabel} writes down goal, state of the work, decisions, open items, files and how to run it (a hidden turn in this
              Session, from its whole memory); {sameAgent ? "a fresh " : ""}
              {forkLabel} gets it as its first message
              {blocker ? ` — ${blocker}` : ""}
            </span>
          </span>
        </label>
      </fieldset>
      <label>
        Title (optional)
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={defaultTitle} />
      </label>
      <fieldset className="choice">
        <legend>{conversation === "handoff" ? "Your message to add after the handoff" : "First message in the fork"}</legend>
        <label className="check">
          <input type="radio" name="first" checked={first === "none"} onChange={() => setFirst("none")} />
          {conversation === "handoff" ? `Nothing: ${forkLabel} reads the handoff and carries on with its open items` : "Nothing, just open the fork"}
        </label>
        {candidates.map((text, i) => (
          <label className="check" key={i} title={text}>
            <input type="radio" name="first" checked={first === `q${i}`} onChange={() => setFirst(`q${i}`)} />
            <span className="choice-text">
              <span className="muted">{i < snapshotCount ? "queued at the snapshot: " : "queued now: "}</span>
              {preview(text)}
            </span>
          </label>
        ))}
        <label className="check">
          <input type="radio" name="first" checked={first === "custom"} onChange={() => setFirst("custom")} />
          A new message
        </label>
        {first === "custom" && <textarea rows={4} autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} />}
      </fieldset>
      {others.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={copyRest} onChange={(e) => setCopyRest(e.target.checked)} />
          Copy the {pickedIndex >= 0 ? "other " : ""}
          {others.length} queued message{others.length === 1 ? "" : "s"} to the fork's queue (sent after its first message)
        </label>
      )}
      <details className="fork-settings" open={settingsOpen} onToggle={(e) => setSettingsOpen(e.currentTarget.open)}>
        <summary>
          Settings of the fork{draftChanged ? " (changed)" : " (same as the origin)"}
        </summary>
        {settingsOpen && (
          <SessionSettingsForm
            mode="fork"
            provider={provider}
            session={session}
            settings={settings}
            models={models[provider]}
            options={options[provider]}
            value={draft}
            onChange={(patch) => {
              setDraft((d) => ({ ...d, ...patch }));
              setDraftChanged(true);
            }}
            disabled={busy}
          />
        )}
      </details>
      <div className="actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || (first === "custom" && !custom.trim()) || (conversation === "handoff" && blocker !== null)}>
          {busy ? "Forking\u2026" : conversation === "handoff" ? "Hand off and fork" : "Fork"}
        </button>
      </div>
    </Modal>
  );
}
