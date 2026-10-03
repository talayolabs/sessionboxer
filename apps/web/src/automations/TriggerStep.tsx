import { useEffect, useMemo, useState } from "react";
import { PR_EVENT_LABELS, PrEventType, SCHEDULE_MISSED_POLICY_LABELS, SCHEDULE_PREVIEW_COUNT, type AutomationTrigger, type McpEventTrigger, type McpEventsCatalog, type PrEventFilters, type PrPeople, type ScheduleMissedPolicy, type Session } from "@sessionboxer/protocol";
import { api } from "../api";
import type { FollowOption, Step } from "../Automations";
import { FollowRepoInline } from "../FollowRepo";
import { LoginList } from "../LoginList";
import { useSectionState, type SectionSetters, type Setter } from "../useSectionState";
import type { TriggerValues, SchedulePreview } from "./form-model";
import { describeCron, formatAt } from "./display";

const CRON_EXAMPLES: Array<[string, string]> = [
  ["0 9 * * 1-5", "weekdays at 09:00"],
  ["0 */2 * * *", "every 2 hours"],
  ["*/30 * * * *", "every 30 minutes"],
  ["0 8 * * 1", "Mondays at 08:00"],
  ["0 0 1 * *", "1st of the month at midnight"],
  ["@hourly", "once an hour"],
  ["@daily", "once a day at midnight"],
];

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function timeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  return intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : ["UTC"];
}

export function useTriggerState(t: AutomationTrigger | undefined) {
  return useSectionState<TriggerValues>({
    triggerType: t?.type ?? "schedule",
    cron: t?.type === "schedule" ? t.cron : "0 9 * * 1-5",
    timezone: t?.type === "schedule" ? t.timezone : localTimeZone(),
    missedRun: t?.type === "schedule" ? t.missedRun : "skip",
    prFollows: t?.type === "pr_event" ? t.follows : [],
    prEvents: t?.type === "pr_event" ? t.events : ["opened", "synchronize", "ready_for_review"],
    filters: t?.type === "pr_event" ? t.filters : { drafts: "skip", forks: "review_only", authors: "not_self", includeOwn: false },
    mcpServerId: t?.type === "mcp_event" ? t.serverId : "",
    mcpEvent: t?.type === "mcp_event" ? t.event : "",
    mcpArguments: t?.type === "mcp_event" && Object.keys(t.arguments).length > 0 ? JSON.stringify(t.arguments, null, 2) : "",
    mcpDelivery: t?.type === "mcp_event" ? t.delivery : "auto",
  });
}

