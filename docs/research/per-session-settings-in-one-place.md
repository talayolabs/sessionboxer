# Research: per-Session settings in one place (design)

Repo state read: `4e246a1` (Release 0.1.0). Design only; no code changed in this note.

Scope: consolidate every per-Session setting into one **Session settings** surface (dialog on a desktop, full-height sheet on a phone), reachable from the Session header and from the mobile overflow sheet, without changing what the Daemon does (pending/turn-end mechanics) or how the composer's model/options quick controls behave.

---

## 1. Inventory: per-Session settings today

Legend for *Takes effect*:
- **immediate** — the Control Plane reads it when needed, no Daemon involvement.
- **idle→now / turn→end** — the Daemon applies it right away when the Agent is idle and queues it until the current turn ends when a turn is active (`*Pending` flag while queued). "Now" may mean a `set_config_option` call (model/options) or an **Agent restart in place** with `session/load` (MCP, Inspect LLM); the conversation is kept either way.
- **stopped→resume** — stored now, the Daemon picks it up on the next Sandbox start.
- **creation-only** — resolved when the Session/Sandbox is created and baked into the container (env, `docker run` flags, git config). Changing it means a new Sandbox: **Fork**.

| Setting | UI today | Stored | Takes effect | Fork copies? | Global default |
|---|---|---|---|---|---|
| Provider | New Session `<select>` | `sessions.provider` | creation-only | yes (`origin.provider`) | none (UI default `claude-code`) |
| Workspace source (empty / git url+ref / copy path) | New Session | `sessions.workspace_source` (JSON) | creation-only | replaced by `{type:"fork", sessionId, snapshotId}` | none |
| Repositories (`Session.repos`, parallel session) | repo chips / dialog (in progress) | new column by that session | live add/remove (clone into `/workspace/<name>`) | to be decided by that session (snapshot already contains the clones) | none |
| Git identity (name, email) | New Session, only shown when source = git, always sent | `git_user_name`, `git_user_email` | creation-only (git config written at Sandbox start) | yes | `Settings.gitUserName/Email` → host git config (`resolveGitIdentity`) |
| Docker mode | New Session checkbox → resolved to `none/sysbox/privileged` | `docker_mode` | creation-only (`docker run` runtime/`--privileged`) | yes (`origin.dockerMode`) | `Settings.dockerInSandbox` + `dockerModeAvailable()` |
| Sandbox CPUs / memory | **not per Session** (global Settings only) | — (`Settings.sandboxCpus/MemoryGb`) | at container creation (create, fork, Rebuild) | n/a | yes |
| Model | New Session `ModelSelect`; composer footer `ModelSelect compact` | `model` (`NULL` = Provider default), `model_pending` | idle→now (`set_config_option`), turn→end, stopped→resume | yes | none (Provider default); `Settings.claudeModels` only shapes the list |
| Agent options (Effort, Fast…) | New Session `OptionSelects`; composer footer compact | `options` (JSON), `options_pending`, `available_options` (state) | same as model (strict on user change, lenient on restore) | yes | none (Agent default) |
| Instructions | New Session textarea (prefilled from Settings); header **Instructions** button → read-only `InstructionsDialog` | `instructions` | creation-only (`SESSIONBOXER_INSTRUCTIONS` env; ADR-0022 made it immutable) | yes (`origin.instructions`) | `Settings.instructions` (copied at creation, not inherited live) |
| MCP servers enabled | New Session `McpPicker`; header **MCP** button → `McpDialog` switches | `mcp_enabled` (JSON ids), `mcp_pending` | idle→restart in place, turn→end, stopped→resume | yes (filtered to known ids) | `McpServerDef.enabledByDefault` per server (copied at creation) |
| Connector credentials in the box (GitHub) | none — derived | none (derived by `resolveBoxCredentials(settings, mcpEnabled)` on every `mcp/set`) | with MCP push | follows `mcpEnabled` | `Settings.connectors` |
| Inspect LLM calls | header **Inspect LLM** toggle button | `inspect_llm`, `inspect_llm_pending` | idle→restart in place (agent env), turn→end, stopped→resume; Claude Code only | yes | none (`false`) |
| Auto-snapshot | **sidebar** size line → `SnapshotsDialog` switch (not in the header) | `auto_snapshot` (`NULL` = inherit) | immediate (checked at each turn end: `s.autoSnapshot ?? settings.autoSnapshot`) | yes (`origin.autoSnapshot`) | `Settings.autoSnapshot` — the only setting already using `null = inherit` |
| Snapshots to keep | **not per Session** | — (`Settings.snapshotKeep`) | immediate at prune | n/a | yes |
| Title | header inline edit | `title` | immediate | new title (`"<origin> (fork n)"`) | — |

