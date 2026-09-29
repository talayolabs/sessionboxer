import { useRef, useState } from "react";
import {
  DEFAULT_UTILITY_ENVIRONMENTS,
  INCIDENT_PROCEDURE_TEMPLATE,
  MCP_TRANSPORTS,
  UTILITY_CREDENTIAL_HINTS,
  UTILITY_GROUPS,
  UTILITY_GROUP_LABELS,
  UTILITY_PRESETS,
  UTILITY_WEB_LOGINS,
  UTILITY_WEB_LOGIN_LABELS,
  applyUtilityPreset,
  parseProcedureSkill,
  procedureSkillMarkdown,
  type ProcedureDef,
  type PublicMcpKeyValue,
  type PublicUtilityDef,
  type UtilityEnvironment,
  type UtilityGroup,
  type UtilityWebLogin,
} from "@sessionboxer/protocol";
import { joinArgs, splitArgs } from "./mcp";
import { Modal } from "./ui";

/**
 * Settings → Utilities (ADR-0073): the target Environments (prod, staging, qa…), the Utilities —
 * observability systems and applications the Agent may investigate with, each with its
 * credentials and facets (MCP server, web UI, HTTP API, SSH host, CLI) — and the procedures
 * (skills) that say how to use them. Secrets are write-only, like the MCP editor's. Saved with the
 * Settings form.
 */
