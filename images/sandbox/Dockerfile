# Sessionboxer Sandbox image: one container per Session, with an X11 Desktop
# (Xvfb + xfce4 + x11vnc + noVNC), the Sandbox Daemon, the computer-use MCP server and the ACP
# Agent of one Provider (or of every Provider). Build from the repo root:
#   npm run build:image [-- --provider <providerId>|base|all]      (scripts/build-image.mjs)
# which is `docker build -f images/sandbox/Dockerfile --target <target> -t ... .` plus the
# `extra-ca` build secret: the CA certificates this machine trusts beyond the public ones
# (Cloudflare WARP, a corporate proxy), so downloads during the build pass TLS inspection.
# EXTRA_CA_FINGERPRINT only changes when that bundle changes; it makes the layers that
# download things rebuild when it does (secret contents are not part of the layer cache key).
#
# Targets (ADR-0088; docs/research/sandbox-image-per-provider-variants.md §6):
#   build              compiles the Sessionboxer packages (Node image)
#   toolchain          Ubuntu + apt stack, uv, VS Code server, Kokoro, bb, the agent user: every pinned
#                      common download, trust-configured, no Sessionboxer code
#   agent-<providerId> one per Provider in PROVIDERS (packages/protocol): installs that Agent into its payload
#   base               toolchain + Sessionboxer dependencies, code and configuration, no Agent
#   <providerId>       base + that Provider's payload (published as <version>-<providerId>)
#   all                base + every payload: the default target, what plain `docker build` and
#                      <version> / <version>-all are
# A source-only edit rebuilds base and the final copies, never an agent-* stage; a pin bump rebuilds
# that one payload. scripts/sandbox-image.test.mjs checks every Provider has both stages. The release
# (scripts/release-sandbox.mjs) builds the finals against the pushed base by digest,
# `--build-context base=docker-image://<repo>@<digest>`, so every variant shares its layers exactly.
#
# Payload layout, /opt/sessionboxer/providers/<providerId>/ (payloadFormat 1):
#   bin/<launcher>     every command the Daemon's provider-commands.ts spawns (and the terminal
#                      command), a relative symlink into lib/; linked into /usr/local/bin by
#                      sessionboxer-link-providers in the final target
#   lib/               the Agent's runtime closure (npm prefix layout `lib/node_modules`, or the
#                      vendor's unpacked archive), root-owned so a Sandbox runs the pinned version
#   manifest.json      { provider, version, payloadFormat: 1, files: [relative paths] }
# A payload is self-contained: nothing in it points outside it, so it is the same bytes in the
# agent-* stage, its own final target and `all`. Labels on base and every final:
# org.opencontainers.image.version, io.sessionboxer.providers (comma-separated ids, empty for base),
# io.sessionboxer.payload-format=1, io.sessionboxer.runtime.
# ---------------------------------------------------------------------------
# Stage 1: compile Sessionboxer TypeScript packages
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/computer-use-mcp/package.json packages/computer-use-mcp/
COPY packages/sessionboxer-mcp/package.json packages/sessionboxer-mcp/
COPY packages/mcp-tee/package.json packages/mcp-tee/
COPY packages/protocol/package.json packages/protocol/
COPY packages/sandbox-daemon/package.json packages/sandbox-daemon/
ARG EXTRA_CA_FINGERPRINT=
RUN --mount=type=secret,id=extra-ca \
    if [ -s /run/secrets/extra-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi \
    && npm ci --workspace @sessionboxer/computer-use-mcp --workspace @sessionboxer/sessionboxer-mcp \
      --workspace @sessionboxer/mcp-tee --workspace @sessionboxer/protocol --workspace @sessionboxer/sandbox-daemon --ignore-scripts
COPY packages/computer-use-mcp packages/computer-use-mcp
COPY packages/sessionboxer-mcp packages/sessionboxer-mcp
COPY packages/mcp-tee packages/mcp-tee
COPY packages/protocol packages/protocol
COPY packages/sandbox-daemon packages/sandbox-daemon
RUN npm run build -w @sessionboxer/protocol \
    && npm run build -w @sessionboxer/computer-use-mcp \
    && npm run build -w @sessionboxer/sessionboxer-mcp \
    && npm run build -w @sessionboxer/mcp-tee \
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
# Stage 2: toolchain, the pinned common downloads every other stage starts from
# ---------------------------------------------------------------------------
FROM ubuntu:24.04 AS toolchain

# Every ARG is declared right before the RUN that uses it: an ARG is part of the cache key of
# every RUN that follows it, so a pin declared up here would rebuild the whole image when bumped.
ARG NODE_MAJOR=22
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
      fonts-dejavu fonts-liberation fonts-inter-variable \
      firefox-esr \
      # Windows Sessions (ADR-0057): the Windows VM's desktop over RDP on this X display,
      # its shell over SSH with the password the Control Plane hands over.
      # macOS Sessions (ADR-0059): the same over VNC (QEMU's server) and SSH.
      freerdp3-x11 tigervnc-viewer sshpass \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# uv/uvx system-wide: most Python MCP servers are launched as `uvx <package>`.
ARG UV_VERSION=0.12.13
RUN curl -fsSL https://astral.sh/uv/${UV_VERSION}/install.sh -o /tmp/uv-install.sh \
    && env UV_UNMANAGED_INSTALL=/usr/local/bin sh /tmp/uv-install.sh \
    && rm -f /tmp/uv-install.sh \
    && uv --version && uvx --version

# VS Code in the browser (the Code pane): openvscode-server is started on demand by the
# Sandbox Daemon on the loopback interface and reached only through the Daemon's port.
ARG OPENVSCODE_SERVER_VERSION=1.109.5
RUN arch="$(dpkg --print-architecture)" && case "$arch" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
    && curl -fsSL "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${OPENVSCODE_SERVER_VERSION}/openvscode-server-v${OPENVSCODE_SERVER_VERSION}-linux-${arch}.tar.gz" -o /tmp/openvscode-server.tar.gz \
    && mkdir -p /opt/openvscode-server \
    && tar -xzf /tmp/openvscode-server.tar.gz -C /opt/openvscode-server --strip-components=1 \
    && rm -f /tmp/openvscode-server.tar.gz \
    && ln -s /opt/openvscode-server/bin/openvscode-server /usr/local/bin/openvscode-server
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

# Unprivileged Agent user with passwordless sudo (the container is the boundary).
RUN userdel -r ubuntu 2>/dev/null || true \
    && groupadd -g 1000 agent \
    && useradd -m -u 1000 -g 1000 -s /bin/bash agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
    && chmod 0440 /etc/sudoers.d/agent \
    && usermod -aG docker agent \
    && mkdir -p /workspace && chown agent:agent /workspace

# ---------------------------------------------------------------------------
# Stage 3: one payload builder per Provider, each branching from toolchain. Each installs exactly
# its Agent into /opt/sessionboxer/providers/<providerId> (layout in the header), checks it runs
# from there and writes the payload manifest. Every ARG is declared right before the RUN that
# uses it: an ARG is part of the cache key of every RUN that follows it in its stage.
# ---------------------------------------------------------------------------

# Claude Code CLI (for the user in the terminal tab) and its ACP adapter (spawned by the Sandbox
# Daemon over stdio), npm's global layout under the payload prefix.
FROM toolchain AS agent-claude-code
ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ARG CLAUDE_CODE_VERSION=2.1.272
ARG CLAUDE_AGENT_ACP_VERSION=0.77.0
RUN npm install -g --prefix /opt/sessionboxer/providers/claude-code \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION} \
    && npm cache clean --force \
    && /opt/sessionboxer/providers/claude-code/bin/claude-agent-acp --version \
    && HOME=/tmp /opt/sessionboxer/providers/claude-code/bin/claude --version | grep -q "${CLAUDE_CODE_VERSION}" && rm -rf /tmp/.claude /tmp/.claude.json
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest claude-code ${CLAUDE_CODE_VERSION}

