# Research: can Inspect LLM record the model calls of every agent, not only Claude Code?

Question: "Can we intercept traffic not only claude code but the rest of the agents somehow, to
have the llm calls details?" — i.e. extend ADR-0032 (the loopback recorder, the `LLM #n` labels,
the Request / Response / Tree / Diff dialog, the *Model API calls* table) to Devin, Codex, Cursor,
pi, OpenCode and fx.

Checked on 2026-10-02 against the 1.5.0 Sandbox image (`sessionboxer/sandbox:dev`): Claude Code
2.1.272, Devin CLI 3000.10.27, codex-cli 0.145.0, cursor-agent 2026.09.23, pi 0.99.2 (pi-acp),
OpenCode 1.18.32, fx 0.0.11. Evidence is the shipped binaries/bundles (strings, bundled JS), the
vendors' current reference docs and, for Codex and pi, their source; **no real login was used, so
every "works" below is a code-level finding until the verification in §4 is done.**

## Short answer

Yes for four of the six — with one qualification each — and no for two, for a structural reason.

| Agent | Where the model is actually called | How to route it through the recorder | Wire format in the box | Verdict |
|---|---|---|---|---|
| Claude Code | In the box, `api.anthropic.com` (or the company proxy) | `ANTHROPIC_BASE_URL` (today) | Anthropic Messages, SSE | Done (ADR-0032) |
| **Codex** | In the box: `api.openai.com/v1` (API key) or `chatgpt.com/backend-api/codex` (ChatGPT login) | `openai_base_url` in our `~/.codex/config.toml` | OpenAI Responses, SSE | **Yes**; upstream depends on the login kind |
| **pi** | In the box, one base URL per built-in provider | `providers.<id>.baseUrl` overlay in `~/.pi/agent/models.json` | Anthropic Messages / OpenAI Responses / Chat Completions / Gemini | **Yes**, per provider; keeps the OAuth login |
| **OpenCode** | In the box, one base URL per provider | `OPENCODE_CONFIG_CONTENT` env with `provider.<id>.options.baseURL` | Same families as pi (Vercel AI SDK) | **Yes** for the providers we know the upstream of |
| **fx** | In the box: Vercel AI Gateway, or a custom Chat Completions connection; ChatGPT / Grok subscription endpoints | `FX_GATEWAY_BASE_URL` (loopback http only — made for this) / connection `base_url` | AI Gateway protocol / Chat Completions | **Gateway and custom connections yes; ChatGPT and Grok no** |
| Devin | On Cognition's servers | `WINDSURF_API_SERVER_URL` reaches only the RPC | Connect-RPC protobuf `GetChatMessage` (new message + conversation ref + session token) | **No LLM call exists in the box** |
| Cursor | On Cursor's servers (`api2.cursor.sh`, `aiserver.v1.*`) | `CURSOR_API_ENDPOINT` exists, but it moves the RPC, not the model call | Connect-RPC protobuf | **No LLM call exists in the box** |

So the honest framing for the UI is: *Inspect LLM* shows the bytes **the agent sends to the model
API**. Claude Code, Codex, pi, OpenCode and fx (Gateway) do that from inside the Sandbox, so the
request *is* the prompt. Devin and Cursor are thin clients of a vendor backend that assembles the
prompt and calls the model there; the Sandbox only ever sees a protobuf RPC carrying the new
message and a session token. There is nothing to intercept that would show "the LLM call": the
switch stays off for them with that sentence as the reason.

## 1. What the recorder is, and what in it is actually Claude-specific

`packages/sandbox-daemon/src/llm-inspector.ts` is a plain HTTP/1.1 reverse proxy on
`127.0.0.1:7200` (`0.0.0.0` for Windows/macOS guests): it forwards the request unchanged minus
hop-by-hop headers with `Host` rewritten to the upstream, pipes the response through (SSE
untouched), keeps the decoded request and response bodies (4 MB cap, last 40 calls, tmpfs) and
emits one `llm_call` summary per call. Nothing in the proxying is Anthropic-specific. Three
things are:

1. **The routing knob** — `index.ts` builds the inspector only for `provider === "claude-code"`
   and turns it on by giving the agent `ANTHROPIC_BASE_URL` (+ `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`).
2. **The summariser** — `summarizeRequest/summarizeResponse` read Anthropic Messages JSON and
   SSE (`message_start` / `message_delta.usage`); the Tree and Diff tabs in `LlmCallDialog.tsx`
   walk `system` / `tools` / `messages`.
3. **The gates** — `apps/control-plane/src/sessions.ts` forces `inspectLlm` to `false` for other
   providers; `SessionSettingsForm.tsx` and the GUIDE say "for Claude Code".

Everything else (event storage and ordinals, pairing bubbles with calls by time window in
`transcript-model.ts`, the dialog, the Context table, the pending/restart-in-place dance) is
provider-neutral already.

