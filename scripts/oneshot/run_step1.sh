#!/usr/bin/env bash
# Step 1 chain (2026-10-09): headroom test, K2-Horizon's two builds, then the dense roster on the Ecosystem Lab.
# Phases are resumable and skip finished work. Triggers are marker files, never log text. The Versutus gate is restored
# on exit, however the chain ends. usage: run_step1.sh [headroom|k2|roster|all]   (default all)
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
L=/c/qwen3-forge-stage/logs/step1
RUNS=/c/qwen3-forge-stage/logs/oneshot/runs
P=docs/benchmarks/oneshot/ecosystem-lab/params-dev.json
S=scripts/oneshot
PHASE=${1:-all}
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$L/step1-chain.log"; }
gpu_free() { while tasklist //FI "IMAGENAME eq llama-server.exe" 2>/dev/null | grep -qi llama-server; do sleep 10; done; }
restore_gate() {
  local since last
  since=$(date -u +%Y-%m-%dT%H:%M:%S)
  log "restoring the Versutus gate (healthy means lastHealthyAt after $since)"
  (cd /c/Projects/Versutus && node gate/cli.mjs service start >> "$L/gate-restore.log" 2>&1)
  for _ in $(seq 1 30); do
    sleep 10
    last=$(cd /c/Projects/Versutus && node gate/cli.mjs service status 2>&1 | grep -o '"lastHealthyAt": "[^"]*"' | cut -d'"' -f4)
    if [[ "$last" > "$since" ]]; then log "gate healthy ($last)"; return; fi
  done
  log "gate: lastHealthyAt not refreshed after 5 min (check by hand)"
}
if [ "$PHASE" = all ]; then trap 'restore_gate' EXIT; fi
cd "$WT" || exit 1
mkdir -p "$L" "$RUNS"

if [ "$PHASE" = all ] || [ "$PHASE" = headroom ]; then
  gpu_free
  log "headroom start"
  "$PY" scripts/moe-bench/headroom_iq3.py --out "$L/headroom.jsonl" --windows 16384,40960,65536,98304,131072 \
    --variants int8,fp32 --stop-file "$L/stop" >> "$L/headroom.out" 2>&1
  log "headroom exit $?"
  touch "$L/headroom.done"
fi

if [ "$PHASE" = all ] || [ "$PHASE" = k2 ]; then
  gpu_free
  log "k2h start (RAM available $("$PY" -c "import sys; sys.path.insert(0, 'scripts/moe-bench'); import moe_sweep; print(moe_sweep.ram_avail_gb())") GB)"
  "$PY" $S/oneshot_bench.py run --model k2h --seeds 1-2 --runs "$RUNS" --stop-file "$L/stop" >> "$L/k2h.out" 2>&1
  log "k2h run exit $?"
  taskkill //F //IM llama-server.exe > /dev/null 2>&1
  "$PY" $S/oneshot_bench.py check --runs "$RUNS" --params $P --set dev --shots --only k2h >> "$L/k2h.out" 2>&1
  "$PY" $S/oneshot_bench.py check --runs "$RUNS" --params $P --set dev --assembled --only k2h >> "$L/k2h.out" 2>&1
  log "k2h checks exit $?"
  touch "$L/k2.done"
fi

if [ "$PHASE" = all ] || [ "$PHASE" = roster ]; then
  # the slow models (27B dense, ternary 27B) go last so one slow run cannot block the roster (deviation, documented)
  ROSTER="gemma4-12b qwen38-9b dsv4pro-qwen35-9b qwen35-9b qwen35-9b-coder qwythos-9b ornith-9b nemotron-nano-9b gemma4-12b-coding llama31-8b nanbeige-3b qwen38-27b bonsai-27b"
  for m in $ROSTER; do
    if [ -e "$L/stop" ]; then log "stop file: roster halted before $m"; break; fi
    if [ -e "$L/roster-$m.done" ]; then continue; fi
    gpu_free
    log "roster $m start"
    "$PY" $S/oneshot_bench.py run --model "$m" --seeds 1-3 --runs "$RUNS" --stop-file "$L/stop" >> "$L/roster-$m.out" 2>&1
    log "roster $m run exit $?"
    taskkill //F //IM llama-server.exe > /dev/null 2>&1
    ( "$PY" $S/oneshot_bench.py check --runs "$RUNS" --params $P --set dev --shots --only "$m" >> "$L/roster-$m.out" 2>&1
      "$PY" $S/oneshot_bench.py check --runs "$RUNS" --params $P --set dev --assembled --only "$m" >> "$L/roster-$m.out" 2>&1
      touch "$L/roster-$m.done"; echo "$(date +%H:%M:%S) roster $m checks done" >> "$L/step1-chain.log" ) &
  done
  wait
  touch "$L/roster.done"
fi
log "chain phase $PHASE finished"
touch "$L/chain-$PHASE.done"