# Codex's ACP adapter, which bundles the Codex CLI (ADR-0046); `codex` for the terminal.
FROM toolchain AS agent-codex
ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ARG CODEX_ACP_VERSION=1.1.9
RUN npm install -g --prefix /opt/sessionboxer/providers/codex @agentclientprotocol/codex-acp@${CODEX_ACP_VERSION} \
    && npm cache clean --force \
    && ln -s ../lib/node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex/bin/codex.js /opt/sessionboxer/providers/codex/bin/codex \
    && /opt/sessionboxer/providers/codex/bin/codex-acp --version && /opt/sessionboxer/providers/codex/bin/codex --version
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest codex ${CODEX_ACP_VERSION}

# Devin CLI (`devin acp` is spawned by the Sandbox Daemon). The pinned installer is a per-user
# install, so it runs as agent; its trailing `devin setup` tries to log in and fails without a TTY,
# which is fine: credentials are injected per Session (WINDSURF_API_KEY), never baked in. The
# versioned bundle it unpacks then moves into the payload, root-owned; the CLI keeps its state
# (installation id, logs, credentials) under ~/.local/share/devin as before. auto_update is off
# (devin-config.json) so a Sandbox runs the version the image was built with.
FROM toolchain AS agent-devin
ARG DEVIN_CLI_VERSION=3000.10.27
USER agent
RUN export HOME=/home/agent PATH="/home/agent/.local/bin:$PATH" \
    && curl -fsSL https://static.devin.ai/cli/${DEVIN_CLI_VERSION}/setup.sh -o /tmp/devin-setup.sh \
    && (bash /tmp/devin-setup.sh </dev/null >/tmp/devin-setup.log 2>&1 || true) \
    && rm -f /tmp/devin-setup.sh /tmp/devin-setup.log \
    && devin --version
USER root
RUN install -d /opt/sessionboxer/providers/devin/bin \
    && mv /home/agent/.local/share/devin/cli/_versions/${DEVIN_CLI_VERSION} /opt/sessionboxer/providers/devin/lib \
    && chown -R root:root /opt/sessionboxer/providers/devin \
    && ln -s ../lib/bin/devin /opt/sessionboxer/providers/devin/bin/devin \
    && HOME=/tmp /opt/sessionboxer/providers/devin/bin/devin --version | grep -q "${DEVIN_CLI_VERSION}" && rm -rf /tmp/.local
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest devin ${DEVIN_CLI_VERSION}

# Cursor CLI (`cursor-agent acp` is spawned by the Sandbox Daemon; `agent` in the terminal, ADR-0054):
# the package Cursor's own installer unpacks, with the Node it bundles (its native modules are
# built for that Node). The two `*-sea` binaries are the code-signed re-exec the CLI uses on macOS
# only; leaving them out saves 270 MB. Auto-update is off (the Daemon passes --disable-auto-update)
# and the install dir is root-owned, so a Sandbox runs the version the image was built with.
FROM toolchain AS agent-cursor
ARG CURSOR_CLI_VERSION=2026.09.23-86fc751
RUN arch="$(dpkg --print-architecture)" && case "$arch" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
    && mkdir -p /opt/sessionboxer/providers/cursor/lib /opt/sessionboxer/providers/cursor/bin \
    && for i in 1 2 3 4 5; do \
         curl -fsSL --retry 5 --retry-all-errors -C - -o /tmp/cursor-agent.tar.gz \
           "https://downloads.cursor.com/lab/${CURSOR_CLI_VERSION}/linux/${arch}/agent-cli-package.tar.gz" && break; \
         [ "$i" = 5 ] && exit 1; sleep 5; \
       done \
    && tar -xzf /tmp/cursor-agent.tar.gz -C /opt/sessionboxer/providers/cursor/lib --strip-components=1 \
         --exclude='*/cursor-agent-sea' --exclude='*/cursor-agent-worker-sea' \
    && rm /tmp/cursor-agent.tar.gz \
    && ln -s ../lib/cursor-agent /opt/sessionboxer/providers/cursor/bin/cursor-agent \
    && ln -s ../lib/cursor-agent /opt/sessionboxer/providers/cursor/bin/agent \
    && test ! -e /opt/sessionboxer/providers/cursor/lib/cursor-agent-sea \
    && HOME=/tmp /opt/sessionboxer/providers/cursor/bin/cursor-agent --version && rm -rf /tmp/.cursor /tmp/.cache /tmp/.config
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest cursor ${CURSOR_CLI_VERSION}

