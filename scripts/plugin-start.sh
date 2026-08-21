#!/usr/bin/env bash
# Ensure the herdr-web bridge is running (idempotent; used by the plugin
# [[startup]] hook and the "Start" action). Startup hooks must exit, so the
# server is detached with setsid+nohup. State lives in HERDR_PLUGIN_STATE_DIR
# when run as a plugin, else ~/.local/state/herdr-web.
set -euo pipefail

PORT="${HERDR_WEB_PORT:-7930}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr-web}"
mkdir -p "$STATE_DIR"

if curl -sf "http://127.0.0.1:${PORT}/api/sessions" >/dev/null 2>&1; then
  echo "herdr-web already running on :${PORT}"
  exit 0
fi

if [ ! -d "$ROOT/node_modules/express" ]; then
  (cd "$ROOT" && npm install --no-fund --no-audit)
fi

# VAPID push keys, same /etc/homelab/[service].env pattern as every other
# homelab service secret — see lib/push.js. Push is simply disabled if this
# isn't provisioned yet (no auto-generated key material).
if [ -f /etc/homelab/herdr-web.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/homelab/herdr-web.env
  set +a
fi

setsid nohup node "$ROOT/server.js" >> "$STATE_DIR/server.log" 2>&1 < /dev/null &
echo $! > "$STATE_DIR/server.pid"

for _ in $(seq 1 20); do
  sleep 0.5
  if curl -sf "http://127.0.0.1:${PORT}/api/sessions" >/dev/null 2>&1; then
    echo "herdr-web started on http://127.0.0.1:${PORT} (log: $STATE_DIR/server.log)"
    exit 0
  fi
done
echo "herdr-web failed to start — see $STATE_DIR/server.log" >&2
exit 1
