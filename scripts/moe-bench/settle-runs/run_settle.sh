#!/usr/bin/env bash
# Settling swap108 as the local config (2026-10-06): a paired speed and VRAM probe against keep96 at the
# speed-lab winner, then tier2b with the phase-1 recipe harness (3 candidates + 1 self-test suite, the same
# seeds) on swap108 and keep96. The Versutus gate is paused before this runs and restored afterwards.
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
MB=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42/scripts/moe-bench
L=/c/qwen3-forge-stage/logs
K96='C:\qwen3-forge-stage\models\prune-qwen36\Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf'
S108='C:\qwen3-forge-stage\models\adapters\keep96-swap108.gguf'
D=2026-10-06
MBW=$(cygpath -w "$MB")  # a path inside a Python string is not converted by Git Bash, so pass the Windows form
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$L/settle-chain.log"; }

# Wait (up to 10 min) for 1 GB of available RAM before a model load; skip the step otherwise.
ram_ok() {
  for _ in $(seq 1 20); do
    "$PY" -c "import sys; sys.path.insert(0, r'$MBW'); import moe_sweep; sys.exit(0 if moe_sweep.ram_avail_gb() >= 1.0 else 1)" && return 0
    sleep 30
  done
  return 1
}

# One model server at a time: wait while any llama-server runs (two on port 8093 collided once, 2026-10-06 19:10).
gpu_free() { while tasklist //FI "IMAGENAME eq llama-server.exe" 2>/dev/null | grep -qi llama-server; do sleep 15; done; }

DONE="$L/settle-chain.done"  # the marker later chains wait for; log lines are not a safe trigger
rm -f "$DONE"
log "start"
if [ "$(grep -c '' "$L/speedpair-$D.jsonl" 2>/dev/null || echo 0)" -ge 4 ]; then
  log "speed_pair already done"
else
  "$PY" "$MB/speed_pair.py" --out "$L/speedpair-$D.jsonl" --reps 2 "$K96" "$S108" > "$L/speedpair-$D.out" 2>&1
  log "speed_pair exit $?"
fi
for m in swap108 keep96; do
  [ "$m" = swap108 ] && G="$S108" || G="$K96"
  sleep 30
  gpu_free
  if ram_ok; then
    BON_GGUF="$G" "$PY" "$MB/bestofn_tier2b.py" run --model qwen36keep96 --n 3 --suites 1 --trials 3 --temp-alt 0.7 \
      --out "$L/tier2b-recipe-$m-$D.jsonl" > "$L/tier2b-recipe-$m-$D.out" 2>&1
    log "tier2b $m exit $?"
    "$PY" "$MB/bestofn_tier2b.py" analyze "$L/tier2b-recipe-$m-$D.jsonl" > "$L/tier2b-recipe-$m-$D.analyze.out" 2>&1
  else
    log "tier2b $m skipped: RAM below 1 GB for 10 min"
  fi
done
log "chain finished"
touch "$DONE"
