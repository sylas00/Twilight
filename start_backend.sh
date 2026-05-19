#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [[ "${1:-}" == "prod" ]]; then
  shift
  exec bash "$SCRIPT_DIR/start_backend_prod.sh" "$@"
fi

if [[ "${1:-}" == "dev" ]]; then
  shift
fi

exec bash "$SCRIPT_DIR/start_backend_dev.sh" "$@"
