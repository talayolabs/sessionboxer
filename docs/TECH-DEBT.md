# Code review and technical debt

Review of Sessionboxer at v1.5.0 (`0bb1294`) with the wondel.ai code-quality skills: Pragmatic
Programmer, Clean Code, Refactoring Patterns, A Philosophy of Software Design, Working Effectively
with Legacy Code. Each section follows its skill's diagnostic and scoring rule. The list at the end
is what to do about it, ordered by risk × payoff.

Baseline: `npm run typecheck` green in 15 s; CI runs typecheck + 5 script-level test files (621
lines of tests) + build + pack. No lint or format gate.

## The shape of the codebase

| File | Lines | Commits since 2026-08 | What it holds |
|---|---|---|---|
| `packages/protocol/src/index.ts` | 5,286 | 96 | every shared Zod schema and type: providers, sessions, daemon RPC, MCP, utilities, automations, PRs |
| `apps/web/src/App.tsx` | 4,475 | 125 | `App` (~1,400 lines), `SessionView` (~730), `NewSession` (~290), `SettingsView` (~1,400, 57 `useState`), 8 dialogs/components |
| `apps/control-plane/src/sessions.ts` | 3,208 | 82 | `SessionManager`, 171 methods: lifecycle, repos, daemon transport, terminals, MCP, queue, branches, snapshots, provider auth, utilities, LLM inspection, recording |
| `apps/control-plane/src/index.ts` | 1,212 | 79 | composition root + all HTTP routes |
| 9 more files | 1,000–1,200 | — | agent-tools, daemon agent, db, Automations.tsx, followed-prs, pull-requests, config, daemon index, guest |

The three biggest files are also the three most-changed files. That is the whole story: the code
that changes most often is the code with the least structure and the least test coverage.

## 1. Pragmatic Programmer — 4/10 (3 of 7 rows pass)

| Row | Pass | Evidence |
|---|---|---|
| DRY: each piece of knowledge has one source | No | The provider list `["claude-code","devin","codex","cursor","pi","opencode","fx"]` is defined in `packages/protocol` and again in `packages/sessionboxer-mcp/src/index.ts`. Provider display names exist in `PROVIDER_LABELS` and again as "the Claude Code CLI"… in `provider-login.ts`. Which secret key means "logged in" is encoded in `apps/web/src/providers.ts`, in `index.ts:452-456`, and in five `*AuthRefreshed` handlers. |
| Orthogonality: one change touches one place | No | Adding a provider today touches ≥9 files (protocol enum, protocol `Daemon<P>AuthParams`/`Changed` schemas, `DAEMON_METHODS`, daemon `index.ts` setup + `authSet` case, `SessionManager.push<P>Auth` + `ToAll`, `index.ts` `<P>AuthRefreshed` handler + settings-update hook, `provider-login.ts`, web `providers.ts`, MCP package). The five provider additions in git history each confirm this. |
| Tracer bullets: thin end-to-end slices | Yes | ADRs 0063–0079 show features landing as working slices behind a flag/section, then widened. |
| Design by contract: preconditions explicit | Partly | Zod parses every RPC boundary (good). Internal invariants are implicit: `SessionManager` methods take a bare `id: string` and throw ad hoc `Error`s ("the Agent has no session yet") with no shared error type on the daemon side. |
| Broken windows: no tolerated rot | Partly | Zero TODO/FIXME, zero commented-out code, zero empty `catch` blocks in TypeScript. Clean — but there is also no lint gate, so nothing stops the first window. |
| Reversibility: vendors behind seams | Yes | Docker/QEMU behind `windows`/`macos` adapters; GitHub/Bitbucket behind connector classes; ACP providers behind `AgentManager` options. |
| Estimation and knowledge portfolio | Yes | Research docs under `docs/research/` precede every large feature; ADRs record the decisions. |

**To reach 10/10:** one provider registry (§ Fix 1), a lint gate (§ Fix 4), and a typed daemon
error (§ Fix 6).

## 2. Clean Code — 4/10 (4 of 10 rows pass)

| Row | Pass | Evidence |
|---|---|---|
| Understand each function without its body | Partly | Names are good (`forkWithHandoff`, `pumpQueue`, `providerUnavailableIn`). Components are not: `SettingsView` is 1,400 lines; you must read it. |
| All functions under 20 lines | No | Many `SessionManager` methods and all four top-level React components are hundreds of lines. |
| Zero commented-out code | Yes | |
| Error handling separate from logic | Partly | Routes do `try { … } catch (e) { throw new HttpError(...) }` consistently; daemon handlers throw bare `Error`. |
| Each class has one responsibility | No | `SessionManager` has at least 12 reasons to change (see table above). `App` owns routing, WebSocket, notifications, onboarding and three dialogs. |
| Test for every public method | No | 5 test files cover telemetry, attachment paths, auth origin, desktop tool descriptions, audit tooling. `SessionManager`, `Automations`, `db` migrations, `config` settings merging, `App.tsx`: zero tests. |
| Test names describe behavior | Yes | e.g. `"rewrites a path under the attachments root"`. |
| Duplication below 3 occurrences | No | The `*AuthRefreshed` block in `index.ts:201-263` is the same 11 lines × 5. `push<P>Auth`/`push<P>AuthToAll` is the same pair × 5. Daemon `provider === "x" ? new AuthFile(...) : null` × 5. |
| Magic numbers named | Yes | Timeouts and limits are named constants throughout (`TICK_MS`, `LIST_POLL_MS`, `STAGED_MAX_AGE_MS`). |
| Tests run under 10 s | Yes | Each test file runs in < 2 s after `tsc -b`. |

