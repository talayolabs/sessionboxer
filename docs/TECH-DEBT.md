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
| **Large Class** | `SessionManager` (3,208 lines, 171 methods) | Extract Class: `ProviderAuthSync`, `SessionQueue`, `SnapshotPolicy`, `RepoSync` — each already a cluster of methods that share no state with the others except `db` and `daemonCall`. |
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

**Status (2026-10-03):** 1–5 are on `main` — e63d067 (provider registry: `apps/control-plane/src/provider-auth.ts`,
`npm run test:provider-auth`), 02fa4f8 (`npm run test:schema`), 7258657 (App.tsx split; move-only),
9f284e0 (lint gate, `npm run lint`), 77dc012 (protocol split by domain; move-only, acyclic barrel).
6–7 are open; 7 still wants the SessionManager harness.

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