## 2. Agent by agent

### Codex — `openai_base_url`, works with the ChatGPT login too

* The built-in `openai` provider takes its base URL from the user-level config key
  `openai_base_url` (`built_in_model_providers(openai_base_url)` →
  `create_openai_provider(base_url)` in `codex-rs/core/src/config/mod.rs`). At request time
  `ModelProviderInfo::to_api_provider` uses that `base_url` if set, otherwise
  `https://chatgpt.com/backend-api/codex` for `AuthMode::Chatgpt` and `https://api.openai.com/v1`
  for an API key — so the override applies to **both** login kinds, and the recorder's upstream
  must be chosen from the login (`~/.codex/auth.json` is on tmpfs behind the symlink of ADR-0046;
  the Daemon can read its `auth_mode`/tokens shape).
* Config is `~/.codex/config.toml`, which in the Sandbox is ours (`images/sandbox/codex-config.toml`).
  Codex's reference says project-local `.codex/config.toml` **cannot** set `openai_base_url`
  (machine-local key), which is exactly what we want: a repository cannot redirect the agent's
  traffic away from the recorder. Codex reads config at start → restart-in-place, like Claude.
* Wire: `wire_api = "responses"` is the only value; requests go to `<base>/responses` as JSON
  and come back as SSE (`response.completed` carries `usage.input_tokens`,
  `usage.input_tokens_details.cached_tokens`, `usage.output_tokens`). Codex adds its own headers
  (`version`, `OpenAI-Organization`, `OpenAI-Project`, `originator`…); they are forwarded and, as
  today, never recorded.
* **WebSockets.** `ModelProviderInfo` has `supports_websockets` and a `websocket_connect_timeout_ms`;
  the reference describes the Responses WebSocket transport as "under development and off by
  default; provider compatibility alone doesn't enable it". The recorder does not speak Upgrade,
  so if OpenAI turns it on the Daemon must set the feature off in our `config.toml` or add an
  `upgrade` passthrough. Not needed for 0.145.0.
* ADR-0046 and GUIDE §Subscription usage say the Codex usage bars are read after each turn (not
  from calls); unchanged.

### pi — a `models.json` overlay rewrites the built-in provider's base URL and keeps its login

* pi has no `ANTHROPIC_BASE_URL`-style env (pi-ai reads none). The knob is
  `~/.pi/agent/models.json`: `providers.<id>.baseUrl`. The code path
  (`dist/core/model-runtime.js` `composeProvider` → `provider-composer.js` `applyModelsJson`)
  takes the **built-in** provider as the base and maps every one of its models to
  `config.baseUrl ?? model.baseUrl`, keeping the built-in auth/login/stream code — i.e.
  `{"providers":{"anthropic":{"baseUrl":"http://127.0.0.1:7200"}}}` sends the Claude Pro/Max
  OAuth token (and pi's `anthropic-beta: oauth-2025-04-20`) to the recorder, which forwards it to
  `api.anthropic.com`. The pi docs confirm `models.json` overlays "an existing built-in" provider
  and that the file is re-read when the model picker opens (and at start).
* Several providers can be logged in at once (pi-ai's catalog: `api.anthropic.com`,
  `api.openai.com/v1`, `chatgpt.com/backend-api` for the Codex subscription, Google, …), each with
  its own upstream → one recorder listener **per provider**, port 7200 + n, overlay entry per
  provider that has a credential. The file is also the user's (ADR-0075 lets a login bring its own
  `models.json`, and the UI tests use one for the mock model): the Daemon must *merge* the
  `baseUrl` into existing entries and remove only what it added when the switch goes off.
* Wire formats: `anthropic-messages` (summariser exists), `openai-responses`,
  `openai-completions`, `google-generative-ai` (new summarisers; Gemini raw-only at first).

### OpenCode — `OPENCODE_CONFIG_CONTENT`, no file edits

* Provider base URLs are `provider.<id>.options.baseURL` in the config; the bundle (bun binary)
  loads `OPENCODE_CONFIG_CONTENT` as a JSON config layer *after* the global and project files
  (OpenCode's documented precedence: remote → global → `OPENCODE_CONFIG` → project →
  `.opencode` → `OPENCODE_CONFIG_CONTENT` → managed). So the Daemon can hand the agent process
  `OPENCODE_CONFIG_CONTENT='{"provider":{"anthropic":{"options":{"baseURL":"http://127.0.0.1:7200"}}}}'`
  the same way it hands Claude an env var, on top of our `images/sandbox/opencode-config.json`
  and whatever the user's `opencode.json` says — nothing on disk changes.
