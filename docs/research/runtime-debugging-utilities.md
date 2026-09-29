# Research: runtime debugging utilities (observability, applications, environments, procedures)

Goal: give a Session a curated set of **runtime debugging utilities** — New Relic, Argo CD, Graylog, Grafana, the RabbitMQ
admin UI, an internal debugging web UI, MongoDB (Compass) — plus access to **debug/QA environments** of the product, so
the Agent can investigate an incident, verify that something works, or reproduce a bug. The user manages all of it in
one place in the Sessionboxer UI (grouped as *observability* / *applications*, split by environment), toggles utilities as a
unit or one by one, keeps the credentials with the utility definition, can add a utility by saying
*"add a debugger tool newrelic with user bocato pass asdqwe at url http://newrelic.itspy.com/"*, and writes reusable
**procedures** ("how we debug X with these utilities") the Agent picks up as skills.

Studied against the code on `main` (`4149dd7`) on 2026-09-29: the MCP registry (ADR-0010, `docs/research/mcp-servers.md`),
the `sessionboxer` MCP (ADR-0062), the tmpfs credential paths (`gh-credentials.ts`, `bb-credentials.ts`, `mcp-config.ts`),
the skills shipped in the image (`images/sandbox/skills/e2e-verification`), and the upstream MCP servers of the utilities the
owner named. No hands-on probes were needed: every mechanism below already exists for MCP servers and connectors; this
is about composing them.

## Summary of the recommendation

