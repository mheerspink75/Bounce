#!/usr/bin/env bash
# Exercises the real provider path. Requires a key in .env.
# Never prints the key.
# Resolve the package root from this script's own location, so the script works
# wherever the checkout lives (it previously hardcoded a /home/... WSL path).
cd "$(dirname "$0")/.." || exit 1

PORT="${1:-8799}"
LOG="/tmp/opencode-live-$PORT.log"

PORT="$PORT" node --env-file-if-exists=.env server/index.js > "$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
sleep 3

if ! kill -0 "$PID" 2>/dev/null; then
  echo "proxy failed to start:"; tail -5 "$LOG"; exit 1
fi

echo "=== startup banner ==="
grep -E "listening|provider:|to use" "$LOG"
echo

echo "=== /api/health ==="
curl -s -m 20 "http://127.0.0.1:$PORT/api/health"; echo
echo

echo "=== live /api/character (real model call) ==="
time curl -s -m 90 -X POST -H 'content-type: application/json' \
  "http://127.0.0.1:$PORT/api/character" -d '{}'
echo
echo

echo "=== second live /api/character (does it vary?) ==="
curl -s -m 90 -X POST -H 'content-type: application/json' \
  "http://127.0.0.1:$PORT/api/character" -d '{}'
echo
echo

echo "=== live /api/intent (real model call) ==="
curl -s -m 90 -X POST -H 'content-type: application/json' \
  "http://127.0.0.1:$PORT/api/intent" -d '{}'
echo
