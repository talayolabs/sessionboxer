# Sessionboxer Sandbox image: one container per Session, with an X11 Desktop
# (Xvfb + xfce4 + x11vnc + noVNC), the Provider ACP adapters (Claude Code,
# Devin CLI), the computer-use MCP server and the Sandbox Daemon. Build from the repo root:
#   npm run build:image        (scripts/build-image.mjs)
# which is `docker build -f images/sandbox/Dockerfile -t sessionboxer/sandbox:dev .` plus the
# `extra-ca` build secret: the CA certificates this machine trusts beyond the public ones
# (Cloudflare WARP, a corporate proxy), so downloads during the build pass TLS inspection.
# EXTRA_CA_FINGERPRINT only changes when that bundle changes; it makes the layers that
# download things rebuild when it does (secret contents are not part of the layer cache key).

# ---------------------------------------------------------------------------
# Stage 1: compile Sessionboxer TypeScript packages
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/computer-use-mcp/package.json packages/computer-use-mcp/
COPY packages/protocol/package.json packages/protocol/
COPY packages/sandbox-daemon/package.json packages/sandbox-daemon/
ARG EXTRA_CA_FINGERPRINT=
RUN --mount=type=secret,id=extra-ca \
    if [ -s /run/secrets/extra-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi \
    && npm ci --workspace @sessionboxer/computer-use-mcp --workspace @sessionboxer/protocol \
      --workspace @sessionboxer/sandbox-daemon --ignore-scripts
COPY packages/computer-use-mcp packages/computer-use-mcp
COPY packages/protocol packages/protocol
COPY packages/sandbox-daemon packages/sandbox-daemon
RUN npm run build -w @sessionboxer/computer-use-mcp \
    && npm run build -w @sessionboxer/protocol \
    && npm run build -w @sessionboxer/sandbox-daemon
# The VS Code extension with the Sessionboxer color themes, generated from the same palettes
# the UI uses (ADR-0048).
RUN node --input-type=module -e ' \
      import { mkdirSync, writeFileSync } from "node:fs"; import { dirname, join } from "node:path"; \
      import { vscodeThemeExtensionFiles } from "./packages/protocol/dist/index.js"; \
      for (const [path, content] of Object.entries(vscodeThemeExtensionFiles())) { \
        const file = join("/src/out/sessionboxer-themes", path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); \
      }' \
    && test -s /src/out/sessionboxer-themes/package.json

# ---------------------------------------------------------------------------
# Stage 2: runtime image
# ---------------------------------------------------------------------------
FROM ubuntu:24.04

ARG NODE_MAJOR=22
ARG CLAUDE_CODE_VERSION=2.1.272
ARG CLAUDE_AGENT_ACP_VERSION=0.77.0
ARG DEVIN_CLI_VERSION=3000.10.27
ARG CODEX_ACP_VERSION=1.1.9
ARG OPENVSCODE_SERVER_VERSION=1.109.5
ARG EXTRA_CA_FINGERPRINT=
# Build-time only (an ARG is not kept in the image): npm/node trust the system store, which
# includes the extra CAs below, while downloading. At runtime the Control Plane manages this.
ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

# Base tooling + Desktop stack. Firefox ESR comes from Mozilla's apt repo
# because Ubuntu's firefox package is a snap shim that does not work in Docker.
RUN --mount=type=secret,id=extra-ca \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg wget \
    && if [ -s /run/secrets/extra-ca ]; then \
         install -m 0644 /run/secrets/extra-ca /usr/local/share/ca-certificates/sessionboxer-extra.crt \
         && update-ca-certificates; \
       fi \
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
      sudo tini procps less vim-tiny jq unzip zip bzip2 openssh-client iproute2 \
      # nested Docker (ADR-0008): dockerd is started by the entrypoint only for
      # Docker-enabled Sessions; the CLI is always present.
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
      # desktop stack
      xvfb xfce4 xfce4-terminal dbus-x11 x11-utils x11-xserver-utils \
      x11vnc novnc websockify \
      xdotool imagemagick ffmpeg \
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
# (spawned by the Sandbox Daemon over stdio); Codex's ACP adapter, which bundles
# the Codex CLI (ADR-0046).
RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION} \
      @agentclientprotocol/codex-acp@${CODEX_ACP_VERSION} \
    && npm cache clean --force \
    && ln -s "$(npm root -g)/@agentclientprotocol/codex-acp/node_modules/@openai/codex/bin/codex.js" /usr/local/bin/codex \
    && codex-acp --version && codex --version

