# The Control Plane as a container (docker compose / a home server / Coolify): the published
# `sessionboxer` npm package installed globally, nothing else. Build context is the directory
# holding the tarball `npm run pack` wrote (build/):
#
#   npm run pack && docker build -f images/control-plane/Dockerfile -t sessionboxer/control-plane:dev build
#
# It talks to the host's Docker daemon through /var/run/docker.sock (mounted by docker-compose.yml),
# so Sandboxes run as siblings, not inside this container; the Sandbox image is pulled by version.

# Stage 1 installs the package with a compiler at hand for the native addons (better-sqlite3 has
# prebuilt binaries for amd64 and arm64; ssh2's optional cpu-features does not).
FROM node:22-bookworm-slim AS install
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=bind,source=.,target=/tmp/pkg \
    set -eu; tgz="$(ls /tmp/pkg/sessionboxer-*.tgz | head -n 1)"; \
    npm install -g --omit=dev "$tgz" \
    && npm cache clean --force

FROM node:22-bookworm-slim
# git: the Control Plane lists the tracked files of a host folder it copies into a Sandbox or pulls into.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=install /usr/local/lib/node_modules/sessionboxer /usr/local/lib/node_modules/sessionboxer
RUN ln -s ../lib/node_modules/sessionboxer/apps/cli/dist/index.js /usr/local/bin/sessionboxer \
    && sessionboxer version

ENV SESSIONBOXER_HOME=/data \
    SESSIONBOXER_HOST=0.0.0.0 \
    SESSIONBOXER_PORT=4000 \
    SESSIONBOXER_IN_CONTAINER=1 \
    NODE_ENV=production
VOLUME /data
EXPOSE 4000

# Root, because /var/run/docker.sock is owned by root (or the docker group, whose id differs per
# host); the container is root-equivalent on the host through that socket anyway.
ENTRYPOINT ["tini", "--", "sessionboxer"]
CMD ["serve"]
