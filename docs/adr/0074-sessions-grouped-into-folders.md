# ADR 0074: Sessions grouped into folders

## Status

Accepted

## Context

Pinning (ADR-0071) keeps the two or three Sessions someone returns to at the top, but the list below still grows without structure: forks, children an agent created, the Sessions automations start. A name to filter on is not enough — people think in projects, and want the Sessions of one project together, the rest folded away.

## Decision

**Folders are first-class entities, not a label on the Session.** A `folders` table (`id`, `name`, `created_at`) plus a nullable `sessions.folder_id` column: an empty folder exists (it can be a drop target before anything is in it), renaming a folder rewrites one row instead of every Session in it, and deleting a folder unfiles its Sessions rather than deleting or orphaning them. `folder_id` stays dangling-safe — a Session pointing at a folder that is gone counts as unfiled until the server's update lands. `GET/POST/PATCH/DELETE /api/folders` manage the list; filing a Session is `PATCH /api/sessions/:id` with `folderId` (`null` for the unfiled list), riding the same update path as the title and the pin. Folder names are trimmed and cannot be empty; the API 404s on an unknown folder.

**The whole folder list is one broadcast.** Folder changes are rare and small, so create, rename and delete each push `{ type: "folders", folders }` to every client; Sessions a delete unfiles go out as ordinary `session` broadcasts. No patch protocol, no reordering protocol — every open browser redraws from the same list.

**The sidebar is folders first, then the unfiled list.** Folders sort by name (case-insensitive) and collapse/expand on click, the folded state kept in the browser's localStorage — it is a per-device comfort, not Session data. Inside each folder, and in the unfiled list, the order is the unchanged pinned-first-then-newest (ADR-0071). Rows are draggable: a Session dropped on a folder header or anywhere in its group files it there, a drop on an unfiled Session or the bare unfiled area unfiles it. The same moves are on the row's new right-click menu — **Move to folder** (a submenu naming every folder, the current one ticked, plus *No folder* and *New folder…*) — next to **Pin**, **Fork…**, **Snapshots…**, **Stop**/**Resume** and **Delete**, so nothing the menu offers needs drag-and-drop or a hover (a phone's long-press opens the same menu).

**Forks inherit the origin's folder.** A fork of a filed Session is work on the same project, so `fork()` copies `folder_id`; the pin is still not inherited (ADR-0071).

## Consequences

- The feature is mostly client-side: three small REST routes, one nullable column, one broadcast type — the Session model and lifecycle are untouched, and `sessionboxer list` needs no change (it lists Sessions flat, folderless, which is correct for a flat listing).
- An unfiled Session is always reachable: there is no "archive" state, no hidden folder, and deleting a folder can never take a Session with it.
- The context menu replaces right-click-to-copy on a row; the row has no text worth selecting, and the browser menu is still available on the chat and everywhere else.
- Folder names are not unique (same name twice is allowed); the id, not the name, is the identity — like Sessions and their titles.
