# Context observability: a gauge from ACP usage updates, per-turn deltas, and a breakdown parsed from the agent's own `/context`

The user wants to see what the agent's context window is made of and how full it is, and to notice when the conversation has been compacted. The research note `docs/research/context-composition-and-inspection.md` found three depths: usage numbers that already flow over ACP but were dropped by the UI, the category breakdown that both agents print for `/context`, and the exact request bytes, which only a logging proxy in the Sandbox can see. This ADR covers the first two ("stage 1"); the proxy is deferred.

## Decision

**Source of truth is the Session's event log.** Nothing new is computed or stored by the Control Plane for the gauge: the web derives the current occupancy, the compaction list, the usage history and the per-turn statistics from the events it already loads (`deriveContext`, `TurnAccumulator` in `apps/web/src/context-model.ts`). That makes the numbers identical after a reload, on a fork (events are copied), and on a branch (events are scoped), with no schema change beyond two new event types.

**Occupancy** comes from ACP `usage_update` (`used`, `size`, optional `cost`). claude-agent-acp sends several per model reply: an early one carrying the model's nominal 200k window, rate-limit ones, and one with the cost and the real window (1M on the long-context plan); Devin sends one with its request tokens in `_meta` and then repeats it tagged `cognition.ai/subagent_context`. The update that carries the reply (a `cost`, or Devin request tokens without the subagent tag) is the *reply usage*: it counts as a model call, fixes the window size (a progress update never shrinks the window once a reply has set it) and is a point of the history; the others only move `used`.

**Per-turn statistics** are attached to the `turn_ended` divider: context after the turn and its delta since the previous turn, model calls, the turn's tokens and its cost delta. The tokens come from the ACP `session/prompt` result's `usage`, which the Daemon now forwards on `turn_ended` (`TurnUsage`: total, input, output, thought, cached read, cached write); Devin's per-request `_meta` counts are the fallback for older events. Claude reports all-zero usage for a turn without a model reply (`/compact`), which is shown as none.

**Compactions** are recognised in two shapes: ACP's experimental `compaction_update`, and claude-agent-acp's `tool_call` / `tool_call_update` whose `_meta.contextCompaction` carries `trigger`, `preTokens`, `postTokens`, `durationMs` (verified live: `32.7k → 1.3k (manual) in 11.2 s`). Each is a transcript marker; completed ones are counted next to the gauge with a ⚠ once there is at least one, because the agent has by then lost part of the conversation.

**The gauge** in the composer footer reads `used / size percent`; its hue goes from green (120°) at empty to red (0°) at half the window and stays red above, where the label **rotting** is added, and the half-way point is marked on the bar. Half is the user's threshold: in practice agents degrade well before the window is full, and the autocompact buffer sits near the end anyway. Clicking the gauge opens the Context pane.

**The breakdown** is the agent's own `/context` report, requested by `POST /api/sessions/:id/context/report` → Daemon RPC `_sessionboxer/context/report`: the Daemon sends `/context` as a prompt on the existing ACP session, captures the `agent_message_chunk`s into a sink instead of forwarding them (so the report is neither a user message nor an assistant reply in the transcript, and claude-agent-acp's habit of delivering the markdown twice is undone), and refuses while a turn or another report is running; the Control Plane refuses while the Session is `running` (409). The text is parsed in `apps/control-plane/src/context-report.ts` into a `ContextBreakdown` (model, total/max tokens, percent, categories with a kind — used / free / buffer / deferred — and the per-MCP-tool, memory-file and skill tables Claude prints; Devin's grid report yields system prompt / tools / messages / free plus its estimate note), appended as a `context_breakdown` event and broadcast, so it survives reloads and the transcript shows a `Context inspected: …` marker. The raw text is kept on the event for the pane's *Raw report* disclosure and for parsers that improve later. Refresh is manual only in this stage.

## Considered Options

- **Compute statistics in the Control Plane and store them per Session** (rejected): the events already hold everything, and a derived table would need its own migration, fork copy and branch scoping.
- **Count every `usage_update` as a model call** (rejected): four per reply on Claude, two on Devin; the divider would read "4 model calls" for one answer.
- **Keep the largest window size seen** (rejected): wrong after switching to a model with a smaller window; "the last reply's size wins" follows the model.
- **Use the ACP SDK's structured `/context` output** (not available): claude-agent-acp forwards only the markdown; parsing it is the price of not forking the adapter. The parser tolerates `8.8k`, `1m`, `~480` and both providers' layouts, and the raw text is kept.
- **Auto-refresh the breakdown at turn end** (deferred): a `/context` costs the agent a prompt round; manual first, a setting later.
- **Exact request capture through a loopback proxy in the Sandbox** (deferred, stage 2): verified feasible in the research note but needs an image rebuild and careful redaction; it will render into the same pane.
- **Red at 80–90% like most meters** (rejected by the user): the half-window threshold with the word *rotting* is the user's explicit choice.

## Consequences

- Two new event types (`turn_ended.usage`, `context_breakdown`) and one Daemon RPC; a Daemon rebuild but no image rebuild. Old events without `usage` show context deltas and model calls but no token counts.
- Occupancy is what the agent reports, not a measurement: Claude's `used` comes from the API's usage fields; Devin's are estimates scaled by character ratio, as its own report says.
- `/context` occupies the agent for a second or two and is refused while it works; the exchange leaves a small `context_breakdown` event and no conversation content on our side; whether the agent keeps the slash command in its own history is the agent's business.
- The composer footer is now full: below ~760 px the hint is dropped and the pickers narrowed, below ~680 px the gauge moves to its own row.
