#!/usr/bin/env bash
# Sandbox entrypoint: bring up the Desktop stack, then hand over to the
# Sandbox Daemon (or, until M1 lands, idle so the Control Plane can exec in).
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

if [[ $# -gt 0 ]]; then
  exec "$@"
fi

# M0: nothing else to run yet; keep the container alive for docker exec.
exec sleep infinity
