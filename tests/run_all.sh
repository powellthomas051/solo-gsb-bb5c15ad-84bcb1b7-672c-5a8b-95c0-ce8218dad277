#!/usr/bin/env bash
# Full test sweep:
#   1. Python + JS syntax
#   2. merge-engine scenarios (Python) and Python<->JS output parity
#   3. end-to-end WebSocket/offline-queue/conflict tests against a live server
#   4. SyncClient (Lamport / version vector / localStorage queue) tests
#
# The server binds to an ephemeral free port (avoiding stale sockets on 8000).
set -euo pipefail
cd "$(dirname "$0")/.."

export DB_PATH="$(mktemp -d)/theater-test.db"

PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
BASE="http://127.0.0.1:$PORT"
export TEST_BASE="$BASE"
echo "test server: $BASE (db $DB_PATH)"

echo "== 1. syntax =="
python3 -m py_compile app/*.py tests/test_sync.py
for f in static/js/*.js tests/*.js; do node --check "$f" >/dev/null; done
echo "ok"

echo "== 2. merge engine (Python scenarios + JSON fixtures) =="
python3 tests/test_sync.py >/dev/null
echo "python scenarios ok"
node tests/test_js_consistency.js

echo "== 3. boot server =="
LOG="$(mktemp)"
setsid python3 -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --app-dir "$(pwd)" >"$LOG" 2>&1 < /dev/null &
SRV=$!
trap 'kill -- -"$SRV" 2>/dev/null || kill "$SRV" 2>/dev/null || true' EXIT

UP=0
for _ in $(seq 1 100); do
  if curl -sf "$BASE/api/plays" >/dev/null 2>&1; then UP=1; break; fi
  if ! kill -0 "$SRV" 2>/dev/null; then
    echo "server exited early:"; cat "$LOG"; exit 1
  fi
  sleep 0.1
done
[ "$UP" = 1 ] || { echo "server did not become ready:"; cat "$LOG"; exit 1; }
echo "server up (pid $SRV)"

echo "== 4. websocket / offline queue / conflict e2e =="
node tests/e2e.js

echo "== 5. SyncClient engine =="
node tests/test_client.js

echo
echo "ALL TEST SUITES PASSED"
