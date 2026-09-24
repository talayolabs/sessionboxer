# The queue plays by itself: Enqueue instead of Save for later plus Play all

The composer had **Save for later**, which put a message in a per-Session list, and the list had a **▶ Play all** button that turned the list into a queue: one message per turn, each sent when the previous turn ended. In practice every use was "send this after what the Agent is doing now", so the list was a queue that had to be started by hand every time, and its name said nothing about sending.

## Decision

**Enqueue, and the queue is playing unless the user pauses it.** The composer's button and its Ctrl+S are **Enqueue**; the panel above the toolbar is **Queue (n)**. `SessionManager.enqueueMessage(id, text, { resumePaused? })` inserts the message, broadcasts the list, turns `queueRunning` on and pumps once. `pumpQueue` sends the first message when the Session is idle *and* its Daemon is connected, so one call covers the four cases: idle → sent now; a turn running → sent at `turn_ended` (through `afterTurn`, after the snapshot and the verification turn, as before); stopped → sent when the Sandbox is resumed, since `onDaemonConnected` now pumps the queue when it has no one-off pending prompt and the Agent has no active turn; created or resumed but the Daemon not yet up → same path. The `POST /sessions/:id/saved` route and the scheduled-task and PR-action callers all go through `enqueueMessage`; the table, the `SavedMessage` type and the other routes (list, reorder, send one now, delete, `POST /queue`) are unchanged.

**Pause is the exception, and it is explicit.** `queueRunning` off with messages in the list means *paused*: the panel says so and offers **Resume** (the old Play all, which now also works on a stopped Session — it plays on resume). A message enqueued from the composer into a paused queue waits behind the others without unpausing, so pausing to reorder or edit does not get undone by the next Ctrl+S; scheduled tasks and PR actions pass `resumePaused: true` because they have no one watching. The queue still pauses itself when a turn is cancelled or fails, and when a Session is stopped *mid-turn* (that cancels the turn); stopping an idle Session leaves the queue playing, so its messages go out after Resume. A fork that receives copied queue messages starts with the queue playing: they go out after its first prompt, or straight away if it has none.

## Considered Options

- **Keep the list as a holding area and add an "auto-play" switch** (rejected): two states to explain for one use; the paused state covers holding.
- **Every Enqueue resumes a paused queue** (rejected): would make pause useless while the user is reordering; the paused panel says clearly that nothing goes out.
- **Enqueue sends directly when the Agent is idle, bypassing the list** (rejected): the message would skip the ordering, the panel and the snapshot's `queuedMessages`; going through the list and pumping at once gives the same result with one code path.
- **Drop the queue on Stop, as before** (rejected): a durable queue that is forgotten by a Stop is a surprise; only the cancelled-turn case pauses.

## Consequences

- No image rebuild; Control Plane and web only. Existing Sessions with a non-empty list and `queueRunning` off show as *Paused* with a Resume button, which is what they were.
- The ▶ in the sidebar means "the queue is playing" as before; it now appears as soon as something is enqueued and goes away when the list drains.
- A message enqueued while a Session is stopped is sent on Resume without further confirmation; the panel says so ("Next one is sent when the Session resumes").
