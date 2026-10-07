#!/usr/bin/env bash
# Testing add108 (2026-10-06, owner's choice after swap108 lost to keep96 on tier2b): remove swap108's file to keep
# C: above 10% free (checksum, rebuild command and Modal backup in docs/benchmarks/adapters/swap108-manifest.json),
# slice add108 = keep96's 96 experts per layer + the 12 highest failure-targeted ones, settle, then tier2b with the
# phase-1 recipe harness and seeds. The Versutus gate stays paused.
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
MB=$WT/scripts/moe-bench
MBW=$(cygpath -w "$MB")
L=/c/qwen3-forge-stage/logs
FULL='C:\qwen3-forge-stage\Qwen3.6-35B-A3B-UD-IQ2_M.gguf'
A108='C:\qwen3-forge-stage\models\adapters\keep96-add108.gguf'
S108=/c/qwen3-forge-stage/models/adapters/keep96-swap108.gguf
D=2026-10-06
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$L/settle-chain.log"; }
gpu_free() { while tasklist //FI "IMAGENAME eq llama-server.exe" 2>/dev/null | grep -qi llama-server; do sleep 15; done; }
ram_ok() {
  for _ in $(seq 1 20); do
    "$PY" -c "import sys; sys.path.insert(0, r'$MBW'); import moe_sweep; sys.exit(0 if moe_sweep.ram_avail_gb() >= 1.0 else 1)" && return 0
    sleep 30
  done
  return 1
}
cd "$WT" || exit 1
rm -f "$L/add108-chain.done"
log "add108 start"
grep -q 31bf807e796c75f45947103313a8c249c644f7a6b29092227e4cceee4bd3be4c docs/benchmarks/adapters/swap108-manifest.json \
  || { log "manifest missing: not removing swap108"; exit 1; }
[ -e "$S108" ] && rm -f "$S108" && log "removed keep96-swap108.gguf (manifest + Modal backup)"
log "free before slice: $(df -h /c | tail -1 | awk '{print $4}')"
"$PY" "$MB/slice_experts.py" "$FULL" "$A108" --keep-list docs/benchmarks/adapters/keeplists/add108.json \
  > "$L/adapters-slice-add108-$D.out" 2>&1
log "slice add108 exit $?; free after: $(df -h /c | tail -1 | awk '{print $4}')"
log "settle 180 s"
sleep 180
gpu_free
if ram_ok; then
  BON_GGUF="$A108" "$PY" "$MB/bestofn_tier2b.py" run --model qwen36keep96 --n 3 --suites 1 --trials 3 --temp-alt 0.7 \
    --out "$L/tier2b-recipe-add108-$D.jsonl" > "$L/tier2b-recipe-add108-$D.out" 2>&1
  log "tier2b add108 exit $?"
  "$PY" "$MB/bestofn_tier2b.py" analyze "$L/tier2b-recipe-add108-$D.jsonl" > "$L/tier2b-recipe-add108-$D.analyze.out" 2>&1
else
  log "tier2b add108 skipped: RAM below 1 GB for 10 min"
fi
log "add108 chain finished"
touch "$L/add108-chain.done"