Global-only, out of scope but referenced by the dialog: `claudeModels` (restart in place), CA certificates (Sandbox start), Claude API base URL (Sandbox start), narration, tunnels/devices, access token.

**State shown in the header that is *not* a setting** and stays where it is: status, `queueRunning`, branches / `activeBranchId`, saved messages, `availableOptions`, `containerId`, `error`, `diskBytes`, `snapshotBytes/Count`, the four `*Pending` flags. The dialog reads the pending flags but never owns them.

Observations that drive the design:
1. Two categories exist already: **live** settings (model, options, MCP, Inspect LLM, auto-snapshot) pushed through `Sessions.edit()` → `push*()` → Daemon RPC with pending semantics, and **frozen** settings (provider, workspace, git identity, Docker mode, instructions) resolved once in `Sessions.create()` and baked into the container.
2. Only `autoSnapshot` inherits the global value *dynamically*. Instructions and MCP defaults are *copied* at creation — changing the global afterwards does not change the Session. This is correct for anything the Sandbox already has, and the data model must keep the distinction.
3. The web app is the only PATCH client (`apps/web/src/api.ts:updateSession`); the CLI (`apps/cli/src/index.ts`) only creates Sessions. The Daemon never sees the `Session` object — it gets individual RPCs. So the protocol shape of `Session` can change with only web + Control Plane in the blast radius.
4. ADR-0035: the header's action row and the phone's bottom sheet are the **same element** (`.session-actions`, `display: contents` on a desktop). Anything added to that row automatically shows in the overflow sheet — one button gives both entry points.

---

## 2. UX proposal

### 2.1 Entry points and what leaves the header

- New header button **Settings ⚙** (label "Session settings", `aria-haspopup="dialog"`) inside `.session-actions`, placed where **MCP · Instructions · Inspect LLM** sit today; those three buttons are removed. On a phone the same button appears in the ⋯ sheet because of ADR-0035's shared element — no second wiring.
- The button carries a small `pending` badge (`warn-sign`, same class as the composer) whenever `mcpPending || modelPending || optionsPending || inspectLlmPending`, so a queued change is visible even with the dialog closed.
- Keep in the header: title, provider/docker/workspace labels (now clickable → open the dialog on *Sandbox*), branch selector, pane tabs, **Snapshot**, **Fork**, **Pull**, **Stop/Resume**, **Delete**.
- Sidebar size line keeps opening `SnapshotsDialog` (list, Snapshot now, Rebuild, Delete all). Its auto-snapshot switch **moves** to Session settings › Snapshots; the dialog shows a one-liner "Auto-snapshot: on (Settings default) · Change…" that opens the settings dialog on that section. One place to flip it.
- Composer footer **unchanged**: `ModelSelect compact` + `OptionSelects compact` + pending pill + `ContextGauge`. They are the quick controls; the *Agent* section of the dialog renders the same two components in non-compact form bound to the same `changeModel` / `changeOption` handlers. Same PATCH, same pending flags, no new state.

### 2.2 Apply model: per-control autosave, not a Save button

Every live control PATCHes on change (exactly what the header buttons and composer do today), so the dialog can never hold a "dirty" state that disagrees with the live `Session` broadcast, and the Daemon's pending flags remain the single truth. Controls are `disabled` while their request is in flight (`mcpBusy`/`modelBusy`/`inspectBusy`, as today). The only multi-keystroke control is the Instructions textarea, which is read-only in Stage 1 (see §2.5) and, if made editable later, gets its own *Apply* button inside its section.

### 2.3 One wording for "when does this apply"

A single helper replaces the three phrasings that exist today (`McpDialog` prose, `ModelSelect` title, `SnapshotsDialog` hint):

```ts
type ApplyKind = "immediate" | "config" | "restart" | "creation";
function applyNote(session: Session, kind: ApplyKind, pending: boolean): string
```

| Situation | Text |
|---|---|
| pending flag set | **"Change pending: applies when the current turn ends."** (banner at the top of the section, `banner-warn`, `role="status"`) |
| `running`, kind ≠ creation | "Applies when the current turn ends." |
| `idle`, kind = `config` | "Applies now." |
| `idle`, kind = `restart` | "Applies now; the Agent restarts in place and the conversation is kept." |
| `stopped`/`error`, kind ≠ creation | "Applies when the Session is resumed." |
| any, kind = `immediate` | "Applies immediately." |
| kind = `creation` | "Fixed for this Session. **Fork with different settings…**" |

Kinds per setting: model/options → `config`; MCP, Inspect LLM → `restart`; auto-snapshot, snapshot keep, title → `immediate`; provider, workspace, git identity, Docker mode, CPUs/memory, instructions → `creation`.

