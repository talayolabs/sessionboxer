# Sessionboxer Sandbox image: one container per Session, with an X11 Desktop
# (Xvfb + xfce4 + x11vnc + noVNC), the Provider ACP adapters (Claude Code,
# Devin CLI), the computer-use MCP server and the Sandbox Daemon. Build from the repo root:
#   docker build -f images/sandbox/Dockerfile -t sessionboxer/sandbox:dev .

# ---------------------------------------------------------------------------
# Stage 1: compile Sessionboxer TypeScript packages
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/computer-use-mcp/package.json packages/computer-use-mcp/
COPY packages/protocol/package.json packages/protocol/
COPY packages/sandbox-daemon/package.json packages/sandbox-daemon/
RUN npm ci --workspace @sessionboxer/computer-use-mcp --workspace @sessionboxer/protocol \
      --workspace @sessionboxer/sandbox-daemon --ignore-scripts
COPY packages/computer-use-mcp packages/computer-use-mcp
COPY packages/protocol packages/protocol
COPY packages/sandbox-daemon packages/sandbox-daemon
RUN npm run build -w @sessionboxer/computer-use-mcp \
    && npm run build -w @sessionboxer/protocol \
    && npm run build -w @sessionboxer/sandbox-daemon

# ---------------------------------------------------------------------------
# Stage 2: runtime image
# ---------------------------------------------------------------------------
FROM ubuntu:24.04

ARG NODE_MAJOR=22
ARG CLAUDE_CODE_VERSION=2.1.272
ARG CLAUDE_AGENT_ACP_VERSION=0.77.0
ARG DEVIN_CLI_VERSION=3000.10.27

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

# Base tooling + Desktop stack. Firefox ESR comes from Mozilla's apt repo
# because Ubuntu's firefox package is a snap shim that does not work in Docker.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg wget \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o /etc/apt/keyrings/packages.mozilla.org.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list \
    && printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get update && apt-get install -y --no-install-recommends \
      # dev tooling
      git build-essential python3 python3-pip python3-venv gh nodejs \
      sudo tini procps less vim-tiny jq unzip zip openssh-client \
      # nested Docker (ADR-0008): dockerd is started by the entrypoint only for
      # Docker-enabled Sessions; the CLI is always present.
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
      # desktop stack
      xvfb xfce4 xfce4-terminal dbus-x11 x11-utils x11-xserver-utils \
      x11vnc novnc websockify \
      xdotool imagemagick \
      fonts-dejavu fonts-liberation \
      firefox-esr \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# uv/uvx system-wide: most Python MCP servers are launched as `uvx <package>`.
ARG UV_VERSION=0.12.13
RUN curl -fsSL https://astral.sh/uv/${UV_VERSION}/install.sh -o /tmp/uv-install.sh \
    && env UV_UNMANAGED_INSTALL=/usr/local/bin sh /tmp/uv-install.sh \
    && rm -f /tmp/uv-install.sh \
    && uv --version && uvx --version

# Claude Code CLI (for the user in the terminal tab) and its ACP adapter
# (spawned by the Sandbox Daemon over stdio).
RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION} \
    && npm cache clean --force

# Computer-use MCP server (compiled in stage 1).
COPY --from=build /src/packages/computer-use-mcp/package.json /opt/sessionboxer/computer-use-mcp/
COPY --from=build /src/packages/computer-use-mcp/dist /opt/sessionboxer/computer-use-mcp/dist
RUN cd /opt/sessionboxer/computer-use-mcp \
    && npm install --omit=dev --no-package-lock --ignore-scripts \
    && npm cache clean --force \
    && ln -s /opt/sessionboxer/computer-use-mcp/dist/index.js /usr/local/bin/sessionboxer-computer-use-mcp \
    && chmod +x /opt/sessionboxer/computer-use-mcp/dist/index.js

