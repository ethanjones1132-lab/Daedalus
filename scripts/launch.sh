#!/bin/bash
# Desktop launches let Tauri own Bun and the Claude CLI proxy. The standalone
# mode is for headless local tooling and uses the caller's launch credential.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" != "--no-tauri" ]]; then
    cd "$ROOT"
    exec cargo tauri dev "$@"
fi
shift
if [[ $# -ne 0 ]]; then
    echo "Usage: scripts/launch.sh --no-tauri (fixed port 19877)" >&2
    exit 2
fi
: "${JARVIS_SERVER_TOKEN:?Generate and export a fresh token before launching standalone Bun}"
export JARVIS_SERVER_TOKEN
cd "$ROOT/server-jarvis"
exec bun run start
