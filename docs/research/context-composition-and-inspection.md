# Research: what is the conversation's context made of, and can we inspect it?

Question: show statistics about what the agent's context window is composed of (system prompt,
tools, memory files, messages…) and let the user debug the *exact* components of the context
that is sent to the model.

Everything below was measured in a Sandbox from the current image (Claude Code 2.1.272,
claude-agent-acp 0.77.0, Agent SDK 0.3.270, Devin CLI 3000.10.27, ACP SDK 1.4.0) on
2026-09-19.

## 1. What is already flowing (and thrown away)

### 1a. ACP `usage_update`

Both agents send an ACP `usage_update` notification after every model reply and after a
compaction. The Control Plane already stores them in `events` (339 rows in this install's DB:
299 Claude, 42 Devin); the web UI drops them (`transcript-model.ts`: "not rendered").

```jsonc
// Claude, after a reply
{"sessionUpdate":"usage_update","used":29792,"size":1000000,
 "cost":{"amount":0.0497,"currency":"USD"},"_meta":{"_claude/origin":{"kind":"human"}}}
// Claude, rate-limit variant (subscription windows)
{"sessionUpdate":"usage_update","used":53755,"size":200000,
 "_meta":{"_claude/rateLimit":{"status":"allowed","rateLimitType":"five_hour",
   "unifiedWindows":{"five_hour":{"utilization":0.28,"resetsAt":…},"seven_day":{"utilization":0.11,…}}}}}
// Devin
{"sessionUpdate":"usage_update","used":11616,"size":262000,
 "_meta":{"cognition.ai/inputTokens":11476,"cognition.ai/outputTokens":140,"cognition.ai/cachedReadTokens":8192}}
```

`used` is the context occupancy after the last reply (input + cache read + cache write + output
of that request), `size` the window. Two quirks: Claude reports `size` as 200 000 in one
notification and 1 000 000 in the next for the same model (the adapter caches the window per
model key and a second code path still defaults to 200k) — take the largest seen per model;
and the `PromptResponse.usage` cumulative totals of the ACP spec are **not** filled by either
agent, so per-turn cost has to be derived by diffing consecutive `usage_update`s (Claude also
gives the running `cost` in USD; Devin gives per-request tokens in `_meta`).

This is enough for: a context meter (used / size, %), a per-turn token/cost line in the
transcript, session totals, and Claude's plan rate-limit windows. Zero Sandbox changes.

### 1b. The `/context` command over ACP

Claude Code's `/context` is a "local-only" slash command: the adapter passes it to Claude
Code, which answers without calling the model (it does call the token-count API per
category, which is free) and the answer comes back as an ordinary `agent_message_chunk`.
Sent through our own `/prompt` endpoint on a fresh session, this is the reply (abridged):

```
## Context Usage
**Model:** claude-sonnet-5   **Tokens:** 29.8k / 1m (3%)

| Category                 | Tokens | Percentage |
| System prompt            | 8.8k   | 0.9%  |
| System tools             | 13.2k  | 1.3%  |
| MCP tools (deferred)     | 5.4k   | 0.5%  |
| System tools (deferred)  | 17k    | 1.7%  |
| Memory files             | 2k     | 0.2%  |
| Skills                   | 2.1k   | 0.2%  |
| Messages                 | 3.8k   | 0.4%  |
| Free space               | 937.2k | 93.7% |
| Autocompact buffer       | 33k    | 3.3%  |

### MCP Tools           (one row per tool: mcp__desktop__stop_recording | desktop | 1.1k …)
### Memory Files        (User | /home/agent/.claude/CLAUDE.md | 2k)
### Skills              (dataviz | Built-in | ~480 …)
```

So the category breakdown the user asked for exists today, per session, on demand — for
Claude. Our Sessionboxer instructions (system-prompt append) are counted inside "System
prompt"; the desktop MCP costs 5.4k tokens of schemas (with Claude's tool-deferral they sit
outside the window until first used). Devin's CLI also advertises `context` and
`session-stats` in its `available_commands_update`; not exercised yet.

Two caveats seen live: the adapter delivered the table **twice** in one turn (once from the
`local_command_output` stream, once from the `result`), so a UI feature must de-duplicate;
and the SDK has a *structured* twin of this table (`SDKContextUsage` on the result message,
`query.getContextUsage()` with `detail: 'summary' | 'full'`) that claude-agent-acp does not
forward — it only forwards the markdown. Parsing the markdown is straightforward (fixed
headings, `12.3k` numbers) but an upstream PR to attach `context_usage` in `_meta` would be
the clean fix.

### 1c. Claude's transcript files

