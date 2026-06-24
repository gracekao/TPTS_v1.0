#!/system/bin/sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_DIR="$SCRIPT_DIR/proxy"

cd "$PROXY_DIR"

chmod 755 "$PROXY_DIR/tpts_backend_android_arm64" 2>/dev/null || true

if [ ! -x "$PROXY_DIR/tpts_backend_android_arm64" ]; then
  echo "[TPTS] Missing Android backend binary: proxy/tpts_backend_android_arm64"
  exit 1
fi

pkill -f tpts_backend_android_arm64 2>/dev/null || true

echo "[TPTS] Starting Android local backend..."
"$PROXY_DIR/tpts_backend_android_arm64" &

sleep 1

echo "[TPTS] Dashboard: http://127.0.0.1:8080"
echo "[TPTS] In dashboard, set target IP to: local"
