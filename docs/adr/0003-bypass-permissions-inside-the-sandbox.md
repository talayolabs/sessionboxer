# The Agent runs with `bypassPermissions`; the Sandbox is the safety boundary

Claude Code normally asks before each risky tool call. Inside a Sandbox that would mean a click-through prompt for every shell command, file write, mouse click and keystroke, which defeats the point of giving the Agent its own machine. We run the Agent with `permissionMode: bypassPermissions` and rely on the Sandbox (its own filesystem, processes and Desktop, nothing of the host mounted in) to contain mistakes. Only tools that genuinely need a human, such as `AskUserQuestion`, reach the user through the Control Plane UI.

## Consequences

- Anything mounted or copied into a Sandbox is fair game for the Agent, including credentials handed to it (ADR-0002). Sandboxes must not receive host secrets they do not need.
- Network egress from the Sandbox is unrestricted for the MVP; an Agent with a leaked token could exfiltrate. Revisit if Sessionboxer ever runs untrusted prompts.