# VS Code in the browser (the Code pane): openvscode-server is started on demand by the
# Sandbox Daemon on the loopback interface and reached only through the Daemon's port.
RUN arch="$(dpkg --print-architecture)" && case "$arch" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
    && curl -fsSL "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_SERVER_VERSION}/openvscode-server-v${OPENVSCODE_SERVER_VERSION}-linux-${arch}.tar.gz" -o /tmp/openvscode-server.tar.gz \
    && mkdir -p /opt/openvscode-server \
    && tar -xzf /tmp/openvscode-server.tar.gz -C /opt/openvscode-server --strip-components=1 \
    && rm -f /tmp/openvscode-server.tar.gz \
    && ln -s /opt/openvscode-server/bin/openvscode-server /usr/local/bin/openvscode-server
# Sandbox defaults for the workbench (settings defaults incl. AI features off, no Get Started; a
# stylesheet hiding the Extensions activity item and the remote indicator), linked from the
# workbench page and served by the server's own static route.
COPY images/sandbox/openvscode-defaults.js /opt/openvscode-server/out/vs/code/browser/workbench/sessionboxer.js
COPY images/sandbox/openvscode-workbench.css /opt/openvscode-server/out/vs/code/browser/workbench/sessionboxer.css
RUN html=/opt/openvscode-server/out/vs/code/browser/workbench/workbench.html \
    && sed -i 's|</head>|\t<script src="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/sessionboxer.js"></script>\n\t<link rel="stylesheet" href="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/sessionboxer.css">\n\t</head>|' "$html" \
    && grep -q sessionboxer.js "$html" && grep -q sessionboxer.css "$html"
# Built-in extensions: one lets the Daemon open a file (at a line) in the connected editor,
# which is how paths clicked in the chat land in the Code pane; the other carries the
# Sessionboxer color themes the Daemon switches between (ADR-0048).
COPY images/sandbox/vscode-sessionboxer /opt/openvscode-server/extensions/sessionboxer
COPY --from=build /src/out/sessionboxer-themes /opt/openvscode-server/extensions/sessionboxer-themes