export function TriggerStep({
  triggerType, cron, timezone, missedRun, prFollows, prEvents, filters, mcpServerId, mcpEvent, mcpArguments, mcpDelivery,
  setTriggerType, setCron, setTimezone, setMissedRun, setPrFollows, setPrEvents, setFilters, setMcpServerId, setMcpEvent, setMcpArguments, setMcpDelivery,
  forSession, follows, busy, preview, showAction, triggerError, setStep,
}: TriggerValues & SectionSetters<TriggerValues> & {
  forSession?: Session;
  follows: FollowOption[];
  busy: boolean;
  preview: SchedulePreview;
  showAction: boolean;
  triggerError: string | null;
  setStep: Setter<Step>;
}) {
  const words = useMemo(() => describeCron(cron), [cron]);
  const zones = useMemo(timeZones, []);
  const isPr = triggerType === "pr_event";
  const [people, setPeople] = useState<PrPeople | null>(null);
  useEffect(() => {
    if (!isPr) return;
    void api.prPeople().then(setPeople, () => undefined);
  }, [isPr]);


  return (
    <section className="automation-step">
      <h3>
        <span className="automation-step-n">1</span> When
      </h3>
      {!forSession && (
        <fieldset className="choice">
          <legend>Trigger</legend>
          <label className="check">
            <input type="radio" name="trigger" checked={triggerType === "schedule"} onChange={() => setTriggerType("schedule")} />
            On a schedule
          </label>
          <label className="check">
            <input type="radio" name="trigger" checked={triggerType === "pr_event"} onChange={() => setTriggerType("pr_event")} />
            When a followed pull request changes
          </label>
          <label className="check">
            <input type="radio" name="trigger" checked={triggerType === "mcp_event"} onChange={() => setTriggerType("mcp_event")} />
            When an MCP server reports an event
          </label>
          <label className="check">
            <input type="radio" name="trigger" checked={triggerType === "manual"} onChange={() => setTriggerType("manual")} />
            Only when I press Run now
          </label>
        </fieldset>
      )}
      {triggerType === "schedule" && (
        <>
          <div className="row">
            <label>
              Cron expression
              <input value={cron} onChange={(e) => setCron(e.target.value)} list="cron-examples" spellCheck={false} />
              <datalist id="cron-examples">
                {CRON_EXAMPLES.map(([expr, label]) => (
                  <option key={expr} value={expr}>
                    {label}
                  </option>
                ))}
              </datalist>
            </label>
            <label>
              Time zone
              <input value={timezone} onChange={(e) => setTimezone(e.target.value)} list="time-zones" spellCheck={false} />
              <datalist id="time-zones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </label>
          </div>
          <div className="schedule-preview">
            {preview && !preview.ok ? (
              <p className="field-hint warn">{preview.error}</p>
            ) : (
              <>
                {words && <p className="field-hint">{words}</p>}
                {preview?.ok && (
                  <p className="field-hint">
                    Next {SCHEDULE_PREVIEW_COUNT}:{" "}
                    {preview.next.map((iso, i) => (
                      <span key={iso}>
                        {i > 0 && ", "}
                        <span title={`${formatAt(iso, timezone)} in ${timezone}`}>{formatAt(iso)}</span>
                      </span>
                    ))}
                    {preview.next.length === 0 && "never (the expression matches no future time)"}
                    {preview.next.length > 0 && timezone.trim() !== localTimeZone() && ` (your time, ${localTimeZone()})`}
                  </p>
                )}
              </>
            )}
          </div>
          <label>
            Runs missed while the Control Plane was off
            <select value={missedRun} onChange={(e) => setMissedRun(e.target.value as ScheduleMissedPolicy)}>
              {(Object.keys(SCHEDULE_MISSED_POLICY_LABELS) as ScheduleMissedPolicy[]).map((p) => (
                <option key={p} value={p}>
                  {SCHEDULE_MISSED_POLICY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {triggerType === "pr_event" && (
        <>
          <fieldset className="choice">
            <legend>Pull requests</legend>
            <label className="check">
              <input type="checkbox" checked={prFollows.length === 0} onChange={(e) => e.target.checked && setPrFollows([])} />
              Every followed pull request
            </label>
            {follows.map((f) => (
              <label key={f.id} className="check">
                <input
                  type="checkbox"
                  checked={prFollows.includes(f.id)}
                  onChange={(e) => setPrFollows((cur) => (e.target.checked ? [...cur, f.id] : cur.filter((x) => x !== f.id)))}
                />
                {f.label}
              </label>
            ))}
            <FollowRepoInline disabled={busy} onFollowed={(f) => setPrFollows((cur) => (cur.includes(f.id) ? cur : [...cur, f.id]))} />
            <p className="field-hint">
              {follows.length === 0
                ? "Nothing is followed yet: name a repository to follow every open PR of it. My PRs and Reviews asked of me are followed from the Pull requests page."
                : "Follow another repository here, or My PRs and Reviews asked of me from the Pull requests page."}
            </p>
          </fieldset>
          <fieldset className="choice">
            <legend>Events</legend>
            <div className="automation-events">
              {PrEventType.options.map((ev) => (
                <label key={ev} className="check">
                  <input type="checkbox" checked={prEvents.includes(ev)} onChange={(e) => setPrEvents((cur) => (e.target.checked ? [...cur, ev] : cur.filter((x) => x !== ev)))} />
                  {PR_EVENT_LABELS[ev]}
                </label>
              ))}
            </div>
          </fieldset>
          <details className="automation-filters">
            <summary>Filters</summary>
            <div className="row">
              <label>
                Draft PRs
                <select value={filters.drafts} onChange={(e) => setFilters({ ...filters, drafts: e.target.value as PrEventFilters["drafts"] })}>
                  <option value="skip">Skip until ready for review</option>
                  <option value="include">Include</option>
                </select>
              </label>
              <label>
                PRs from forks
                <select value={filters.forks} onChange={(e) => setFilters({ ...filters, forks: e.target.value as PrEventFilters["forks"] })}>
                  <option value="skip">Skip</option>
                  <option value="review_only">Review only (no QA, no new Session on their code)</option>
                  <option value="allow">Allow everything</option>
                </select>
              </label>
            </div>
            <div className="row">
              <label>
                Authors
                <select value={filters.authors} onChange={(e) => setFilters({ ...filters, authors: e.target.value as PrEventFilters["authors"] })}>
                  <option value="any">Anyone</option>
                  <option value="not_self">Not my own PRs</option>
                  <option value="self_only">Only my own PRs</option>
                </select>
              </label>
              <label>
                Base branch (glob, optional)
                <input value={filters.baseRef ?? ""} onChange={(e) => setFilters({ ...filters, baseRef: e.target.value })} placeholder="main, release/*" spellCheck={false} />
              </label>
            </div>
            <div className="row">
              <label>
                Only PRs by these authors (optional)
                <LoginList
                  value={filters.authorLogins ?? []}
                  onChange={(authorLogins) => setFilters({ ...filters, authorLogins })}
                  suggestions={people?.authors ?? []}
                  placeholder="login — Enter adds"
                />
              </label>
              <label>
                Only PRs where one of these is asked to review (optional)
                <LoginList
                  value={filters.reviewers ?? []}
                  onChange={(reviewers) => setFilters({ ...filters, reviewers })}
                  suggestions={people?.reviewers ?? []}
                  placeholder="login, or a team as org/slug"
                />
              </label>
            </div>
            <div className="row">
              <label>
                Title must match (regular expression, optional)
                <input value={filters.titleMatch ?? ""} onChange={(e) => setFilters({ ...filters, titleMatch: e.target.value })} placeholder="^(?!WIP)" spellCheck={false} />
              </label>
              <label>
                Any of these labels (comma-separated, optional)
                <input
                  value={(filters.labels ?? []).join(", ")}
                  onChange={(e) =>
                    setFilters({
                      ...filters,
                      labels: e.target.value
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="needs-review"
                />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={filters.includeOwn} onChange={(e) => setFilters({ ...filters, includeOwn: e.target.checked })} />
              Also react to what my own account did (my review, my push)
            </label>
          </details>
        </>
      )}
      {triggerType === "mcp_event" && (
        <McpEventFields serverId={mcpServerId} event={mcpEvent} args={mcpArguments} delivery={mcpDelivery} setServerId={setMcpServerId} setEvent={setMcpEvent} setArgs={setMcpArguments} setDelivery={setMcpDelivery} />
      )}
      {triggerType === "manual" && <p className="field-hint">Nothing starts it but the Run now button (or an agent's `automation_run`); useful to keep a template at hand.</p>}
      {!showAction && (
        <div className="actions">
          <button type="button" className="primary" disabled={triggerError !== null} onClick={() => setStep("action")}>
            Next: what to do
          </button>
        </div>
      )}
    </section>
  );
}

const DELIVERY_LABELS: Record<McpEventTrigger["delivery"], string> = {
  auto: "Push when the server offers it, poll otherwise",
  push: "Push only (events/stream)",
  poll: "Poll only (events/poll)",
};

/** Property names of a JSON Schema object, for hints; nothing when the schema is not of that shape. */
function schemaKeys(schema: Record<string, unknown> | undefined): string[] {
  const props = schema?.properties;
  return props && typeof props === "object" ? Object.keys(props as object) : [];
}

/** The MCP event trigger (ADR-0081): the registry's servers asked for their event types on the spot. */
function McpEventFields({
  serverId, event, args, delivery, setServerId, setEvent, setArgs, setDelivery,
}: {
  serverId: string;
  event: string;
  args: string;
  delivery: McpEventTrigger["delivery"];
  setServerId: Setter<string>;
  setEvent: Setter<string>;
  setArgs: Setter<string>;
  setDelivery: Setter<McpEventTrigger["delivery"]>;
}) {
  const [catalog, setCatalog] = useState<McpEventsCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = (refresh: boolean) => {
    setLoading(true);
    setError(null);
    api.mcpEventsCatalog(refresh).then(setCatalog, (e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false));
  };
  useEffect(() => load(false), []);
  const server = catalog?.servers.find((s) => s.serverId === serverId) ?? null;
  const type = server?.events.find((e) => e.name === event) ?? null;
  const inputKeys = schemaKeys(type?.inputSchema);
  const payloadKeys = schemaKeys(type?.payloadSchema);
  return (
    <>
      <div className="row">
        <label>
          MCP server
          <select value={serverId} onChange={(e) => { setServerId(e.target.value); setEvent(""); }}>
            <option value="">{loading && !catalog ? "Asking the servers…" : "Pick a server"}</option>
            {catalog?.servers.map((s) => (
              <option key={s.serverId} value={s.serverId}>
                {s.server}
                {s.state === "none" ? " (no events)" : s.state === "error" ? " (unreachable)" : ` (${s.events.length} event type${s.events.length === 1 ? "" : "s"})`}
              </option>
            ))}
            {serverId && catalog && !server && <option value={serverId}>{serverId} (not in the registry)</option>}
          </select>
        </label>
        <label>
          Event
          <select value={event} onChange={(e) => setEvent(e.target.value)} disabled={!server || server.events.length === 0}>
            <option value="">{server?.events.length ? "Pick an event" : "—"}</option>
            {server?.events.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
            {event && server && !type && <option value={event}>{event} (no longer offered)</option>}
          </select>
        </label>
      </div>
      {error && <p className="field-hint warn">{error}</p>}
      {server?.state === "error" && <p className="field-hint warn">Could not ask {server.server}: {server.error}</p>}
      {server?.state === "none" && <p className="field-hint warn">{server.server} is a plain MCP server: it answers no `events/list`.</p>}
      {catalog && catalog.servers.length === 0 && <p className="field-hint">No MCP servers in the registry yet: add one under Global settings → MCP &amp; connectors.</p>}
      {type && (
        <p className="field-hint">
          {type.description && <>{type.description} · </>}
          Delivery: {type.delivery.join(", ") || "none"}.
          {payloadKeys.length > 0 && (
            <>
              {" "}
              Payload fields for the prompt: {payloadKeys.map((k, i) => (
                <span key={k}>
                  {i > 0 && ", "}
                  <code>{`{event.data.${k}}`}</code>
                </span>
              ))}
              .
            </>
          )}
        </p>
      )}
      <div className="row">
        <label>
          Arguments (JSON{inputKeys.length > 0 ? `: ${inputKeys.join(", ")}` : ""})
          <textarea rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={inputKeys.length > 0 ? `{"${inputKeys[0]}": "…"}` : "{}"} spellCheck={false} />
        </label>
        <label>
          Delivery
          <select value={delivery} onChange={(e) => setDelivery(e.target.value as McpEventTrigger["delivery"])}>
            {(Object.keys(DELIVERY_LABELS) as Array<McpEventTrigger["delivery"]>).map((d) => (
              <option key={d} value={d}>
                {DELIVERY_LABELS[d]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="field-hint">
        The Control Plane keeps its own connection to the server (push: a long-lived `events/stream`; poll: `events/poll` at the server's pace), so events arrive with no Session running. Each event runs the action once; the payload reaches the prompt as data.{" "}
        <button type="button" className="link" onClick={() => load(true)} disabled={loading}>
          {loading ? "Asking…" : "Ask the servers again"}
        </button>
      </p>
    </>
  );
}
