# ADR 0089: Bulk detach attached pull requests

## Status

Accepted

## Context

Detaching several PRs from a Session requires opening each row's menu and confirming each detach. The list needs one selection click per PR and one action for the batch.

## Decision

Add a checkbox to each row in the Session's PRs list, plus **Select all**, the selected count, and **Detach selected**. Selecting does not open the PR; the rest of the row retains its navigation behavior. The select-all checkbox shows a mixed state for a partial selection.

Bulk detach has no confirmation dialog. An inline explanation states that the operation forgets the PRs and comments in this Session only, not on GitHub or Bitbucket. Existing single-PR actions remain unchanged.

Reuse the per-PR DELETE endpoint sequentially to avoid flooding the Control Plane. Disable selection and row actions while the batch runs. Remove successful IDs from selection, continue after a failed request, and report failures through the existing error banner. Failed PRs stay selected for retry. Selection uses attachment IDs, is pruned when the list updates, and resets when the list unmounts or the Session changes.

## Consequences

- No protocol, database, or Sandbox image change is needed.
- A batch is not atomic: successful detaches are not undone when another request fails.
- The followed-PR page is unchanged; detaching applies to Session attachments, not follows.
- The list lives in `PrList.tsx`, separate from PR details, keeping both below the source-size budget.