# Kokoro TTS model (Apache-2.0) that the computer-use MCP speaks recording captions with, in
# sherpa-onnx's packaging (ADR-0029). The release tag is rolling, so the checksum pins the
# contents; Chinese-only files are dropped (narration offers en/es/fr/it/pt/hi).
ARG KOKORO_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2
ARG KOKORO_SHA256=c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298
RUN curl -fsSL "${KOKORO_URL}" -o /tmp/kokoro.tar.bz2 \
    && echo "${KOKORO_SHA256}  /tmp/kokoro.tar.bz2" | sha256sum -c - \
    && mkdir -p /opt/sessionboxer/tts \
    && tar -xjf /tmp/kokoro.tar.bz2 -C /opt/sessionboxer/tts \
    && mv /opt/sessionboxer/tts/kokoro-multi-lang-v1_0 /opt/sessionboxer/tts/kokoro \
    && rm -rf /tmp/kokoro.tar.bz2 /opt/sessionboxer/tts/kokoro/dict /opt/sessionboxer/tts/kokoro/lexicon-zh.txt /opt/sessionboxer/tts/kokoro/*-zh.fst \
    && test -s /opt/sessionboxer/tts/kokoro/model.onnx

# Computer-use MCP server (compiled in stage 1); sherpa-onnx-node brings the TTS runtime.
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
# Devin CLI loads it as an always-on rule too (`devin rules list`). Codex reads
# its global instructions from ~/.codex/AGENTS.md and skills from ~/.agents/skills.
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.claude/CLAUDE.md
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.codex/AGENTS.md
COPY --chown=agent:agent images/sandbox/codex-config.toml /home/agent/.codex/config.toml
COPY --chown=agent:agent images/sandbox/claude-settings.json /home/agent/.claude/settings.json
# Skills the Control Plane asks for by name (ADR-0044); Claude Code discovers them here, Devin reads the file.
COPY --chown=agent:agent images/sandbox/skills /home/agent/.claude/skills
RUN mkdir -p /home/agent/.agents && ln -s /home/agent/.claude/skills /home/agent/.agents/skills && chown -Rh agent:agent /home/agent/.agents
COPY --chown=agent:agent images/sandbox/mcp.json /home/agent/.sessionboxer/mcp.json
COPY images/sandbox/entrypoint.sh /usr/local/bin/sessionboxer-entrypoint
RUN chmod +x /usr/local/bin/sessionboxer-entrypoint

# bb, the gh-like CLI for Bitbucket Data Center (github.com/talayolabs/bb), bundled from a pinned
# commit into one file; `bb pr create`, `bb api` and the git credential helper below use it.
ARG BB_REF=0eed2a2f8a0531f61cb2c04b55ebd5bbeea55275
RUN mkdir /tmp/bb && cd /tmp/bb \
    && git init -q && git fetch -q --depth 1 https://github.com/talayolabs/bb.git "${BB_REF}" && git checkout -q FETCH_HEAD \
    && npm ci --ignore-scripts && npm run bundle \
    && install -D -m 0644 build/bb.mjs /opt/sessionboxer/bb/bb.mjs \
    && printf '#!/bin/sh\nexec node /opt/sessionboxer/bb/bb.mjs "$@"\n' > /usr/local/bin/bb && chmod 0755 /usr/local/bin/bb \
    && cd / && rm -rf /tmp/bb && npm cache clean --force \
    && bb --version

# GitHub and Bitbucket logins arrive from the Control Plane while a Connector entry is enabled:
# the Daemon writes gh's / bb's hosts.yml on tmpfs (nothing in Snapshots); git asks gh for
# github.com and bb for every host (bb answers only for the Bitbucket hosts it is logged in to).
RUN git config --system credential.https://github.com.helper '!gh auth git-credential' \
    && git config --system credential.helper '!bb auth git-credential'

# A repository bound to one GitHub login (Sessionboxer per-repository accounts) gets, in its own
# .git/config, `credential.https://github.com.helper = sessionboxer <login>` and
# `sessionboxer.githubAccount = <login>`: git asks this helper for that login's token and the gh
# in front of /usr/bin/gh acts as it whenever the working directory is that repository.
COPY images/sandbox/git-credential-sessionboxer /usr/local/bin/git-credential-sessionboxer
COPY images/sandbox/gh-as-repo-account /usr/local/bin/gh
RUN chmod 0755 /usr/local/bin/git-credential-sessionboxer /usr/local/bin/gh

ENV DISPLAY=:1 \
    SESSIONBOXER_DISPLAY_WIDTH=1024 \
    SESSIONBOXER_DISPLAY_HEIGHT=768 \
    HOME=/home/agent \
    GH_CONFIG_DIR=/dev/shm/sessionboxer/gh \
    GH_NO_UPDATE_NOTIFIER=1 \
    BB_CONFIG_DIR=/dev/shm/sessionboxer/bb \
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

# 6080: noVNC/websockify, 7000: Sandbox Daemon (RPC, raw files and the Code pane's
# VS Code). Both are reached only over the Docker network, never published on the host.
EXPOSE 6080 7000

ENTRYPOINT ["tini", "--", "/usr/local/bin/sessionboxer-entrypoint"]