### 2.4 Sections

1. **Agent** — Provider (read-only, icon + label), Model (`ModelSelect`, "Provider default" entry allowed so the override can be cleared → PATCH `model: null`, which today's `UpdateSessionRequest` rejects: `z.string().min(1)`; fix in Stage 2), Options (`OptionSelects` from `availableOptions` when live, `ProviderOptions` otherwise), Inspect LLM switch (Claude only; on Devin shown disabled with "Devin's CLI talks to Cognition, not to a model API"). Pending banner covers all three.
2. **Instructions** — the text (`<pre>` as today), delivery note, provenance ("Settings text at creation" / "edited for this Session" / "none"), *creation* note with **Fork with different settings…**. Reset link absent (read-only).
3. **MCP servers & connectors** — the switch list from `McpDialog` (`desktop` always on, shown first, disabled); per server the transport/summary; a **Connectors** line under servers that use one ("GitHub: logged in as @x · credentials are placed in the box while this server is on" / "not connected — Settings › Add GitHub"). Footer link "Manage servers in Settings". Pending banner.
4. **Repositories** — mounts the parallel session's repo chips/dialog component (`RepoChips` + add/remove) unchanged; this section is the *home* for it, the header chips stay as quick view. Live; no pending mechanics of ours (the clone happens in the box).
5. **Snapshots** — Auto-snapshot switch (three-state presentation: effective value + "Settings default" / "overrides Settings (on|off) · use default"), **Keep** number input (per-Session override of `snapshotKeep`, same three-state), totals line, link "Open snapshots…" (→ `SnapshotsDialog`). *Immediate*.
6. **Sandbox** — read-only rows: Docker mode (label + `DockerModeNote`-style warning when `privileged`), CPUs / memory (effective value + source: "Settings default (2 CPUs, 4 GB)" or "set for this Session"), Git identity, Workspace source (url/ref or path or "forked from <title> #n"). Footer: **Fork with different settings…**.

### 2.5 Fork with different settings

`ForkDialog` gets a collapsed **"Change settings for the fork"** disclosure that renders the same `SessionSettingsForm` in *create* mode, pre-filled from the origin's settings (that is what `Sessions.fork()` copies today). Submitting sends `ForkSessionRequest.settings` (partial; omitted = copy origin). Provider and workspace cannot change in a fork (the image is the origin's), so the form hides them. The "Fork with different settings…" links in the dialog open `ForkDialog` with that disclosure expanded and the latest snapshot preselected (or "Snapshot now, then fork" when there is none — `createSnapshot` then open).

Instructions stay immutable per ADR-0022 ("different rules in one conversation"). If that is revisited, the mechanics exist: Claude gets the text on every `session/new`/`session/load`, so a restart in place (kind `restart`) would apply it; Devin's first-prompt prefix is already consumed, so for Devin it remains creation-only. Noted as an optional Stage 5, needs its own ADR.

### 2.6 Desktop wireframe

```
┌ Session header ───────────────────────────────────────────────────────────────────────┐
│ Fix login bug ✎   Claude Code · Docker (Sysbox) · git github.com/acme/app  [main ▾]    │
│ [Chat|Desktop|Code|Terminal|Context]   [Snapshot] [Fork] [Pull] [⚙ Settings •] [Stop] [Delete] │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                             •  = pending badge (any *Pending true)

┌ modal .session-settings (max-width 860px, 2 columns) ─────────────────────────────────┐
│ Session settings — "Fix login bug"                                              [×]   │
├──────────────┬────────────────────────────────────────────────────────────────────────┤
│ ▸ Agent    • │  Agent                                                                 │
│   Instructions│  ┌ ⚠ Change pending: applies when the current turn ends. ──────────┐   │
│   MCP & connectors│└────────────────────────────────────────────────────────────────┘ │
│   Repositories│  Provider     Claude Code                                    (fixed)  │
│   Snapshots  │  Model        [ sonnet — Sonnet 4.5 (default)            ▾ ] pending   │
│   Sandbox    │  Effort       [ high                                      ▾ ]          │
│              │  Fast mode    [ off                                       ▾ ]          │
│              │  Applies now.                                                          │
│              │                                                                        │
│              │  ○━━ Inspect LLM calls   Records every request to the model API and    │
│              │                          shows it in the Context pane.                 │
│              │  Applies now; the Agent restarts in place and the conversation is kept.│
│              │                                                                        │
│              │  Also in the composer footer for quick changes.                        │
├──────────────┴────────────────────────────────────────────────────────────────────────┤
│  Fixed-at-creation values: [Fork with different settings…]                  [Close]   │
└────────────────────────────────────────────────────────────────────────────────────────┘

Sandbox section (right column):
│  Sandbox                                                                               │
│  Docker         Docker (Sysbox)                                                        │
│  CPUs / memory  2 CPUs · 4 GB          Settings default                                │
│  Git identity   Jane Doe <jane@acme.dev>   from Settings                               │
│  Workspace      git https://github.com/acme/app.git @ main                             │
│  Fixed for this Session. [Fork with different settings…]                               │

Snapshots section:
│  ●━━ Snapshot after every completed turn     overrides Settings (off) · use default    │
│  Keep automatic snapshots  [ 10 ]  Settings default · 0 = all                          │
│  Machine 312 MB on top of its image · Snapshots 84 MB in 7 snapshots   [Open snapshots…]│
│  Applies immediately.                                                                  │
```