## 3. Refactoring Patterns — smells by name

| Smell | Where | Named refactoring |
|---|---|---|
| **Large Class** | `SessionManager` (3,208 lines, 171 methods when written; 2,894 after fix 7) | Extract Class: `ProviderAuthSync`, `SessionQueue`, `SnapshotPolicy`, `RepoSync` — each already a cluster of methods that share no state with the others except `db` and `daemonCall`. Done: `ProviderAuthSync` (fix 1, `provider-auth.ts`), `SessionQueue` (`session-queue.ts`: the saved-messages queue and the Agent-to-Agent origins) and `SnapshotPolicy` (`snapshots.ts`: take/auto/prune/delete/collect, the per-Session chain rebuilds share), each behind an explicit deps object with one-line delegations left in `SessionManager`. Open: `RepoSync`. |
| **Large Class / Divergent Change** | `App.tsx` components | Extract Component: move `SettingsView`, `NewSession`, `SessionView` into their own files (structure-only, zero behavior change), then Extract Hook for the state clusters inside `SettingsView`. |
| **Duplicated Code** | 5× `*AuthRefreshed`, 5× `push*Auth(ToAll)`, 5× daemon `AuthFile` setup | Form Template Method / Replace with a provider table: one `ProviderAuth` descriptor per provider holding `secretKey`, `isNewer`, `daemonMethod`, `paramsOf`. |
| **Shotgun Surgery** | adding a provider = 9+ files | Same fix as above; the table becomes the single change point. |
| **Switch Statements on type code** | `provider === "…"` × 16 in daemon `index.ts`; `switch (provider)` in web `providers.ts` | Keep. These encode genuinely different per-provider behaviour (env vars, MCP config writer, usage command). Replacing with polymorphism would hide the differences; a table of descriptors is enough. |
| **Primitive Obsession** | `id: string` for sessions, snapshots, automations, PRs everywhere | Low priority; Zod `.brand()` on the id schemas would catch mix-ups at compile time without runtime cost. |
| **Long Parameter List** | `AgentManager` options object (~20 keys, provider-conditional spreads) | Introduce Parameter Object per provider: `providerAgentOptions(provider, guest)` returning the spread. Extract Function only; no behaviour change. |
| **Speculative Generality** | none found | — |

## 4. A Philosophy of Software Design — 5/10 (4 of 8)

| Row | Pass | Evidence |
|---|---|---|
| Describe each module in one sentence | Partly | `@sessionboxer/protocol`: "every type two processes share" — true but not a design decision, a dumping ground. `SessionManager`: cannot be done in one sentence. |
| Interfaces simpler than implementations | Yes | `daemonCall(id, method, params)`, `Automations`, `AgentManager` are deep: small surface, lots of behaviour. |
| Change implementation without touching callers | Partly | Docker vs QEMU yes; provider internals no (see § 1). |
| Interface comments describe the abstraction | Yes | Top-of-class comments are good and explain *why* (`// Codex rotates its ChatGPT tokens inside the Sandbox…`). |
| Design discussion in reviews | Yes | 79 ADRs. |
| Each module hides an important decision | Partly | `protocol/index.ts` hides nothing: it is the sum of everyone's types. Splitting it by domain (`sessions.ts`, `daemon.ts`, `mcp.ts`, `automations.ts`, `prs.ts`, `utilities.ts`) with `index.ts` re-exporting keeps every import path working and makes `git blame`/conflicts tractable. |
| Newcomer understands boundaries without reading implementations | No | The boundary between `index.ts` (routes) and `SessionManager` is not stated; some HTTP-level logic (settings-update → `push*AuthToAll`) lives in the composition root. |
| 10–20% time on design | Yes | ADR + research cadence. |

## 5. Working Effectively with Legacy Code — the safety-net map

Change points for every fix below sit in `sessions.ts`, `index.ts`, `App.tsx`, daemon `index.ts` —
all untested. Test points and seams that already exist:

| Change point | Test point / seam | Characterization test to write |
|---|---|---|
| provider auth push & refresh | `SessionManager` ctor takes `db`, `docker`, `settings()`, `log`, `push` — a constructor seam. `daemonCall` is one method to stub. | For each provider: stored secret → `push<P>Auth` calls `daemonCall` with the method/params observed today. `<P>AuthRefreshed` with older/newer JSON → settings saved or ignored, as today (pin `*AuthNewer` quirks). |
| `applySettingsUpdate` / `config.ts` | pure functions, no seam needed | Golden master: current defaults + a few updates → exact JSON. Pins the "preserve explicit `sessionboxerMcp.policy`" rule. |
| `db.ts` migrations | `better-sqlite3` in-memory (already used by `auth-origin.test.mjs`) | Open empty DB, run migrations, assert the 24 table names and key columns. Pins schema. |
| `protocol/index.ts` split | types only | `tsc -b` is the test; plus one test that `PROVIDERS` is the only provider list (grep-style, in `scripts/`). |
| `App.tsx` component moves | none (no React test runner) | `npm run build` + the existing UI testing skill; moving a component to its own file is a Move-only refactor with import changes verified by `tsc`. |

