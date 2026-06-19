#!/bin/bash
# Launch the Windows Tauri dev shell from the WSL checkout.
set -e

PROJECT="/home/ethan/.openclaw/agents/coderclaw/workspace/home-base"
WINDOWS_LAUNCHER="$(wslpath -w "$PROJECT/scripts/tauri-dev.bat")"

echo "[home-base] Starting Windows Tauri dev shell..."
cmd.exe /c "$WINDOWS_LAUNCHER"