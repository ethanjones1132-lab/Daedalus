#!/usr/bin/env bash
# Laya partner GPU session 1 on keep96 (plan Task 10 steps 2-3; deviation 9): the calibration pool's nested
# runs (60 tasks x 3 trials, Qwen only), then Laya's labels on the CPU. It starts when the settle chain
# (settle-runs/run_settle.sh) has touched its marker. The live smoke test (Task 10 step 1) needs Qwen and Laya
# loaded together and is left to a session with 2 GB of RAM to spare. The Versutus gate stays paused throughout.
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
LPY=/c/qwen3-forge-stage/venv-laya/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
MB=$WT/scripts/moe-bench
L=/c/qwen3-forge-stage/logs
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$L/laya-chain.log"; }
gpu_free() { while tasklist //FI "IMAGENAME eq llama-server.exe" 2>/dev/null | grep -qi llama-server; do sleep 15; done; }
cd "$WT" || exit 1

# The settle chain touches this marker when it finishes. (A log-line trigger fired early on 2026-10-06 19:10,
# when "speed_pair already done" matched " done$", and two servers shared port 8093.)
until [ -e "$L/settle-chain.done" ]; do sleep 20; done
sleep 30
log "session 1 start"
for try in 1 2 3; do  # the runner resumes per (task, trial), so a crash costs one task-trial
  gpu_free
  TIER2B_DIR=docs/benchmarks/laya-calib "$PY" "$MB/playbook_tier2b.py" nested --model qwen36keep96 \
    --out "$L/laya-calib-nested.jsonl" >> "$L/laya-calib-nested.out" 2>&1
  log "calib nested try $try exit $?"
  [ "$(wc -l < "$L/laya-calib-nested.jsonl")" -ge 180 ] && break
  sleep 60
done
log "calib nested rows $(wc -l < "$L/laya-calib-nested.jsonl")"
sleep 30
TIER2B_DIR=docs/benchmarks/laya-calib USE_TF=0 "$LPY" "$MB/laya_partner.py" label \
  --runs "$L/laya-calib-nested.jsonl" --out "$L/laya-calib-labels.jsonl" >> "$L/laya-calib-labels.out" 2>&1
log "calib labels exit $?"
log "session 1 done"
