#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_PYTHON="$PROJECT_DIR/.venv-video-bridge/bin/python"
if [[ ! -x "$BRIDGE_PYTHON" ]]; then
  echo "Create .venv-video-bridge and install requirements-video-bridge.txt first (see docs/minimax-video-bridge.md)." >&2
  exit 1
fi
cd "$PROJECT_DIR"
exec "$BRIDGE_PYTHON" "$PROJECT_DIR/minimax_video_bridge.py"
