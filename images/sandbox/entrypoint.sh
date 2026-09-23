#!/usr/bin/env bash
# Sandbox entrypoint: bring up the Desktop stack (and dockerd for Docker-enabled
# Sessions), then hand over to the Sandbox Daemon.
set -euo pipefail

: "${DISPLAY:=:1}"
: "${SESSIONBOXER_DISPLAY_WIDTH:=1024}"
: "${SESSIONBOXER_DISPLAY_HEIGHT:=768}"
: "${SESSIONBOXER_NOVNC_PORT:=6080}"
: "${SESSIONBOXER_VNC_PORT:=5900}"

LOG_DIR="$HOME/.sessionboxer/log"
mkdir -p "$LOG_DIR"

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# Git identity is injected per Sandbox by the Control Plane (ADR: no GitHub
# token in the MVP, identity only).
if [[ -n "${GIT_AUTHOR_NAME:-}" ]]; then
  git config --global user.name "$GIT_AUTHOR_NAME"
fi
if [[ -n "${GIT_AUTHOR_EMAIL:-}" ]]; then
  git config --global user.email "$GIT_AUTHOR_EMAIL"
fi

# A stopped container keeps its /tmp, so a previous X server's lock would
# otherwise block the Desktop on resume.
rm -f "/tmp/.X${DISPLAY#:}-lock" "/tmp/.X11-unix/X${DISPLAY#:}"

log "starting Xvfb on $DISPLAY (${SESSIONBOXER_DISPLAY_WIDTH}x${SESSIONBOXER_DISPLAY_HEIGHT})"
Xvfb "$DISPLAY" -screen 0 "${SESSIONBOXER_DISPLAY_WIDTH}x${SESSIONBOXER_DISPLAY_HEIGHT}x24" \
  -ac -nolisten tcp -dpi 96 >"$LOG_DIR/xvfb.log" 2>&1 &

for _ in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || { log "Xvfb failed to start"; cat "$LOG_DIR/xvfb.log" >&2; exit 1; }

log "starting xfce4"
# xfce4 needs a session bus; xfconfd and friends are started by the session.
dbus-launch --exit-with-session startxfce4 >"$LOG_DIR/xfce4.log" 2>&1 &

log "starting x11vnc on 127.0.0.1:${SESSIONBOXER_VNC_PORT}"
x11vnc -display "$DISPLAY" -forever -shared -nopw -localhost -rfbport "$SESSIONBOXER_VNC_PORT" \
  -xkb -noxrecord -noxfixes -noxdamage -quiet -bg -o "$LOG_DIR/x11vnc.log"

log "starting noVNC on 0.0.0.0:${SESSIONBOXER_NOVNC_PORT}"
websockify --web /usr/share/novnc "0.0.0.0:${SESSIONBOXER_NOVNC_PORT}" \
  "127.0.0.1:${SESSIONBOXER_VNC_PORT}" >"$LOG_DIR/novnc.log" 2>&1 &

log "desktop ready"

# SESSIONBOXER_DOCKER is `sysbox` or `privileged` (ADR-0008); either way the
# Sandbox gets a private dockerd, whose state survives Stop/Resume.
if [[ -n "${SESSIONBOXER_DOCKER:-}" ]]; then
  log "starting dockerd (${SESSIONBOXER_DOCKER})"
  # cgroup v2 nesting: move PID 1's cgroup out of the root so dockerd can
  # create its own subtrees (same dance as the official docker:dind image).
  if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
    sudo -n bash -c '
      mkdir -p /sys/fs/cgroup/init
      xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs || :
      sed -e "s/ / +/g" -e "s/^/+/" < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control
    ' 2>>"$LOG_DIR/dockerd.log" || log "cgroup nesting setup failed (continuing)"
  fi
  # /run is part of the container's rootfs, so a stopped Sandbox keeps the
  # previous daemon's pid files.
  sudo -n rm -f /var/run/docker.pid /run/containerd/containerd.pid
  # SESSIONBOXER_DOCKER_POOL (`192.168.240.0/20`): the block this dockerd carves its
  # networks from, instead of 172.17.0.0/16 and up, which would shadow company
  # or VPN hosts in those ranges. docker0 takes the first /24 of it.
  dockerd_args=()
  if [[ "${SESSIONBOXER_DOCKER_POOL:-}" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.[0-9]+/[0-9]+$ ]]; then
    dockerd_args=(--bip "${BASH_REMATCH[1]}.1/24" --default-address-pool "base=${SESSIONBOXER_DOCKER_POOL},size=24")
    log "dockerd address pool ${SESSIONBOXER_DOCKER_POOL}"
  fi
  sudo -n dockerd "${dockerd_args[@]}" >>"$LOG_DIR/dockerd.log" 2>&1 &
  for _ in $(seq 1 150); do
    if docker info >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
  if docker info >/dev/null 2>&1; then
    log "dockerd ready"
  else
    log "dockerd did not come up; see $LOG_DIR/dockerd.log"
    tail -n 20 "$LOG_DIR/dockerd.log" >&2 || true
  fi
fi

if [[ $# -gt 0 ]]; then
  exec "$@"
fi

# The Sandbox Daemon is PID-1's child: when it dies the container exits and
# the Control Plane sees the Session fail.
exec sessionboxer-daemon