# Sandbox Daemon (compiled in stage 1) plus the shared protocol package it
# imports at runtime; the workspace dependency becomes a symlink. node-pty has
# no Linux prebuilds, so it is compiled here (build-essential + python3 above).
COPY --from=build /src/packages/protocol/package.json /opt/sessionboxer/protocol/
COPY --from=build /src/packages/protocol/dist /opt/sessionboxer/protocol/dist
COPY --from=build /src/packages/sandbox-daemon/package.json /opt/sessionboxer/sandbox-daemon/
COPY --from=build /src/packages/sandbox-daemon/dist /opt/sessionboxer/sandbox-daemon/dist
RUN cd /opt/sessionboxer/protocol \
    && npm install --omit=dev --no-package-lock --ignore-scripts \
    && cd /opt/sessionboxer/sandbox-daemon \
    && npm pkg delete dependencies.@sessionboxer/protocol \
    && npm install --omit=dev --no-package-lock --ignore-scripts \
    && npm rebuild node-pty \
    && mkdir -p node_modules/@sessionboxer \
    && ln -s /opt/sessionboxer/protocol node_modules/@sessionboxer/protocol \
    && npm cache clean --force \
    && ln -s /opt/sessionboxer/sandbox-daemon/dist/index.js /usr/local/bin/sessionboxer-daemon \
    && chmod +x /opt/sessionboxer/sandbox-daemon/dist/index.js

# Unprivileged Agent user with passwordless sudo (the container is the boundary).
RUN userdel -r ubuntu 2>/dev/null || true \
    && groupadd -g 1000 agent \
    && useradd -m -u 1000 -g 1000 -s /bin/bash agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
    && chmod 0440 /etc/sudoers.d/agent \
    && usermod -aG docker agent \
    && mkdir -p /workspace && chown agent:agent /workspace

# Firefox: no first-run wizard, no update nags, no default-browser prompt.
COPY images/sandbox/firefox-policies.json /etc/firefox/policies/policies.json

# Agent-facing configuration and the Desktop entrypoint. The Desktop briefing
# is installed once as ~/.claude/CLAUDE.md: Claude Code reads it natively and
# Devin CLI loads it as an always-on rule too (`devin rules list`).
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.claude/CLAUDE.md
COPY --chown=agent:agent images/sandbox/claude-settings.json /home/agent/.claude/settings.json
COPY --chown=agent:agent images/sandbox/mcp.json /home/agent/.sessionboxer/mcp.json
COPY images/sandbox/entrypoint.sh /usr/local/bin/sessionboxer-entrypoint
RUN chmod +x /usr/local/bin/sessionboxer-entrypoint

ENV DISPLAY=:1 \
    SESSIONBOXER_DISPLAY_WIDTH=1024 \
    SESSIONBOXER_DISPLAY_HEIGHT=768 \
    HOME=/home/agent \
    IS_SANDBOX=1 \
    PATH=/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER agent
WORKDIR /workspace

# Devin CLI (`devin acp` is spawned by the Sandbox Daemon). The pinned installer
# is a per-user install, so it runs as agent; its trailing `devin setup` tries
# to log in and fails without a TTY, which is fine: credentials are injected
# per Session (WINDSURF_API_KEY), never baked in. auto_update is off so a
# Sandbox runs the version the image was built with.
RUN curl -fsSL https://static.devin.ai/cli/${DEVIN_CLI_VERSION}/setup.sh -o /tmp/devin-setup.sh \
    && (bash /tmp/devin-setup.sh </dev/null >/tmp/devin-setup.log 2>&1 || true) \
    && rm -f /tmp/devin-setup.sh /tmp/devin-setup.log \
    && devin --version
# Devin only exposes MCP servers from its own config to the model (the one the
# Daemon passes over ACP connects but is invisible to mcp_list_tools/call_tool),
# so the desktop MCP is also registered at user scope.
COPY --chown=agent:agent images/sandbox/devin-config.json /home/agent/.config/devin/config.json
COPY --chown=agent:agent images/sandbox/devin-mcp-config.json /home/agent/.config/devin/mcp_config.json

# 6080: noVNC/websockify, 7000: Sandbox Daemon. Both are reached only over the
# Docker network, never published on the host.
EXPOSE 6080 7000

ENTRYPOINT ["tini", "--", "/usr/local/bin/sessionboxer-entrypoint"]
