#!/usr/bin/env bash
# Laya partner GPU session 2 (plan Task 12, pre-registered in 2026-10-05-laya-partner-prereg.md, commit 76a2873):
# the judge set's nested runs, configurations 3-5 live on the judge set, the same on tier2b (reported only), then
# Laya's labels of the judge nested runs (CPU), the report, and the Versutus gate restored. Every runner resumes per
# (task, trial), so a crash costs one task-trial; each step is retried up to 3 times. Live runs use the spec's
# 2,048 MB guard and are retried once at 1,024 MB if refused at launch (owner-delegated, 2026-10-07).
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
LPY=/c/qwen3-forge-stage/venv-laya/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
MB=$WT/scripts/moe-bench
L=/c/qwen3-forge-stage/logs
D=docs/benchmarks/laya-partner
export BON_EXTRA='["--load-mode","none"]'
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$L/laya-chain.log"; }
gpu_free() { while tasklist //FI "IMAGENAME eq llama-server.exe" 2>/dev/null | grep -qi llama-server; do sleep 15; done; }
rows() { [ -e "$1" ] && grep -c '' "$1" || echo 0; }
cd "$WT" || exit 1
rm -f "$L/laya-session2.done"
log "session 2 start"

for try in 1 2 3; do
  gpu_free
  TIER2B_DIR=docs/benchmarks/laya-judge "$PY" "$MB/playbook_tier2b.py" nested --model qwen36keep96 \
    --out "$L/laya-judge-nested.jsonl" >> "$L/laya-judge-nested.out" 2>&1
  log "judge nested try $try exit $?; rows $(rows "$L/laya-judge-nested.jsonl")"
  [ "$(rows "$L/laya-judge-nested.jsonl")" -ge 180 ] && break
  sleep 60
done

live() {  # live SET DIR CONF NOTE VERIFY N
  local out="$L/laya-$1-$3.jsonl" guard=2048
  for try in 1 2 3; do
    gpu_free
    sleep 20
    TIER2B_DIR="$2" "$PY" "$MB/playbook_tier2b.py" live --model qwen36keep96 --out "$out" --rule "$D/rule.json" \
      --calib "$D/calib.json" --note "$4" --verify "$5" --min-free-mb "$guard" >> "${out%.jsonl}.out" 2>&1
    local rc=$?
    log "$1 $3 try $try exit $rc (guard $guard MB); rows $(rows "$out")"
    if tail -3 "${out%.jsonl}.out" | grep -q "MB available; the guard is"; then guard=1024; fi
    [ "$(rows "$out")" -ge "$6" ] && break
    sleep 30
  done
}
live judge docs/benchmarks/laya-judge c3 on off 180
live judge docs/benchmarks/laya-judge c4 on on 180
live judge docs/benchmarks/laya-judge c5 off on 180
live tier2b scripts/benchmark-tier2b c3 on off 117
live tier2b scripts/benchmark-tier2b c4 on on 117
live tier2b scripts/benchmark-tier2b c5 off on 117

gpu_free
sleep 20
TIER2B_DIR=docs/benchmarks/laya-judge USE_TF=0 "$LPY" "$MB/laya_partner.py" label --runs "$L/laya-judge-nested.jsonl" \
  --out "$L/laya-judge-labels.jsonl" >> "$L/laya-judge-labels.out" 2>&1
log "judge labels exit $?"

"$PY" "$MB/playbook.py" report --trials "$L/laya-judge-nested.jsonl" --labels "$L/laya-judge-labels.jsonl" \
  --calib "$D/calib.json" --rule "$D/rule.json" --live c3="$L/laya-judge-c3.jsonl" --live c4="$L/laya-judge-c4.jsonl" \
  --live c5="$L/laya-judge-c5.jsonl" --out "$L/laya-judge-report.json" > "$L/laya-judge-report.out" 2>&1
log "report exit $?"
"$PY" "$MB/laya_calibrate.py" report --trials "$L/laya-judge-nested.jsonl" --labels "$L/laya-judge-labels.jsonl" \
  --calib "$D/calib.json" --out "$L/laya-judge-diagnostics.json" > "$L/laya-judge-diagnostics.out" 2>&1
log "diagnostics exit $?"
for c in c3 c4 c5; do "$PY" "$MB/playbook_tier2b.py" summarize "$L/laya-tier2b-$c.jsonl" > "$L/laya-tier2b-$c.summary" 2>&1; done

powershell -NoProfile -Command "Set-Location C:\Projects\Versutus; node gate\cli.mjs service start" >> "$L/laya-chain.log" 2>&1
log "Versutus gate start requested"
log "session 2 done"
touch "$L/laya-session2.done"