Tests go next to the existing ones in `scripts/*.test.mjs` importing from `dist/`, run with
`node --test`, wired into `package.json` and `ci.yml` like `test:auth`. Introducing Vitest for the web
is a separate decision (would be the first React test; worth it only once `App.tsx` is split).

## Prioritised fixes

**Status (2026-10-03):** 1–6 are on `main` — e63d067 (provider registry: `apps/control-plane/src/provider-auth.ts`,
`npm run test:provider-auth`), 02fa4f8 (`npm run test:schema`), 7258657 (App.tsx split; move-only),
9f284e0 (lint gate, `npm run lint`), 77dc012 (protocol split by domain; move-only, acyclic barrel),
fbd8c9b (`DaemonError` + `DAEMON_ERROR_CODES`, ADR-0080, `npm run test:daemon-errors`). 7 is on `main` too —
b1b575d (SessionManager harness: `scripts/session-manager.test.mjs`, 30 characterization tests through the public
surface, `npm run test:session-manager`), 7acb654 (`SessionQueue` → `apps/control-plane/src/session-queue.ts`) and
b671bbe (`SnapshotPolicy` → `apps/control-plane/src/snapshots.ts`); `ProviderAuthSync` had landed as the
provider registry of fix 1. `SessionManager` is 2,894 lines; `RepoSync` is the next cluster to pull out, with the same harness.

Ordered by risk-reduction per hour. Each is a behaviour-preserving commit on its own; none depends on
the one after it.

1. **Provider registry (DRY + orthogonality).** `packages/protocol`: a `PROVIDER_AUTH` table typed
   `Record<Provider, { secretKeys, daemonSetMethod, … }>`; `sessionboxer-mcp` imports `PROVIDERS`
   instead of redeclaring it; `provider-login.ts` display names derive from `PROVIDER_LABELS`.
   `SessionManager`: one `pushProviderAuth(id, provider)` / `pushProviderAuthToAll(provider)` replacing
   ten methods; `index.ts`: one `providerAuthRefreshed(provider)` factory replacing five blocks.
   Guard: characterization tests above, written first. Adding provider #8 then touches the table,
   the daemon setup and the UI policy switch — three places, all of them typed so `tsc` finds the rest.
2. **Safety-net tests for `config.ts` and `db.ts`** (settings golden master, migration schema). These
   are the two files where a silent mistake loses user data; they are pure/in-memory and cheap to pin.
3. **Split `App.tsx` by component** — move `SettingsView`, `NewSession`, `SessionView` to their own
   files, no other change. Cuts the 125-commit hotspot into four; makes merge conflicts between
   sibling sessions rarer. Follow-up (separate commit): `useSettingsForm()` hook for `SettingsView`.
4. **Lint gate.** `eslint` with `typescript-eslint` recommended + `no-empty` + `no-floating-promises`,
   run in CI. The codebase likely passes already, so the cost is the config; the
   value is that broken windows cannot appear.
5. **Split `packages/protocol/src/index.ts` by domain** with a re-exporting `index.ts`. Zero import
   changes elsewhere. Do this after 1 so the provider table lands in `providers.ts`.
6. **Daemon `DaemonError`** with a code (`no_agent_session`, `wrong_provider`, …) replacing bare
   `Error` in the RPC handler, mirrored by `HttpError` on the Control Plane side. Small; gives the UI
   something to switch on.
7. **Extract `ProviderAuthSync`, `SessionQueue`, `SnapshotPolicy` from `SessionManager`** — only after
   1 and 2 give the class a test harness. This is the biggest payoff and the biggest risk; do not
   start it without the harness.

Not recommended: replacing `provider === "x"` branches in the daemon with polymorphism (the branches
*are* the knowledge), introducing a state-management library in the web app, or splitting
`@sessionboxer/protocol` into several npm packages.

---

# Round 2 (2026-10-03, after fixes 1–7)

Same five skills, same diagnostics, run against `main` at 7315c4c. Baseline now: `npm run lint`,
`typecheck`, `build`, 8 test suites (88 tests, 1,616 lines) in CI; jscpd (≥70 tokens, ≥8 lines) finds
38 clone pairs = 0.9 % of tokens.

## The shape of the codebase, now

| File | Lines | Round 1 | What changed |
|---|---|---|---|
| `apps/control-plane/src/sessions.ts` | 2,894 | 3,208 | `SessionQueue`, `SnapshotPolicy`, provider auth out; 147 methods remain, 92 `HttpError` throws |
| `apps/web/src/SettingsView.tsx` | 1,732 | (in App.tsx) | 64 `useState`, one 1,400-line component — the biggest React file |
| `apps/web/src/App.tsx` | 1,322 | 4,475 | still 50 `useState`: routing, WebSocket, notifications, onboarding, dialogs |
| `apps/control-plane/src/agent-tools.ts` | 1,176 | — | one 44-case `switch (tool)` dispatch (fine: table-shaped) |
| `apps/control-plane/src/index.ts` | 1,149 | 1,212 | 166 routes, all thin except `/fs/raw`, `/fs/app`, `/ws` (27–45 lines) |
| `packages/sandbox-daemon/src/agent.ts` | 1,147 | — | unchanged |
| `packages/protocol/src/index.ts` | 36 | 5,286 | barrel over 34 domain files |

