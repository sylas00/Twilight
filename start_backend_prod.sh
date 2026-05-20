#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 防 CRLF：上游 env / .env 可能携带 \r，导致 [[ $X == "1" ]] 这种条件统统判错，
# 历史上就因此让 Scheduler 整段被跳过。所有外部变量都走一遍 strip_cr。
strip_cr() { printf '%s' "${1//$'\r'/}"; }

if [[ -x ".venv/bin/python" ]]; then
  PYTHON=".venv/bin/python"
elif [[ -x "venv/bin/python" ]]; then
  PYTHON="venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
else
  PYTHON="python"
fi

HOST="$(strip_cr "${TWILIGHT_API_HOST:-0.0.0.0}")"
PORT="$(strip_cr "${TWILIGHT_API_PORT:-5000}")"
WORKERS="$(strip_cr "${TWILIGHT_UVICORN_WORKERS:-1}")"
LIMIT_CONCURRENCY="$(strip_cr "${TWILIGHT_UVICORN_LIMIT_CONCURRENCY:-100}")"
BACKLOG="$(strip_cr "${TWILIGHT_UVICORN_BACKLOG:-128}")"
KEEP_ALIVE="$(strip_cr "${TWILIGHT_UVICORN_KEEP_ALIVE:-5}")"
NOFILE="$(strip_cr "${TWILIGHT_NOFILE_LIMIT:-65535}")"
WITH_BOT="$(strip_cr "${TWILIGHT_WITH_BOT:-1}")"
FORCE_RESTART_BOT="$(strip_cr "${TWILIGHT_FORCE_RESTART_BOT:-0}")"
BOT_LOCK_FILE="$(strip_cr "${TWILIGHT_BOT_LOCK_FILE:-$SCRIPT_DIR/db/telegram_bot.lock}")"
WITH_SCHEDULER="$(strip_cr "${TWILIGHT_WITH_SCHEDULER:-1}")"
FORCE_RESTART_SCHEDULER="$(strip_cr "${TWILIGHT_FORCE_RESTART_SCHEDULER:-0}")"
SCHEDULER_LOCK_FILE="$(strip_cr "${TWILIGHT_SCHEDULER_LOCK_FILE:-$SCRIPT_DIR/db/scheduler.lock}")"

# 子进程要往锁目录写文件，提前 mkdir 一次
mkdir -p "$(dirname "$BOT_LOCK_FILE")" "$(dirname "$SCHEDULER_LOCK_FILE")"

echo "=========================================="
echo "   Twilight Backend (Production)"
echo "=========================================="
echo "Using Python: $PYTHON"
echo "Mode: production (uvicorn)"
echo "Host: $HOST  Port: $PORT  Workers: $WORKERS"
echo "Uvicorn: limit_concurrency=$LIMIT_CONCURRENCY backlog=$BACKLOG keep_alive=${KEEP_ALIVE}s"

if command -v ulimit >/dev/null 2>&1; then
  CURRENT_NOFILE="$(ulimit -n || true)"
  if ulimit -n "$NOFILE" 2>/dev/null; then
    echo "NOFILE: $(ulimit -n)"
  else
    echo "WARNING: unable to raise NOFILE to $NOFILE (current: $CURRENT_NOFILE). Configure systemd LimitNOFILE or container ulimit."
  fi
fi
if [[ "$WITH_BOT" == "1" ]]; then
  echo "Bot: enabled (separate process)"
  echo "Bot lock: $BOT_LOCK_FILE"
else
  echo "Bot: disabled (set TWILIGHT_WITH_BOT=1 to enable)"
fi
if [[ "$WITH_SCHEDULER" == "1" ]]; then
  echo "Scheduler: enabled (separate process)"
  echo "Scheduler lock: $SCHEDULER_LOCK_FILE"
else
  echo "Scheduler: disabled (set TWILIGHT_WITH_SCHEDULER=1 to enable)"
fi

BOT_STARTED=0
SCHEDULER_STARTED=0

