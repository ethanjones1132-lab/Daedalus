#!/usr/bin/env bash
# Laya v3 pool session (plan docs/superpowers/plans/2026-10-08-laya-v3.md, Task 10): extend the 2026-10-06 pool rows
# (r8/pr candidates and suites unchanged) with probe v3's p3 block, Laya's evidence answers live; copy the pool's
# labels (their candidates are the base rows'), then add Laya's P(valid) for every example assert. The runner resumes
# per (task, trial); 3 tries; the RAM guard is 2,048 MB with the pre-registered 1,024 MB fallback. The Versutus gate
# is paused by the caller and restored here at the end, even on failure.
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
LPY=/c/qwen3-forge-stage/venv-laya/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
MB=$WT/scripts/moe-bench
L=/c/qwen3-forge-stage/logs
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
rm -f "$L/laya3-pool.done"
log "pool session start"

guard=2048
for try in 1 2 3; do
  gpu_free
  sleep 20
  TIER2B_DIR=docs/benchmarks/laya-calib "$PY" "$MB/playbook_tier2b.py" nested --v3 --base "$L/laya-calib-nested.jsonl" \
    --calib docs/benchmarks/laya-partner/calib.json --min-free-mb "$guard" --out "$L/laya3-calib-nested.jsonl" \
    >> "$L/laya3-calib-nested.out" 2>&1
  log "pool nested try $try exit $? (guard $guard MB); rows $(rows "$L/laya3-calib-nested.jsonl")"
  if tail -3 "$L/laya3-calib-nested.out" | grep -q "MB available; the guard is"; then guard=1024; fi
  [ "$(rows "$L/laya3-calib-nested.jsonl")" -ge 180 ] && break
  sleep 30
done

cp "$L/laya-calib-labels.jsonl" "$L/laya3-calib-labels.jsonl"
TIER2B_DIR=docs/benchmarks/laya-calib USE_TF=0 "$LPY" "$MB/laya_partner.py" label --v3 --runs "$L/laya3-calib-nested.jsonl" \
  --out "$L/laya3-calib-labels.jsonl" >> "$L/laya3-calib-labels.out" 2>&1
log "pool labels exit $?; valid rows $(grep -c '"type": "valid"' "$L/laya3-calib-labels.jsonl")"
touch "$L/laya3-pool.done"
log "pool session done"