## Scores

| Skill | Round 1 | Round 2 | Rows still failing |
|---|---|---|---|
| Pragmatic Programmer | 4/10 | 8/10 | DRY (partly: the clone pairs below); broken windows (partly: see § housekeeping) |
| Clean Code | 4/10 | 6/10 | functions under 20 lines (`fork` 120, `createClaimed` 87, `prompt` 50); error handling separate from logic (partly: domain classes throw `HttpError` with statuses — 92 in `SessionManager`, 14 `Automations`, 15 `PullRequests`, 19 `FollowedPrs`); SRP (partly); test per public method (no: `Automations`, `PullRequests`, `FollowedPrs`, routes, all of `apps/web`) |
| Refactoring Patterns | — | 7/10 | Long Method; Duplicated Code (pairs, no triples left); polymorphism where apt (partly: `WindowsVms`/`MacosVms` both implement `GuestVms` yet copy ~100 lines instead of sharing a base) |
| Philosophy of Software Design | 5/10 | 7/10 | one-sentence module (`SessionManager` still no); each module hides a decision (partly: `Prs.tsx` and `PullRequests.tsx` both own "how a PR's threads and checks render"); newcomer boundaries (partly: route ↔ `SessionManager` ↔ deps-object classes is now a visible pattern but unwritten) |
| Working with Legacy Code | — | 7/10 | every fix in round 1 landed with pins first; the untested classes above are the next change points |

## Duplicated knowledge (jscpd pairs that matter)

| Pair | Lines | What it is | Verdict |
|---|---|---|---|
| `Prs.tsx` `FollowedPrDetail` ↔ `PullRequests.tsx` `PrPane` | 160 (60 differ) | checks list + "Comments & reviews" thread list with select-all / show-resolved | Extract Component `PrThreads` (identical part); the differences are real (followed PRs have no "addressed" state, no "all failed" selection) and stay in the callers as props |
| `windows.ts` `WindowsVms` ↔ `macos.ts` `MacosVms` | ~100 across 6 clones | `start/stop/state/remove/diskUsage`, create-volume-then-cleanup, install log follower, "N Sessions still use the base disk" | Pull Up Method into an abstract `QemuVms` in `vm-host.ts`; the guest-specific parts (`guestEnv`, OpenCore files, SSH provisioning) stay in the subclasses |
| `McpServersEditor.tsx` ↔ `UtilitiesEditor.tsx` `KeyValueList` | 45 | the same name/value/secret row editor | one component in `ui.tsx`, `placeholder` and `allowSecret` as props |
| `code-proxy.ts` ↔ `desktop-proxy.ts` | 22 | WebSocket bridge: buffer-until-open, close-both | Extract Function `bridgeSockets(client, upstream)`; the websockify 1005 workaround is a parameter |
| daemon `bb-credentials.ts` ↔ `gh-credentials.ts` | 22 | `unquote`/`yamlKey`/`yamlString` for the `gh`/Bitbucket hosts files | move to `yaml-lite.ts` |
| `followed-prs.ts` ×13, `PullRequests.tsx` ×9 `provider === "github"` | — | mostly genuinely different API paths (keep); ~8 are display facts ("GitHub"/"Bitbucket", ` on ${host}`) | a `PR_HOST` table next to `PR_PROVIDER_LABEL` for the display facts only |

Not duplication worth touching: `host-sync.ts`/`workspace-sync.ts` (a 12-line `sha256` helper on
different sides of the wire), `settings.ts`/`session-settings.ts` schema shapes (the per-session
override mirrors the global on purpose), `agent.ts` 523/548 (two symmetric branches).

## Housekeeping (broken windows)

- `sessions.ts`: `boot`, `create`, `createClaimed`, `fork`, `provision`, `startSandbox`, `prompt` sit
  under the `// --- Terminals` header (lines 1098–1716); the lifecycle header was never written. Add
  `// --- Lifecycle` and `// --- Prompting` headers; move nothing.
- `fork()` is 120 lines doing five things (validate, pick settings, snapshot or reuse image, create
  the row, hand off). Extract Method ×4 after pinning it in the harness.
- Two `TODO`s, four `eslint-disable`/`@ts-expect-error` in 66 k lines: fine.

## Safety-net map, round 2

