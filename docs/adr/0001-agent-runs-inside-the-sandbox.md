# The Agent runs inside the Sandbox, not on the host

Sessionboxer gives each Session an isolated container with a desktop; the question was whether Claude Code should run on the host and reach into the container remotely (Devin-cloud style split) or run inside the container itself. We run it inside the Sandbox: the Agent edits Workspace files in place, drives its own Desktop through a local computer-use MCP server, and the Control Plane only relays the message stream. This removes any remote file-editing or remote tool layer and makes the container the blast radius for everything the Agent does, which is what lets ADR-0003 skip permission prompts.

## Considered Options

- Claude Code on the host, tools proxied into the container over the network: keeps one Claude install and one login, but every tool (file edit, shell, screenshot, click) needs a remote adapter, and a mistake in that adapter escapes the Sandbox.
- Claude Code inside the Sandbox (chosen): one extra concern (getting credentials into each container, see ADR-0002), everything else becomes local.
