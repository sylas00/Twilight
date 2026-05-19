#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -x ".venv/bin/python" ]]; then
  PYTHON=".venv/bin/python"
elif [[ -x "venv/bin/python" ]]; then
  PYTHON="venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
else
  PYTHON="python"
fi

echo "=========================================="
echo "   Twilight Backend (Development)"
echo "=========================================="
echo "Using Python: $PYTHON"
echo "Mode: development (main.py api --debug)"
WITH_SCHEDULER="${TWILIGHT_WITH_SCHEDULER:-1}"
SCHEDULER_LOCK_FILE="${TWILIGHT_SCHEDULER_LOCK_FILE:-$SCRIPT_DIR/db/scheduler.lock}"

if [[ "$WITH_SCHEDULER" == "1" ]]; then
  echo "Scheduler: enabled (separate process)"
  EXISTING_SCHEDULER_PID=""
  if [[ -f "$SCHEDULER_LOCK_FILE" ]]; then
    EXISTING_SCHEDULER_PID="$(tr -dc '0-9' < "$SCHEDULER_LOCK_FILE" || true)"
    if [[ -n "$EXISTING_SCHEDULER_PID" ]] && kill -0 "$EXISTING_SCHEDULER_PID" 2>/dev/null; then
      echo "Found running Scheduler PID: $EXISTING_SCHEDULER_PID, skip starting duplicate instance"
    else
      EXISTING_SCHEDULER_PID=""
    fi
  fi

  if [[ -z "$EXISTING_SCHEDULER_PID" ]]; then
    "$PYTHON" main.py scheduler &
    SCHEDULER_PID=$!
  fi

  cleanup() {
    if [[ -n "${SCHEDULER_PID:-}" ]]; then
      kill "$SCHEDULER_PID" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT INT TERM
else
  echo "Scheduler: disabled (set TWILIGHT_WITH_SCHEDULER=1 to enable)"
fi

"$PYTHON" main.py api --debug "$@"
exit $?