# pi (earendil-works/pi) and pi-acp, the adapter that bridges `pi --mode rpc` to ACP for the Sandbox
# Daemon (ADR-0075); `pi` itself in the terminal. Root-owned so a Sandbox runs the pinned version.
# pi 0.99 is the first line with built-in MCP (`~/.pi/agent/mcp.json`), which the Daemon relies on.
FROM toolchain AS agent-pi
ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ARG PI_VERSION=0.99.2
ARG PI_ACP_VERSION=0.0.34
RUN npm install -g --prefix /opt/sessionboxer/providers/pi \
      @earendil-works/pi-coding-agent@${PI_VERSION} \
      pi-acp@${PI_ACP_VERSION} \
    && npm cache clean --force \
    && HOME=/tmp PI_SKIP_VERSION_CHECK=1 /opt/sessionboxer/providers/pi/bin/pi --version && rm -rf /tmp/.pi
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest pi ${PI_VERSION}

# OpenCode (`opencode acp` is spawned by the Sandbox Daemon; `opencode` in the terminal, ADR-0076):
# the single prebuilt binary of the platform package `opencode-ai` depends on, taken from the npm
# registry by exact version (what `npm i -g opencode-ai@<version>` would unpack). Root-owned so a
# Sandbox runs the version the image was built with; the update check is off
# (OPENCODE_DISABLE_AUTOUPDATE in the Agent's environment and `autoupdate: false` in its config).
FROM toolchain AS agent-opencode
ARG OPENCODE_VERSION=1.18.32
RUN arch="$(dpkg --print-architecture)" && case "$arch" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
    && mkdir -p /opt/sessionboxer/providers/opencode/lib /opt/sessionboxer/providers/opencode/bin \
    && for i in 1 2 3 4 5; do \
         curl -fsSL --retry 5 --retry-all-errors -C - -o /tmp/opencode.tgz \
           "https://registry.npmjs.org/opencode-linux-${arch}/-/opencode-linux-${arch}-${OPENCODE_VERSION}.tgz" && break; \
         [ "$i" = 5 ] && exit 1; sleep 5; \
       done \
    && tar -xzf /tmp/opencode.tgz -C /opt/sessionboxer/providers/opencode/lib --strip-components=2 package/bin/opencode \
    && rm /tmp/opencode.tgz \
    && chmod 0755 /opt/sessionboxer/providers/opencode/lib/opencode \
    && ln -s ../lib/opencode /opt/sessionboxer/providers/opencode/bin/opencode \
    && HOME=/tmp OPENCODE_DISABLE_AUTOUPDATE=1 /opt/sessionboxer/providers/opencode/bin/opencode --version | grep -qx "${OPENCODE_VERSION}" \
    && rm -rf /tmp/.local /tmp/.cache /tmp/.config
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest opencode ${OPENCODE_VERSION}

# Kimi CLI standalone release from the ACP registry; root-owned, checksummed and no self-update
# (KIMI_CLI_NO_AUTO_UPDATE, set in base).
FROM toolchain AS agent-kimi
ARG KIMI_VERSION=1.52.0
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) arch=x86_64; sha=a676204f7804ed5dae87652a9d66f578e0718d5026c9cb1bfa32b9a5eace4208 ;; \
         arm64) arch=aarch64; sha=9e06eea96273600aed485b1f0bedda95b7084db4f22cf28614fe20138933507a ;; \
         *) echo "unsupported arch $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 5 --retry-all-errors -o /tmp/kimi.tar.gz \
         "https://github.com/MoonshotAI/kimi-cli/releases/download/${KIMI_VERSION}/kimi-${KIMI_VERSION}-${arch}-unknown-linux-gnu.tar.gz" \
    && echo "$sha  /tmp/kimi.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/sessionboxer/providers/kimi/lib /opt/sessionboxer/providers/kimi/bin \
    && tar -xzf /tmp/kimi.tar.gz --no-same-owner -C /opt/sessionboxer/providers/kimi/lib \
    && rm /tmp/kimi.tar.gz \
    && chmod 0755 /opt/sessionboxer/providers/kimi/lib/kimi \
    && ln -s ../lib/kimi /opt/sessionboxer/providers/kimi/bin/kimi \
    && HOME=/tmp KIMI_CLI_NO_AUTO_UPDATE=1 /opt/sessionboxer/providers/kimi/bin/kimi --version | grep -qx "kimi, version ${KIMI_VERSION}" \
    && rm -rf /tmp/.kimi
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest kimi ${KIMI_VERSION}