Claude Code writes `/home/agent/.claude/projects/-workspace/<session>.jsonl` inside the box:
one line per user/assistant message with the full content blocks *and* the API `usage` of
each assistant message (`input_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, `output_tokens`, thinking tokens). It does not contain the system
prompt or tool schemas. Useful for post-hoc per-message accounting; it is already inside every
snapshot.

## 2. The exact bytes: capture the API requests in the Sandbox

The only place the *complete* context exists is the HTTPS request Claude Code sends to
`api.anthropic.com`. Since the agent runs in our container, we can put a logging reverse
proxy in front of it: Claude Code honours `ANTHROPIC_BASE_URL`, and — verified — it does so
with the subscription OAuth token too (the `Authorization: Bearer` header is simply forwarded).
A 40-line Node proxy on `127.0.0.1:8787` in the box, `claude -p "Say just hi."` with the
variable set, gave a complete picture of one turn:

| Request | What it was | Size |
|---|---|---|
| `GET /api/hello` | connectivity check | – |
| `POST /v1/messages` #1 | **hidden side call**: "You are naming a coding session…" (3 059-char prompt, no tools) | 1 168 input tokens |
| `POST /v1/messages` #2 | the real turn | 130 kB body |

Request #2 decomposed:

* `system`: 3 blocks — a 74-char billing header; "You are a Claude agent, built on Anthropic's Claude Agent SDK." (cache_control 1h); the 26 835-char main system prompt incl. our instructions and CLAUDE.md (cache_control 1h).
* `tools`: 25 schemas — Bash 11.8 kB, DesignSync 8.9 kB, Agent 8.6 kB, Monitor 7.6 kB, Workflow 5.4 kB, SendMessage 5.4 kB, ScheduleWakeup 4.6 kB … Write 1.0 kB (the MCP tools were deferred, so absent).
* `messages`: 2 (14.9 kB, includes injected system-reminder blocks).
* other keys: `metadata`, `max_tokens`, `thinking`, `context_management`, `output_config`, `stream`.
* response `usage`: `cache_creation_input_tokens: 45240` (1h cache), `input_tokens: 2`, `output_tokens: 6`.

That is exactly the "debug the components" view: every block with its size, which blocks are
cache-marked, what was cached vs re-sent, and the side requests (session naming, and on longer
sessions compaction summaries) that the transcript never shows. Consecutive requests can be
diffed to show what each turn added.

Constraints:

* **Privacy/size.** Bodies carry the whole conversation; the proxy must never log headers
  (the OAuth token), must stay bound to the container's loopback, and should be **off by
  default** (a per-session "Inspect API requests" switch). A request body grows with the
  conversation (130 kB for turn 1); keep per-request *summaries* (block sizes, usage, timing)
  for the whole session and full bodies only for the last N requests, in tmpfs so they are
  not snapshotted.
* **Streaming.** Claude Code uses SSE; the proxy must pipe the stream through untouched and
  only summarise the final `message_delta.usage`. Latency added was ~1 ms.
* **Devin.** The Devin CLI talks to Cognition's API; whether its endpoint can be redirected is
  not verified — assume 1a/1b only for Devin.
* **Token counts from bytes.** Requests give characters; the response gives total tokens. For
  per-block tokens either estimate (~3.6 chars/token for English prose, ~3 for JSON schemas)
  or call `POST /v1/messages/count_tokens` through the same proxy with the box's credentials
  (this is what `/context` does; free).

## 3. Proposal

**Stage 1 — statistics (no image rebuild, ~½ session).**
* Context meter in the session header from `usage_update` (`used`/`size`, %; Claude's cost;
  Devin's per-request tokens), max-of-sizes per model to hide the 200k/1m flip.
* Per-turn line under each turn: Δ tokens (input / cache read / cache write / output), Δ cost,
  compactions marked (`compaction_update` exists in ACP; check the adapter emits it).
* Claude plan rate-limit windows from `_claude/rateLimit` (5-hour / 7-day utilisation).
* A **Context** pane with a *Refresh breakdown* button: sends `/context` as a hidden prompt
  (flagged so the transcript does not show it), parses the tables into category bars, MCP tool
  list, memory files, skills; de-duplicates the doubled output. Same for Devin if its
  `/context` output is parseable.

**Stage 2 — inspector (image rebuild, ~1 session).**
* Daemon starts the capture proxy on loopback when the session's "Inspect API requests" switch
  is on and sets `ANTHROPIC_BASE_URL` for the agent process (restart-in-place, as for MCP
  changes). Summaries streamed to the Control Plane over a new notification; full bodies kept in
  tmpfs (last 20) and fetched on demand.
* Context pane, *Requests* tab: one row per API call (time, kind: turn / side call / compaction,
  input / cached / output tokens, latency); click → block tree: system blocks (text, size,
  cache marker), tools (name, schema size, sorted), messages (role, per-block type and size,
  system-reminders highlighted), with *diff to previous request*.
* Exact per-block token counts via `count_tokens` on demand.

**Not proposed:** re-implementing Claude Code's prompt assembly ourselves (it changes every
release), or an always-on recorder.

## 4. Decisions

1. Should the `/context` refresh be hidden from the transcript, or shown as a normal
   command exchange (it is persisted in Claude's own transcript either way)?
2. Inspector default: off per session with a switch, or a global Setting?
3. Retention of full request bodies: last N in tmpfs (lost on Stop) vs. under
   `/workspace/.sessionboxer/api-log` (survives, but ends up in snapshots and grows).