Left column: sticky list of sections; the right column scrolls (one long page with `<h3 id>` anchors; clicking a section scrolls to it — simpler than tabs and keeps Ctrl+F working). Pending dot next to Agent / MCP when their flag is set.

### 2.7 Phone wireframe (≤ 800 px)

```
┌ topbar ──────────────────────┐        ┌ ⋯ sheet (.session-actions.open) ──┐
│ ☰  Fix login bug          ●  │        │ Fix login bug                    × │
├ session-header ──────────────┤        │ Claude Code · Docker · git …       │
│ Fix login bug             ⋯  │  tap → │ [main ▾]                            │
│                              │        │ [Snapshot]  [Fork]  [Pull]          │
│   chat …                     │        │ [⚙ Session settings •]              │
│                              │        │ [Stop]                              │
│ [sonnet▾][Effort▾] ◔ ⋯ Send  │        │ [Delete]                            │
├ bottom-tabs ─────────────────┤        └────────────────────────────────────┘
│ Chat Desktop Code Term Ctx   │
└──────────────────────────────┘

tap ⚙ →  full-height sheet (.app.mobile .modal.session-settings: inset 0, radius 0,
         padding-top env(safe-area-inset-top); sections as accordions, all collapsed
         but the one requested; sticky header with × )
┌──────────────────────────────┐
│ ← Session settings        ×  │
│ Fix login bug                │
├──────────────────────────────┤
│ ▾ Agent                   •  │
│   ⚠ Change pending: applies  │
│     when the current turn    │
│     ends.                    │
│   Provider  Claude Code      │
│   Model     [ sonnet      ▾ ]│
│   Effort    [ high        ▾ ]│
│   Fast mode [ off         ▾ ]│
│   ○━━ Inspect LLM calls      │
│   Applies now; the Agent…    │
│ ▸ Instructions               │
│ ▸ MCP servers & connectors • │
│ ▸ Repositories          (2)  │
│ ▸ Snapshots                  │
│ ▸ Sandbox               fixed│
├──────────────────────────────┤
│ [Fork with different settings…]│
└──────────────────────────────┘
```

Same component; `mobile` prop (from `useMediaQuery(MOBILE_QUERY)`) switches the two-column layout to accordions (`<details>`), the modal to full height, and inputs to 16 px (the `.app.mobile select/input` rule already does that). The ⋯ sheet closes when the dialog opens (`setMenuOpen(false)`), as it does for the other actions.

### 2.8 What stays as quick controls

| Control | Composer footer | Header | Dialog |
|---|---|---|---|
| Model | yes (compact) | — | yes (full) |
| Options | yes (compact) | — | yes (full) |
| Context gauge | yes | — | — |
| MCP | — | **removed** | yes |
| Instructions | — | **removed** | yes (read-only) |
| Inspect LLM | — | **removed** | yes |
| Auto-snapshot | — | — (SnapshotsDialog keeps a link) | yes |
| Snapshot / Fork / Pull / Stop / Delete / branch | — | yes (unchanged) | Fork link only |

---

## 3. Data model proposal

### 3.1 Recommendation: one `SessionSettings` object in the protocol, one JSON column, runtime state stays in columns

**Protocol.** Introduce `SessionSettings` (durable, user-chosen values) and expose it as `Session.settings`. The four `*Pending` flags, `availableOptions`, status etc. stay top-level: they are Daemon-reported state, not settings, and the Daemon status sync (`syncDaemonStatus` → `update(id, {modelPending, …})`) keeps writing them unchanged.

**Two flavours of field inside the object** — this is the important nuance, and the reason not to make everything `nullable`:

- **Live, inheritable** (`null` = "use the global value *at the time it is used*"): `autoSnapshot`, `snapshotKeep`, and for the Sandbox block `cpus`, `memoryGb` (used at every container creation: create, fork, Rebuild). Effective value: `session ?? global`.
- **Live, own value** (`null` means "Provider/Agent default", not "inherit"): `model`, `options`, `mcpEnabled`, `inspectLlm`. There is no meaningful global for these (`claudeModels` is a list, `enabledByDefault` is a per-server seed). They are seeded from globals at creation, then owned by the Session.
- **Frozen** (resolved once in `create()`/`fork()`, never `null` afterwards because the Sandbox already has them): `instructions`, `gitIdentity`, `dockerMode`. Storing `null` here would make a later change of the global silently change what the UI shows for an existing Sandbox, which would be a lie.

So `null = inherit` applies exactly where the Control Plane re-reads the value at use time; everywhere else the stored value is the truth. The UI still shows provenance ("Settings default at creation") for frozen fields by comparing with the current global, purely informational.

**Zod (pseudo-code, `packages/protocol/src/index.ts`):**

```ts
/** Durable per-Session choices. Runtime state (status, *Pending, availableOptions…) lives on Session. */
export const SandboxSettings = z.object({
  /** Frozen at Sandbox creation (resolved from Settings.dockerInSandbox + host capability). */
  dockerMode: DockerMode.default("none"),
  /** null = Settings.sandboxCpus/MemoryGb at the next container creation (create, fork, Rebuild). */
  cpus: z.number().positive().nullable().default(null),
  memoryGb: z.number().positive().nullable().default(null),
  /** Frozen at creation (git config in the box). */
  gitIdentity: GitIdentity.default({ name: "", email: "" }),
});

export const SessionSettings = z.object({
  // Agent — live, pushed to the Daemon (config option; pending during a turn)
  model: z.string().nullable().default(null),          // null = Provider default
  options: OptionValues.default({}),                   // missing key = Agent default
  inspectLlm: z.boolean().default(false),              // Claude Code only; restart in place
  // Tools — live, restart in place; also drives connector credentials in the box
  mcpEnabled: z.array(z.string()).default([]),
  // Instructions — frozen at creation (ADR-0022)
  instructions: z.string().max(INSTRUCTIONS_MAX_CHARS).default(""),
  // Snapshots — live, null = inherit Settings at use time
  autoSnapshot: z.boolean().nullable().default(null),
  snapshotKeep: z.number().int().nonnegative().nullable().default(null),
  // Sandbox
  sandbox: SandboxSettings.default({}),
});
export type SessionSettings = z.infer<typeof SessionSettings>;

/** What a client may send when creating or forking: everything optional, the Control Plane resolves. */
export const SessionSettingsInput = SessionSettings.deepPartial();

/** What PATCH may change on an existing Session: live fields only. */
export const SessionSettingsPatch = z.object({
  model: z.string().min(1).nullable().optional(),      // null now allowed: back to Provider default
  options: OptionValues.optional(),                    // merged, as today; value null = clear key
  inspectLlm: z.boolean().optional(),
  mcpEnabled: z.array(z.string()).optional(),
  autoSnapshot: z.boolean().nullable().optional(),
  snapshotKeep: z.number().int().nonnegative().nullable().optional(),
  sandbox: z.object({
    cpus: z.number().positive().nullable().optional(),
    memoryGb: z.number().positive().nullable().optional(),
  }).optional(),
}).strict();

export const Session = z.object({
  id, title, provider, status, workspaceSource,
  settings: SessionSettings.default({}),
  // runtime state, unchanged:
  mcpPending, modelPending, optionsPending, inspectLlmPending, availableOptions,
  containerId, error, queueRunning, diskBytes, snapshotBytes, snapshotCount,
  branches, activeBranchId, createdAt, updatedAt,
  // Stage 0–3 only: legacy mirrors of settings.* so old code keeps compiling; removed in Stage 4.
  /** @deprecated use settings.model */ model, options, mcpEnabled, instructions, inspectLlm, autoSnapshot, dockerMode, gitIdentity,
});

export const CreateSessionRequest = z.object({
  title, provider, workspaceSource, prompt,
  settings: SessionSettingsInput.optional(),
  // legacy flat fields kept for the CLI (`--model`, `--instructions`, `--docker`, `--mcp`); mapped in create()
  docker, mcpEnabled, model, options, instructions, gitIdentity, inspectLlm,
});

export const UpdateSessionRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  settings: SessionSettingsPatch.optional(),
  // legacy flat fields, accepted until Stage 4 (normalized into `settings` in Sessions.edit)
  autoSnapshot, mcpEnabled, model, options, inspectLlm,
});

export const ForkSessionRequest = z.object({
  snapshotId, title, prompt, savedMessages,
  /** Overrides on top of the origin's settings (provider/workspace cannot change: it is the origin's image). */
  settings: SessionSettingsInput.omit({ instructions: true }).optional(), // or keep instructions: see §2.5
});
```

