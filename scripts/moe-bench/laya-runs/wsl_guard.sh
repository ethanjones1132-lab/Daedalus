#!/usr/bin/env bash
# Laya v3 judge session (2026-10-08): a background app restarts the WSL VM (~600 MB) within minutes of each shutdown;
# shut it down whenever it is up, until the judge session is done.
L=/c/qwen3-forge-stage/logs
until [ -e $L/laya3-judge.done ]; do
  if tasklist //FI "IMAGENAME eq vmmemWSL" 2>/dev/null | grep -qi vmmem; then
    wsl --shutdown > /dev/null 2>&1
    echo "$(date +%H:%M:%S) wsl guard: WSL VM was up; shut down" >> $L/laya3-wsl-guard.log
  fi
  sleep 20
done
