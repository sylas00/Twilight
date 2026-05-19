#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "   Twilight Starting..."
echo "=========================================="

# 启动后端
echo "Starting Backend (All Services)..."
if [[ -x ".venv/bin/python" ]]; then
  PYTHON=".venv/bin/python"
elif [[ -x "venv/bin/python" ]]; then
  PYTHON="venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
else
  PYTHON="python"
fi

"$PYTHON" main.py all &
BACKEND_PID=$!

# 等待后端初始化
sleep 2

# 启动前端（生产模式）
echo "Starting Frontend..."
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. On NixOS, run 'nix develop' first." >&2
  kill "$BACKEND_PID" 2>/dev/null || true
  exit 1
fi

cd webui && pnpm start -p 3000 &
FRONTEND_PID=$!
cd "$SCRIPT_DIR"

# 等待前端启动
sleep 5

echo "=========================================="
echo "   All services are launching!"
echo "   Backend: http://127.0.0.1:5000/api/v1/docs"
echo "   Frontend: http://localhost:3000"
echo "=========================================="
echo "Press Ctrl+C to stop all services."

# 捕获退出信号，停止子进程
trap 'kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit' INT TERM

wait