**Resolution helpers (pure, in the protocol so web and Control Plane agree):**

```ts
export type Source = "session" | "global";
export interface EffectiveSessionSettings {
  autoSnapshot: { value: boolean; source: Source };
  snapshotKeep: { value: number; source: Source };
  sandbox: { cpus: { value: number; source: Source }; memoryGb: { value: number; source: Source } };
}
export function resolveSessionSettings(s: SessionSettings, g: Pick<Settings, "autoSnapshot"|"snapshotKeep"|"sandboxCpus"|"sandboxMemoryGb">): EffectiveSessionSettings;

/** Seed for New Session and for `create()` when a field was omitted. Frozen fields are copied, live ones are null/seeded. */
export function defaultSessionSettings(g: PublicSettings, provider: Provider): SessionSettings {
  return {
    model: null, options: {}, inspectLlm: false,
    mcpEnabled: g.mcpServers.filter((m) => m.enabledByDefault).map((m) => m.id),
    instructions: g.instructions,
    autoSnapshot: null, snapshotKeep: null,
    sandbox: { dockerMode: g.dockerInSandbox ? g.dockerModeAvailable : "none", cpus: null, memoryGb: null,
               gitIdentity: { name: g.gitUserName || g.hostGitIdentity.name, email: g.gitUserEmail || g.hostGitIdentity.email } },
  };
}
```

Control Plane call sites that change from `settings.x` to the effective value:
- `sessions.ts:1074` prune: `const keep = resolve(s.settings, this.settings()).snapshotKeep.value`.
- auto-snapshot check after a turn (`s.autoSnapshot ?? this.settings().autoSnapshot`) → `resolve(...).autoSnapshot.value`.
- `createSandbox` (`cpus: settings.sandboxCpus, memoryGb: settings.sandboxMemoryGb, dockerMode: session.dockerMode`) → from `resolve(...)` + `session.settings.sandbox.dockerMode`; same for Rebuild and fork.

**DB.** Add `settings TEXT NOT NULL DEFAULT '{}'` to `sessions`; `rowToSession` does `SessionSettings.parse(JSON.parse(row.settings))` so a key added later appears with its default without a migration. Keep `*_pending`, `available_options`, and all runtime columns. `SessionPatch` gains `settings?: SessionSettings` (full object; `Db.updateSession` already merges a patch into the whole Session and rewrites the row, so writing the blob whole is the same pattern).

### 3.2 Why not keep individual columns (and why not a hybrid for long)

| | Individual columns (today) | One JSON `settings` column (proposed) |
|---|---|---|
| Adding a setting (snapshotKeep, cpus, memoryGb, next ones) | migration + row type + `rowToSession` + `SessionPatch` + `insertSession` + `updateSession` (6 places) | one Zod line |
| Fork copy | 9 explicit field copies in `fork()`, easy to forget one | `settings: { ...origin.settings }` |
| PATCH | one flat request with a growing list of optionals | `settings: SessionSettingsPatch` (strict → typos rejected) |
| SQL filtering on a setting | possible | `json_extract` if ever needed; nothing queries them today (`SELECT * … ORDER BY updated_at`) |
| Write amplification | one column | whole blob (< 25 KB with max instructions; rows are rewritten whole already) |
| Risk | none (status quo) | one migration, backfilled at startup |

The hybrid (JSON in the protocol, columns in SQLite) is the *right* Stage 0 — it lets the UI ship first with zero DB risk — but keeping it means every new setting still needs a column, which is the maintenance cost we are trying to remove. So: Stage 0 hybrid, Stage 2 column, Stage 4 drop the dead columns.

### 3.3 New Session = same component, pre-filled from global defaults

