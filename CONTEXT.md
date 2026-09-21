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
The directory inside a Sandbox that the agent works in (`/workspace`): the agent's working directory, holding one subdirectory per Repository plus anything that belongs to none.
_Avoid_: Project, repo (a Workspace holds repos, it is not one), cwd

**Repository**:
One source tree in a Workspace, at `/workspace/<name>`, with its own git history: cloned from a git URL or copied from a directory on the host. A Session lists its Repositories and can add or remove them while it runs.
_Avoid_: Workspace Source (the pre-Repository term for a single source seeded into `/workspace` itself, kept only for such legacy Sessions), Project, module

**Workspace Source**:
Legacy: where a single-source Workspace's contents came from (git clone URL, host directory copy, empty) before Repositories; kept for Sessions created that way and for forks.
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

**Docker Mode**:
Whether a Sandbox has its own private Docker daemon, fixed when the Session is created: `none`, `sysbox` (the Sandbox runs under the Sysbox runtime, unprivileged) or `privileged` (fallback when the host lacks Sysbox; the Sandbox runs `--privileged` and the user is warned).
_Avoid_: DinD, nested Docker, Docker-in-Docker (fine in prose, not as the feature name)