1. **One new noun, `Utility`, layered on top of the MCP registry — not a replacement for it.** ("Utility" rather than
   "tool": the word *tool* is taken by MCP/LLM tools.) A Utility is a *named service the
   Agent may use during debugging*: `newrelic (prod)`, `grafana (staging)`, `rabbitmq admin (qa)`. It carries a **group**
   (`observability` | `applications`), an **environment** (`prod`, `staging`, `qa`, … user-defined), zero or more **access
   facets** (an MCP server, a web UI, an HTTP API, SSH, a CLI), its **credentials** (secret key/values, one optional TOTP
   seed), a **read-only** switch and free-text **notes** ("VPN needed", "click the Okta tile", "the dashboard that matters
   is *Checkout latency*"). The MCP facet *is* an `McpServerDef` (same Zod, same transports, same `localhost` rewrite),
   so everything the registry already does — per-Session enablement, deferred restart during a turn, tmpfs config for
   Devin, guest bridging for Windows/macOS — applies unchanged.
2. **Native MCP servers per utility, not a gateway.** The mcp-servers research chose "restart the agent with the new server
   set" over a proxy, and nothing here changes that: Grafana, Argo CD, MongoDB, RabbitMQ, New Relic and the owner's
   Graylog server all ship as MCP servers with their own tool names, read-only flags and (for New Relic) OAuth. A gateway
   would have to re-export every tool, resource and prompt and would break `--readOnly`-style guarantees the upstreams
   give for free. The "single entrypoint" the owner asked for is delivered elsewhere: **(a)** one UI page, **(b)** one
   switch per group/environment/utility, **(c)** one manifest and a `utilities_*` family in the `sessionboxer` MCP that tell the
   Agent what is on, and **(d)** one CLI in the box, `sb-util`, that hands credentials to shell/browser steps without the
   model ever seeing them.
3. **Enable/disable at three grains, applied like MCP toggles today.** Global defaults per Utility (`enabledByDefault`),
   per-Session selection in *New Session → Advanced* and *Session settings → Utilities* (group ▸ environment ▸ utility, with
   all/none at each level), flipped live. Flipping calls the existing `mcp/set` path (agent restart when idle, deferred
   otherwise) for the MCP facets and applies credentials immediately for the other facets — exactly the two-speed
   behaviour `DaemonMcpSetParams` documents.
4. **Credentials stay with the utility, never reach the model.** Stored in `config.json` next to `mcpServers` with the same
   write-only round trip (`null` keeps, `""` forgets); in the box they live on the tmpfs (`/dev/shm/sessionboxer/utilities/`)
   so `docker commit` never captures them. The Agent uses them through **placeholders**: `${util:newrelic.password}` in a
   `desktop.type` call or an `sb-util env newrelic -- curl …` shell command is substituted inside the computer-use MCP /
   the CLI, so transcripts, prompts and LLM requests contain the placeholder, not the value. `${util:newrelic.otp}`
   yields a fresh TOTP code the same way — that is how "user/pass + 2FA + a specific procedure" becomes generic.
5. **The Agent knows its utilities from three places.** A `.sessionboxer/utilities.json` manifest in the Workspace (what is on,
   in which environment, how to reach it, read-only or not, the notes — no secrets), a paragraph in the briefing pointing
   at it, and `sessionboxer.utilities_list / utilities_get / utilities_open` for the live view. Chat markers ("Utilities now: newrelic
   (prod), grafana (staging)") mirror the existing "MCP servers now: …" marker.
6. **Chat-driven setup through the approval card that already exists.** `sessionboxer.utilities_add` proposes a Utility; the
   Control Plane shows a card with the parsed fields (password masked, editable) and the user confirms — the same
   `agent_approval` flow as Session creation. Presets (New Relic, Grafana, Argo CD, RabbitMQ, MongoDB, generic web UI,
   generic SSH host) fill in the MCP command, env names and read-only flag from the URL/credentials the user gave.
7. **Procedures are skills the user (or the Agent) writes in Sessionboxer.** A `Procedure` is a `SKILL.md` (name,
   description, body, the utilities/environments it uses) stored in settings; the Daemon materialises those whose utilities are
   enabled into `~/.claude/skills/<name>/` (already symlinked as `~/.agents/skills`, which Claude Code, Codex, Cursor and
   Devin all read). `sessionboxer.procedure_save` lets the Agent turn a successful investigation into a procedure, behind
   the same approval card.

Cost: ~4 sessions in four increments (§9); the first one (registry + UI + per-Session switches, MCP facet only) already
covers Grafana, Argo CD, MongoDB, RabbitMQ and the owner's Graylog MCP.

## 1. Where we start

| Need | Already in Sessionboxer | Where |
|---|---|---|
| Register a service with secrets, enable it per Session, flip it live | `Settings.mcpServers: McpServerDef[]`, `SessionSettings.mcpEnabled`, `mcp/set` (restart when idle, deferred during a turn, `mcp_changed` marker) | `packages/protocol/src/index.ts`, `sandbox-daemon/src/agent.ts`, `mcp-config.ts` |
| Hide secrets from the UI after save | `PublicMcpKeyValue.value: null` = keep, `""` = forget | `PublicSettings`, `UpdateSettingsRequest.mcpServers` |
| Keep secrets out of snapshots | tmpfs `/dev/shm/sessionboxer` behind symlinks; Devin's `mcp_config.json`, `gh`/Bitbucket credentials live there | `sandbox-daemon/src/index.ts:155`, `gh-credentials.ts`, `bb-credentials.ts` |
| Reach services on the user's machine / LAN / VPN | `host.docker.internal` alias (`ExtraHosts: host-gateway`), `localhost` rewrite in MCP URLs, host CA bundle copied in (ADR-0015), configurable inner Docker address pool (ADR-0045) | `control-plane/src/docker.ts`, `ca-env.ts` |
| Drive a web UI or a GUI (Compass, Firefox) | `desktop` MCP (screenshot/click/type/recording), Firefox ESR, XFCE | `packages/computer-use-mcp`, `images/sandbox/Dockerfile` |
| Run CLIs the utilities need | `node/npx`, `python3`, `uv/uvx`, `ssh`+`sshpass`, `jq`, `curl`, Docker CLI | Dockerfile |
| Tell the Agent about its Session | briefing (`sandbox-briefing.md`), `.sessionboxer/session.json`, `sessionboxer.whoami/docs/settings_get` | `session-info.ts`, `docs.ts`, `sessionboxer-mcp` |
| Let the Agent act on Sessionboxer behind an approval | `agent_approval` cards (`approveCreate`), `agentTools` policy off/session/all | `control-plane/src/agent-tools.ts`, ADR-0062 |
| Ship skills the Agent follows | `images/sandbox/skills/e2e-verification/SKILL.md` → `~/.claude/skills`, symlink `~/.agents/skills`; `e2e.ts` injects a hidden prompt that names the skill | Dockerfile, `control-plane/src/e2e.ts` |
| Group settings with a section rail | `SessionSettingsSection = environment \| agent \| mcp \| qa \| debug` | `apps/web/src/SessionSettingsForm.tsx`, `AdvancedSettingsDialog.tsx` |
| Windows/macOS guests | stdio MCPs bridged from the Linux side, credential files pushed into the guest | `sandbox-daemon/src/guest.ts` |

What is missing is only the **grouping noun** (Utility, with group + environment), the **non-MCP facets** (web UI, HTTP,
SSH, CLI) with their credentials, the **placeholder substitution**, the **manifest**, the **`utilities_*` MCP tools**, the
**presets**, and **procedures as user-editable skills**.

## 2. What a "utility" is — the model

The owner's list is deliberately heterogeneous: New Relic (SaaS with a remote MCP and a web UI), Argo CD (API token +
MCP + web UI), Graylog (his own MCP), Grafana (MCP + web UI), the RabbitMQ admin UI (web UI, an HTTP management API, an
MCP exists), an internal debugging web UI (browser only, probably behind SSO), MongoDB Compass (a GUI; the MCP server is
the useful Agent-side facet). A debug/QA environment is the same shape again: a URL, a login, maybe an SSH host or a
`kubectl` context. One utility therefore needs several **facets**, all optional, all sharing the utility's credentials:

```ts
export const UTILITY_GROUPS = ["observability", "applications"] as const;   // extensible later
export const UtilityGroup = z.enum(UTILITY_GROUPS);

/** A named service the Agent may use while debugging. Lives in `Settings.utilities`; one row in Settings → Utilities. */
export const UtilityDef = z.object({
  id: z.string().min(1),
  name: z.string().regex(MCP_NAME_PATTERN),          // `newrelic`, `grafana`, `rabbitmq-admin`; unique per environment
  label: z.string().max(200).default(""),            // "New Relic", shown in the UI
  group: UtilityGroup,
  /** Which system this instance belongs to: "prod", "staging", "qa-2"… A name from `Settings.utilityEnvironments`. */
  environment: z.string().min(1).max(64),
  preset: z.string().nullable().default(null),       // "newrelic" | "grafana" | "argocd" | "rabbitmq" | "mongodb" | "web" | "ssh" | null
  /** All secret values of this utility, referenced by name from the facets (`${util:<name>.<key>}`). */
  credentials: z.array(McpKeyValue).default([]),      // { name: "user", value, secret: false }, { name: "password", value, secret: true }
  /** Base32 TOTP seed; `${util:<name>.otp}` yields the current code. */
  totp: z.object({ secret: z.string(), digits: z.number().int().default(6), period: z.number().int().default(30) }).nullable().default(null),
  /** Refuse mutating operations where the facet knows how (`--readOnly`, `--disable-write`, no `--allow-mutative-tools`). */
  readOnly: z.boolean().default(true),
  /** Free text the Agent reads in the manifest: how to log in, what to look at, caveats. */
  notes: z.string().max(20_000).default(""),
  enabledByDefault: z.boolean().default(true),
  mcp: McpServerDef.omit({ id: true, name: true, enabledByDefault: true, connector: true }).nullable().default(null),
  web: z.object({ url: z.string(), login: z.enum(["none", "basic", "form", "sso"]).default("form") }).nullable().default(null),
  http: z.object({ baseUrl: z.string(), headers: z.array(McpKeyValue).default([]) }).nullable().default(null),
  ssh: z.object({ host: z.string(), port: z.number().int().default(22), user: z.string(), jump: z.string().default(""), key: z.string().default("") }).nullable().default(null),
  cli: z.object({ install: z.string().default(""), env: z.array(McpKeyValue).default([]) }).nullable().default(null),
});
```

Notes on the choices:

- **`environment` is the owner's word, and it collides with Sessionboxer's "Environment" (Docker/Windows/macOS).** In the
  Utilities page the column is still labelled *Environment* because that is what an on-call engineer says ("the staging
  Grafana"); in code the field is `environment` on `UtilityDef` and the list is `Settings.utilityEnvironments`, and the New
  Session form keeps its runtime selector as "Runtime"… or not — see open question §10.1. Environments are plain strings
  the user creates once (`prod`, `staging`, `qa`); a Utility belongs to exactly one. The *same* Grafana in two environments
  is two Utilities sharing a preset, which is what makes "enable only the staging utilities for this Session" a one-click thing.
- **`credentials` reuses `McpKeyValue`** (`name/value/secret`), so the write-only round trip, the `null` = keep
  semantics and the `PublicSettings` stripping are the existing code paths. Facets refer to credentials by placeholder:
  the New Relic preset writes `headers: [{ name: "api-key", value: "${util:newrelic.apiKey}" }]`, the Grafana preset
  `env: [{ name: "GRAFANA_SERVICE_ACCOUNT_TOKEN", value: "${util:grafana.token}" }]`. The Daemon resolves placeholders
  when it writes MCP config, so `McpServerSpec` sent to the box is unchanged in shape.
- **`readOnly` defaults to true**, and presets translate it: MongoDB `--readOnly` / `MDB_MCP_READ_ONLY=true`, Grafana
  `--disable-write`, RabbitMQ (amazon-mq server) *omit* `--allow-mutative-tools`, Argo CD has no flag (its server exposes
  `sync_application`, `delete_application`, `run_resource_action`) so the UI shows "this preset cannot enforce read-only;
  use a read-only Argo CD token" — the honest answer, and the reason a gateway is tempting (§3). Production environments
  could additionally refuse `readOnly: false` unless the user confirms (§7).
- **`web` is a launch target, not an integration.** The Agent opens `url` in Firefox through the desktop MCP and logs in
  with placeholders; `login` only tells the manifest which procedure applies (`basic` → the CLI can pre-build the
  `user:pass@` URL; `form` → type `${util:x.user}` / `${util:x.password}` / `${util:x.otp}`; `sso` → follow `notes`).
  MongoDB Compass would be a `web`-like `gui` facet if the image ever ships it; for now MongoDB is served by its MCP and
  `mongosh`, and the research recommends *not* adding Compass to the image (300 MB Electron app; the MCP covers what the
  Agent needs). The owner's internal debugging UI is `web` + `notes` and nothing else — exactly the "I don't know what
  it needs, maybe a jump server" case: an `ssh` facet with `jump` gives `ssh -J`, and the CLI can open a local port
  forward on request (`sb-util tunnel internal-ui 8443:internal:443`).
- **`cli`** covers `argocd`, `mongosh`, `kubectl` with a context, `rabbitmqadmin`: `install` is a one-liner the Daemon runs
  once per box (cached), `env` are variables exported by `sb-util env <utility> -- <cmd>`.

### Presets (what "add a debugger tool newrelic …" expands to)

| Preset | MCP facet | Credentials | Read-only lever | Web facet | Source |
|---|---|---|---|---|---|
| `newrelic` | `http` → `https://mcp.newrelic.com/mcp/` (EU: `mcp.eu.newrelic.com`), header `api-key: ${util:x.apiKey}`; OAuth also offered upstream but not usable over ACP (no `/mcp` panel), so the preset asks for a User API key | `apiKey`, optionally `user`/`password` for the web UI | New Relic RBAC on the key | `https://one.newrelic.com` or the user's URL | [docs.newrelic.com MCP setup](https://docs.newrelic.com/docs/agentic-ai/mcp/setup/), [newrelic/mcp-server](https://github.com/newrelic/mcp-server) |
| `grafana` | `stdio` → `uvx mcp-grafana --disable-write`, env `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN` (or `GRAFANA_USERNAME/PASSWORD`) | `token` or `user`+`password` | `--disable-write` (`--enable-query` keeps raw SQL when the SA is read-only) | the same URL | [grafana/mcp-grafana](https://github.com/grafana/mcp-grafana), [flags](https://grafana.com/docs/grafana/latest/developer-resources/mcp/configure/command-line-flags/) |
| `argocd` | `stdio` → `npx argocd-mcp@latest stdio`, env `ARGOCD_BASE_URL`, `ARGOCD_API_TOKEN`; `NODE_TLS_REJECT_UNAUTHORIZED=0` only if the user ticks "self-signed" (ADR-0015 CA copy is the better fix) | `token` | none in the server → "use a read-only token" hint | the same URL | [argoproj-labs/mcp-for-argocd](https://github.com/argoproj-labs/mcp-for-argocd) |
| `rabbitmq` | `stdio` → `uvx amq-mcp-server-rabbitmq --rabbitmq-host … --username … --password … --use-tls` (mutations need `--allow-mutative-tools`) | `user`, `password` | omit `--allow-mutative-tools` | management UI URL (`form` login) | [amazon-mq/mcp-server-rabbitmq](https://github.com/amazon-mq/mcp-server-rabbitmq) |
| `mongodb` | `stdio` → `npx -y mongodb-mcp-server@latest --readOnly`, env `MDB_MCP_CONNECTION_STRING` (or Atlas client id/secret) | `connectionString` | `--readOnly` | — (Compass stays on the user's machine) | [mongodb-js/mongodb-mcp-server](https://github.com/mongodb-js/mongodb-mcp-server), [docs](https://www.mongodb.com/docs/mcp-server/overview/) |
| `graylog` | the owner's own server, via the existing *Import JSON* (any stdio/http/sse definition) | whatever it needs | — | Graylog URL | — |
| `web` | — | `user`, `password`, optional TOTP | n/a | required | — |
| `ssh` | — | `password` or `key`, `jump` | n/a | — | — |
| `custom` | any `McpServerDef` | any | — | any | — |

Presets are data (a JSON file in `apps/web/src` mirrored in the Control Plane for `utilities_add`), not code; adding one is a
row. Pinning package versions (`mcp-grafana==x`, `argocd-mcp@x`) rather than `@latest` is the same supply-chain call
the MCP page already leaves to the user; presets should default to a pinned version bumped on release.

## 3. Per-utility MCP servers vs one gateway vs skills

| | A. Native MCP server per utility (+ manifest + `sb-util`) | B. One Daemon-hosted gateway MCP (`debug`) | C. Skills only |
|---|---|---|---|
| Agent sees | `mcp__grafana__query_prometheus`, `mcp__argocd__get_application` — the upstream names and schemas | `mcp__debug__grafana_query_prometheus`… re-exported, or `call(utility, name, args)` meta-tools | a `SKILL.md` per utility telling it to `curl`/browse |
| Toggle a utility live | restart with the new set (idle) / deferred (busy) — as today | `notifications/tools/list_changed`, no restart (verified in the mcp-servers research) | rewrite the skills dir; Claude Code reads skills at start → restart anyway |
| Read-only guarantee | upstream flags (`--readOnly`, `--disable-write`), token scopes | could filter mutating tools by name for servers without a flag (Argo CD) | none |
| OAuth remote servers (New Relic) | needs an API key over ACP (no interactive `/mcp` login); a Control-Plane-side OAuth like the GitHub connector is a later add | the gateway could hold the OAuth token — same later add | n/a |
| Resources/prompts of upstream servers | pass through | must be proxied too | n/a |
| Devin | works (config file per process) | works | works |
| Windows/macOS guests | stdio bridged already | one more bridged server | skills pushed into the guest |
| Complexity | ~0 new transport code | a proxy that mirrors tools, resources, prompts, progress, errors, OAuth for N servers | cheap, but the Agent guesses APIs |

**Recommendation: A**, with B kept as a later, opt-in "policy proxy" if the Argo-CD-style "no read-only flag" gap bites
in practice. C is not an integration strategy but it *is* the right vehicle for procedures (§8) and for the utilities that
have no MCP at all (the internal web UI, SSH hosts): their "skill" is the manifest entry plus notes, which is cheaper
than a `SKILL.md` per utility and does not fragment discovery.

The owner's "one entrypoint" reads, in this light, as *one place to turn a unit on and off* rather than *one MCP server*.
Unit = a group (`observability`), an environment (`staging`), or "all debugging utilities"; each is a checkbox over the
Utility ids, and the Session's `utilitiesEnabled: string[]` is the only state — the same shape as `mcpEnabled`.

## 4. How the Agent knows what it has

Three layers, cheapest first (the pattern ADR-0062 set for the Session's own identity):

1. **`.sessionboxer/utilities.json` in the Workspace**, rewritten by the Daemon on every change (like `session.json`). No
   secrets; one entry per *enabled* Utility:

   ```json
   {
     "environments": ["prod", "staging"],
     "utilities": [
       { "name": "grafana", "label": "Grafana", "group": "observability", "environment": "staging", "readOnly": true,
         "mcp": "grafana", "web": { "url": "https://grafana.staging.itspy.com", "login": "form" },
         "credentials": ["user", "password"], "otp": false,
         "notes": "Dashboards folder 'Checkout'. Loki datasource is 'loki-staging'." },
       { "name": "internal-debug", "label": "Internal debugging UI", "group": "applications", "environment": "staging",
         "web": { "url": "https://debug.staging.itspy.com", "login": "sso" }, "ssh": { "host": "bastion.itspy.com", "jump": "" },
         "credentials": ["user", "password"], "otp": true,
         "notes": "Okta SSO: click 'Sign in with Okta', use ${util:internal-debug.user}/${util:internal-debug.password}, then the OTP." }
     ],
     "procedures": ["checkout-latency-triage", "stuck-rabbitmq-consumer"]
   }
   ```

   Disabled utilities are listed by name only under `"available": [...]` so the Agent can *ask* for one ("enable the prod
   New Relic utility?" → the user flips it in the chip, or `utilities_enable` behind an approval).
2. **A briefing paragraph** ("Runtime debugging utilities: read `.sessionboxer/utilities.json`; use each utility's MCP tools by
   name; for web UIs open the URL in Firefox and log in with `${util:<name>.<credential>}` placeholders in `desktop.type`
   — they are substituted, you never see the value; for shell steps prefix with `sb-util env <name> --`; prefer read-only
   actions; procedures under `~/.agents/skills` describe known investigations").
3. **`sessionboxer` MCP tools**: `utilities_list` (the manifest, live), `utilities_get name` (notes + facets), `utilities_open name`
   (the Control Plane opens the web facet in the Sandbox's Firefox and focuses it — a `ui_open` sibling — so the Agent
   does not fumble the URL), `utilities_add` / `utilities_update` / `utilities_enable` (approval cards, §6), `procedure_save` (§8).
   Governed by the existing `agentTools` policy: `off` hides them, `session` allows read + enable within this Session,
   `all` allows adding utilities to the registry.

The chat shows the same information as **markers**: "Utilities now: grafana (staging), rabbitmq-admin (staging)" whenever the
set changes (same emitter as `mcp_changed`), and the Session header gets a **Utilities 2/7** chip next to the MCP chip with a
popover to flip switches.

## 5. Credentials: with the utility in the UI, never in the model

- **Storage**: `Settings.utilities[].credentials` in `config.json` (0600, next to `mcpServers` and `providerSecrets`).
  `PublicUtilityDef` nulls secret values; the update request keeps `null`, forgets `""` — identical to MCP entries. The TOTP
  seed is a secret too (shown as "configured", never echoed; a "test code" button shows one code to compare with the phone).
- **Into the box**: the Control Plane resolves the Session's enabled Utilities and sends `utilities/set { utilities: UtilitySpec[] }` to
  the Daemon alongside `mcp/set`. The Daemon writes `/dev/shm/sessionboxer/utilities/<name>.json` (0600, tmpfs — never in
  a snapshot, like `mcp_config.json`) and resolves `${util:…}` in the MCP facets before it writes agent MCP config.
  Guests receive the files through the existing push path in `guest.ts`; the guest-side `sb-util` is the same script.
- **To the Agent's hands without its eyes**:
  - `desktop.type` (computer-use MCP) substitutes `${util:<name>.<key>}` and `${util:<name>.otp}` from the tmpfs files
    before `xdotool type`. The transcript, the ACP stream and the LLM request all carry the placeholder. Same for
    `desktop.key_sequence`-style paste if it exists. The UI's tool-call rendering can show `••••` for substituted args.
  - `sb-util env <name> -- <cmd>` exports the credentials as `UTIL_<NAME>_<KEY>` env vars for one command (`curl -u
    "$UTIL_RABBITMQ_USER:$UTIL_RABBITMQ_PASSWORD" …`); `sb-util url <name>` prints the web URL with basic-auth embedded;
    `sb-util otp <name>` prints the current code (this one *does* reveal a 30-second code, acceptable); `sb-util ssh
    <name> [cmd]` runs `ssh -J jump user@host` with the key/password from tmpfs (`sshpass -f`); `sb-util tunnel`. Output
    of a command the Agent runs is of course visible to it — the point is that *stored* secrets are not echoed unless the
    Agent deliberately `echo`es them, which the briefing tells it not to and which `readOnly` cannot prevent.
  - Secrets the *user* types into the chat ("pass asdqwe") have already reached the model. §6 mitigates at the source.
- **Least privilege**: the presets ask for tokens where the upstream supports them (Grafana SA token, Argo CD API token,
  New Relic User key) and say so in the field hint; user/password is the fallback for web UIs.
- **Audit**: native MCP calls already appear as tool calls in the transcript; `sb-util` invocations are shell commands,
  also visible; `utilities_*` changes go through approval cards that stay in the transcript.

## 6. Adding a utility by talking

*"add a debugger tool newrelic with user bocato pass asdqwe at url http://newrelic.itspy.com/"*

1. The Agent calls `sessionboxer.utilities_add({ preset: "newrelic", name: "newrelic", environment: "prod", group:
   "observability", credentials: { user: "bocato", password: "asdqwe" }, web: { url: "http://newrelic.itspy.com/" } })`.
   The URL is *not* the official New Relic host, so the preset's MCP facet is offered but flagged "New Relic's MCP lives at
   mcp.newrelic.com; this URL is used for the web UI" — presets must never assume the SaaS endpoint from the preset name.
2. The Control Plane returns `pending` and the chat shows an **approval card that is a form**: preset, name, group,
   environment (dropdown of existing + new), the facets the preset proposes, credential fields *masked and editable*,
   read-only on, "Enabled in this Session" on. Allow saves the Utility, enables it here, and replies to the Agent; Deny replies
   denied. This is `agent_approval` with a payload instead of a yes/no.
3. On Allow, the Control Plane **redacts the secret from the stored user message** (SQLite transcript: replace the value
   with `••••`) and shows a hint under the card: "Tip: type `/util` to add a utility without sending the password to the
   model." The `/util add …` composer command opens the same form locally — the message never reaches the Agent. Both
   paths land on the same `POST /settings/utilities`.
4. `utilities/set` runs; the marker "Utilities now: … newrelic (prod)" appears; `utilities.json` is rewritten; the Agent continues.

The same card serves `utilities_update` (add a TOTP seed, change notes) and `procedure_save` (§8).

## 7. Environments and the *applications* group

"Debug/QA environments the Agent can test or reproduce against" are Utilities in the `applications` group of an environment:
the QA web app (`web` facet, `form` login, seed accounts as credentials), its API (`http` facet), a bastion (`ssh`), a
`kubectl` context (`cli` with a kubeconfig credential). Nothing new in the model; the UI shows the group under its own
heading so the owner's "tools – observability / tools – applications" split is literal.

Environment-level defaults make the split safe:

- `Settings.utilityEnvironments: Array<{ name, production: boolean, enabledByDefault: boolean }>` — `prod` is
  `production: true, enabledByDefault: false`; `staging`/`qa` on by default.
- A production environment forces `readOnly` on its Utilities unless the user unticks a per-Utility "allow writes in production"
  with a confirm; the manifest tells the Agent so.
- Automations (ADR-0063) that start Sessions can choose the utility set like they choose MCP servers; a "reproduce this bug
  report" automation would enable the `qa` environment's utilities only.

## 8. Procedures: debugging skills the user and the Agent write

A procedure is an Agent Skill (`SKILL.md` with `name`/`description` frontmatter; the spec and the Codex, Cursor and
Devin docs all agree on `~/.agents/skills` / `.agents/skills` as a discovery root; Claude Code reads `~/.claude/skills`,
which the image already links to `~/.agents/skills`). Progressive disclosure is built into the format: agents load the
name + description list, and the body only when the description matches — so a dozen procedures cost a few hundred tokens
until one is used.

```ts
export const ProcedureDef = z.object({
  id: z.string(),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),   // skill name = directory name
  description: z.string().max(1024),                      // the trigger sentence agents match on
  body: z.string().max(200_000),                          // Markdown, may reference ${util:x.y} placeholders and `sb-util`
  utilities: z.array(z.string()).default([]),                 // Utility names it needs; the skill is only materialised when they are enabled
  environments: z.array(z.string()).default([]),          // empty = any
  source: z.enum(["user", "agent", "repo"]).default("user"),
});
```

- **Where they live**: `Settings.procedures` (global, exported/imported as a folder of `SKILL.md`s so they can be
  committed to a team repo); a repo's own `.agents/skills/` keeps working untouched.
- **In the box**: the Daemon writes `~/.claude/skills/<name>/SKILL.md` for procedures whose `utilities` are all enabled and
  removes the rest; `scripts/` and `references/` subfolders are allowed in the body via fenced files later. Claude Code
  discovers skills at start, so procedure changes ride the same restart as MCP changes (deferred when busy).
- **Written by the Agent**: after a successful investigation the user says "save this as a procedure"; the Agent calls
  `procedure_save` with name/description/body listing the utilities it used; the approval card shows the Markdown for edits.
  This closes the loop the owner described — utilities first, then "skills specific to debug something particular using those
  tools" — without leaving the chat. (Recordings of such Sessions are also natural Runbooker input.)
- **Kick-off**: a *New Session → Investigate an incident* template (like Auto QA's hidden prompt) that enables the chosen
  environment's utilities, pastes the alert text and says "use the matching procedure if one exists, otherwise start from the
  observability utilities, and propose a procedure at the end".
- **No secrets in procedures**: the body may only reference placeholders; the save path rejects anything matching a
  configured credential value.

## 9. UI and plan

**Settings → Utilities** (new section between *MCP & connectors* and *Auto QA*, same rail): an environments strip
(`prod ● staging ● qa` chips with production flag and default), then two headed lists *Observability* and *Applications*,
each row a Utility card (label, environment chip, facet icons MCP/web/http/ssh/cli, read-only badge, `enabled by default`
switch, edit/delete), an *Add utility* button (preset picker → form) and *Import JSON* (drops into `custom`). A *Procedures*
sub-tab lists skills with a Markdown editor and Import/Export folder. The MCP page hides servers owned by a Utility behind a
"managed in Utilities" line so nothing is duplicated.

**New Session → Advanced → Utilities** and **Session settings → Utilities**: the same tree with switches at group, environment and
utility level, all/none shortcuts, defaults from `enabledByDefault` × environment default. The header chip mirrors it.

| Increment | Delivers | Touches | Size |
|---|---|---|---|
| 1. Registry + MCP facet | `UtilityDef`/`PublicUtilityDef`/`UtilitySpec`, `Settings.utilities`, `utilityEnvironments`, `SessionSettings.utilitiesEnabled`, Settings → Utilities page, per-Session switches + chip, presets (grafana, argocd, mongodb, rabbitmq, graylog-via-import, custom), Daemon resolves placeholders into MCP config, `utilities.json`, briefing paragraph, marker | protocol, control-plane (settings, sessions, `mcp/set` caller), web, daemon `mcp-config.ts` + `session-info.ts`, briefing | 1 session (+ image rebuild for the briefing) |
| 2. Non-MCP facets + `sb-util` | web/http/ssh/cli facets, tmpfs credential files, `sb-util` CLI in the image, `${util:…}` substitution in the computer-use MCP incl. TOTP, `utilities_open`, guest push | daemon, computer-use-mcp, Dockerfile, guest.ts | 1 session (+ image rebuild) |
| 3. Agent-side management | `utilities_list/get/add/update/enable` in the `sessionboxer` MCP, approval card as a form, transcript redaction, `/util` composer command, New Relic preset (API key) | sessionboxer-mcp, agent-tools.ts, web | 1 session |
| 4. Procedures | `ProcedureDef`, editor + import/export, Daemon materialises skills, `procedure_save`, "Investigate an incident" template, docs (GUIDE section, MCP.md tools, ADR) | protocol, web, daemon, sessionboxer-mcp, docs | 1 session |

Later, if needed: a policy proxy (option B) for servers without read-only flags; Control-Plane OAuth for remote MCPs
(New Relic) modelled on the GitHub connector; Compass or other GUIs in the image.

## 10. Open questions for the owner (with the recommended default)

1. **Naming the environment axis.** `environment` clashes with the runtime selector. **Default: keep "Environment" in
   the Utilities UI (it is the on-call vocabulary), and label the New Session Docker/Windows/macOS selector "Runtime" — the
   word the Windows/macOS ADRs already reach for.** Alternative: call the utility axis "Target".
2. **Where do MCP servers that are Utilities appear?** **Default: only in Utilities; the MCP page shows a one-line "3 servers
   managed in Utilities".** Alternative: show them read-only in both.
3. **Production write access.** **Default: production environments force read-only; per-Utility override with a confirm.**
4. **Chat setup and the password in the message.** **Default: allow it, redact the stored message on save, teach `/util`.**
   Alternative: refuse and always open the form.
5. **Gateway later?** **Default: no, unless Argo CD-style servers without read-only flags are used against production.**
6. **Procedures in the repo vs in settings.** **Default: settings, with folder export; a repo's `.agents/skills` stays
   the developer's business.**
7. **Presets pinned or `@latest`.** **Default: pinned per release, "use latest" checkbox per Utility.**

## References

- Sessionboxer: `docs/research/mcp-servers.md`, ADR-0010, ADR-0062, ADR-0015, ADR-0045, ADR-0063; `packages/protocol/src/index.ts`
  (`McpServerDef`, `PublicMcpKeyValue`, `SessionSettings.mcpEnabled`, `DaemonMcpSetParams`), `packages/sandbox-daemon/src/{mcp-config,session-info,gh-credentials,guest}.ts`,
  `packages/sessionboxer-mcp/src/index.ts`, `apps/control-plane/src/{agent-tools,e2e,docker}.ts`, `apps/web/src/{McpServersEditor,SessionSettingsForm}.tsx`,
  `images/sandbox/{Dockerfile,sandbox-briefing.md,skills/e2e-verification/SKILL.md}`.
- Agent Skills: [specification](https://agentskills.io/specification), [Codex skills](https://developers.openai.com/codex/skills),
  [Cursor skills](https://cursor.com/docs/skills), [Devin skills](https://docs.devin.ai/cli/extensibility/skills/overview).
- New Relic: [MCP setup](https://docs.newrelic.com/docs/agentic-ai/mcp/setup/), [newrelic/mcp-server](https://github.com/newrelic/mcp-server).
- Grafana: [grafana/mcp-grafana](https://github.com/grafana/mcp-grafana), [command-line flags (`--disable-write`)](https://grafana.com/docs/grafana/latest/developer-resources/mcp/configure/command-line-flags/),
  [client configuration examples](https://grafana.com/docs/grafana/latest/developer-resources/mcp/set-up/client-configuration-examples/).
- Argo CD: [argoproj-labs/mcp-for-argocd](https://github.com/argoproj-labs/mcp-for-argocd) (`ARGOCD_BASE_URL`, `ARGOCD_API_TOKEN`; no read-only flag), [akuity/argocd-mcp](https://github.com/akuity/argocd-mcp).
- RabbitMQ: [amazon-mq/mcp-server-rabbitmq](https://github.com/amazon-mq/mcp-server-rabbitmq) (`--allow-mutative-tools`), [kucharovic/rabbitmq-mcp](https://github.com/kucharovic/rabbitmq-mcp).
- MongoDB: [mongodb-js/mongodb-mcp-server](https://github.com/mongodb-js/mongodb-mcp-server) (`--readOnly`, `MDB_MCP_READ_ONLY`), [MCP server docs](https://www.mongodb.com/docs/mcp-server/overview/).