| Change point | Seam | Characterization test to write |
|---|---|---|
| `Automations` (706 lines, 0 tests; a wrong tick creates Sessions at the wrong time) | `AutomationDeps` object; `parseCron`/`scheduleOf`/`fillPlaceholders`/`preview` are pure | pure functions: cron → next 3 occurrences in a timezone, DST day; placeholders; `create`/`update` 400s; `tick()` with a fake `sessions` and a fixed `Date` → which runs start |
| `fork()` / `createClaimed()` | the existing `makeManager()` harness | fork from snapshot vs live, cross-provider refusal (400), `conversation: "continue"` rules, handoff cap |
| `WindowsVms`/`MacosVms` pull-up | `VmHost` is a class the ctor receives | fake `VmHost` recording calls: `create` cleans the volume on failure, `removeBase` refuses with N Sessions |
| `PrThreads`, `KeyValueList`, `SettingsView` sections | none (no React runner) | `tsc` + `npm run build`; move-only extractions verified by line-diff as in fix 3 |

## Prioritised fixes, round 2

Ordered by risk-reduction per hour; each a behaviour-preserving commit with its pins first.

8. **`KeyValueList` → `ui.tsx`; daemon `yaml-lite.ts`; `bridgeSockets()`.** Three mechanical
   de-duplications, ~90 lines removed, `tsc` is the test.
9. **`Automations` characterization tests** (`npm run test:automations`). The one untested class
   that acts on a timer.
10. **`sessions.ts` housekeeping**: section headers; pin `fork()` in the harness, then Extract Method.
11. **`SettingsView` split by section** — `EnvironmentSettings`, `AgentSettings`, `McpSettings`,
    `AutoQaSettings`, `DebugSettings` as files, move-only like fix 3; then the state hook per section.
12. **`PrThreads` component** shared by `FollowedPrDetail` and `PrPane` (the 100 identical lines).
13. **`QemuVms` base class** for `WindowsVms`/`MacosVms`, with the fake-`VmHost` pins first.
14. **`PR_HOST` display table**; `RepoSync` out of `SessionManager` (next cluster, same harness).

**Status (2026-10-03):** 8–10 are on `main` — bc457dc (`apps/web/src/KeyValueList.tsx`,
`packages/sandbox-daemon/src/yaml-lite.ts`, `apps/control-plane/src/ws-bridge.ts`; what differed between the copies
travels as props/`BridgeOptions`), 7b6274c (`scripts/automations.test.mjs`: 28 characterization tests,
`npm run test:automations` in CI; `scripts/fixtures.mjs` holds the Session row fixture both harnesses use),
1890e14 (section headers), 4c5f36a (four `fork()` pins in the SessionManager harness) and 9fbdea2 (`fork()` → 15 lines
over `assertForkable`, `forkDockerMode`, `forkedSession`/`forkSettings`, `recordFork`, `launchFork`; bodies moved
verbatim). 13 is on `main` — bf99908 (`scripts/guest-vms.test.mjs`: 31 characterization tests of `WindowsVms`/`MacosVms`
through a fake `VmHost` passed as an optional trailing constructor argument, `npm run test:guest-vms` in CI) and 45ba2ad
(`apps/control-plane/src/qemu-vms.ts`, 149 lines: `abstract class QemuVms<Base, Status> implements GuestVms` with
`start`/`stop`/`state`/`remove`/`diskUsage`, `vmName`/`kvmUnavailable`, the base record and `setBase`, `removeBase` with
the "N Sessions still use the base disk" refusal as `assertBaseUnused`, and `createOnVolume` = Session volume, platform
container, volume removed again on failure; `windows.ts` 368 → 305 lines, `macos.ts` 884 → 822; bodies moved verbatim,
pins unchanged). Not pulled up: the two install-log followers — macOS's also flips the phase on "Booting macOS", passes
`provisioned`/`reprovision` to `finishInstall` and clears its poll timer, so they differ in more than names. Gate on
HEAD: lint, typecheck, build, 11 suites green. 11 is on `main` — f569174 (move-only: `apps/web/src/SettingsView.tsx`
1,732 → 492 lines; one file per section under `apps/web/src/settings/` — `ProvidersSettings`, `EnvironmentSettings`,
`AgentSettings`, `McpSettings`, `UtilitiesSettings`, `AutoQaSettings`, `InterfaceSettings`, `DevicesSettings`, plus
`shared.ts`; the moved bodies line-diffed against the original: 0 non-plumbing lines) and 0d1dba3 (`useSectionState` in
`shared.ts` and one `use<Section>Settings(settings)` next to each section component, returning `{ values, set, dirty }`;
`SettingsView.tsx` 492 → 260 lines; on a worked example that fills every control of every section the
`PUT /api/settings` body is byte-identical before and after). 12 is on `main` — aa966e6 (`apps/web/src/PrThreads.tsx`, 346 lines:
`usePrSelection(items, checks)` for the selection set, show-resolved switch, visible items, threads and sorted/failed
checks, plus `PrChecks` and `PrThreads`; `FollowedPrDetail` 971 → 814 lines, `PullRequests.tsx` 837 → 609; JSX moved
verbatim — the moved blocks line-diffed against both originals: 0 non-plumbing lines; the action menus, the "all failed"
selector, the addressed-state labels and the select-all / self-author titles travel as props). jscpd
`apps/web/src --min-lines 10`: 273 → 151 duplicated lines, 17 → 12 clones; the four `Prs.tsx` ↔ `PullRequests.tsx`
clones left are the breadcrumb/toolbar header, not the PR blocks. 14 is open.