# fx (`fx acp` is spawned by the Sandbox Daemon; `fx` in the terminal, ADR-0077): Vercel Labs'
# single static binary, the release archive its installer (fx.sh/setup.sh) would download, fetched
# directly for the pinned version and checked against the sha256 observed at pin time (the release
# publishes none). Root-owned; auto-upgrade is off per process (the Daemon sets FX_AUTO_UPGRADE=0),
# so a Sandbox runs the version the image was built with.
FROM toolchain AS agent-fx
ARG FX_VERSION=v0.0.11
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) arch=x86_64; sha=0438a067df1e2b0e2d85f1e018795b7fe5a4b5fafb37f4a590a733917e53943b ;; \
         arm64) arch=aarch64; sha=0067d2156ac31956f52bb0b7b69722733d2756a373f47c4456681b1490b458fe ;; \
         *) echo "unsupported arch $arch" >&2; exit 1 ;; \
       esac \
    && mkdir -p /opt/sessionboxer/providers/fx/lib /opt/sessionboxer/providers/fx/bin \
    && for i in 1 2 3 4 5; do \
         curl -fsSL --retry 5 --retry-all-errors -C - -o /tmp/fx.tar.gz \
           "https://releases.fx.sh/${FX_VERSION}/fx-linux-${arch}.tar.gz" && break; \
         [ "$i" = 5 ] && exit 1; sleep 5; \
       done \
    && echo "$sha  /tmp/fx.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/fx.tar.gz --no-same-owner -C /opt/sessionboxer/providers/fx/lib && rm /tmp/fx.tar.gz \
    && ln -s ../lib/fx /opt/sessionboxer/providers/fx/bin/fx \
    && HOME=/tmp FX_AUTO_UPGRADE=0 /opt/sessionboxer/providers/fx/bin/fx --version && rm -rf /tmp/.fx
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest fx ${FX_VERSION}

# GitHub Copilot CLI (`copilot --acp` is spawned by the Sandbox Daemon; `copilot` in the terminal, ADR-0082):
# the npm package `@github/copilot` is a launcher that execs the binary of its platform package
# (`@github/copilot-linux-<arch>`, a Node single-executable application). Both tarballs are fetched from
# the npm registry by exact version and checked against the sha256 observed at pin time, then installed
# root-owned into the payload's lib (the one runtime dependency, detect-libc, comes from the registry). On
# first start the binary unpacks its application files (185 MB) into ~/.cache/copilot; that is done once
# here, into lib/dist, and COPILOT_CLI_DIST_DIR (set in base) points every launch at it, so a Sandbox
# neither unpacks nor downloads anything. Auto-update is off per process (the Daemon passes
# --no-auto-update and sets COPILOT_AUTO_UPDATE=false), so a Sandbox runs the version the image was built with.
FROM toolchain AS agent-copilot
ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ARG COPILOT_VERSION=1.0.91
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) arch=x64; sha=11d1dcd5a30d59b270b201e6eeea78fc8b89a59fa2f7da31fd62b35bdd708104 ;; \
         arm64) arch=arm64; sha=fbc585b4653505e0af63a2ca95a6d6e370b404b46c92f277bba8d66bc01f4829 ;; \
         *) echo "unsupported arch $arch" >&2; exit 1 ;; \
       esac \
    && mkdir -p /opt/sessionboxer/providers/copilot/lib /opt/sessionboxer/providers/copilot/bin \
    && for i in 1 2 3 4 5; do \
         curl -fsSL --retry 5 --retry-all-errors -C - -o /tmp/copilot.tgz \
           "https://registry.npmjs.org/@github/copilot/-/copilot-${COPILOT_VERSION}.tgz" \
         && curl -fsSL --retry 5 --retry-all-errors -C - -o /tmp/copilot-platform.tgz \
           "https://registry.npmjs.org/@github/copilot-linux-${arch}/-/copilot-linux-${arch}-${COPILOT_VERSION}.tgz" && break; \
         [ "$i" = 5 ] && exit 1; sleep 5; \
       done \
    && echo "4f305d718a1e6cb994e926d0f570883eb63bfb79ef091d00d5ff9c67d9d83781  /tmp/copilot.tgz" | sha256sum -c - \
    && echo "$sha  /tmp/copilot-platform.tgz" | sha256sum -c - \
    && cd /opt/sessionboxer/providers/copilot/lib \
    && npm install --no-fund --no-audit --omit=optional /tmp/copilot.tgz /tmp/copilot-platform.tgz \
    && rm /tmp/copilot.tgz /tmp/copilot-platform.tgz && npm cache clean --force \
    && ln -s ../lib/node_modules/.bin/copilot /opt/sessionboxer/providers/copilot/bin/copilot \
    && HOME=/tmp XDG_CACHE_HOME=/tmp/copilot-cache /opt/sessionboxer/providers/copilot/bin/copilot --no-auto-update --version \
    && mv "/tmp/copilot-cache/copilot/pkg/linux-${arch}/${COPILOT_VERSION}" /opt/sessionboxer/providers/copilot/lib/dist \
    && rm -rf /tmp/copilot-cache /tmp/.copilot \
    && HOME=/tmp COPILOT_CLI_DIST_DIR=/opt/sessionboxer/providers/copilot/lib/dist /opt/sessionboxer/providers/copilot/bin/copilot --no-auto-update --version | grep -q "${COPILOT_VERSION}" \
    && rm -rf /tmp/.copilot /tmp/.cache
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest copilot ${COPILOT_VERSION}

