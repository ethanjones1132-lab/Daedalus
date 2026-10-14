#!/usr/bin/env bash
# One-shot benchmark round two (owner, 2026-10-07): every MoE tested on tier2b, 3 builds each (temperature 0.2,
# seeds 1-3), keep96 and DeepSeek already done in round one. Models on disk run first so the downloads (gpt-oss-20b,
# Xing4.0, K2-Horizon to E:) can finish; keep24 is re-sliced from gpt-oss with its original imatrix, and Xing4.0 gets
# its metadata fix, as soon as their sources land. Each model's builds are checked (dev set, with screenshots, plus
# the exploratory assembled score) right after it. The Versutus gate is paused here and restored on exit. A watchdog
# stops everything before 01:00 on 2026-10-08 (Laya v3 starts at 01:30); unfinished models resume after that run.
set -u
PY=/c/qwen3-forge-stage/venv/Scripts/python.exe
WT=/c/Projects/home-base-recovered/.claude/worktrees/micro-agent-swarm-design-929d42
S=$WT/scripts/oneshot
L=/c/qwen3-forge-stage/logs/oneshot
RUNS=$L/runs
P=$WT/docs/benchmarks/oneshot/ecosystem-lab/params-dev.json
EM=/e/qwen3-forge/models
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$L/round2.log"; }
gpu_free() { while tasklist //FI "IMAGENAME eq llama-server.exe" 2>/dev/null | grep -qi llama-server; do sleep 15; done; }
gate() { powershell -NoProfile -Command "Set-Location C:\Projects\Versutus; node gate\cli.mjs service $1" >> "$L/round2.log" 2>&1; }
stopped() { [ -e "$L/STOP2" ]; }
DEADLINE=$(date -d "2026-10-08 00:50" +%s)

rm -f "$L/STOP2" "$L/round2.done"
finish() { gate start; log "Versutus gate start requested; round two chain done"; touch "$L/round2.done"; }
trap finish EXIT
( while [ "$(date +%s)" -lt "$DEADLINE" ]; do sleep 30; [ -e "$L/round2.done" ] && exit 0; done
  touch "$L/STOP2"; sleep 420; [ -e "$L/round2.done" ] || taskkill //F //IM llama-server.exe > /dev/null 2>&1 ) &

prep() {  # derived files, made once their sources exist
  if [ -f "$EM/gpt-oss-20b-MXFP4.gguf" ] && [ ! -f "$EM/gpt-oss-20b-MXFP4-keep24-selfgen.gguf" ]; then
    "$PY" "$WT/scripts/moe-bench/slice_experts.py" "$(cygpath -w $EM/gpt-oss-20b-MXFP4.gguf)" \
      "$(cygpath -w $EM/gpt-oss-20b-MXFP4-keep24-selfgen.gguf.part)" --keep 24 \
      --imatrix 'C:\qwen3-forge-stage\models\prune-gptoss20b\imatrix-gptoss-selfgen.gguf' \
      --report "$(cygpath -w $L/keep24-report.json)" >> "$L/round2.log" 2>&1 \
      && mv "$EM/gpt-oss-20b-MXFP4-keep24-selfgen.gguf.part" "$EM/gpt-oss-20b-MXFP4-keep24-selfgen.gguf"
    log "keep24 slice exit $?"
  fi
  if [ -f "$EM/Xing4.0-29B-A4B-IQ3_XXS.gguf" ] && [ ! -f "$L/xing4-fixed" ]; then
    /c/qwen3-forge-stage/venv/Scripts/gguf-set-metadata.exe "$(cygpath -w $EM/Xing4.0-29B-A4B-IQ3_XXS.gguf)" \
      xing4_0.nextn_predict_layers 0 --force >> "$L/round2.log" 2>&1 && touch "$L/xing4-fixed"
    log "xing4 metadata fix exit $?"
  fi
}

model_file() { "$PY" -c "import sys; sys.path.insert(0, r'$(cygpath -w $S)'); import oneshot_bench as o; print(o.MODELS[sys.argv[1]]['path'])" "$1"; }

log "round two start; idle VRAM $(nvidia-smi --query-gpu=memory.used --format=csv,noheader)"
gate stop
for m in qwen36full gemma26b tiel gptoss20b gptoss20b-keep24 qwen36full-iq3xxs lfm25-8b-a1b xing4 k2h; do
  stopped && { log "stop: deadline reached before $m"; break; }
  prep
  f=$(model_file "$m")
  waited=0
  while [ ! -f "$(cygpath -u "$f")" ] && [ $waited -lt 3600 ] && ! stopped; do sleep 60; waited=$((waited + 60)); prep; done
  if [ ! -f "$(cygpath -u "$f")" ]; then log "$m skipped: $f not available"; continue; fi
  [ "$m" = xing4 ] && [ ! -f "$L/xing4-fixed" ] && { log "xing4 skipped: metadata fix missing"; continue; }
  gpu_free
  "$PY" "$S/oneshot_bench.py" run --model "$m" --seeds 1-3 --runs "$RUNS" --stop-file "$L/STOP2" >> "$L/round2-$m.out" 2>&1
  log "$m generation exit $?: $(grep -c 'finish' "$L/round2-$m.out") builds; $(grep 'ncmoe' "$L/round2-$m.out" | tail -1)"
  "$PY" "$S/oneshot_bench.py" check --runs "$RUNS" --params "$P" --set dev --shots --only "$m" >> "$L/round2-$m.check" 2>&1
  "$PY" "$S/oneshot_bench.py" check --runs "$RUNS" --params "$P" --set dev --assembled --only "$m" >> "$L/round2-$m.check" 2>&1
  log "$m checks: $(grep -o 'score [0-9.]* ([0-9]*/70)' "$L/round2-$m.check" | tr '\n' ' ')"
done
log "round two loop done"