export function UtilitiesEditor({
  utilities,
  environments,
  procedures,
  onUtilities,
  onEnvironments,
  onProcedures,
}: {
  utilities: PublicUtilityDef[];
  environments: UtilityEnvironment[];
  procedures: ProcedureDef[];
  onUtilities: (list: PublicUtilityDef[]) => void;
  onEnvironments: (list: UtilityEnvironment[]) => void;
  onProcedures: (list: ProcedureDef[]) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<UtilityGroup | null>(null);
  const [editingProcedure, setEditingProcedure] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const envNames = environments.map((e) => e.name);
  const production = new Set(environments.filter((e) => e.production).map((e) => e.name));
  const update = (id: string, patch: Partial<PublicUtilityDef>) => onUtilities(utilities.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  const add = (def: PublicUtilityDef) => {
    onUtilities([...utilities, def]);
    setAdding(null);
    setEditing(def.id);
  };
  const remove = (id: string) => {
    const u = utilities.find((x) => x.id === id);
    if (u && !confirm(`Delete the Utility "${utilityLabel(u)}" (${u.environment}) and its credentials?`)) return;
    onUtilities(utilities.filter((x) => x.id !== id));
    if (editing === id) setEditing(null);
  };

  const importSkills = async (files: FileList | null) => {
    if (!files) return;
    const next = [...procedures];
    for (const file of Array.from(files)) {
      if (!/skill\.md$/i.test(file.name)) continue;
      const parsed = parseProcedureSkill(await file.text());
      if (!parsed) continue;
      const dirName = file.webkitRelativePath.split("/").slice(-2, -1)[0];
      const name = (parsed.name || dirName || file.name.replace(/\.md$/i, "")).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "procedure";
      const i = next.findIndex((p) => p.name === name);
      const def: ProcedureDef = { id: i >= 0 ? next[i]!.id : newId(), name, description: parsed.description || name, body: parsed.body, utilities: [], environments: [], source: "user", enabled: true };
      if (i >= 0) next[i] = def;
      else next.push(def);
    }
    onProcedures(next);
    if (importRef.current) importRef.current.value = "";
  };
  const exportSkill = (p: ProcedureDef) => {
    const blob = new Blob([procedureSkillMarkdown(p)], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${p.name}.SKILL.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const addProcedure = (template: boolean) => {
    const base = template ? INCIDENT_PROCEDURE_TEMPLATE : { name: "", description: "", body: "" };
    let name = base.name || "procedure";
    for (let i = 2; procedures.some((p) => p.name === name); i++) name = `${base.name || "procedure"}-${i}`;
    const def: ProcedureDef = { id: newId(), name, description: base.description, body: base.body, utilities: [], environments: [], source: "user", enabled: true };
    onProcedures([...procedures, def]);
    setEditingProcedure(def.id);
  };

  return (
    <div className="mcp-registry utilities-editor">
      <h4 className="ss-sub" id="settings-environments">
        Environments
      </h4>
      <p className="muted">
        What the Utilities point at: <code>prod</code>, <code>staging</code>, <code>qa</code>… (not the Session&apos;s Machine). Production ones are off for new
        Sessions unless marked default, and the Agent is told to look, not change.
      </p>
      <ul className="mcp-list env-list">
        {environments.map((env, i) => (
          <li key={i} className="mcp-card">
            <input
              className="env-name"
              value={env.name}
              pattern="[a-z0-9][a-z0-9_\-]{0,63}"
              placeholder="staging"
              onChange={(e) => {
                const name = e.target.value.toLowerCase();
                onEnvironments(environments.map((x, j) => (j === i ? { ...x, name } : x)));
                onUtilities(utilities.map((u) => (u.environment === env.name ? { ...u, environment: name } : u)));
              }}
            />
            <label className="check" title="The Agent is told it is production: read-only, careful, and it asks before switching a Utility of it on">
              <input type="checkbox" checked={env.production} onChange={(e) => onEnvironments(environments.map((x, j) => (j === i ? { ...x, production: e.target.checked } : x)))} />
              production
            </label>
            <label className="check" title="Its Utilities marked default are on for new Sessions">
              <input type="checkbox" checked={env.enabledByDefault} onChange={(e) => onEnvironments(environments.map((x, j) => (j === i ? { ...x, enabledByDefault: e.target.checked } : x)))} />
              on by default
            </label>
            <span className="muted">
              {utilities.filter((u) => u.environment === env.name).length} utilit{utilities.filter((u) => u.environment === env.name).length === 1 ? "y" : "ies"}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="small danger"
              disabled={utilities.some((u) => u.environment === env.name)}
              title={utilities.some((u) => u.environment === env.name) ? "Delete or move its Utilities first" : "Remove"}
              onClick={() => onEnvironments(environments.filter((_, j) => j !== i))}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <div className="mcp-actions">
        <button type="button" onClick={() => onEnvironments([...environments, { name: "", production: false, enabledByDefault: true }])}>
          Add Environment
        </button>
        {environments.length === 0 && (
          <button type="button" onClick={() => onEnvironments(DEFAULT_UTILITY_ENVIRONMENTS)}>
            Use prod / staging / qa
          </button>
        )}
      </div>

      {UTILITY_GROUPS.map((group) => {
        const list = utilities.filter((u) => u.group === group);
        return (
          <div key={group} id={`settings-utilities-${group}`}>
            <h4 className="ss-sub">{UTILITY_GROUP_LABELS[group]}</h4>
            <p className="muted">
              {group === "observability"
                ? "Where to look: dashboards, logs, traces, alerts, deploy state (New Relic, Grafana, Graylog, Argo CD…)."
                : "What to poke: the applications under test, admin UIs, queues, databases, hosts (a QA web app, the RabbitMQ admin, MongoDB, an SSH bastion…)."}
            </p>
            {list.length === 0 && <p className="empty ss-empty">None yet.</p>}
            {envNames
              .filter((env) => list.some((u) => u.environment === env))
              .map((env) => (
                <div key={env} className="util-env">
                  <div className="util-env-title">
                    <span className="mcp-name">{env}</span>
                    {production.has(env) && <span className="util-prod">production</span>}
                  </div>
                  <ul className="mcp-list">
                    {list
                      .filter((u) => u.environment === env)
                      .map((u) =>
                        editing === u.id ? (
                          <li key={u.id} className="mcp-card editing">
                            <UtilityForm
                              utility={u}
                              environments={environments}
                              onChange={(patch) => update(u.id, patch)}
                              onDone={() => setEditing(null)}
                              onDelete={() => remove(u.id)}
                            />
                          </li>
                        ) : (
                          <li key={u.id} className="mcp-card">
                            <label className="check" title="On for new Sessions (when the Environment is too)">
                              <input type="checkbox" checked={u.enabledByDefault} onChange={(e) => update(u.id, { enabledByDefault: e.target.checked })} />
                            </label>
                            <span className="mcp-name">{utilityLabel(u)}</span>
                            <span className="muted mcp-transport">{facetsOf(u).join(" · ") || "no facet"}</span>
                            <span className="muted mcp-summary" title={u.notes}>
                              {summarizeUtility(u)}
                            </span>
                            {u.readOnly && <span className="muted mcp-transport">read-only</span>}
                            <span className="spacer" />
                            <button type="button" className="small" onClick={() => setEditing(u.id)}>
                              Edit
                            </button>
                            <button type="button" className="small danger" onClick={() => remove(u.id)}>
                              Delete
                            </button>
                          </li>
                        ),
                      )}
                  </ul>
                </div>
              ))}
            <div className="mcp-actions">
              <button type="button" onClick={() => setAdding(group)} disabled={environments.length === 0} title={environments.length === 0 ? "Add an Environment first" : undefined}>
                Add {group === "observability" ? "observability" : "application"} Utility
              </button>
              {group === "applications" && <span className="muted mcp-hint">Checkbox = on for new Sessions. Saved with the form below.</span>}
            </div>
          </div>
        );
      })}

      <h4 className="ss-sub" id="settings-procedures">
        Procedures
      </h4>
      <p className="muted">
        Skills about investigating or verifying something with the Utilities (which to open, what to query, what healthy looks like). Each becomes{" "}
        <code>~/.claude/skills/&lt;name&gt;/SKILL.md</code> in every Session whose Utilities and Environments it names; Agents may propose new ones
        (<code>procedure_save</code>), which you allow in the chat. Never put credentials in them.
      </p>
      <ul className="mcp-list">
        {procedures.map((p) =>
          editingProcedure === p.id ? (
            <li key={p.id} className="mcp-card editing">
              <ProcedureForm
                procedure={p}
                utilities={utilities}
                environments={environments}
                onChange={(patch) => onProcedures(procedures.map((x) => (x.id === p.id ? { ...x, ...patch } : x)))}
                onDone={() => setEditingProcedure(null)}
                onDelete={() => {
                  onProcedures(procedures.filter((x) => x.id !== p.id));
                  setEditingProcedure(null);
                }}
              />
            </li>
          ) : (
            <li key={p.id} className="mcp-card">
              <label className="check" title="Materialised as a skill">
                <input type="checkbox" checked={p.enabled} onChange={(e) => onProcedures(procedures.map((x) => (x.id === p.id ? { ...x, enabled: e.target.checked } : x)))} />
              </label>
              <span className="mcp-name">{p.name}</span>
              <span className="muted mcp-summary" title={p.description}>
                {p.description}
              </span>
              {p.source === "agent" && <span className="muted mcp-transport">by an Agent</span>}
              {(p.utilities.length > 0 || p.environments.length > 0) && (
                <span className="muted" title="Sessions with these Utilities / Environments get it">
                  {[...p.utilities, ...p.environments].join(", ")}
                </span>
              )}
              <span className="spacer" />
              <button type="button" className="small" onClick={() => exportSkill(p)} title="Download as SKILL.md">
                Export
              </button>
              <button type="button" className="small" onClick={() => setEditingProcedure(p.id)}>
                Edit
              </button>
              <button type="button" className="small danger" onClick={() => onProcedures(procedures.filter((x) => x.id !== p.id))}>
                Delete
              </button>
            </li>
          ),
        )}
      </ul>
      <div className="mcp-actions">
        <button type="button" onClick={() => addProcedure(false)}>
          Add procedure
        </button>
        <button type="button" onClick={() => addProcedure(true)} title="A starting point: gather the symptom, look at deploys, errors, logs, traces, conclude">
          Add “Investigate an incident”
        </button>
        <button type="button" onClick={() => importRef.current?.click()} title="Pick one or more SKILL.md files (or a skills folder)">
          Import SKILL.md…
        </button>
        <input ref={importRef} type="file" accept=".md" multiple hidden onChange={(e) => void importSkills(e.target.files)} />
      </div>

      {adding && <AddUtilityDialog group={adding} environments={environments} taken={utilities} onClose={() => setAdding(null)} onAdd={add} />}
    </div>
  );
}

export function utilityLabel(u: Pick<PublicUtilityDef, "name" | "label">): string {
  return u.label.trim() || u.name;
}

export function facetsOf(u: PublicUtilityDef): string[] {
  return [
    ...(u.mcp ? ["mcp"] : []),
    ...(u.web && u.web.url !== "" ? ["web"] : []),
    ...(u.http && u.http.baseUrl !== "" ? ["http"] : []),
    ...(u.ssh && u.ssh.host !== "" ? ["ssh"] : []),
    ...(u.cli ? ["cli"] : []),
  ];
}

function summarizeUtility(u: PublicUtilityDef): string {
  const where = u.web?.url || u.http?.baseUrl || (u.ssh?.host ? `${u.ssh.user ? `${u.ssh.user}@` : ""}${u.ssh.host}` : "") || (u.mcp ? (u.mcp.transport === "stdio" ? `${u.mcp.command} ${u.mcp.args.join(" ")}`.trim() : u.mcp.url) : "");
  const creds = u.credentials.map((c) => c.name).join(", ");
  return [where, creds ? `credentials: ${creds}` : ""].filter((s) => s !== "").join(" · ");
}

function newId(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** A blank Utility of a group in an Environment, from a preset when one is picked. */
export function newUtility(group: UtilityGroup, environment: string, preset: string | null, url: string, name: string): PublicUtilityDef {
  const p = preset ? UTILITY_PRESETS[preset] : undefined;
  const facets = p ? applyUtilityPreset(p, url) : { web: url ? { url, login: "form" as const } : null, http: null, cli: null, mcp: null };
  return {
    id: newId(),
    name,
    label: p?.label ?? "",
    group: p?.group ?? group,
    environment,
    preset,
    credentials: (p?.credentials ?? ["user", "password"]).map((n) => ({ name: n, value: "", secret: n !== "user" })),
    readOnly: true,
    notes: p?.notes ?? "",
    enabledByDefault: true,
    ssh: preset === "ssh" ? { host: url.replace(/^ssh:\/\//, ""), port: 22, user: "", jump: "" } : null,
    ...facets,
  };
}

function AddUtilityDialog({
  group,
  environments,
  taken,
  onClose,
  onAdd,
}: {
  group: UtilityGroup;
  environments: UtilityEnvironment[];
  taken: PublicUtilityDef[];
  onClose: () => void;
  onAdd: (def: PublicUtilityDef) => void;
}) {
  const presets = Object.entries(UTILITY_PRESETS).filter(([, p]) => p.group === group);
  const [preset, setPreset] = useState<string>("");
  const [environment, setEnvironment] = useState(environments.find((e) => !e.production)?.name ?? environments[0]?.name ?? "");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const chosen = preset ? UTILITY_PRESETS[preset] : undefined;
  const finalName = (name || preset || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  const dup = taken.some((u) => u.name === finalName && u.environment === environment);
  return (
    <Modal title={`Add ${group === "observability" ? "an observability" : "an application"} Utility`} onClose={onClose}>
      <label>
        Kind
        <select value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="">Custom (web UI, API, SSH, CLI, MCP — filled in next)</option>
          {presets.map(([key, p]) => (
            <option key={key} value={key}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Environment
        <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
          {environments.map((e) => (
            <option key={e.name} value={e.name}>
              {e.name}
              {e.production ? " (production)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        {chosen?.urlHint ?? "URL (the web UI or API; optional)"}
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoFocus />
      </label>
      <label>
        Name (lowercase; `${"{"}util:&lt;name&gt;.…{"}"}`, `sb-util &lt;name&gt;`)
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={preset || "my-app"} pattern="[a-z0-9][a-z0-9_\-]{0,63}" />
      </label>
      {dup && <p className="warn-sign">“{finalName}” already exists in {environment}.</p>}
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={finalName === "" || environment === "" || dup} onClick={() => onAdd(newUtility(group, environment, preset || null, url, finalName))}>
          Add
        </button>
      </div>
    </Modal>
  );
}

function UtilityForm({
  utility: u,
  environments,
  onChange,
  onDone,
  onDelete,
}: {
  utility: PublicUtilityDef;
  environments: UtilityEnvironment[];
  onChange: (patch: Partial<PublicUtilityDef>) => void;
  onDone: () => void;
  onDelete: () => void;
}) {
  const [argsText, setArgsText] = useState(joinArgs(u.mcp?.args ?? []));
  const mcp = u.mcp;
  return (
    <div className="mcp-form">
      <div className="row">
        <label>
          Name (lowercase; the placeholder and sb-util name)
          <input value={u.name} pattern="[a-z0-9][a-z0-9_\-]{0,63}" onChange={(e) => onChange({ name: e.target.value.toLowerCase() })} />
        </label>
        <label>
          Label (shown)
          <input value={u.label} placeholder={u.name} onChange={(e) => onChange({ label: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <label>
          Group
          <select value={u.group} onChange={(e) => onChange({ group: e.target.value as UtilityGroup })}>
            {UTILITY_GROUPS.map((g) => (
              <option key={g} value={g}>
                {UTILITY_GROUP_LABELS[g]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Environment
          <select value={u.environment} onChange={(e) => onChange({ environment: e.target.value })}>
            {environments.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
                {e.production ? " (production)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={u.readOnly} onChange={(e) => onChange({ readOnly: e.target.checked })} />
        Read-only: the Agent is told to look, not change (MCP presets pass their read-only flag)
      </label>

      <CredentialList items={u.credentials} onChange={(credentials) => onChange({ credentials })} />

      <Facet
        title="Web UI"
        on={u.web !== null}
        onToggle={(on) => onChange({ web: on ? { url: "", login: "form" } : null })}
        hint="Opened in the Sandbox's browser (utilities_open / sb-util open); the Agent signs in by typing the placeholders."
      >
        {u.web && (
          <div className="row">
            <label>
              URL
              <input value={u.web.url} placeholder="https://grafana.example.com" onChange={(e) => onChange({ web: { ...u.web!, url: e.target.value } })} />
            </label>
            <label>
              Login
              <select value={u.web.login} onChange={(e) => onChange({ web: { ...u.web!, login: e.target.value as UtilityWebLogin } })}>
                {UTILITY_WEB_LOGINS.map((l) => (
                  <option key={l} value={l}>
                    {UTILITY_WEB_LOGIN_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </Facet>

      <Facet
        title="HTTP API"
        on={u.http !== null}
        onToggle={(on) => onChange({ http: on ? { baseUrl: "", headers: [] } : null })}
        hint="sb-util curl <name> <path> adds the headers (${cred:token} etc. filled in) and basic auth from user / password."
      >
        {u.http && (
          <>
            <label>
              Base URL
              <input value={u.http.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => onChange({ http: { ...u.http!, baseUrl: e.target.value } })} />
            </label>
            <KeyValueList label="Headers (value may use ${cred:<credential>})" items={u.http.headers} namePlaceholder="Authorization" onChange={(headers) => onChange({ http: { ...u.http!, headers } })} />
          </>
        )}
      </Facet>

      <Facet
        title="SSH host"
        on={u.ssh !== null}
        onToggle={(on) => onChange({ ssh: on ? { host: "", port: 22, user: "", jump: "" } : null })}
        hint="sb-util ssh <name> [cmd] and sb-util tunnel <name> <local>:<host>:<port>, with the ssh_key or password credential."
      >
        {u.ssh && (
          <>
            <div className="row">
              <label>
                Host
                <input value={u.ssh.host} placeholder="db-1.internal" onChange={(e) => onChange({ ssh: { ...u.ssh!, host: e.target.value } })} />
              </label>
              <label>
                Port
                <input type="number" min={1} max={65535} value={u.ssh.port} onChange={(e) => onChange({ ssh: { ...u.ssh!, port: Number(e.target.value) || 22 } })} />
              </label>
            </div>
            <div className="row">
              <label>
                User (blank: the user credential)
                <input value={u.ssh.user} placeholder="ubuntu" onChange={(e) => onChange({ ssh: { ...u.ssh!, user: e.target.value } })} />
              </label>
              <label>
                Jump host (ssh -J)
                <input value={u.ssh.jump} placeholder="user@bastion.example.com:22" onChange={(e) => onChange({ ssh: { ...u.ssh!, jump: e.target.value } })} />
              </label>
            </div>
          </>
        )}
      </Facet>

      <Facet
        title="Command-line client"
        on={u.cli !== null}
        onToggle={(on) => onChange({ cli: on ? { install: "", env: [] } : null })}
        hint="sb-util env <name> -- <command> runs it with these variables (and UTIL_<CREDENTIAL>) set."
      >
        {u.cli && (
          <>
            <label>
              How to install it in the Sandbox (for the Agent)
              <input value={u.cli.install} placeholder="pip install --user rabbitmqadmin" onChange={(e) => onChange({ cli: { ...u.cli!, install: e.target.value } })} />
            </label>
            <KeyValueList label="Environment variables (value may use ${cred:<credential>})" items={u.cli.env} namePlaceholder="MONGODB_URI" onChange={(env) => onChange({ cli: { ...u.cli!, env } })} />
          </>
        )}
      </Facet>

      <Facet
        title="MCP server"
        on={mcp !== null}
        onToggle={(on) => onChange({ mcp: on ? { transport: "stdio", command: "", args: [], env: [], url: "", headers: [] } : null })}
        hint={`Joins the Session's MCP servers as "${u.name}" while the Utility is on; ${"${cred:<credential>}"} in args, env and headers is filled in inside the Sandbox.`}
      >
        {mcp && (
          <>
            <label>
              Transport
              <select value={mcp.transport} onChange={(e) => onChange({ mcp: { ...mcp, transport: e.target.value as (typeof MCP_TRANSPORTS)[number] } })}>
                {MCP_TRANSPORTS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {mcp.transport === "stdio" ? (
              <>
                <label>
                  Command (runs inside the Sandbox)
                  <input value={mcp.command} placeholder="npx" onChange={(e) => onChange({ mcp: { ...mcp, command: e.target.value } })} />
                </label>
                <label>
                  Arguments (shell-style quoting)
                  <input
                    value={argsText}
                    placeholder="-y mongodb-mcp-server --readOnly"
                    onChange={(e) => {
                      setArgsText(e.target.value);
                      onChange({ mcp: { ...mcp, args: splitArgs(e.target.value) } });
                    }}
                  />
                </label>
                <KeyValueList label="Environment variables" items={mcp.env} namePlaceholder="MDB_MCP_CONNECTION_STRING" onChange={(env) => onChange({ mcp: { ...mcp, env } })} />
              </>
            ) : (
              <>
                <label>
                  URL
                  <input value={mcp.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => onChange({ mcp: { ...mcp, url: e.target.value } })} />
                </label>
                <KeyValueList label="Headers" items={mcp.headers} namePlaceholder="Authorization" onChange={(headers) => onChange({ mcp: { ...mcp, headers } })} />
              </>
            )}
          </>
        )}
      </Facet>

      <label>
        Notes for the Agent (how to use it, what to look for, useful queries; no secrets)
        <textarea rows={4} value={u.notes} spellCheck={false} onChange={(e) => onChange({ notes: e.target.value })} />
      </label>
      <div className="mcp-actions">
        <button type="button" onClick={onDone}>
          Done
        </button>
        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

function Facet({ title, on, onToggle, hint, children }: { title: string; on: boolean; onToggle: (on: boolean) => void; hint: string; children?: React.ReactNode }) {
  return (
    <div className={`util-facet${on ? " on" : ""}`}>
      <label className="check" title={hint}>
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        <strong>{title}</strong>
        <span className="muted util-facet-hint">{hint}</span>
      </label>
      {on && <div className="util-facet-body">{children}</div>}
    </div>
  );
}

const CREDENTIAL_NAMES = Object.keys(UTILITY_CREDENTIAL_HINTS);

/** The Utility's credentials: known names get their hint; secrets are write-only. */
function CredentialList({ items, onChange }: { items: PublicMcpKeyValue[]; onChange: (items: PublicMcpKeyValue[]) => void }) {
  const set = (i: number, patch: Partial<PublicMcpKeyValue>) => onChange(items.map((kv, j) => (j === i ? { ...kv, ...patch } : kv)));
  return (
    <div className="kv">
      <span className="muted" title="Stored with the Utility, never shown again here, never in the transcript; the Agent uses them by name">
        Credentials — <code>{"${util:<name>.<credential>}"}</code> for the Agent
      </span>
      {items.map((kv, i) => {
        const stored = kv.secret && kv.value === null;
        const multiline = kv.name === "ssh_key";
        return (
          <div key={i} className="kv-row">
            <input list="util-credential-names" value={kv.name} placeholder="password" title={UTILITY_CREDENTIAL_HINTS[kv.name]} onChange={(e) => set(i, { name: e.target.value })} />
            {multiline && !stored ? (
              <textarea rows={3} value={kv.value ?? ""} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} onChange={(e) => set(i, { value: e.target.value })} />
            ) : (
              <input
                type={kv.secret ? "password" : "text"}
                autoComplete="off"
                value={kv.value ?? ""}
                placeholder={stored ? "(set; leave empty to keep)" : kv.name === "totp" ? "base32 secret from the 2FA setup" : "value"}
                onChange={(e) => set(i, { value: e.target.value === "" && kv.secret && stored ? null : e.target.value })}
              />
            )}
            <label className="check" title="Secret: write-only here, kept out of snapshots and the transcript">
              <input type="checkbox" checked={kv.secret} onChange={(e) => set(i, { secret: e.target.checked, ...(e.target.checked ? {} : { value: kv.value ?? "" }) })} />
              secret
            </label>
            <button type="button" className="small danger" onClick={() => onChange(items.filter((_, j) => j !== i))} title="Remove">
              ×
            </button>
          </div>
        );
      })}
      <datalist id="util-credential-names">
        {CREDENTIAL_NAMES.map((n) => (
          <option key={n} value={n}>
            {UTILITY_CREDENTIAL_HINTS[n]}
          </option>
        ))}
      </datalist>
      <div>
        <button type="button" className="small" onClick={() => onChange([...items, { name: "", value: "", secret: true }])}>
          Add credential
        </button>
      </div>
    </div>
  );
}

function KeyValueList({ label, items, namePlaceholder, onChange }: { label: string; items: PublicMcpKeyValue[]; namePlaceholder: string; onChange: (items: PublicMcpKeyValue[]) => void }) {
  const set = (i: number, patch: Partial<PublicMcpKeyValue>) => onChange(items.map((kv, j) => (j === i ? { ...kv, ...patch } : kv)));
  return (
    <div className="kv">
      <span className="muted">{label}</span>
      {items.map((kv, i) => {
        const stored = kv.secret && kv.value === null;
        return (
          <div key={i} className="kv-row">
            <input value={kv.name} placeholder={namePlaceholder} onChange={(e) => set(i, { name: e.target.value })} />
            <input
              type={kv.secret ? "password" : "text"}
              autoComplete="off"
              value={kv.value ?? ""}
              placeholder={stored ? "(set; leave empty to keep)" : "value or ${cred:token}"}
              onChange={(e) => set(i, { value: e.target.value === "" && kv.secret && stored ? null : e.target.value })}
            />
            <label className="check" title="Secret: write-only here (a ${cred:…} placeholder is not a secret itself)">
              <input type="checkbox" checked={kv.secret} onChange={(e) => set(i, { secret: e.target.checked, ...(e.target.checked ? {} : { value: kv.value ?? "" }) })} />
              secret
            </label>
            <button type="button" className="small danger" onClick={() => onChange(items.filter((_, j) => j !== i))} title="Remove">
              ×
            </button>
          </div>
        );
      })}
      <div>
        <button type="button" className="small" onClick={() => onChange([...items, { name: "", value: "", secret: false }])}>
          Add
        </button>
      </div>
    </div>
  );
}

function ProcedureForm({
  procedure: p,
  utilities,
  environments,
  onChange,
  onDone,
  onDelete,
}: {
  procedure: ProcedureDef;
  utilities: PublicUtilityDef[];
  environments: UtilityEnvironment[];
  onChange: (patch: Partial<ProcedureDef>) => void;
  onDone: () => void;
  onDelete: () => void;
}) {
  const names = [...new Set(utilities.map((u) => u.name))];
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="mcp-form">
      <div className="row">
        <label>
          Name (the skill directory; lowercase, digits, -)
          <input value={p.name} pattern="[a-z0-9][a-z0-9\-]{0,63}" placeholder="investigate-5xx-spike" onChange={(e) => onChange({ name: e.target.value.toLowerCase() })} />
        </label>
      </div>
      <label>
        Description — when to use it (the skill&apos;s frontmatter, what the Agent reads first)
        <input value={p.description} placeholder="Find why an endpoint returns 5xx: deploys, errors, logs, traces." onChange={(e) => onChange({ description: e.target.value })} />
      </label>
      <label>
        Steps (Markdown; name the Utilities, sb-util commands, MCP tools and web pages to use; no credentials)
        <textarea rows={14} value={p.body} spellCheck={false} onChange={(e) => onChange({ body: e.target.value })} />
      </label>
      {names.length > 0 && (
        <div className="kv">
          <span className="muted">Needs these Utilities (none = any Session with Utilities on)</span>
          <div className="util-chips">
            {names.map((n) => (
              <label key={n} className="check">
                <input type="checkbox" checked={p.utilities.includes(n)} onChange={() => onChange({ utilities: toggle(p.utilities, n) })} />
                {n}
              </label>
            ))}
          </div>
        </div>
      )}
      {environments.length > 0 && (
        <div className="kv">
          <span className="muted">Applies to these Environments (none = all)</span>
          <div className="util-chips">
            {environments.map((e) => (
              <label key={e.name} className="check">
                <input type="checkbox" checked={p.environments.includes(e.name)} onChange={() => onChange({ environments: toggle(p.environments, e.name) })} />
                {e.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="mcp-actions">
        <button type="button" onClick={onDone}>
          Done
        </button>
        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