# Mistral Vibe (`vibe-acp` is spawned by the Sandbox Daemon, ADR-0085): the standalone ACP build of
# Mistral's agent from its GitHub release (a PyInstaller bundle: the binary and its `_internal`
# runtime, about 260 MB unpacked), the archive the ACP registry pins for the architecture, checked
# against the sha256 the registry publishes. Root-owned; the Daemon runs it with
# VIBE_ENABLE_AUTO_UPDATE=false, so a Sandbox runs the version the image was built with.
FROM toolchain AS agent-vibe
ARG VIBE_VERSION=2.25.8
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) arch=x86_64; sha=dbe693ee66f29fdfcf9029dcbf3b2d4da138554b193e432b089840148ecf08b3 ;; \
         arm64) arch=aarch64; sha=09913291476fd2f8fc5c2b330602d6afded3ae6c016e197d9dcf805922bf82e8 ;; \
         *) echo "unsupported arch $arch" >&2; exit 1 ;; \
       esac \
    && mkdir -p /opt/sessionboxer/providers/vibe/lib /opt/sessionboxer/providers/vibe/bin \
    && for i in 1 2 3 4 5; do \
         curl -fsSL --retry 5 --retry-all-errors -C - -o /tmp/vibe-acp.tar.gz \
           "https://github.com/mistralai/mistral-vibe/releases/download/v${VIBE_VERSION}/vibe-acp-linux-${arch}-${VIBE_VERSION}.tar.gz" && break; \
         [ "$i" = 5 ] && exit 1; sleep 5; \
       done \
    && echo "$sha  /tmp/vibe-acp.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/vibe-acp.tar.gz --no-same-owner -C /opt/sessionboxer/providers/vibe/lib && rm /tmp/vibe-acp.tar.gz \
    && ln -s ../lib/vibe-acp /opt/sessionboxer/providers/vibe/bin/vibe-acp \
    && HOME=/tmp /opt/sessionboxer/providers/vibe/bin/vibe-acp --version && rm -rf /tmp/.vibe
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest vibe ${VIBE_VERSION}

# Grok Build (`grok agent stdio` is spawned by the Sandbox Daemon; `grok` in the terminal, ADR-0086):
# xAI's proprietary agent, one static binary. Its npm package (@xai-official/grok) only unpacks the
# Brotli-compressed binary of the platform package into ~/.grok/bin at postinstall, so the platform
# package is fetched directly for the pinned version, checked against the sha256 npm publishes for it,
# and decompressed with node. Root-owned; the auto-updater is off per process (the Daemon sets
# GROK_DISABLE_AUTOUPDATER=1; `cli.auto_update = false` in its config covers the terminal).
FROM toolchain AS agent-grok
ARG GROK_VERSION=1.0.49
RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) arch=x64; sha=578c9be9d1e3316c04acff2dada0d9cf9e9937e0a44bc1bfe33e08c2cfb6e7cf ;; \
         arm64) arch=arm64; sha=7945ed6d352e23378c346cde3b5fdee51c5132a21a9a9006c8e0ef83e6e4d6d1 ;; \
         *) echo "unsupported arch $arch" >&2; exit 1 ;; \
       esac \
    && mkdir -p /opt/sessionboxer/providers/grok/lib /opt/sessionboxer/providers/grok/bin /tmp/grok \
    && for i in 1 2 3 4 5; do \
         curl -fsSL --retry 5 --retry-all-errors -C - -o /tmp/grok.tgz \
           "https://registry.npmjs.org/@xai-official/grok-linux-${arch}/-/grok-linux-${arch}-${GROK_VERSION}.tgz" && break; \
         [ "$i" = 5 ] && exit 1; sleep 5; \
       done \
    && echo "$sha  /tmp/grok.tgz" | sha256sum -c - \
    && tar -xzf /tmp/grok.tgz --no-same-owner -C /tmp/grok --strip-components=2 package/bin/grok.br \
    && node -e 'const z = require("zlib"), f = require("fs"); f.writeFileSync("/opt/sessionboxer/providers/grok/lib/grok", z.brotliDecompressSync(f.readFileSync("/tmp/grok/grok.br")), { mode: 0o755 })' \
    && rm -rf /tmp/grok /tmp/grok.tgz \
    && ln -s ../lib/grok /opt/sessionboxer/providers/grok/bin/grok \
    && HOME=/tmp GROK_DISABLE_AUTOUPDATER=1 /opt/sessionboxer/providers/grok/bin/grok --version && rm -rf /tmp/.grok
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest grok ${GROK_VERSION}

# Gemini CLI (`gemini --acp` is spawned by the Sandbox Daemon; `gemini` in the terminal, ADR-0087):
# Google's npm package, fetched as the registry tarball of the pinned version and checked against its
# sha256 before `npm install -g` unpacks it (its one bundle has no dependencies of its own; the pty
# and keychain add-ons are optional and skipped so a Google login stays in a file). Root-owned so a
# Sandbox runs the version the image was built with; no update check (the settings file in base
# turns auto-update and its notice off).
FROM toolchain AS agent-gemini
ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ARG GEMINI_CLI_VERSION=0.62.0
ARG GEMINI_CLI_SHA256=2276032b1c33d2b828b1cf197e52f48e74b0a395326763ff01a80d97d0fbc0c3
RUN for i in 1 2 3 4 5; do \
         curl -fsSL --retry 5 --retry-all-errors -C - -o /tmp/gemini-cli.tgz \
           "https://registry.npmjs.org/@google/gemini-cli/-/gemini-cli-${GEMINI_CLI_VERSION}.tgz" && break; \
         [ "$i" = 5 ] && exit 1; sleep 5; \
       done \
    && echo "${GEMINI_CLI_SHA256}  /tmp/gemini-cli.tgz" | sha256sum -c - \
    && npm install -g --prefix /opt/sessionboxer/providers/gemini --omit=optional /tmp/gemini-cli.tgz \
    && rm /tmp/gemini-cli.tgz \
    && npm cache clean --force \
    && HOME=/tmp /opt/sessionboxer/providers/gemini/bin/gemini --version | grep -qx "${GEMINI_CLI_VERSION}" && rm -rf /tmp/.gemini
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest gemini ${GEMINI_CLI_VERSION}