Deliberately not recommended: replacing `HttpError` in the domain classes with a domain error type
and one HTTP mapping. It is the textbook fix for "error handling mixed with logic", but every
message is already user-facing and status-correct, nothing switches on the strings, and the change
would touch ~150 throws for no behaviour gain. Revisit only if a second transport (CLI, MCP) starts
needing different mappings.

---

# Round 3 (2026-10-03, after fixes 8–13, `33dab0a`)

Same five skills, same method. Round 2's list is done except item 14. The gate is lint + typecheck +
build + 10 node suites (151 tests) + the Python audit test, in CI.

## The shape of the codebase, now

| File | Lines | Round 2 | What changed |
|---|---|---|---|
| `apps/control-plane/src/sessions.ts` | 2,952 | 2,894 | `fork()` split (+pins, +headers); 151 methods; still the file with the most 90-day churn in the Control Plane (89 commits) |
| `apps/web/src/App.tsx` | 1,322 | 1,322 | untouched: 50 `useState`, a 175-line WebSocket effect switching on 27 message types, a 219-line `sessionEntry` closure; 126 commits in 90 days — the most-changed file in the repo |
| `apps/control-plane/src/agent-tools.ts` | 1,176 | 1,176 | table-shaped dispatch (fine) |
| `apps/control-plane/src/index.ts` | 1,149 | 1,149 | 161 routes in one file: 65 `/sessions`, 21 `/prs`, 9 `/auth`, 8 `/schedules`, 8 `/automations`… |
| `packages/sandbox-daemon/src/agent.ts` | 1,147 | 1,147 | `AgentManager.start` 146 lines; 0 tests |
| `apps/web/src/Automations.tsx` | 1,067 | 1,067 | `AutomationForm` 615 lines, 31 `useState` |
| `apps/control-plane/src/followed-prs.ts` / `pull-requests.ts` | 1,052 / 1,047 | — | poll on timers; 0 tests; `PullRequests.poll` 126 lines |
| `apps/web/src/SessionView.tsx` | 1,017 | 1,017 | `SessionView` 651 lines, 27 `useState` |
| `apps/web/src/SettingsView.tsx` | 260 | 1,732 | eight section files under `settings/`, one state hook each |
| `apps/web/src/Prs.tsx` / `PullRequests.tsx` | 814 / 609 | 971 / 837 | `PrThreads.tsx` (346) holds the shared part |
| `apps/control-plane/src/windows.ts` / `macos.ts` | 305 / 822 | 368 / 884 | `qemu-vms.ts` (149) holds the shared part |

Function sizes (TypeScript AST over `apps/*/src`, `packages/*/src`; 2,596 functions): 80 % are under
20 lines, 141 are 50 or more, 24 are 200 or more. Of those 24, 22 are React components or closures
inside them; the other two are `vscodeColors` (a 308-line theme table) and the daemon's `handle()`
(197 lines, 49 `case`s — a dispatch table). The Control Plane's longest non-table methods are
`Connectors.start` (141), `provisionScript` (137), `PullRequests.poll` (126). The long-function
problem is now a web-app problem.

Duplication (`jscpd --min-lines 10 --min-tokens 70` over `apps`, `packages`, `scripts`; 272 files,
70,219 lines): 19 clones, 289 lines, 0.41 % — about half of round 2's, and no clone is over 33 lines.

## Scores

| Skill | Round 1 | Round 2 | Round 3 | Rows still failing |
|---|---|---|---|---|
| Pragmatic Programmer | 4/10 | 8/10 | 8/10 | DRY (partly: the five pairs below, two of them knowledge rather than text); broken windows (partly: three schemas filed under `speech.ts`; nothing watches file sizes, so the next 1,700-line file will arrive the way `SettingsView` did) |
| Clean Code | 4/10 | 6/10 | 7/10 | functions under 20 lines (no: 24 over 200, all but two in `apps/web`); test per public method (no: `PullRequests`, `FollowedPrs`, `Connectors`, `AgentManager`, every web component); error handling separate from logic (unchanged, see "not recommended") |
| Refactoring Patterns | — | 7/10 | 8/10 | Long Method (React); Duplicated Code is pairs under 35 lines |
| Philosophy of Software Design | 5/10 | 7/10 | 8/10 | `App.tsx` is still "everything the shell does" with no one-sentence description; `speech.ts` hides nothing it says it does; newcomer boundaries still unwritten (`DESIGN.md` stops at the container picture; the route → class → deps-object pattern lives only in the code) |
| Working with Legacy Code | — | 7/10 | 8/10 | every round-2 fix landed pins first and the pins passed unchanged across the moves; the untested change points left are PR sync (two timer-driven classes) and the web app |

Round 2's moves held up: `useSectionState` is 17 lines and a plain `useState` in disguise;
`PrChecks`/`PrThreads` take 5 and 7 props and the callers' differences are visible in the prop
names; `QemuVms` is a real pull-up (one odd corner: `protected abstract readonly installing: object | null`
exists only so the base can ask "is an install running" — a `protected abstract installing(): boolean`
would say that).

## Duplicated knowledge, round 3

