#!/usr/bin/env bash
# Laya v3 judge session, the rest of the chain (2026-10-08 repair; see the results doc). It takes over from
# run_v3_judge.sh, which was stopped while its nested runner kept going: a game opened mid-run pushed the paged-out Laya
# worker past its 5 s deadline, so the client stopped asking it and later nested rows have no evidence answer.
#  1. Wait for that nested runner to finish; rerun it as run_v3_judge.sh would if it stopped short.
#  2. Before every GPU step, wait until no game is running, then shut WSL down.
#  3. Regenerate the p3 block of rows without an evidence answer (nested --v3 --base, the same seeds) and merge them.
#  4. Live on the judge set and on tier2b; rows run after Laya died are removed and rerun (infrastructure flag only).
#  5. Labels, the report, the diagnostics. The Versutus gate is restored on exit, even on failure.
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
LPY=/c/qwen3-forge-stage/venv-laya/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
MB=$WT/scripts/moe-bench
REDO="$PY $MB/laya-runs/p3_redo.py"
L=/c/qwen3-forge-stage/logs
V=docs/benchmarks/laya3
J=docs/benchmarks/laya-judge3
N=$L/laya3-judge-nested.jsonl
export BON_EXTRA='["--load-mode","none"]'
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$L/laya3-chain.log"; }
gpu_free() { while tasklist //FI "IMAGENAME eq llama-server.exe" 2>/dev/null | grep -qi llama-server; do sleep 15; done; }
rows() { [ -e "$1" ] && grep -c '' "$1" || echo 0; }
restore_gate() {
  powershell -NoProfile -Command "Set-Location C:\Projects\Versutus; node gate\cli.mjs service start" >> "$L/laya3-chain.log" 2>&1
  log "Versutus gate start requested"
}
trap restore_gate EXIT
cd "$WT" || exit 1
rm -f "$L/laya3-judge.done"
log "judge session (rest) start"

nested_alive() {
  powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -match 'playbook_tier2b.py nested' }).Count" 2>/dev/null | tr -d '\r'
}
wait_quiet() {  # no game running (it squeezes RAM until Laya misses its deadline), then WSL down
  local n=0
  while tasklist //FI "IMAGENAME eq RobloxPlayerBeta.exe" 2>/dev/null | grep -qi roblox; do
    [ $((n % 40)) -eq 0 ] && log "waiting: a game is running (RobloxPlayerBeta); Laya misses its deadline under that memory pressure"
    n=$((n + 1))
    sleep 15
  done
  wsl --shutdown > /dev/null 2>&1
}
step() {  # step NAME TARGET_ROWS OUT COMMAND... (as run_v3_judge.sh, plus wait_quiet)
  local name=$1 want=$2 out=$3 guard=2048
  shift 3
  for try in 1 2 3; do
    gpu_free
    wait_quiet
    sleep 20
    "$@" --min-free-mb "$guard" --out "$out" >> "${out%.jsonl}.out" 2>&1
    log "$name try $try exit $? (guard $guard MB); rows $(rows "$out")"
    if tail -3 "${out%.jsonl}.out" | grep -q "MB available; the guard is"; then guard=1024; fi
    [ "$(rows "$out")" -ge "$want" ] && return 0
    sleep 30
  done
  log "$name: stopped after 3 tries"
}
live_step() {  # live_step NAME TARGET_ROWS OUT COMMAND...: rerun rows that ran after Laya died, up to 3 passes
  local name=$1 want=$2 out=$3
  shift 3
  for pass in 1 2 3; do
    step "$name" "$want" "$out" "$@"
    $REDO drop-dead "$out" | tee -a "$L/laya3-chain.log"
    [ "$(rows "$out")" -ge "$want" ] && return 0
  done
  log "$name: Laya still died after 3 passes; rows $(rows "$out")"
}

while [ "$(nested_alive)" != "0" ]; do sleep 30; done
gpu_free
log "judge nested runner finished; rows $(rows "$N")"
if [ "$(rows "$N")" -lt 360 ]; then
  step "judge nested" 360 "$N" \
    env TIER2B_DIR=$J "$PY" "$MB/playbook_tier2b.py" nested --v3 --model qwen36keep96 --calib "$V/calib.json"
fi

for pass in 1 2 3; do
  $REDO split "$N" "$L/laya3-judge-nested-redo.jsonl" "$L/laya3-judge-nested-base.jsonl" | tee -a "$L/laya3-chain.log"
  [ "$(rows "$L/laya3-judge-nested-base.jsonl")" -eq 0 ] && break
  step "p3 redo pass $pass" 360 "$L/laya3-judge-nested-redo.jsonl" \
    env TIER2B_DIR=$J "$PY" "$MB/playbook_tier2b.py" nested --v3 --model qwen36keep96 --calib "$V/calib.json" \
    --base "$L/laya3-judge-nested-base.jsonl"
  $REDO merge "$N" "$L/laya3-judge-nested-redo.jsonl" 360 | tee -a "$L/laya3-chain.log"
done

live_step "judge live" 360 "$L/laya3-judge-live.jsonl" \
  env TIER2B_DIR=$J "$PY" "$MB/playbook_tier2b.py" live --v3 --model qwen36keep96 --rule "$V/rule.json" --calib "$V/calib.json"
live_step "tier2b live" 117 "$L/laya3-tier2b-live.jsonl" \
  env TIER2B_DIR=scripts/benchmark-tier2b "$PY" "$MB/playbook_tier2b.py" live --v3 --model qwen36keep96 --rule "$V/rule.json" --calib "$V/calib.json"

gpu_free
TIER2B_DIR=$J USE_TF=0 "$LPY" "$MB/laya_partner.py" label --v3 --runs "$N" \
  --out "$L/laya3-judge-labels.jsonl" >> "$L/laya3-judge-labels.out" 2>&1
log "judge labels exit $?"
"$PY" "$MB/playbook.py" report-v3 --trials "$N" --labels "$L/laya3-judge-labels.jsonl" \
  --calib "$V/calib.json" --rule "$V/rule.json" --live "$L/laya3-judge-live.jsonl" --tier2b-live "$L/laya3-tier2b-live.jsonl" \
  --tier2b-recipe docs/benchmarks/2026-10-06/tier2b-recipe-keep96-2026-10-06.jsonl \
  --v2-calib docs/benchmarks/laya-partner/calib.json --v2-rule docs/benchmarks/laya-partner/rule.json \
  --out "$L/laya3-judge-report.json" > "$L/laya3-judge-report.out" 2>&1
log "report exit $?"
"$PY" "$MB/laya_calibrate.py" report --trials "$N" --labels "$L/laya3-judge-labels.jsonl" \
  --calib "$V/calib.json" --out "$L/laya3-judge-diagnostics.json" > "$L/laya3-judge-diagnostics.out" 2>&1
log "diagnostics exit $?"
touch "$L/laya3-judge.done"
log "judge session done"
