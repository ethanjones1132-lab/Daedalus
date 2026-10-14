#!/usr/bin/env bash
# A background app restarts the WSL VM (~600 MB) within minutes of each shutdown (2026-10-08). Shut it down whenever
# it is up, until the marker file exists. usage: wsl_guard.sh [MARKER]   (default: the Laya v3 judge-session marker)
L=/c/qwen3-forge-stage/logs
MARKER=${1:-$L/laya3-judge.done}
until [ -e "$MARKER" ]; do
  if tasklist //FI "IMAGENAME eq vmmemWSL" 2>/dev/null | grep -qi vmmem; then
    wsl --shutdown > /dev/null 2>&1
    echo "$(date +%H:%M:%S) wsl guard: WSL VM was up; shut down" >> $L/wsl-guard.log
  fi
  sleep 20
done