| Pair | Lines | What it is | Verdict |
|---|---|---|---|
| `packages/computer-use-mcp/src/utilities.ts` `totp()` ↔ `packages/protocol/src/utilities.ts` `totpCode()` | 24 | RFC 6238: HMAC-SHA1 over the counter, dynamic truncation, base32 decoding — once sync over `Buffer`, once async over WebCrypto | the same knowledge in two packages, and `computer-use-mcp` already depends on `protocol`. Keep one: the MCP's `fillUtilityPlaceholders` becomes async (its callers already are) and calls `totpCode` |
| `apps/control-plane/src/docker-engine.ts` ↔ `apps/desktop/src/docker.ts` | 33 | where the Docker socket may be: the same eight candidate paths | imposed duplication (the Electron shell packs no workspace packages, by design). Board it up: a test that both `dockerSocketCandidates()` lists are equal, so they cannot drift silently |
| `sessions.ts` `createClaimed` ↔ `forkedSession` | 16 | the 25 default fields of a new `Session` row (`containerId: null`, `queueRunning`, `usage`, `usb`, `pinned`…) | Extract Function `newSessionRow(...)`; the fork's two differences (`queueRunning`, `folderId`) stay at the call site. Adding a Session field today means two edits and no error if you miss one |
| `UtilitiesEditor.tsx` `CredentialList` ↔ `KeyValueList.tsx` | 15 | fix 8 unified two of the three name/value/secret editors; the Utility credentials one still has its own copy | `KeyValueList` with `nameList` (the datalist), `valuePlaceholder(kv)` and `multiline(kv)` props; the `ssh_key` textarea and the `totp` hint are the real differences |
| `settings/EnvironmentSettings.tsx` `WindowsBase` ↔ `MacosBase.tsx` | 12 + 13 | `act()` (working/error/confirm-delete around a base-disk call) and the "Checking the base disk…" / started-at line | a `useBaseDiskAction()` hook; the two status shapes stay different |

Not worth touching: `docker-engine`'s probe order itself, `host-sync.ts`/`workspace-sync.ts`
(different sides of the wire), `session-settings.ts` (the override schema mirrors the global on
purpose), `mcp-config.ts` 76/120 (tmpfs-and-symlink for two agents' config files — 10 lines, two
different file names and shapes), `sessionboxer-mcp` 457/491 (a create and an update tool whose
schemas differ in descriptions and defaults), `DockerIcon`/`EnvironmentIcon` (SVG).

## Housekeeping (broken windows)

- `packages/protocol/src/speech.ts` holds `SandboxImageStatus`, `WindowsBaseStatus` and
  `MacosBaseStatus` (lines 37–113) between the Whisper model list and `SpeechStatus`; `events.ts`
  imports the VM statuses from `./speech.js`. Fix 5's split filed them with their neighbours in the
  old barrel. Move them to `sandbox-image.ts` and `vm-bases.ts` (move-only; the barrel re-exports).
- `QemuVms.installing` as above.
- Nothing watches sizes. `SettingsView` reached 1,732 lines over 40 commits without anyone deciding
  it should. A size budget in CI (`scripts/size-budget.mjs`: the current line count of every file over
  600 lines, rounded up; fails when one grows past its number; lowering a number is a one-line edit)
  is the "boiled frog" monitor the Pragmatic Programmer asks for. Same for jscpd: `--threshold 0.5`.
- `DESIGN.md` has the container picture and the MVP decisions; it does not say how the Control Plane
  is put together (route handlers are thin and `throw HttpError`; each domain is a class behind a
  `*Deps` object constructed once in `index.ts`; every class with a timer has a harness under
  `scripts/`). Twenty lines there would save every newcomer — and every child session — a reading.

## Safety-net map, round 3

| Change point | Seam | Characterization test to write |
|---|---|---|
| `FollowedPrs` (1,052 lines, 0 tests, polls GitHub/Bitbucket on a 10 s tick, creates Automation runs) | `FollowedPrDeps`; `GhTransport`/`BbTransport` are one-method interfaces | fake transports replaying recorded JSON: `fetchThreads`/`fetchChecks`/`fetchBbActivities`/`fetchBbBuilds` → the `PrItem`/`PrCheckItem` lists (hand-written expectations from the fixtures); `tick()` with a changed list → which events, which runs, dedupe on head SHA, debounce; `filterReason`; `describeFollow` |
| `PullRequests` (1,047 lines, 0 tests) | `PullRequestDeps` (`daemonGhApi`, `prompt`, `enqueue` are functions) | `attach` 400s, `poll()` → `pr_activity` once idle, `action` → `buildPrompt` text for each action, Bitbucket vs GitHub paths |
| `App.tsx` WebSocket effect (27 message types → 14 `set*` calls) | none yet; the switch body is a pure `(state, msg) → state` waiting to be named | after extraction, a `feedReducer` test: each message type → the state change, in `node:test` without React |
| `Connectors.start` (141 lines), `AgentManager.start` (146 lines) | `GhCli`/`fetch` in `Connectors`; `AgentTransport` in `AgentManager` | later: the ACP handshake needs a scripted fake agent; not this round |

## Prioritised fixes, round 3

Ordered by risk-reduction per hour; each a behaviour-preserving commit with its pins first.