* ADR-0076 already verified the mock OpenAI-compatible provider through `options.baseURL`. For
  the Anthropic subscription login OpenCode uses the `opencode-anthropic-auth` plugin, which
  supplies the OAuth headers around the Anthropic SDK; the SDK still takes `baseURL` from
  `options` (same `createX({...e.options, baseURL})` pattern throughout the bundle), so this
  should hold, but it is the one OpenCode item to verify live.
* Upstreams: OpenCode's providers come from the models.dev catalog; the Daemon needs a small
  table (anthropic, openai, openai via ChatGPT plugin `chatgpt.com/backend-api/codex`, google,
  openrouter, …) and declares the switch unsupported for a provider it has no upstream for,
  rather than guessing. Same per-provider listener model as pi.

### fx — `FX_GATEWAY_BASE_URL` is literally "loopback http only"

* Three providers (`session/new` `configOptions.provider`: gateway / codex / grok). The binary
  honours `FX_GATEWAY_BASE_URL` and refuses anything but a loopback `http://` URL
  (`ignoring FX_GATEWAY_BASE_URL: not loopback http`) — it exists for exactly a local recorder
  in front of `https://ai-gateway.vercel.sh`. Custom connections (`~/.fx/settings.json`
  `connections.<name>.base_url`, Chat Completions; "Base URLs require HTTPS except for loopback
  addresses") can be rewritten the same way with the connection's own URL as upstream.
* The Gateway endpoint is `/v4/ai/language-model` — the Vercel AI SDK gateway protocol, not
  OpenAI's shape. The bodies are JSON (prompt, tools, usage), so Request/Response show them and
  a Gateway summariser can pull model and usage; Tree comes later.
* `codex` (ChatGPT subscription → `chatgpt.com/backend-api/codex/responses`) and `grok`
  (`cli-chat-proxy.grok.com/v1/responses`): no override string in the binary, HTTPS pinned →
  not interceptable; the switch says so for those two providers. fx does have its own tracer
  (`FX_TRACE=1` / `FX_TRACE_LOG`, "a complete transport record", `FX_TRACE_SCOPES`) which could
  be a second, fx-written source for those; whether it includes bodies, and redaction, is
  unknown — one experiment, not part of the plan.

### Devin and Cursor — thin clients of a vendor backend

* Devin: measured in `context-composition-and-inspection.md` §2. `WINDSURF_API_SERVER_URL` is
  honoured and a loopback proxy works, but the call is a Connect-RPC
  `POST /exa.api_server_pb.ApiServerService/GetChatMessage` (`application/connect+proto`,
  1.4 kB for a 10.8k-token turn): the prompt is assembled and the model called on Cognition's
  side, the body embeds the session token, the schema is not public.
* Cursor: `cursor-agent` is a Connect-RPC client of `https://api2.cursor.sh` (`aiserver.v1.*`
  services, gRPC/connect framing). `CURSOR_API_ENDPOINT` / `CURSOR_API_URL` override "the public
  API base" (they are documented in the bundle for the background-agent controller) — that moves
  the RPC, but the prompt and the model call stay in Cursor's backend, as with Devin.
* For both, the ACP `usage_update` tokens (already shown in the gauge) are all the model-level
  information available. Showing the redacted RPC bytes was considered and dropped: it is not an
  LLM call, the protobuf is not decodable without the schema, and the token is inside the body.

## 3. Plan

One session of Daemon + Control Plane + Web work, no image rebuild (all knobs are config/env the
Daemon writes at runtime), then a verification pass with real logins.

**Daemon (`packages/sandbox-daemon`).**
* `LlmInspector` becomes multi-route: `routes: { port, upstream, family }[]`, one listener per
  upstream (7200, 7201, …; `0.0.0.0` in guest mode as today), shared body store and call list.
  `LlmCall` gains `provider`, `family` (`anthropic` | `openai-responses` | `openai-completions` |
  `gemini` | `ai-gateway` | `raw`) and `upstreamHost`; the summariser is chosen by `family`
  (`raw` = method, path, status, sizes, timing only).
* A per-provider *router* replaces the `provider === "claude-code"` block:
  `claude-code` → env (unchanged); `codex` → upsert `openai_base_url` in `/home/agent/.codex/config.toml`,
  upstream from the login kind; `pi` → merge `baseUrl` into `~/.pi/agent/models.json` for each
  logged-in built-in provider; `opencode` → `OPENCODE_CONFIG_CONTENT` for the providers in the
  upstream table; `fx` → `FX_GATEWAY_BASE_URL` and connection rewrites, unsupported for
  codex/grok; `devin`, `cursor` → `{ supported: false, reason }`. `setLlmInspect` returns the
  reason so the UI can say it; config files are written before the restart-in-place and reverted
  on disable.
* New summarisers: OpenAI Responses (model, `instructions` size, `input` items by type, `tools`,
  `response.completed` usage incl. cached tokens, `previous_response_id`), Chat Completions
  (`messages`, `usage.prompt_tokens` / `prompt_tokens_details.cached_tokens`), AI Gateway (model,
  usage). Anthropic unchanged.

**Control Plane.** Drop the `claude-code` conditions on `inspectLlm` (default on wherever the
Daemon reports `supported`); keep the stored `reason` on the session so New session can grey the
switch for Devin/Cursor with the sentence from the short answer. `llm_call` storage is already neutral.

**Web.** `LlmCallDialog` Tree/Diff by family (Anthropic as today; Responses: instructions / input
items / tools / output items; Completions: messages / tools; raw-only otherwise); the bubble
label uses the call's model instead of "Claude"; the Context table gets a *provider/upstream*
column when a session has more than one route. Settings and GUIDE copy: "for agents that call
the model API from the Sandbox (Claude Code, Codex, pi, OpenCode, fx Gateway)…".

**Docs.** ADR-0080 "Inspect LLM for every agent that calls the model from the Sandbox" (next free
number after 0079), CHANGELOG unreleased line, GUIDE §Inspect LLM, this document linked.

**Not proposed.** Host-level capture (mitmproxy/TLS interception) — the same four agents are
reachable with their own knobs and the two that are not would only yield protobuf; recording
headers; a Devin/Cursor "backend RPC" view.

## 4. Open questions, with defaults

1. **Codex over the ChatGPT backend through a loopback proxy** — unverified live (Claude needed
   `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` for its first-party behaviour; Codex keeps the same
   provider struct and auth, so no equivalent is expected). Default: build it, verify with
   Julian's ChatGPT login first; fall back to API-key sessions only if the backend rejects the
   rewritten `Host`.
2. **OpenCode + Anthropic OAuth plugin + `options.baseURL`** — verify live; default: ship, with
   the switch disabled for that combination if it fails.
3. **Which pi/OpenCode providers get a route** — default: those with a credential *and* an entry
   in the Daemon's upstream table; others show "no upstream known for provider X".
4. **Multiple listeners vs one listener with a path prefix** — default: one port per upstream
   (agents prepend their own paths, so a prefix would need rewriting on the way out).
5. **fx Gateway Tree** — default: raw Request/Response + usage summary in the first cut.
6. **Devin/Cursor** — default: off with the reason; no RPC view.
7. **Codex WebSockets** — default: nothing until OpenAI turns the feature on; then pin it off in
   our `config.toml` or add Upgrade passthrough.

## References

* ADR-0032 `docs/adr/0032-exact-model-api-calls-recorded-by-a-loopback-proxy-in-the-sandbox.md`;
  `packages/sandbox-daemon/src/llm-inspector.ts`, `packages/sandbox-daemon/src/index.ts`
  (`LLM_INSPECTOR_ENV`, `setLlmInspect`); `apps/control-plane/src/sessions.ts` (`inspectLlm`);
  `apps/web/src/LlmCallDialog.tsx`, `apps/web/src/transcript-model.ts`.
* `docs/research/context-composition-and-inspection.md` §2 (Devin measurement).
* Provider ADRs 0046 (Codex), 0054 (Cursor), 0075 (pi), 0076 (OpenCode), 0077 (fx);
  `images/sandbox/codex-config.toml`, `opencode-config.json`, `pi-settings.json`, `fx-settings.json`.
* Codex: `codex-rs/core/src/model_provider_info.rs` (`to_api_provider`, `create_openai_provider`,
  `supports_websockets`), `codex-rs/core/src/config/mod.rs` (`openai_base_url` →
  `built_in_model_providers`); config reference https://developers.openai.com/codex/config-reference
  (`openai_base_url`, machine-local keys, WebSocket transport off by default).
* pi: `@earendil-works/pi-coding-agent` `dist/core/model-runtime.js`, `dist/core/provider-composer.js`,
  `dist/core/model-config.js` (schema); docs https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md
  ("Configure a compatible endpoint", overlays on built-in providers).
* OpenCode: https://opencode.ai/docs/config/ (precedence, `OPENCODE_CONFIG_CONTENT`),
  https://opencode.ai/docs/providers/ (`options.baseURL`); bundle strings for the
  `OPENCODE_CONFIG_CONTENT` "local" layer.
* fx: https://fx.sh/docs/configure-fx/configuration (trace variables),
  https://fx.sh/docs/configure-fx/custom-model-connections (`base_url`, loopback rule);
  binary strings `FX_GATEWAY_BASE_URL`, `ignoring FX_GATEWAY_BASE_URL: not loopback http`,
  `https://ai-gateway.vercel.sh/v4/ai/language-model`.
* Cursor: `/opt/cursor-agent/*.index.js` (`CURSOR_API_ENDPOINT`, `api2.cursor.sh`, `aiserver.v1.*`).