`NewSession` keeps provider/workspace/title/first prompt as its own fields and renders `SessionSettingsForm mode="create"` for everything else, with `value = defaultSessionSettings(settings, provider)` and a "Reset to Settings defaults" link per field where the value differs (today's pattern for instructions and git identity, generalized). Model and options keep `allowDefault` (they already do). The form's `mode` decides:

| mode | model/options/MCP/inspect | instructions | snapshots | sandbox |
|---|---|---|---|---|
| `create` (New Session, Fork) | editable, local state | editable textarea | editable (three-state) | editable: Docker checkbox (+ `DockerModeNote`), CPUs/memory number inputs with "Settings default" placeholder, git identity |
| `live` (Session settings dialog) | editable, PATCH on change, pending banners | read-only + fork link | editable, PATCH | read-only + fork link |

Fork uses `create` mode with `value = origin.settings` and provider/workspace hidden.

---

## 4. Migration and compatibility

**Database (Stage 2, one `migrate()` step):**
1. `ALTER TABLE sessions ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'`.
2. Backfill in JS inside the same transaction: for each row with `settings = '{}'`, build the object from `docker_mode, auto_snapshot, mcp_enabled, model, options, instructions, inspect_llm, git_user_name, git_user_email` and write it. (`user_version` bump as with the other steps.)
3. Old columns are left in place until Stage 4 and no longer read/written after Stage 2 (SQLite ≥ 3.35 supports `DROP COLUMN`; `node:sqlite` ships a newer one — verify at Stage 4, or just leave them: they cost nothing).
4. Downgrade safety: a Control Plane from before Stage 2 ignores the extra column; a Control Plane from Stage 2+ started on an older DB runs the backfill. Nothing is destroyed until Stage 4.

**API:**
- `PATCH /api/sessions/:id` accepts both shapes until Stage 4: `Sessions.edit()` first folds legacy flat fields into a `SessionSettingsPatch`, then runs one code path: `update(id, {settings: merged})` → the same four `push*()` calls in the same order → return `this.get(id)`. Behavior for today's web client is byte-identical.
- `POST /api/sessions` (CLI + web): same folding of `docker/model/options/mcpEnabled/instructions/gitIdentity/inspectLlm` into `settings`. The CLI flags do not change at all.
- New: `model: null` in a patch = "back to Provider default". Verified: `DaemonModelSetParams` is `{ model: z.string().min(1) }` and `AgentManager.setModel(model: string)` — the Daemon has no "default" case today (which is why the current PATCH forbids `null`). Supporting it needs a small Daemon change: widen the param to `nullable()`, and in `setModel(null)` pick the ACP option's default choice (Claude advertises `default`; Devin's list has no default entry — fall back to the first choice or reject). Until then the dialog hides the "Provider default" entry in live mode (as the composer does) and offers it only in create mode; this is the one place where Stage 2 touches the Daemon, and it can be deferred without blocking anything else.
- `WS session` broadcasts carry `settings` from Stage 0; old tabs of the web app simply reload (they are served by the same Control Plane).

**Web:** `api.updateSession(id, {settings: {...}})` from Stage 1; the composer's `changeModel`/`changeOption` switch to the nested shape in the same commit (they live in `App.tsx`, 4 lines).

**What NOT to change:**
- Daemon: no RPC, `DaemonStatus`, `AgentManager.setModel/setOptions/setMcpServers/setAgentEnv` or pending logic changes. The pending flags remain Daemon-owned and are synced into top-level `Session` fields exactly as today.
- `Sessions.pushModel/pushOptions/pushMcpServers/pushLlmInspect` and their order in `edit()`; the strict/lenient option semantics (ADR-0013).
- Composer footer contents and the `compact` props of `ModelSelect`/`OptionSelects`.
- `SnapshotsDialog` list/actions, `ForkDialog` snapshot/first-message logic, Rebuild.
- `.session-actions` single-element pattern (ADR-0035); the dialog is a sibling `.modal`, not a second action list.
- Instructions immutability (ADR-0022) unless a new ADR says otherwise.
- `resolveBoxCredentials` — connector credentials stay derived from `mcpEnabled`; the dialog only *displays* the relationship.
- `Settings`/`PublicSettings` and `/api/settings*`: globals are untouched (the dialog links to `#/settings`).

---

## 5. Staged plan

Effort is in Devin sessions (one session ≈ what I can finish in one sitting including tests/typecheck).

