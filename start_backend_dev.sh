#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Windows 下用户可能用 CRLF 编辑这份脚本；这里在 Linux/macOS 直接走 LF。
# 即使解释器读取没问题，env 变量里仍可能塞 \r（来自上游脚本传值），统一裁掉。
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

echo "=========================================="
echo "   Twilight Backend (Development)"
echo "=========================================="
echo "Using Python: $PYTHON"
echo "Mode: development (main.py api --debug)"

WITH_SCHEDULER="$(strip_cr "${TWILIGHT_WITH_SCHEDULER:-1}")"
SCHEDULER_LOCK_FILE="$(strip_cr "${TWILIGHT_SCHEDULER_LOCK_FILE:-$SCRIPT_DIR/db/scheduler.lock}")"
FORCE_RESTART_SCHEDULER="$(strip_cr "${TWILIGHT_FORCE_RESTART_SCHEDULER:-0}")"

# 提前创建 lock 目录，避免子进程因为 db/ 不存在写锁失败默默退出
mkdir -p "$(dirname "$SCHEDULER_LOCK_FILE")"

SCHEDULER_PID=""

start_scheduler() {
  # 把 lock 路径透传给 main.py，保证父子双方看的是同一个文件
  TWILIGHT_SCHEDULER_LOCK_FILE="$SCHEDULER_LOCK_FILE" \
  TWILIGHT_FORCE_RESTART_SCHEDULER="$FORCE_RESTART_SCHEDULER" \
    "$PYTHON" main.py scheduler &
  SCHEDULER_PID=$!
  echo "Started Scheduler PID: $SCHEDULER_PID"
}

if [[ "$WITH_SCHEDULER" == "1" ]]; then
  echo "Scheduler: enabled (separate process)"
  echo "Scheduler lock: $SCHEDULER_LOCK_FILE"
  EXISTING_SCHEDULER_PID=""
  if [[ -f "$SCHEDULER_LOCK_FILE" ]]; then
    EXISTING_SCHEDULER_PID="$(tr -dc '0-9' < "$SCHEDULER_LOCK_FILE" || true)"
    if [[ -n "$EXISTING_SCHEDULER_PID" ]] && kill -0 "$EXISTING_SCHEDULER_PID" 2>/dev/null; then
      if [[ "$FORCE_RESTART_SCHEDULER" == "1" ]]; then
        echo "Found running Scheduler PID: $EXISTING_SCHEDULER_PID, force restarting..."
        kill "$EXISTING_SCHEDULER_PID" 2>/dev/null || true
        # 等锁文件释放
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
    start_scheduler
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