# Qwen Code (ADR-0083): Alibaba's fork of Gemini CLI, whose ACP server is `qwen --acp`. The npm
# tarball is pinned by version and checked against its sha256 before `npm install -g` (root-owned,
# so a Sandbox runs the pinned version); its update check is off in ~/.qwen/settings.json (base).
FROM toolchain AS agent-qwen
ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ARG QWEN_CODE_VERSION=0.24.7
ARG QWEN_CODE_SHA256=64430248ab6e996fc0c6b9a0789361f868c3b97f83d16210e0424e51dffc5fa9
RUN curl -fsSL --retry 5 --retry-all-errors -o /tmp/qwen-code.tgz \
      "https://registry.npmjs.org/@qwen-code/qwen-code/-/qwen-code-${QWEN_CODE_VERSION}.tgz" \
    && echo "${QWEN_CODE_SHA256}  /tmp/qwen-code.tgz" | sha256sum -c - \
    && npm install -g --prefix /opt/sessionboxer/providers/qwen /tmp/qwen-code.tgz \
    && rm /tmp/qwen-code.tgz && npm cache clean --force \
    && HOME=/tmp /opt/sessionboxer/providers/qwen/bin/qwen --version && rm -rf /tmp/.qwen
COPY --chmod=0755 images/sandbox/payload-manifest /usr/local/bin/sessionboxer-payload-manifest
RUN sessionboxer-payload-manifest qwen ${QWEN_CODE_VERSION}

# ---------------------------------------------------------------------------
# Stage 4: base, the shared runtime: toolchain + Sessionboxer dependencies, code and configuration.
# No Agent. Published as <version>-base; what the VM helper containers run.
# ---------------------------------------------------------------------------
FROM toolchain AS base
ARG NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# Computer-use MCP server: dependencies first (sherpa-onnx-node brings the TTS runtime), the
# compiled code (stage 1) after.
COPY packages/computer-use-mcp/package.json /opt/sessionboxer/computer-use-mcp/
RUN cd /opt/sessionboxer/computer-use-mcp \
    && npm pkg delete dependencies.@sessionboxer/protocol \
    && npm install --omit=dev --no-package-lock --ignore-scripts \
    && mkdir -p node_modules/@sessionboxer \
    && ln -s /opt/sessionboxer/protocol node_modules/@sessionboxer/protocol \
    && npm cache clean --force \
    && ln -s /opt/sessionboxer/computer-use-mcp/dist/index.js /usr/local/bin/sessionboxer-computer-use-mcp

# The `sessionboxer` MCP server (ADR-0062): the Agent's knowledge of, and actions on, its own Session,
# through the Daemon on loopback. Its `docs` tool reads the user guide shipped here.
COPY packages/sessionboxer-mcp/package.json /opt/sessionboxer/sessionboxer-mcp/
RUN cd /opt/sessionboxer/sessionboxer-mcp \
    && npm pkg delete dependencies.@sessionboxer/protocol \
    && npm install --omit=dev --no-package-lock --ignore-scripts \
    && mkdir -p node_modules/@sessionboxer \
    && ln -s /opt/sessionboxer/protocol node_modules/@sessionboxer/protocol \
    && npm cache clean --force \
    && ln -s /opt/sessionboxer/sessionboxer-mcp/dist/index.js /usr/local/bin/sessionboxer-mcp
COPY docs/GUIDE.md /opt/sessionboxer/docs/GUIDE.md

# The MCP tee (ADR-0079): the Agent reaches each user MCP server through `sessionboxer-mcp-tee <name>`,
# which mirrors the exchange to the Daemon for MCP Apps.
COPY packages/mcp-tee/package.json /opt/sessionboxer/mcp-tee/
RUN cd /opt/sessionboxer/mcp-tee \
    && npm pkg delete dependencies.@sessionboxer/protocol \
    && npm install --omit=dev --no-package-lock --ignore-scripts \
    && mkdir -p node_modules/@sessionboxer \
    && ln -s /opt/sessionboxer/protocol node_modules/@sessionboxer/protocol \
    && npm cache clean --force \
    && ln -s /opt/sessionboxer/mcp-tee/dist/index.js /usr/local/bin/sessionboxer-mcp-tee

# Sandbox Daemon plus the shared protocol package it imports at runtime; the workspace
# dependency becomes a symlink. node-pty has no Linux prebuilds, so it is compiled here
# (build-essential + python3 above).
COPY packages/protocol/package.json /opt/sessionboxer/protocol/
COPY packages/sandbox-daemon/package.json /opt/sessionboxer/sandbox-daemon/
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
    && ln -s /opt/sessionboxer/sandbox-daemon/dist/sb-util.js /usr/local/bin/sb-util

# GitHub and Bitbucket logins arrive from the Control Plane while a Connector entry is enabled:
# the Daemon writes gh's / bb's hosts.yml on tmpfs (nothing in Snapshots); git asks gh for
# github.com and bb for every host (bb answers only for the Bitbucket hosts it is logged in to).
RUN git config --system credential.https://github.com.helper '!gh auth git-credential' \
    && git config --system credential.helper '!bb auth git-credential'

# A repository bound to one GitHub login (Sessionboxer per-repository accounts) gets, in its own
# .git/config, `credential.https://github.com.helper = sessionboxer <login>` and
# `sessionboxer.githubAccount = <login>`: git asks this helper for that login's token and the gh
# in front of /usr/bin/gh acts as it whenever the working directory is that repository.
COPY --chmod=0755 images/sandbox/git-credential-sessionboxer /usr/local/bin/git-credential-sessionboxer
# Sign in with Mistral Vibe from Settings (ADR-0085): drives `vibe-acp` through its browser sign-in on a pty.
COPY --chmod=0755 images/sandbox/vibe-login /usr/local/bin/sessionboxer-vibe-login
COPY --chmod=0755 images/sandbox/gh-as-repo-account /usr/local/bin/gh

# Firefox: no first-run wizard, no update nags, no default-browser prompt.
COPY images/sandbox/firefox-policies.json /etc/firefox/policies/policies.json

# Sandbox defaults for the VS Code workbench (settings defaults incl. AI features off, no Get
# Started; a stylesheet hiding the Extensions activity item and the remote indicator), linked
# from the workbench page and served by the server's own static route.
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

