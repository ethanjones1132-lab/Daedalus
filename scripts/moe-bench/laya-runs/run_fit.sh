#!/usr/bin/env bash
# After GPU session 1 (plan Task 11 steps 1-2, run on keep96): the RAM check for the live runs (ram_check.py), then
# Laya's calibration fit and the rule fit on the calibration pool. Starts when session 1 logs its end; touches
# logs/laya-fit.done. The pre-registration is written by hand from these outputs before any judge run.
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
MB=$WT/scripts/moe-bench
L=/c/qwen3-forge-stage/logs
P=docs/benchmarks/laya-partner
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$L/laya-chain.log"; }
gpu_free() { while tasklist //FI "IMAGENAME eq llama-server.exe" 2>/dev/null | grep -qi llama-server; do sleep 15; done; }
cd "$WT" || exit 1
rm -f "$L/laya-fit.done"

until grep -q "session 1 done" "$L/laya-chain.log" 2>/dev/null; do sleep 20; done
sleep 30
gpu_free
TIER2B_DIR=docs/benchmarks/laya-calib "$PY" "$MB/laya-runs/ram_check.py" --out "$L/laya-ram-check.json" > "$L/laya-ram-check.out" 2>&1
log "ram check exit $?"
"$PY" "$MB/laya_calibrate.py" fit --trials "$L/laya-calib-nested.jsonl" --labels "$L/laya-calib-labels.jsonl" \
  --out "$P/calib.json" > "$L/laya-fit-calib.out" 2>&1
log "calib fit exit $?"
"$PY" "$MB/playbook.py" fit --trials "$L/laya-calib-nested.jsonl" --labels "$L/laya-calib-labels.jsonl" \
  --calib "$P/calib.json" --out "$P/rule.json" > "$L/laya-fit-rule.out" 2>&1
log "rule fit exit $?"
touch "$L/laya-fit.done"
