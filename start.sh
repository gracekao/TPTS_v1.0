#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$ROOT_DIR/proxy"

cd "$PROXY_DIR"

if command -v pkill >/dev/null 2>&1; then
  pkill -f tpts_backend_linux_amd64 >/dev/null 2>&1 || true
fi

if [[ -x "$PROXY_DIR/tpts_backend_linux_amd64" ]]; then
  BACKEND_BIN="$PROXY_DIR/tpts_backend_linux_amd64"
elif [[ -x "$PROXY_DIR/tpts_backend" ]]; then
  BACKEND_BIN="$PROXY_DIR/tpts_backend"
else
  echo "[TPTS] Missing Linux backend binary. Build with:"
  echo "  cd proxy && GOOS=linux GOARCH=amd64 go build -o tpts_backend_linux_amd64 ."
  exit 1
fi

echo "[TPTS] Starting backend: $BACKEND_BIN"
"$BACKEND_BIN" &

sleep 1

echo "[TPTS] Dashboard: http://localhost:8080"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:8080" >/dev/null 2>&1 || true
fi