# Devin only exposes MCP servers from its own config to the model (the one the
# Daemon passes over ACP connects but is invisible to mcp_list_tools/call_tool),
# so the desktop MCP is also registered at user scope.
COPY --chown=agent:agent images/sandbox/devin-config.json /home/agent/.config/devin/config.json
COPY --chown=agent:agent images/sandbox/devin-mcp-config.json /home/agent/.config/devin/mcp_config.json

# Agent-facing configuration and the Desktop entrypoint. The Desktop briefing
# is installed once as ~/.claude/CLAUDE.md: Claude Code reads it natively and
# Devin CLI loads it as an always-on rule too (`devin rules list`). Codex reads
# its global instructions from ~/.codex/AGENTS.md and skills from ~/.agents/skills.
# Cursor reads AGENTS.md from the workspace and every directory above it, so the
# briefing sits at /AGENTS.md: above /workspace and every repository, inside none.
# pi reads ~/.pi/agent/AGENTS.md; its settings trust every project (the Sandbox is the isolation).
# fx reads its user-level instructions from ~/.fx/AGENTS.md and its settings from ~/.fx/settings.json;
# a Session mounts a volume over ~/.fx, populated from these files (ADR-0077).
# Copilot reads its user-level instructions from ~/.copilot/copilot-instructions.md; its settings allow
# plaintext token storage, so a `copilot login` in the terminal lands in the config.json the Daemon keeps on tmpfs (ADR-0082).
# Mistral Vibe reads its user-level AGENTS.md from ~/.vibe (ADR-0085); the Daemon writes its trusted_folders.toml there.
# Grok Build reads its config from ~/.grok/config.toml and every *.md in ~/.grok/rules/ as an always-on
# rule, whatever the project (ADR-0086); the briefing goes there.
COPY --chown=agent:agent images/sandbox/codex-config.toml /home/agent/.codex/config.toml
COPY --chown=agent:agent images/sandbox/pi-settings.json /home/agent/.pi/agent/settings.json
COPY --chown=agent:agent images/sandbox/cursor-cli-config.json /home/agent/.cursor/cli-config.json
COPY --chown=agent:agent images/sandbox/opencode-config.json /home/agent/.config/opencode/opencode.json
COPY --chown=agent:agent images/sandbox/fx-settings.json /home/agent/.fx/settings.json
COPY --chown=agent:agent images/sandbox/copilot-settings.json /home/agent/.copilot/settings.json
COPY --chown=agent:agent images/sandbox/grok-config.toml /home/agent/.grok/config.toml
COPY --chown=agent:agent images/sandbox/gemini-settings.json /home/agent/.gemini/settings.json
COPY --chown=agent:agent images/sandbox/qwen-settings.json /home/agent/.qwen/settings.json
COPY --chown=agent:agent images/sandbox/claude-settings.json /home/agent/.claude/settings.json
COPY --chown=agent:agent images/sandbox/mcp.json /home/agent/.sessionboxer/mcp.json
COPY --chmod=0755 images/sandbox/entrypoint.sh /usr/local/bin/sessionboxer-entrypoint
# Windows Sessions (ADR-0057): the RDP view of the VM and the `win` / `win-scp` commands into it.
COPY --chmod=0755 images/sandbox/windows-desktop /usr/local/bin/sessionboxer-windows-desktop
COPY --chmod=0755 images/sandbox/win images/sandbox/win-scp /usr/local/bin/
# macOS Sessions (ADR-0059, ADR-0061): the VNC view of the VM and the Linux-side `mac` / `mac-scp` conveniences into it.
COPY --chmod=0755 images/sandbox/macos-desktop /usr/local/bin/sessionboxer-macos-desktop
COPY --chmod=0755 images/sandbox/mac images/sandbox/mac-scp /usr/local/bin/
# Skills the Control Plane asks for by name (ADR-0044); Claude Code discovers them here, Devin reads the file.
COPY --chown=agent:agent images/sandbox/skills /home/agent/.claude/skills
RUN mkdir -p /home/agent/.agents && ln -s /home/agent/.claude/skills /home/agent/.agents/skills && chown -Rh agent:agent /home/agent/.agents
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.claude/CLAUDE.md
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.codex/AGENTS.md
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.pi/agent/AGENTS.md
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.config/opencode/AGENTS.md
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.fx/AGENTS.md
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.copilot/copilot-instructions.md
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.vibe/AGENTS.md
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.grok/rules/sandbox-briefing.md
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.gemini/GEMINI.md
COPY --chown=agent:agent images/sandbox/sandbox-briefing.md /home/agent/.qwen/QWEN.md
COPY images/sandbox/sandbox-briefing.md /AGENTS.md
# The briefing an Agent running inside the Windows VM gets instead (ADR-0060); the Daemon pushes it there.
COPY --chown=agent:agent images/sandbox/windows-briefing.md /home/agent/.sessionboxer/windows-briefing.md
COPY --chown=agent:agent images/sandbox/macos-briefing.md /home/agent/.sessionboxer/macos-briefing.md

# The compiled Sessionboxer code (stage 1): the layers that change with every release, last.
COPY --from=build --chmod=0755 /src/packages/computer-use-mcp/dist /opt/sessionboxer/computer-use-mcp/dist
COPY packages/computer-use-mcp/assets /opt/sessionboxer/computer-use-mcp/assets
COPY --from=build --chmod=0755 /src/packages/sessionboxer-mcp/dist /opt/sessionboxer/sessionboxer-mcp/dist
COPY --from=build --chmod=0755 /src/packages/mcp-tee/dist /opt/sessionboxer/mcp-tee/dist
COPY --from=build /src/packages/protocol/dist /opt/sessionboxer/protocol/dist
COPY --from=build --chmod=0755 /src/packages/sandbox-daemon/dist /opt/sessionboxer/sandbox-daemon/dist

