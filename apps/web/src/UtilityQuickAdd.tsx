import { useState } from "react";
import { UTILITY_GROUPS, UTILITY_GROUP_LABELS, UTILITY_PRESETS, type PublicSettings, type PublicUtilityDef, type Session, type UtilityGroup } from "@sessionboxer/protocol";
import { api } from "./api";
import { Modal } from "./ui";
import { newUtility } from "./UtilitiesEditor";

/** What `/util …` said: a Utility to register, credentials included (they stay in this browser until the Control Plane stores them). */
export interface UtilCommand {
  name: string;
  preset: string | null;
  url: string;
  environment: string | null;
  group: UtilityGroup | null;
  credentials: Array<{ name: string; value: string }>;
}

const CRED_WORDS: Record<string, string> = { user: "user", username: "user", login: "user", pass: "password", password: "password", pw: "password", token: "token", apikey: "token", key: "token", totp: "totp", otp: "totp", "2fa": "totp", uri: "uri" };

/**
 * `/util add newrelic with user bocato pass s3cret token NRAK-… totp JBSW… at https://one.newrelic.com in staging`
 * (`add` optional; `<name>` may be a preset name or `<preset> <name>`; `as observability|applications`). `null`
 * when the text is not a /util command.
 */
export function parseUtilCommand(text: string): UtilCommand | null {
  const m = /^\/util(?:\s+add)?\s+(.*)$/is.exec(text.trim());
  if (!m) return null;
  const words = m[1]!.split(/\s+/).filter((w) => w !== "");
  const out: UtilCommand = { name: "", preset: null, url: "", environment: null, group: null, credentials: [] };
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const lower = w.toLowerCase();
    const next = words[i + 1];
    if (/^https?:\/\//i.test(w)) out.url = w;
    else if ((lower === "at" || lower === "url") && next && /^https?:\/\//i.test(next)) {
      out.url = next;
      i++;
    } else if ((lower === "in" || lower === "env" || lower === "environment") && next) {
      out.environment = next.toLowerCase();
      i++;
    } else if (lower === "as" && next && (UTILITY_GROUPS as readonly string[]).includes(next.toLowerCase())) {
      out.group = next.toLowerCase() as UtilityGroup;
      i++;
    } else if (CRED_WORDS[lower] && next !== undefined) {
      out.credentials.push({ name: CRED_WORDS[lower]!, value: next });
      i++;
    } else if (lower === "with" || lower === "and" || lower === "tool" || lower === "utility" || lower === "a") continue;
    else rest.push(w);
  }
  for (const w of rest) {
    const lower = w.toLowerCase();
    if (out.preset === null && UTILITY_PRESETS[lower] && out.name === "") out.preset = lower;
    else if (out.name === "") out.name = lower;
  }
  if (out.name === "" && out.preset) out.name = out.preset;
  if (out.name === "" && out.url) {
    try {
      out.name = new URL(out.url).hostname.split(".")[0] ?? "";
    } catch {
      out.name = "";
    }
  }
  out.name = out.name.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return out;
}

/**
 * The `/util` composer command's confirmation (ADR-0073): the Utility as parsed, credentials masked
 * and editable, Environment and group pickable. Save stores it in Settings → Utilities and
 * switches it on for this Session; nothing of it enters the transcript.
 */
export function UtilityQuickAdd({
  command,
  session,
  settings,
  onSettings,
  onClose,
}: {
  command: UtilCommand;
  session: Session;
  settings: PublicSettings;
  onSettings: (s: PublicSettings) => void;
  onClose: () => void;
}) {
  const envs = settings.utilityEnvironments;
  const [name, setName] = useState(command.name);
  const [preset, setPreset] = useState(command.preset ?? "");
  const [url, setUrl] = useState(command.url);
  const [environment, setEnvironment] = useState(command.environment ?? envs.find((e) => !e.production)?.name ?? envs[0]?.name ?? "");
  const [group, setGroup] = useState<UtilityGroup>(command.group ?? (command.preset ? UTILITY_PRESETS[command.preset]!.group : "observability"));
  const [credentials, setCredentials] = useState(command.credentials.length > 0 ? command.credentials : [{ name: "user", value: "" }, { name: "password", value: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dup = settings.utilities.some((u) => u.name === name && u.environment === environment);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const base = newUtility(group, environment, preset || null, url, name);
      const def: PublicUtilityDef = {
        ...base,
        group,
        credentials: credentials.filter((c) => c.name.trim() !== "").map((c) => ({ name: c.name.trim(), value: c.value, secret: c.name.trim() !== "user" })),
      };
      const saved = await api.updateSettings({ utilities: [...settings.utilities, def] });
      onSettings(saved);
      const stored = saved.utilities.find((u) => u.name === def.name && u.environment === def.environment);
      if (stored) await api.updateSession(session.id, { settings: { utilitiesEnabled: [...session.settings.utilitiesEnabled, stored.id] } });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add a Utility"
      description="Stored in Settings → Utilities and switched on for this Session; the credentials never enter the chat."
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="row">
        <label>
          Name
          <input value={name} pattern="[a-z0-9][a-z0-9_\-]{0,63}" onChange={(e) => setName(e.target.value.toLowerCase())} autoFocus={name === ""} />
        </label>
        <label>
          Kind
          <select
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value);
              if (e.target.value) setGroup(UTILITY_PRESETS[e.target.value]!.group);
            }}
          >
            <option value="">Custom (web UI)</option>
            {Object.entries(UTILITY_PRESETS).map(([k, p]) => (
              <option key={k} value={k}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        {preset ? UTILITY_PRESETS[preset]!.urlHint : "URL"}
        <input value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <div className="row">
        <label>
          Environment
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            {envs.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
                {e.production ? " (production)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Group
          <select value={group} onChange={(e) => setGroup(e.target.value as UtilityGroup)}>
            {UTILITY_GROUPS.map((g) => (
              <option key={g} value={g}>
                {UTILITY_GROUP_LABELS[g]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="kv">
        <span className="muted">Credentials</span>
        {credentials.map((c, i) => (
          <div key={i} className="kv-row">
            <input value={c.name} placeholder="password" onChange={(e) => setCredentials(credentials.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input type={c.name === "user" ? "text" : "password"} autoComplete="off" value={c.value} onChange={(e) => setCredentials(credentials.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <button type="button" className="small danger" onClick={() => setCredentials(credentials.filter((_, j) => j !== i))} title="Remove">
              ×
            </button>
          </div>
        ))}
        <div>
          <button type="button" className="small" onClick={() => setCredentials([...credentials, { name: "", value: "" }])}>
            Add credential
          </button>
        </div>
      </div>
      {dup && <p className="warn-sign">“{name}” already exists in {environment}; edit it in Settings → Utilities instead.</p>}
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || name === "" || environment === "" || dup}>
          Add and switch on
        </button>
      </div>
    </Modal>
  );
}
