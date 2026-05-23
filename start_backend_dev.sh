#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

HOST="${TWILIGHT_API_HOST:-0.0.0.0}"
PORT="${TWILIGHT_API_PORT:-5000}"
CONFIG="config.toml"

echo "=========================================="
echo "   Twilight Backend (Go Development)"
echo "=========================================="
echo "Host: $HOST  Port: $PORT"
echo "Config: $CONFIG"

if [[ -n "${TWILIGHT_GO_BIN:-}" ]]; then
  exec "$TWILIGHT_GO_BIN" api --host "$HOST" --port "$PORT" --config "$CONFIG" --debug "$@"
fi

if [[ -x "./bin/twilight" ]]; then
  exec ./bin/twilight api --host "$HOST" --port "$PORT" --config "$CONFIG" --debug "$@"
fi

exec go run ./cmd/twilight api --host "$HOST" --port "$PORT" --config "$CONFIG" --debug "$@"