# Links every payload's launchers into /usr/local/bin (run by the final targets below).
COPY --chmod=0755 images/sandbox/link-providers /usr/local/bin/sessionboxer-link-providers

ENV DISPLAY=:1 \
    SESSIONBOXER_DISPLAY_WIDTH=1024 \
    SESSIONBOXER_DISPLAY_HEIGHT=768 \
    HOME=/home/agent \
    GH_CONFIG_DIR=/dev/shm/sessionboxer/gh \
    GH_NO_UPDATE_NOTIFIER=1 \
    BB_CONFIG_DIR=/dev/shm/sessionboxer/bb \
    IS_SANDBOX=1 \
    KIMI_CLI_NO_AUTO_UPDATE=1 \
    COPILOT_CLI_DIST_DIR=/opt/sessionboxer/providers/copilot/lib/dist \
    PATH=/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER agent
WORKDIR /workspace

# 6080: noVNC/websockify, 7000: Sandbox Daemon (RPC, raw files and the Code pane's
# VS Code). Both are reached only over the Docker network, never published on the host.
EXPOSE 6080 7000

ENTRYPOINT ["tini", "--", "/usr/local/bin/sessionboxer-entrypoint"]

# Image labels of the contract (ADR-0088); SESSIONBOXER_VERSION comes from scripts/build-image.mjs
# or the release workflow. Declared after every RUN so a version bump only rewrites metadata.
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="" \
      io.sessionboxer.payload-format="1" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

# ---------------------------------------------------------------------------
# Stage 5: the final images, base plus payloads. One per Provider (<version>-<providerId>) and
# `all`, the default target (<version>, <version>-all): the same payload bytes, never reinstalled.
# ---------------------------------------------------------------------------

FROM base AS claude-code
USER root
COPY --from=agent-claude-code /opt/sessionboxer/providers/claude-code /opt/sessionboxer/providers/claude-code
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="claude-code" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS devin
USER root
COPY --from=agent-devin /opt/sessionboxer/providers/devin /opt/sessionboxer/providers/devin
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="devin" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS codex
USER root
COPY --from=agent-codex /opt/sessionboxer/providers/codex /opt/sessionboxer/providers/codex
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="codex" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS cursor
USER root
COPY --from=agent-cursor /opt/sessionboxer/providers/cursor /opt/sessionboxer/providers/cursor
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="cursor" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS pi
USER root
COPY --from=agent-pi /opt/sessionboxer/providers/pi /opt/sessionboxer/providers/pi
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="pi" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS opencode
USER root
COPY --from=agent-opencode /opt/sessionboxer/providers/opencode /opt/sessionboxer/providers/opencode
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="opencode" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS fx
USER root
COPY --from=agent-fx /opt/sessionboxer/providers/fx /opt/sessionboxer/providers/fx
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="fx" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS kimi
USER root
COPY --from=agent-kimi /opt/sessionboxer/providers/kimi /opt/sessionboxer/providers/kimi
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="kimi" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS copilot
USER root
COPY --from=agent-copilot /opt/sessionboxer/providers/copilot /opt/sessionboxer/providers/copilot
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="copilot" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS vibe
USER root
COPY --from=agent-vibe /opt/sessionboxer/providers/vibe /opt/sessionboxer/providers/vibe
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="vibe" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS grok
USER root
COPY --from=agent-grok /opt/sessionboxer/providers/grok /opt/sessionboxer/providers/grok
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="grok" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS gemini
USER root
COPY --from=agent-gemini /opt/sessionboxer/providers/gemini /opt/sessionboxer/providers/gemini
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="gemini" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS qwen
USER root
COPY --from=agent-qwen /opt/sessionboxer/providers/qwen /opt/sessionboxer/providers/qwen
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="qwen" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"

FROM base AS all
USER root
COPY --from=agent-claude-code /opt/sessionboxer/providers/claude-code /opt/sessionboxer/providers/claude-code
COPY --from=agent-devin /opt/sessionboxer/providers/devin /opt/sessionboxer/providers/devin
COPY --from=agent-codex /opt/sessionboxer/providers/codex /opt/sessionboxer/providers/codex
COPY --from=agent-cursor /opt/sessionboxer/providers/cursor /opt/sessionboxer/providers/cursor
COPY --from=agent-pi /opt/sessionboxer/providers/pi /opt/sessionboxer/providers/pi
COPY --from=agent-opencode /opt/sessionboxer/providers/opencode /opt/sessionboxer/providers/opencode
COPY --from=agent-fx /opt/sessionboxer/providers/fx /opt/sessionboxer/providers/fx
COPY --from=agent-kimi /opt/sessionboxer/providers/kimi /opt/sessionboxer/providers/kimi
COPY --from=agent-copilot /opt/sessionboxer/providers/copilot /opt/sessionboxer/providers/copilot
COPY --from=agent-vibe /opt/sessionboxer/providers/vibe /opt/sessionboxer/providers/vibe
COPY --from=agent-grok /opt/sessionboxer/providers/grok /opt/sessionboxer/providers/grok
COPY --from=agent-gemini /opt/sessionboxer/providers/gemini /opt/sessionboxer/providers/gemini
COPY --from=agent-qwen /opt/sessionboxer/providers/qwen /opt/sessionboxer/providers/qwen
RUN sessionboxer-link-providers
USER agent
ARG SESSIONBOXER_VERSION
LABEL org.opencontainers.image.version="${SESSIONBOXER_VERSION}" \
      io.sessionboxer.providers="claude-code,devin,codex,cursor,pi,opencode,fx,kimi,copilot,vibe,grok,gemini,qwen" \
      io.sessionboxer.runtime="${SESSIONBOXER_VERSION}"
