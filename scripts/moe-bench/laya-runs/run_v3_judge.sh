#!/usr/bin/env bash
# Laya v3 judge session (plan docs/superpowers/plans/2026-10-08-laya-v3.md, Task 13; pre-registered in
# docs/superpowers/specs/2026-10-08-laya-v3-prereg.md before anything ran on docs/benchmarks/laya-judge3):
# the extended nested runs on the judge set, full v3 live on the judge set (the bar) and on tier2b (the guard),
# Laya's labels, the report and the diagnostics. Every runner resumes per (task, trial); 3 tries each; the RAM guard
# is 2,048 MB with the pre-registered 1,024 MB fallback. The Versutus gate is paused by the caller and restored here
# at the end, even on failure.
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
LPY=/c/qwen3-forge-stage/venv-laya/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
MB=$WT/scripts/moe-bench
L=/c/qwen3-forge-stage/logs
V=docs/benchmarks/laya3
J=docs/benchmarks/laya-judge3
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
log "judge session start"

step() {  # step NAME TARGET_ROWS OUT COMMAND...
  local name=$1 want=$2 out=$3 guard=2048
  shift 3
  for try in 1 2 3; do
    gpu_free
    sleep 20
    "$@" --min-free-mb "$guard" --out "$out" >> "${out%.jsonl}.out" 2>&1
    log "$name try $try exit $? (guard $guard MB); rows $(rows "$out")"
    if tail -3 "${out%.jsonl}.out" | grep -q "MB available; the guard is"; then guard=1024; fi
    [ "$(rows "$out")" -ge "$want" ] && return 0
    sleep 30
  done
  log "$name: stopped after 3 tries"
}

step "judge nested" 360 "$L/laya3-judge-nested.jsonl" \
  env TIER2B_DIR=$J "$PY" "$MB/playbook_tier2b.py" nested --v3 --model qwen36keep96 --calib "$V/calib.json"
step "judge live" 360 "$L/laya3-judge-live.jsonl" \
  env TIER2B_DIR=$J "$PY" "$MB/playbook_tier2b.py" live --v3 --model qwen36keep96 --rule "$V/rule.json" --calib "$V/calib.json"
step "tier2b live" 117 "$L/laya3-tier2b-live.jsonl" \
  env TIER2B_DIR=scripts/benchmark-tier2b "$PY" "$MB/playbook_tier2b.py" live --v3 --model qwen36keep96 --rule "$V/rule.json" --calib "$V/calib.json"

gpu_free
TIER2B_DIR=$J USE_TF=0 "$LPY" "$MB/laya_partner.py" label --v3 --runs "$L/laya3-judge-nested.jsonl" \
  --out "$L/laya3-judge-labels.jsonl" >> "$L/laya3-judge-labels.out" 2>&1
log "judge labels exit $?"
"$PY" "$MB/playbook.py" report-v3 --trials "$L/laya3-judge-nested.jsonl" --labels "$L/laya3-judge-labels.jsonl" \
  --calib "$V/calib.json" --rule "$V/rule.json" --live "$L/laya3-judge-live.jsonl" --tier2b-live "$L/laya3-tier2b-live.jsonl" \
  --tier2b-recipe docs/benchmarks/2026-10-06/tier2b-recipe-keep96-2026-10-06.jsonl \
  --v2-calib docs/benchmarks/laya-partner/calib.json --v2-rule docs/benchmarks/laya-partner/rule.json \
  --out "$L/laya3-judge-report.json" > "$L/laya3-judge-report.out" 2>&1
log "report exit $?"
"$PY" "$MB/laya_calibrate.py" report --trials "$L/laya3-judge-nested.jsonl" --labels "$L/laya3-judge-labels.jsonl" \
  --calib "$V/calib.json" --out "$L/laya3-judge-diagnostics.json" > "$L/laya3-judge-diagnostics.out" 2>&1
log "diagnostics exit $?"
touch "$L/laya3-judge.done"
log "judge session done"
