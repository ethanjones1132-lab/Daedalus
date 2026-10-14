#!/usr/bin/env bash
# Long-context check for keep96 (spec docs/superpowers/specs/2026-10-07-long-context-design.md, plan
# docs/superpowers/plans/2026-10-07-long-context.md): the memory and speed grid; Short and Late at 64k; bar (a) at
# 64k if Late passes; Short and Late at the largest window that fits, then its bar (a); Early at 64k last (reported
# only). If Late fails at 64k, Short and Late at 32k instead. Every runner resumes per sample. The Versutus gate is
# paused here and restored on exit, even on failure. A watchdog stops everything before 01:00 on 2026-10-08 (the
# Laya v3 run starts at 01:30); an unfinished step resumes after that run.
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
MB=$WT/scripts/moe-bench
L=/c/qwen3-forge-stage/logs/longctx
K96='C:\qwen3-forge-stage\models\prune-qwen36\Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf'
STORED=$WT/docs/benchmarks/2026-10-06/tier2b-recipe-keep96-2026-10-06.jsonl
RUNS=$L/sessions.jsonl
mkdir -p "$L"
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$L/chain.log"; }
gpu_free() { while tasklist //FI "IMAGENAME eq llama-server.exe" 2>/dev/null | grep -qi llama-server; do sleep 15; done; }
gate() { powershell -NoProfile -Command "Set-Location C:\Projects\Versutus; node gate\cli.mjs service $1" >> "$L/chain.log" 2>&1; }
q() { "$PY" "$MB/longctx_sessions.py" query --verdict "$L/grid.verdict.json" --report "$L/report.json" --bar-a-dir "$L" "$1"; }
stopped() { [ -e "$L/STOP" ]; }
DEADLINE=$(date -d "2026-10-08 00:55" +%s)

rm -f "$L/STOP" "$L/chain.done"
finish() { gate start; log "Versutus gate start requested; chain done"; touch "$L/chain.done"; }
trap finish EXIT
( while [ "$(date +%s)" -lt "$DEADLINE" ]; do sleep 30; [ -e "$L/chain.done" ] && exit 0; done
  touch "$L/STOP"; sleep 150; taskkill //F //IM llama-server.exe > /dev/null 2>&1 ) &

log "start; idle VRAM $(nvidia-smi --query-gpu=memory.used --format=csv,noheader)"
gate stop
gpu_free

# 1. Memory and speed grid (spec §2)
if [ ! -e "$L/grid.verdict.json" ]; then
  "$PY" "$MB/speed_pair.py" --grid --out "$L/grid.jsonl" --min-ram-gb 1.0 "$K96" > "$L/grid.out" 2>&1
  log "grid exit $?; $(tail -1 "$L/grid.out")"
fi
[ -e "$L/grid.verdict.json" ] || { log "no grid verdict; stopping"; exit 1; }

session() {  # session WINDOW CONDS
  local w=$1 conds=$2 k guard=2048 rc
  k=$(q "ctk:$w")
  if [ "$k" = none ]; then log "session $w $conds skipped: the window did not pass the grid"; return 1; fi
  for try in 1 2 3; do
    stopped && return 1
    gpu_free
    sleep 20
    "$PY" "$MB/longctx_sessions.py" run --window "$w" --target "$(q "target:$w")" --conds "$conds" \
      --extra "[\"-ctk\",\"$k\",\"-ctv\",\"$k\"]" --out "$RUNS" --counts "$L/unit-tokens.json" \
      --stop-file "$L/STOP" --min-free-mb "$guard" >> "$L/sessions.out" 2>&1
    rc=$?
    log "session $w $conds try $try exit $rc (guard $guard MB)"
    [ $rc -eq 2 ] && guard=1024
    [ $rc -eq 0 ] || [ $rc -eq 3 ] && break
    sleep 30
  done
  "$PY" "$MB/longctx_sessions.py" report --runs "$RUNS" --stored "$STORED" --out "$L/report.json" > "$L/report.out" 2>&1
  log "report exit $?: $(grep -c 'bar (b) PASS' "$L/report.out") group(s) pass bar (b)"
}

bar_a() {  # bar_a WINDOW
  local w=$1 k
  k=$(q "ctk:$w")
  stopped && return 1
  gpu_free
  sleep 20
  BON_EXTRA="[\"--load-mode\",\"none\",\"-c\",\"$w\",\"-ctk\",\"$k\",\"-ctv\",\"$k\"]" "$PY" "$MB/bestofn_tier2b.py" run \
    --model qwen36keep96 --n 3 --suites 1 --trials 3 --temp-alt 0.7 --out "$L/recipe-$w.jsonl" > "$L/recipe-$w.out" 2>&1
  log "recipe $w exit $?"
  stopped && return 1
  "$PY" "$MB/longctx_sessions.py" bar-a --stored "$STORED" --new "$L/recipe-$w.jsonl" --out "$L/bar-a-$w.json" \
    > "$L/bar-a-$w.out" 2>&1
  log "bar (a) $w: $(q "bara:$w")"
}

# 2. Short and Late at 64k (bar (b)), then bar (a) at 64k; 3. the largest window that fits
session 65536 short,late
case "$(q barb:65536)" in
  pass)
    bar_a 65536
    TOP=$(q top)
    if [ "$TOP" != none ] && [ "$TOP" -gt 65536 ]; then
      session "$TOP" short,late
      [ "$(q "barb:$TOP")" = pass ] && bar_a "$TOP"
    fi ;;
  fail)
    session 32768 short,late
    [ "$(q barb:32768)" = pass ] && bar_a 32768 ;;
  *) log "64k Late incomplete; resume after the Laya v3 run" ;;
esac
# 4. Early at 64k (reported only)
session 65536 early
log "chosen window: $(q chosen)"