if [[ "$WITH_BOT" == "1" ]]; then
  EXISTING_BOT_PID=""

  if [[ -f "$BOT_LOCK_FILE" ]]; then
    EXISTING_BOT_PID="$(tr -dc '0-9' < "$BOT_LOCK_FILE" || true)"
    if [[ -n "$EXISTING_BOT_PID" ]] && kill -0 "$EXISTING_BOT_PID" 2>/dev/null; then
      if [[ "$FORCE_RESTART_BOT" == "1" ]]; then
        echo "Found running Bot PID: $EXISTING_BOT_PID, force restarting..."
        kill "$EXISTING_BOT_PID" 2>/dev/null || true
        sleep 1
        EXISTING_BOT_PID=""
      else
        echo "Found running Bot PID: $EXISTING_BOT_PID, skip starting duplicate instance"
      fi
    else
      echo "Found stale Bot lock, cleaning: $BOT_LOCK_FILE"
      rm -f "$BOT_LOCK_FILE" || true
      EXISTING_BOT_PID=""
    fi
  fi

  if [[ -z "$EXISTING_BOT_PID" ]]; then
    TWILIGHT_BOT_LOCK_FILE="$BOT_LOCK_FILE" \
    TWILIGHT_FORCE_RESTART_BOT="$FORCE_RESTART_BOT" \
      "$PYTHON" main.py bot &
    BOT_PID=$!
    BOT_STARTED=1
    echo "Started Bot PID: $BOT_PID"
  fi
fi

if [[ "$WITH_SCHEDULER" == "1" ]]; then
  EXISTING_SCHEDULER_PID=""

  if [[ -f "$SCHEDULER_LOCK_FILE" ]]; then
    EXISTING_SCHEDULER_PID="$(tr -dc '0-9' < "$SCHEDULER_LOCK_FILE" || true)"
    if [[ -n "$EXISTING_SCHEDULER_PID" ]] && kill -0 "$EXISTING_SCHEDULER_PID" 2>/dev/null; then
      if [[ "$FORCE_RESTART_SCHEDULER" == "1" ]]; then
        echo "Found running Scheduler PID: $EXISTING_SCHEDULER_PID, force restarting..."
        kill "$EXISTING_SCHEDULER_PID" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
          [[ -f "$SCHEDULER_LOCK_FILE" ]] || break
          sleep 1
        done
        EXISTING_SCHEDULER_PID=""
      else
        echo "Found running Scheduler PID: $EXISTING_SCHEDULER_PID, skip starting duplicate instance"
      fi
    else
      echo "Found stale Scheduler lock, cleaning: $SCHEDULER_LOCK_FILE"
      rm -f "$SCHEDULER_LOCK_FILE" || true
      EXISTING_SCHEDULER_PID=""
    fi
  fi

  if [[ -z "$EXISTING_SCHEDULER_PID" ]]; then
    TWILIGHT_SCHEDULER_LOCK_FILE="$SCHEDULER_LOCK_FILE" \
    TWILIGHT_FORCE_RESTART_SCHEDULER="$FORCE_RESTART_SCHEDULER" \
      "$PYTHON" main.py scheduler &
    SCHEDULER_PID=$!
    SCHEDULER_STARTED=1
    echo "Started Scheduler PID: $SCHEDULER_PID"
  fi
fi

cleanup() {
  if [[ "${BOT_STARTED:-0}" == "1" && -n "${BOT_PID:-}" ]]; then
    kill "$BOT_PID" 2>/dev/null || true
  fi
  if [[ "${SCHEDULER_STARTED:-0}" == "1" && -n "${SCHEDULER_PID:-}" ]]; then
    kill "$SCHEDULER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

"$PYTHON" -m uvicorn asgi:app \
  --host "$HOST" \
  --port "$PORT" \
  --workers "$WORKERS" \
  --limit-concurrency "$LIMIT_CONCURRENCY" \
  --backlog "$BACKLOG" \
  --timeout-keep-alive "$KEEP_ALIVE" \
  "$@"
exit $?