| Stage | What | Files | Effort |
|---|---|---|---|
| **0 — Protocol shape, no behavior change** | `SessionSettings`, `SessionSettingsInput/Patch`, `resolveSessionSettings`, `defaultSessionSettings`, `applyNote` wording table (protocol so CLI could reuse). `rowToSession` assembles `settings` from the existing columns; `create()`/`fork()` build it; legacy mirrors kept. Unit tests for resolution/default seeding. | `packages/protocol/src/index.ts`, `apps/control-plane/src/db.ts` (`rowToSession`), `apps/control-plane/src/sessions.ts` (`create`, `fork`), tests | ½ session |
| **1 — The dialog** | `SessionSettingsDialog.tsx` (shell: two-column desktop / accordion phone, pending badge logic) + `SessionSettingsForm.tsx` (sections, `mode: "live"`) + `McpSwitches` extracted from `McpDialog`; header ⚙ button replaces MCP/Instructions/Inspect LLM; `SnapshotsDialog` switch → link; `applyNote` used everywhere; CSS. Delete `McpDialog.tsx` (keep `McpPicker` inside `McpSwitches` with a `mode` prop) and `InstructionsDialog.tsx` (move `deliveryNote` to a small `instructions.ts`). | new `apps/web/src/SessionSettingsDialog.tsx`, `SessionSettingsForm.tsx`, `McpSwitches.tsx`, `applyNote.ts`; edit `App.tsx` (SessionView state/handlers, header, mobile sheet close), `SnapshotsDialog.tsx`, `api.ts`, `styles.css`; remove `McpDialog.tsx`, `InstructionsDialog.tsx` | 1 session |
| **2 — Storage + API** | `settings` JSON column + backfill migration; `SessionPatch.settings`; `UpdateSessionRequest.settings` with legacy folding in `edit()`; `model: null` allowed (optional Daemon `setModel(null)`, see §4); per-Session `snapshotKeep` used by prune; per-Session `cpus/memoryGb` used by `createSandbox` (create/fork/Rebuild). Tests for migration and folding. | `db.ts` (schema, migrate, row type, insert/update, rowToSession), `sessions.ts` (`edit`, prune, auto-snapshot check, `createSandbox`, rebuild), `index.ts` (route unchanged, schema parse), protocol | ½–1 session |
| **3 — Create and Fork share the form** | `NewSession` renders `SessionSettingsForm mode="create"` seeded from `defaultSessionSettings`; CPUs/memory inputs there; `ForkDialog` "Change settings for the fork" + `ForkSessionRequest.settings` applied in `fork()`; "Fork with different settings…" links from the dialog (auto-snapshot-then-fork when no snapshot). Repositories section mounts the parallel session's component (coordinate on its prop shape: `session`, `run`). | `App.tsx` (`NewSession`), `ForkDialog.tsx`, `SessionSettingsForm.tsx`, `sessions.ts` (`fork`), protocol | 1 session |
| **4 — Cleanup** | Remove legacy top-level `Session` mirrors and legacy PATCH/create flat fields from web + Control Plane (CLI keeps its flags, folded server-side only in `create`); drop dead columns or leave with a comment; ADR "Per-Session settings as one object and one dialog". | protocol, `db.ts`, `sessions.ts`, `App.tsx`, `api.ts`, `docs/adr/0037-…md` | ½ session |
| **5 — Optional** | Editable instructions for Claude via restart in place (new Daemon RPC `_sessionboxer/instructions/set`, `SESSIONBOXER_INSTRUCTIONS` re-read); live `docker update` of CPUs/memory (needs a check that Sysbox containers accept it); moving `Session.repos` into `settings.repos` if the parallel session's semantics fit (live list with side effects). Each wants its own ADR. | daemon `index.ts`/`agent.ts`, `sessions.ts` | 1 session each |

Total for stages 0–4: about 3½–4 sessions, shippable after each stage (Stage 1 alone already delivers the "one place" UX on the current storage).

### Components to merge / remove / add

| Today | After |
|---|---|
| `McpDialog.tsx` (`McpDialog` + `McpPicker`) | **remove**; switches become `McpSwitches` used by the dialog (live) and New Session/Fork (create) |
| `InstructionsDialog.tsx` | **remove**; text view becomes the Instructions section; `deliveryNote` → `instructions.ts` |
| header **Inspect LLM** button (`toggleInspectLlm`) | **remove**; switch in Agent section, same handler |
| header **MCP**, **Instructions** buttons, `mcpOpen`/`instructionsOpen` state | **remove**; one `settingsOpen: SectionId \| null` |
| `SnapshotsDialog` auto-snapshot switch | **move** to Snapshots section; dialog keeps a link |
| `ModelSelect`, `OptionSelects` | **keep**, reused non-compact in the dialog and New Session; unchanged in the composer |
| `DockerModeNote` | **keep**, reused in Sandbox section (create mode) |
| `NewSession` settings fields (docker, MCP, instructions, git identity, model/options) | **replace** with `SessionSettingsForm mode="create"` |
| `ForkDialog` | **extend** with the collapsed create-mode form |
| — | **add** `SessionSettingsDialog.tsx`, `SessionSettingsForm.tsx`, `McpSwitches.tsx`, `applyNote.ts`; protocol `SessionSettings*`, `resolveSessionSettings`, `defaultSessionSettings` |

### Open questions to settle before Stage 2

1. Whether to add `setModel(null)` to the Daemon (see §4) or keep "no way back to Provider default once a model was picked" as today.
2. `Session.repos` (parallel session): keep as its own top-level field with its own routes, or fold into `settings`? Recommendation: keep separate until its add/remove semantics have shipped; the dialog just hosts the component.
3. Should the SnapshotsDialog keep a duplicate auto-snapshot switch for convenience? Recommendation no — "one place" is the point; a link is enough.
4. Per-Session CPUs/memory: creation-only (this doc) or live via `docker update`? Creation-only first; live is a Stage 5 item.