15. **Housekeeping batch** (tsc is the test): `speech.ts` → `sandbox-image.ts` + `vm-bases.ts`;
    `newSessionRow()`; `totp` once; `KeyValueList` for Utility credentials; the docker-engine
    equality test; `QemuVms.installing()`. ~1 session.
16. **PR sync characterization tests** (`npm run test:pr-sync`): `FollowedPrs` and `PullRequests`
    through their deps objects and fake transports with recorded fixtures. The two timer-driven
    classes without a harness; the next PR-provider change (a third host, a GitHub API version)
    lands blind otherwise.
17. **`App.tsx` split**: `useSessionFeed()` with a pure `feedReducer` (the WebSocket effect, pinned
    under node:test), `Sidebar.tsx` (`sessionEntry` + the 13 sidebar states + folders drag/drop),
    move-only like fix 3, browser-checked. 1,322 → ~600.
18. **Routes by domain**: `apps/control-plane/src/routes/{sessions,prs,auth,automations,…}.ts`,
    each `register(api, deps)`; `index.ts` keeps the composition root. Move-only; the test is a dump
    of `method + path` for every route before and after (identical) plus the gate.
19. **Size budget + jscpd threshold in CI**; the twenty lines in `DESIGN.md`.
20. **`AutomationForm` and `SessionView`** the `SettingsView` way (sections, one state hook each) —
    only once 17 has shown the pattern holds for a component with a live WebSocket feed.

**Status (2026-10-03):** 15 is on `main` — 66a75ee: `packages/protocol/src/sandbox-image.ts` and `vm-bases.ts`
(move-only, bodies identical; `speech.ts` 158 → 81 lines), `newSessionDefaults()` in `sessions.ts` (the fork spreads it and
overrides `queueRunning`/`folderId`, key order kept), `computer-use-mcp` on protocol's `totpCode` (its `fillUtilityPlaceholders`
is now async — a Sandbox image change, so it reaches Sessions after `npm run build:image`), `KeyValueList` with
`nameOptions`/`valuePlaceholder(kv)`/`multiline`/`labelTitle`/`newItemSecret` replacing `CredentialList`,
`QemuVms.isInstalling()`, and `scripts/cross-package.test.mjs` (`npm run test:cross-package`, in CI: the two Docker socket
lists are equal; `totpCode` answers the RFC 6238 appendix-B vectors). 16 is on `main` — 8a8c727 (the seam: `PullRequests` and
`FollowedPrs` take an optional trailing `PrTransports` factory defaulting to `tokenTransport`/`bitbucketTokenTransport`;
`followed-prs.ts` 1,052 → 1,055 lines, `pull-requests.ts` 1,047 → 1,058, `index.ts` untouched) and 5fb9382
(`scripts/pr-sync.test.mjs`, 1,651 lines, 41 tests, `npm run test:pr-sync`, in CI: the pure helpers, the GitHub and
Bitbucket readers on hand-written payloads, `FollowedPrs` and `PullRequests` on an in-memory `Db` with fake transports;
one bug pinned as-is: `pollFollowNow` and the webhook hint `touchFollow` (polled_at = NULL) before the read, which
`pollFollow` takes as a baseline, so a PR first seen that way never gets `opened`). 18 is on `main` — 09fd9b1 (`scripts/route-table.mjs`: static extraction of the 171 `METHOD /path` routes in registration order, `npm run test:routes`, in CI) and fa5745d (`apps/control-plane/src/routes/*.ts`, 16 files + `deps.ts` with `RouteDeps`; `index.ts` 1,149 → 411 lines; the 8 overlapping pattern pairs each live in one file and keep their order; 13 handler lines changed beyond import plumbing, all `settings` → `settings.get()`/`.set()` and `applySettingsRequest` → `deps.applySettings`; 2 route tests added). 17 is on `main` — c94e3ad (`apps/web/src/Sidebar.tsx`, move-only: 585 of its 648 lines byte-identical to App's, the rest import/props plumbing; shared state stays in App as props) and 258a16e (`apps/web/src/feed.ts`: `feedReducer(state, msg)` over the 27 message types, pure, no React; `apps/web/src/useSessionFeed.ts`: `useReducer` + the unchanged `subscribe()` transport, reconnect refetch and the per-message side effects — navigate on `session_deleted`, banner on `snapshot_failed`, notifications for `pr_activity`/`pr_merged`, settings refetch on `windows_base`/`macos_base`, `userIsTyping` gate on `ui_hint`; `scripts/feed.test.mjs`, 26 tests via Node type stripping, `npm run test:feed`, in CI); `App.tsx` 1,322 → 548 lines; sidebar DOM before/after byte-identical for the same data in the browser (folders, drag-and-drop, branch tree, Snapshots/Fork from the sidebar, live status, synthetic PR toasts, delete-while-selected); pinned as-is: `session_deleted` leaves the Session's entry in `prs`. 19–20 are open.

Still not recommended: `HttpError` out of the domain classes (round 2's reasoning stands); a daemon
`AgentManager` harness (a scripted ACP agent is a project of its own; the daemon changes rarely —
27 commits in 90 days against 126 for `App.tsx`); unifying `host-sync`/`workspace-sync`.
