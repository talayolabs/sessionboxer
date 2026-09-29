# ADR 0071: Pinned Sessions stay at the top of the list

## Status

Accepted

## Context

The sidebar lists Sessions newest first, and the list only grows: forks, children an agent created (ADR-0062), the Sessions automations start (ADR-0069). The two or three Sessions someone actually returns to every day — a project's long-running agent, the one with the phone attached — drift down under everything created since and have to be found again by title.

## Decision

**A `pinned` flag on the Session, kept by the Control Plane.** `sessions.pinned` (INTEGER, 0 by default) is a column like the title, not a setting: it describes how the owner wants the Session shown, nothing about the Sandbox or the Agent, and forks and snapshots do not carry it. `PATCH /api/sessions/:id` takes `pinned: true | false` next to `title`; the update is broadcast like any other Session change, so every open client reorders at once.

**The order is pinned first, then newest first.** `GET /api/sessions` returns `ORDER BY pinned DESC, created_at DESC`, and the web client sorts by the same key whenever it inserts or updates a Session, so a pin from another browser, or a Session created while pinned ones exist, lands in the right place without a reload. No manual ordering: pinning is a yes/no, and among pinned Sessions the newest is first, the same rule as below the line.

**Two places to pin.** In the sidebar, a pin button shows on hover at the right of the row and stays visible, in the accent colour, once the Session is pinned (on a phone, where nothing hovers, only pinned Sessions show it); the Session's ⋯ menu has **Pin to top** / **Unpin** for the same call, which is also where a phone pins.

## Consequences

- The pin is the owner's, on the server: every browser, the desktop app and the CLI list the same order; a Session pinned on the laptop is pinned on the phone.
- The list is one list with a stable rule; there is no separate "pinned" section header to keep in sync, and the CLI's `list` output is already in the new order without a flag.
- Agents do not see or set pins: `sessions_list` of the sessionboxer MCP is unchanged; pinning is a matter of the owner's attention, not of the work.
