# Sessionboxer

A local, self-hosted session manager for Claude Code. Every Session gets its own throwaway Linux machine with a graphical desktop, which the agent drives like a human would (mouse, keyboard, screenshots), while the user watches and edits from a browser UI.

## Language

**Session**:
One conversation thread with the agent, bound to exactly one Sandbox for its whole life. Created, stopped, resumed and deleted by the user.
_Avoid_: Thread, task, run, chat

**Sandbox**:
The isolated Docker container that belongs to a Session: its filesystem, processes, Desktop and the agent itself all live inside it. It is the safety boundary for everything the agent does.
_Avoid_: VM, virtual machine, box, environment

**Workspace**:
The code directory inside a Sandbox that the agent works on. Seeded at Session creation from a Workspace Source.
_Avoid_: Project, repo (a Workspace may not be a git repo), cwd

**Workspace Source**:
Where a Workspace's initial contents come from: a git clone URL, a copy of a directory on the host, or nothing (empty).
_Avoid_: Template, seed, mount

**Desktop**:
The graphical display inside a Sandbox that the agent controls and the user can watch or take over live.
_Avoid_: Screen, display, VNC, GUI

**Control Plane**:
The single local server plus browser UI that creates and manages Sessions and Sandboxes and relays everything between the user and the Agent.
_Avoid_: Host, backend, manager, orchestrator, server (ambiguous with servers the Agent runs inside a Sandbox)

**Provider**:
An agent implementation Sessionboxer can run inside a Sandbox (Claude Code first; Codex, Gemini CLI and others later). A Session has exactly one Provider, chosen at creation.
_Avoid_: Backend, model, harness, vendor

**Agent**:
The running instance of a Session's Provider inside its Sandbox.
_Avoid_: Claude, bot, model, worker

**Sandbox Daemon**:
The Sessionboxer-owned process inside every Sandbox that starts the Agent, talks to it on the Control Plane's behalf, and serves the Workspace's files and terminals to the UI.
_Avoid_: Agent (taken), sidecar, runner, bridge
